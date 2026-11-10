/**
 * Аватарки игроков — личная картинка профиля («профиль: день рождения +
 * аватарка»). Стек — по образцу зоны личных окрасов #83 (server/my-sprites.js):
 * cookie-сессия (401 гость), apiZone-CSRF unsafe-cookie (net.js + перепроверка
 * общей политикой csrfDecision, как в profiles.js), multipart-парсер и
 * атомарная запись из sprites.js, rate на аккаунт in-memory.
 *
 *   POST   /avatars/mine   — multipart {file}: загрузка/замена СВОЕЙ аватарки →
 *                            200 {ok:true, avatar:"/avatars/file/<id>.<ext>?v=…"}
 *                            (файл один на аккаунт: имя = id аккаунта, любая
 *                            заливка — перезапись; идентичность — только сессия,
 *                            имена/id из формы игнорируются);
 *   DELETE /avatars/mine   — удаление своей аватарки → 200 {ok:true, avatar:null}
 *                            (файл уходит первым; ошибка диска → io, профильные
 *                            поля не меняются);
 *   GET    /avatars/file/<id>.png|.jpg — публичная отдача файла (404 на мусор
 *                            и отсутствие; host-гейтом не спрятан — читается
 *                            обоим сайтам, как /sprites/file; имена строятся
 *                            только из [A-Za-z0-9_-]{1,64} + расширение).
 *
 * PROFILE-поля аккаунта (source of truth): profile.avatarExt ('png'|'jpg') и
 * profile.avatarAt (unix-ms; 0 = аватарки нет). DTO собирает
 * accounts.avatarUrlOf (поле avatar в publicProfile), он же строит ответ
 * POST: «?v=<avatarAt>» меняется с каждой заменой и обходит кэш браузера.
 *
 * Лимиты (локальные константы зоны): тело ≤ 2 МБ; формат PNG или JPEG по магии
 * байтов; каждая сторона 64–1500 px; суммарно ≤ 2 250 000 px; файл ≥ 100 байт;
 * не чаще одной загрузки в 10 секунд на аккаунт. Сквозного лимита HTTP-тела
 * в net.js нет — зоны держат свои (sprites 3 МБ, my-sprites 1 МБ, profiles
 * 16 КиБ); по меньшему из применимых режет эта константа.
 *
 * Отказы {ok:false, reason, message}: auth_required 401, csrf* 403, rate 429,
 * too_large 413, bad_multipart/no_file/bad_content_type/bad_magic/bad_dims
 * 400, io 500 — человеческий текст человеку, кодовая причина в reason.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, csrfDecision, siteClassOfRequest } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, setCors } from "./runtime-config.js";
import { flushAccounts, avatarUrlOf } from "./accounts.js";
import { readBody, parseMultipart, PNG_MAGIC } from "./sprites.js";

const DIR = path.join(DATA_DIR, "avatars");
/** Каталог аватарок создаётся при старте (импорт модуля = старт сервера). */
fs.mkdirSync(DIR, { recursive: true });

/** Потолок тела загрузки: 2 МБ — бытовой аватар весит килобайты, запас на
 *  фотореалистичные JPEG оставлен без «безразмерности» (мultipart-обёртка
 *  добавляет копейки; проверяется по факту прочитанных байтов, не по
 *  Content-Length — отсутствующий заголовок не обходит лимит). */
const MAX_AVATAR_UPLOAD = 2 * 1024 * 1024;

/** Габариты: каждая сторона 64–1500 px, всего ≤ 2 250 000 px — квадратная
 *  аватарка 1500×1500 проходит впритык, «полоса» 1500×1499 тоже. */
const DIM_MIN = 64;
const DIM_MAX = 1500;
const AREA_MAX = 2_250_000;

/** Минимальный вес файла: ниже 100 байт картинки не бывает — огрызки и
 *  «магия без тела» отбиваются до разбора габаритов. */
const MIN_FILE_BYTES = 100;

/** Менять аватарку можно не чаще раза в 10 секунд: скользящее окно
 *  in-memory на аккаунт (сброс при рестарте — норма: это щит от зацикленного
 *  клиента, а не бухгалтерия; засчитываются только успешные загрузки). */
const RATE_INTERVAL_MS = 10_000;

/** Имя файла: <id аккаунта>.<png|jpg> — имена строятся только из
 *  [A-Za-z0-9_-]{1,64} + расширение (набор зашит в regex маршрута отдачи):
 *  пути из URL в файловую систему не передаются. */
const fileOf = (accountId, ext) => path.join(DIR, `${accountId}.${ext}`);

/** Атомарная запись — та же пара tmp+rename, что в sprites.js/accounts.js:
 *  читатель никогда не видит наполовину записанный файл. */
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/* ---------- разбор картинок: PNG по IHDR, JPEG по SOF-кадру ---------- */

/** Габариты PNG из IHDR (байты 16–24): та же раскладка, что в my-sprites.js
 *  — 8-байтовая подпись, длина чанка, «IHDR»; короче 24 байт/не PNG → null. */
function pngDimsOf(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) return null;
  if (PNG_MAGIC.compare(data, 0, 8) !== 0) return null;
  if (data.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
}

/** Габариты JPEG из первого SOF-кадра: маркеры FF C0–CF, кроме C4 (DHT),
 *  C8 (JPG) и CC (DAC) — это таблицы, а не кадры. Сегменты перебираются по
 *  заявленным длинам (big-endian); маркеры-разделители без длины (FF 01,
 *  FF D0–D7) пропускаются парой байт; height/width читаются BE из кадра.
 *  SOF не найден / сегменты не сходятся → null. */
function jpegDimsOf(data) {
  if (!Buffer.isBuffer(data) || data.length < 4) return null;
  let pos = 2; // после SOI (FF D8)
  while (pos + 4 < data.length) {
    if (data[pos] !== 0xff) return null; // вне маркера остаёмся только после EOI
    const marker = data[pos + 1];
    if (marker === 0xff) {
      pos += 1; // fill-байты перед маркером
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2; // TEM/RSTn/SOI/EOI — длины не несут
      continue;
    }
    if (pos + 3 >= data.length) return null;
    const len = data.readUInt16BE(pos + 2);
    if (len < 2) return null; // длина сегмента включает саму себя
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      // SOF: длина(2) точность(1) height(2) width(2) — все big-endian.
      if (pos + 9 > data.length) return null;
      return { h: data.readUInt16BE(pos + 5), w: data.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  return null;
}

/** Формат по магии байтов: PNG — подпись 8 байт (89 50 4E 47 0D 0A 1A 0A),
 *  JPEG — FF D8 FF в начале И FF D9 в конце (обрезанные огрызки не берём).
 *  null = не картинка ни в одном из двух форматов. */
function sniffImage(data) {
  if (!Buffer.isBuffer(data) || data.length < 4) return null;
  if (data.length >= 8 && PNG_MAGIC.compare(data, 0, 8) === 0) return "png";
  if (
    data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff &&
    data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9
  ) {
    return "jpg";
  }
  return null;
}

/* ---------- rate: не чаще одной загрузки в 10 с на аккаунт ---------- */

const lastUploadAt = new Map();

function rateAllow(accountId) {
  return Date.now() - (lastUploadAt.get(accountId) || 0) >= RATE_INTERVAL_MS;
}

/** Засчитываются только успешные загрузки (момент УЧЁТА — после записи). */
function rateRecord(accountId) {
  lastUploadAt.set(accountId, Date.now());
}

/* ---------- маршруты ---------- */

function isAvatarsPath(p) {
  return (
    p === "/avatars/mine" || p.startsWith("/avatars/mine/") ||
    p === "/avatars/file" || p.startsWith("/avatars/file/")
  );
}

/** Разбор маршрутов аватарок: true — наш (ответ отписан), false — чужой
 *  (дальше по цепочке net.js, до статики: без этого хука /avatars/file
 *  уходил бы в файловый 404). */
export async function handleAvatarsHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  if (!isAvatarsPath(p)) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  /* ---------- публичная отдача файла: GET /avatars/file/<id>.<ext> ---------- */
  if (p === "/avatars/file" || p.startsWith("/avatars/file/")) {
    const m = /^\/avatars\/file\/([A-Za-z0-9_-]{1,64})\.(png|jpg)$/.exec(p);
    if (!m) {
      json(res, 404, { ok: false, reason: "not_found" });
      return true;
    }
    if (req.method !== "GET") {
      json(res, 405, { ok: false, reason: "method_not_allowed" });
      return true;
    }
    try {
      const data = fs.readFileSync(fileOf(m[1], m[2]));
      res.writeHead(200, {
        "content-type": m[2] === "png" ? "image/png" : "image/jpeg",
        "content-length": String(data.length),
        // короткий публичный кэш: замена картинки меняет ?v= в URL профиля
        "cache-control": "public, max-age=300",
      });
      res.end(data);
    } catch {
      // отсутствующий файл (в т.ч. уже удалённая аватарка) — единый 404
      json(res, 404, { ok: false, reason: "not_found" });
    }
    return true;
  }

  /* ---------- сессионная зона: POST/DELETE /avatars/mine ---------- */
  // Сессия — единственный источник владельца (стек /profiles и /sprites/mine).
  const session = sessionFromRequest(req);
  if (!session) {
    json(res, 401, {
      ok: false,
      reason: "auth_required",
      message: "Аватарка профиля доступна после входа в аккаунт.",
    });
    return true;
  }
  // CSRF: unsafe + cookie — Origin обязан быть своим (первая проверка уже в
  // net.js apiZone; здесь перепроверка общей политикой, как в profiles.js).
  if (req.method !== "GET" && req.method !== "HEAD") {
    const csrfBad = csrfDecision({
      method: req.method,
      origin: req.headers.origin,
      destClass: siteClassOfRequest(req),
      hasAuth: true,
    });
    if (csrfBad) {
      json(res, csrfBad.status, {
        ok: false,
        reason: csrfBad.reason,
        message: "Запрос отклонён — обновите страницу и попробуйте снова.",
      });
      return true;
    }
  }

  const acc = session.account;
  const accountId = String(acc?.id || "");

  /* ---------- загрузка/замена (POST /avatars/mine) ---------- */
  if (req.method === "POST" && p === "/avatars/mine") {
    if (!rateAllow(accountId)) {
      json(res, 429, {
        ok: false,
        reason: "rate",
        message: "Аватарку можно менять раз в 10 секунд — немного подождите.",
      });
      return true;
    }
    const contentType = String(req.headers["content-type"] || "");
    if (!/^multipart\/form-data/i.test(contentType)) {
      json(res, 400, {
        ok: false,
        reason: "bad_content_type",
        message: "Ожидается multipart/form-data.",
      });
      return true;
    }
    let buf;
    try {
      buf = await readBody(req, MAX_AVATAR_UPLOAD);
    } catch (e) {
      if (e && e.code === "too_large") {
        json(res, 413, {
          ok: false,
          reason: "too_large",
          message: "Картинка больше 2 МБ не принимается — уменьшите её и попробуйте снова.",
        });
        return true;
      }
      json(res, 400, {
        ok: false,
        reason: "bad_multipart",
        message: "Загрузка не читается — попробуйте ещё раз.",
      });
      return true;
    }
    const form = parseMultipart(buf, contentType);
    if (!form) {
      json(res, 400, {
        ok: false,
        reason: "bad_multipart",
        message: "Форма загрузки не читается — файл не найден.",
      });
      return true;
    }
    if (!form.file || !form.file.data || !form.file.data.length) {
      json(res, 400, {
        ok: false,
        reason: "no_file",
        message: "Файл картинки не приложен.",
      });
      return true;
    }
    const img = form.file.data;
    const ext = sniffImage(img);
    if (!ext) {
      json(res, 400, {
        ok: false,
        reason: "bad_magic",
        message: "Файл не похож на картинку — нужен PNG или JPEG.",
      });
      return true;
    }
    const dims = ext === "png" ? pngDimsOf(img) : jpegDimsOf(img);
    if (
      !dims ||
      dims.w < DIM_MIN || dims.w > DIM_MAX ||
      dims.h < DIM_MIN || dims.h > DIM_MAX ||
      dims.w * dims.h > AREA_MAX ||
      img.length < MIN_FILE_BYTES
    ) {
      json(res, 400, {
        ok: false,
        reason: "bad_dims",
        message: "Картинка не подходит: сторона от 64 до 1500 px, всего до 2 250 000 px, файл от 100 байт.",
      });
      return true;
    }

    // Коммит: файл лёг атомарно → профильные поля обновляются (avatarAt —
    // новая версия кэша) и сливаются в стор; ошибка диска → io, поля НЕ
    // трогаем — аккаунт не должен ссылаться на неписаный файл.
    try {
      writeFileAtomic(fileOf(accountId, ext), img);
    } catch (e) {
      console.warn("avatar upload failed:", e?.message || e);
      json(res, 500, { ok: false, reason: "io", message: "Не удалось сохранить аватарку." });
      return true;
    }
    if (!acc.profile || typeof acc.profile !== "object") acc.profile = {};
    acc.profile.avatarExt = ext;
    acc.profile.avatarAt = Date.now();
    flushAccounts(true); // форс-проход: саму мутацию accounts не считает
    rateRecord(accountId);
    json(res, 200, { ok: true, avatar: avatarUrlOf(acc) });
    return true;
  }

  /* ---------- удаление (DELETE /avatars/mine) ---------- */
  if (req.method === "DELETE" && p === "/avatars/mine") {
    // Файл уходит ПЕРВЫМ: ошибка диска (не ENOENT) → io, профильные поля не
    // трогаем. Чистим оба расширения: мусор в profile.avatarExt не должен
    // оставлять осиротевший файл на диске.
    try {
      for (const ext of ["png", "jpg"]) {
        try {
          fs.unlinkSync(fileOf(accountId, ext));
        } catch (e) {
          if (e?.code !== "ENOENT") throw e;
        }
      }
    } catch (e) {
      console.warn("avatar delete failed:", e?.message || e);
      json(res, 500, { ok: false, reason: "io", message: "Не удалось удалить файл аватарки." });
      return true;
    }
    if (acc.profile && typeof acc.profile === "object") {
      acc.profile.avatarExt = null;
      acc.profile.avatarAt = 0;
    }
    flushAccounts(true);
    json(res, 200, { ok: true, avatar: null });
    return true;
  }

  json(res, 405, { ok: false, reason: "method_not_allowed" });
  return true;
}
