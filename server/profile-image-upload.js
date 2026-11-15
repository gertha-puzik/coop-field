/** Bounded profile uploads: multipart or ordered 512 KiB chunks, after auth/CSRF. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBody, parseMultipart } from './sprites.js';

const CHUNK = 512 * 1024;
const MAX_ACTIVE = 16;
const TTL = 5 * 60_000;
const uploads = new Map();
process.once('exit', () => {
  for (const [key, upload] of uploads) discard(key, upload);
});
const fail = (status, reason, message) => Object.assign(new Error(message), { status, reason });
function discard(key, upload) {
  if (uploads.get(key) === upload) uploads.delete(key);
  clearTimeout(upload.timer);
  fs.rmSync(upload.dir, { recursive: true, force: true });
}

async function readLimited(req, limit) {
  let timer, aborted;
  const interrupted = new Promise((_, reject) => {
    aborted = () => reject(fail(400, 'bad_multipart', 'Передача файла прервалась.'));
    req.once('aborted', aborted);
    timer = setTimeout(() => reject(fail(408, 'upload_expired', 'Время передачи файла истекло.')), 30_000);
    timer.unref();
  });
  try { return await Promise.race([readBody(req, limit), interrupted]); }
  finally { clearTimeout(timer); req.off('aborted', aborted); }
}

export async function readProfileImage(req, { owner, kind, maxBytes }) {
  const url = new URL(req.url, 'http://localhost');
  const type = String(req.headers['content-type'] || '');
  if (!url.searchParams.has('upload')) {
    if (!/^multipart\/form-data/i.test(type)) throw fail(400, 'bad_content_type', 'Ожидается файл картинки.');
    let body;
    try { body = await readLimited(req, maxBytes + 64 * 1024); }
    catch (error) { if (error?.reason) throw error; throw fail(error?.code === 'too_large' ? 413 : 400, error?.code === 'too_large' ? 'too_large' : 'bad_multipart', 'Не удалось прочитать файл.'); }
    const form = parseMultipart(body, type);
    if (!form) throw fail(400, 'bad_multipart', 'Форма загрузки не читается.');
    if (!form.file?.data?.length) throw fail(400, 'no_file', 'Файл картинки не приложен.');
    return form.file.data;
  }

  const id = url.searchParams.get('upload');
  const indexText = url.searchParams.get('part') || '';
  const sizeText = url.searchParams.get('size') || '';
  if (!/^[a-f0-9-]{36}$/.test(id) || !/^\d{1,3}$/.test(indexText) || !/^\d{1,9}$/.test(sizeText) || type !== 'application/octet-stream') {
    throw fail(400, 'bad_multipart', 'Неверные параметры загрузки.');
  }
  const index = Number(indexText), size = Number(sizeText);
  if (size > maxBytes) throw fail(413, 'too_large', 'GIF — до 100 МБ.');
  if (size < 100 || index >= Math.ceil(size / CHUNK)) throw fail(400, 'bad_multipart', 'Неверный размер загрузки.');
  const key = `${kind}:${owner}`;
  let upload = uploads.get(key);
  if (upload?.busy) throw fail(409, 'upload_conflict', 'Дождитесь завершения текущей загрузки.');
  if (index === 0) {
    if (upload) discard(key, upload);
    if (uploads.size >= MAX_ACTIVE) throw fail(429, 'rate', 'Сервер занят, попробуйте немного позже.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-profile-upload-'));
    upload = { id, size, next: 0, busy: false, dir, timer: null };
    upload.timer = setTimeout(() => discard(key, upload), TTL);
    upload.timer.unref();
    uploads.set(key, upload);
  }
  if (!upload || upload.id !== id || upload.size !== size || upload.next !== index) {
    throw fail(409, 'upload_conflict', 'Загрузка прервалась — выберите файл ещё раз.');
  }
  upload.busy = true;
  try {
    let bytes;
    try { bytes = await readLimited(req, CHUNK); }
    catch (error) { if (error?.reason) throw error; throw fail(error?.code === 'too_large' ? 413 : 400, error?.code === 'too_large' ? 'too_large' : 'bad_multipart', 'Не удалось прочитать часть файла.'); }
    if (uploads.get(key) !== upload) throw fail(408, 'upload_expired', 'Время загрузки истекло — попробуйте ещё раз.');
    if (bytes.length !== Math.min(CHUNK, size - index * CHUNK)) throw fail(400, 'bad_multipart', 'Часть файла передана не полностью.');
    const file = path.join(upload.dir, 'image');
    fs.appendFileSync(file, bytes);
    upload.next++;
    upload.timer.refresh();
    if (upload.next * CHUNK < size) return null;
    return fs.readFileSync(file);
  } catch (error) {
    discard(key, upload);
    throw error;
  } finally {
    upload.busy = false;
    if (upload.next * CHUNK >= size) discard(key, upload);
  }
}
