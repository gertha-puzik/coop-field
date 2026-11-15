/** Keep every request below common proxy body limits; preserve original image bytes. */
import { type ApiRow } from './http-auth';
import { httpOrigin } from './coop';

const CHUNK = 512 * 1024;
export async function postProfileImage(path: string, file: File): Promise<{ status: number; row: ApiRow | null }> {
  if (file.size > 100 * 1024 * 1024) return { status: 413, row: { reason: 'too_large' } };
  try {
    const chunked = file.size > CHUNK;
    const id = chunked ? crypto.randomUUID() : '';
    const count = chunked ? Math.ceil(file.size / CHUNK) : 1;
    for (let part = 0; part < count; part++) {
      const form = new FormData();
      if (!chunked) form.append('file', file, file.name || 'image.gif');
      const query = chunked ? `?upload=${id}&part=${part}&size=${file.size}` : '';
      const res = await fetch(`${httpOrigin()}${path}${query}`, {
        method: 'POST', credentials: 'include',
        ...(chunked ? { headers: { 'content-type': 'application/octet-stream' } } : {}),
        body: chunked ? file.slice(part * CHUNK, (part + 1) * CHUNK) : form,
      });
      let row: ApiRow | null = null;
      try {
        const parsed: unknown = await res.json();
        row = parsed && typeof parsed === 'object' ? parsed as ApiRow : null;
      } catch { /* A proxy can return HTML, including for HTTP 413. */ }
      if (res.status === 413 && !row?.reason) row = { reason: 'proxy_too_large' };
      if (part === count - 1 || res.status !== 202 || row?.pending !== true) return { status: res.status, row };
    }
  } catch { return { status: 0, row: null }; }
  return { status: 0, row: null };
}
