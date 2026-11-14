/**
 * Горизонтальный фон профиля (баннер). Стек как у server/avatars.js:
 * cookie-сессия, apiZone-CSRF, multipart, атомарная запись.
 *
 *   POST   /banners/mine  — multipart {file} → 200 {ok, banner}
 *   DELETE /banners/mine  — 200 {ok, banner:null}
 *   GET    /banners/file/<id>.(png|jpg|gif) — публичная отдача
 *
 * Лимиты: PNG/JPEG/GIF по магии; ширина ≤1200, высота ≤400; файл ≥100 байт
 * и ≤2 МБ; не чаще 1 загрузки / 10 с на аккаунт. Поля профиля:
 * bannerExt ('png'|'jpg'|'gif'), bannerAt (unix-ms).
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, csrfDecision, siteClassOfRequest } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, setCors } from "./runtime-config.js";
import { flushAccounts, bannerUrlOf } from "./accounts.js";
import { readBody, parseMultipart, PNG_MAGIC } from "./sprites.js";
import { writeFileAtomic } from "./atomic-file.js";
import { pushActivity } from "./activity.js";

const DIR = path.join(DATA_DIR, "banners");
fs.mkdirSync(DIR, { recursive: true });

const MAX_UPLOAD = 2 * 1024 * 1024;
const DIM_W_MAX = 1200;
const DIM_H_MAX = 400;
const DIM_MIN = 16;
const MIN_FILE_BYTES = 100;
const RATE_INTERVAL_MS = 10_000;

const fileOf = (accountId, ext) => path.join(DIR, `${accountId}.${ext}`);

function pngDimsOf(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) return null;
  if (PNG_MAGIC.compare(data, 0, 8) !== 0) return null;
  if (data.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
}

function jpegDimsOf(data) {
  if (!Buffer.isBuffer(data) || data.length < 4) return null;
  let pos = 2;
  while (pos + 4 < data.length) {
    if (data[pos] !== 0xff) return null;
    const marker = data[pos + 1];
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2;
      continue;
    }
    if (pos + 3 >= data.length) return null;
    const len = data.readUInt16BE(pos + 2);
    if (len < 2) return null;
    if (
      marker >= 0xc0 && marker <= 0xcf &&
      marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    ) {
      if (pos + 9 > data.length) return null;
      return { h: data.readUInt16BE(pos + 5), w: data.readUInt16BE(pos + 7) };
    }
    pos += 2 + len;
  }
  return null;
}

/** Logical Screen Descriptor GIF87a/89a: width/height LE at bytes 6–9. */
function gifDimsOf(data) {
  if (!Buffer.isBuffer(data) || data.length < 10) return null;
  const sig = data.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  return { w: data.readUInt16LE(6), h: data.readUInt16LE(8) };
}

function sniffImage(data) {
  if (!Buffer.isBuffer(data) || data.length < 6) return null;
  if (data.length >= 8 && PNG_MAGIC.compare(data, 0, 8) === 0) return "png";
  if (
    data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff &&
    data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9
  ) {
    return "jpg";
  }
  const sig = data.toString("ascii", 0, 6);
  if (sig === "GIF87a" || sig === "GIF89a") return "gif";
  return null;
}

function dimsOf(ext, data) {
  if (ext === "png") return pngDimsOf(data);
  if (ext === "jpg") return jpegDimsOf(data);
  if (ext === "gif") return gifDimsOf(data);
  return null;
}

const lastUploadAt = new Map();
function rateAllow(accountId) {
  return Date.now() - (lastUploadAt.get(accountId) || 0) >= RATE_INTERVAL_MS;
}
function rateRecord(accountId) {
  lastUploadAt.set(accountId, Date.now());
}

/** Канон /banners/*; обходной /cfg/banners/* — прод nginx уже шлёт /cfg в Node. */
function isBannersPath(p) {
  return (
    p === "/banners/mine" || p.startsWith("/banners/mine/") ||
    p === "/banners/file" || p.startsWith("/banners/file/") ||
    p === "/cfg/banners/mine" || p.startsWith("/cfg/banners/mine/") ||
    p === "/cfg/banners/file" || p.startsWith("/cfg/banners/file/")
  );
}

function canonBannersPath(p) {
  if (p === "/cfg/banners/mine" || p.startsWith("/cfg/banners/mine/")) {
    return "/banners/mine" + p.slice("/cfg/banners/mine".length);
  }
  if (p === "/cfg/banners/file" || p.startsWith("/cfg/banners/file/")) {
    return "/banners/file" + p.slice("/cfg/banners/file".length);
  }
  return p;
}

const CONTENT_TYPE = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
};

export async function handleBannersHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const raw = url.pathname;
  if (!isBannersPath(raw)) return false;
  const p = canonBannersPath(raw);
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (p === "/banners/file" || p.startsWith("/banners/file/")) {
    const m = /^\/banners\/file\/([A-Za-z0-9_-]{1,64})\.(png|jpg|gif)$/.exec(p);
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
        "content-type": CONTENT_TYPE[m[2]] || "application/octet-stream",
        "content-length": String(data.length),
        "cache-control": "public, max-age=300",
      });
      res.end(data);
    } catch {
      json(res, 404, { ok: false, reason: "not_found" });
    }
    return true;
  }

  const session = sessionFromRequest(req);
  if (!session) {
    json(res, 401, {
      ok: false,
      reason: "auth_required",
      message: "Фон профиля доступен после входа в аккаунт.",
    });
    return true;
  }
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

  if (req.method === "POST" && p === "/banners/mine") {
    if (!rateAllow(accountId)) {
      json(res, 429, {
        ok: false,
        reason: "rate",
        message: "Фон можно менять раз в 10 секунд — немного подождите.",
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
      buf = await readBody(req, MAX_UPLOAD);
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
        message: "Файл не похож на картинку — нужен PNG, JPEG или GIF.",
      });
      return true;
    }
    const dims = dimsOf(ext, img);
    if (
      !dims ||
      dims.w < DIM_MIN || dims.w > DIM_W_MAX ||
      dims.h < DIM_MIN || dims.h > DIM_H_MAX ||
      img.length < MIN_FILE_BYTES
    ) {
      json(res, 400, {
        ok: false,
        reason: "bad_dims",
        message: "Фон не подходит: ширина до 1200 px, высота до 400 px, файл от 100 байт.",
      });
      return true;
    }

    try {
      // Стираем прежние расширения — один файл на аккаунт.
      for (const old of ["png", "jpg", "gif"]) {
        if (old === ext) continue;
        try {
          fs.unlinkSync(fileOf(accountId, old));
        } catch (e) {
          if (e?.code !== "ENOENT") throw e;
        }
      }
      writeFileAtomic(fileOf(accountId, ext), img);
    } catch (e) {
      console.warn("banner upload failed:", e?.message || e);
      json(res, 500, { ok: false, reason: "io", message: "Не удалось сохранить фон." });
      return true;
    }
    if (!acc.profile || typeof acc.profile !== "object") acc.profile = {};
    acc.profile.bannerExt = ext;
    acc.profile.bannerAt = Date.now();
    flushAccounts(true);
    rateRecord(accountId);
    pushActivity(accountId, "banner_changed");
    json(res, 200, { ok: true, banner: bannerUrlOf(acc) });
    return true;
  }

  if (req.method === "DELETE" && p === "/banners/mine") {
    try {
      for (const ext of ["png", "jpg", "gif"]) {
        try {
          fs.unlinkSync(fileOf(accountId, ext));
        } catch (e) {
          if (e?.code !== "ENOENT") throw e;
        }
      }
    } catch (e) {
      console.warn("banner delete failed:", e?.message || e);
      json(res, 500, { ok: false, reason: "io", message: "Не удалось удалить файл фона." });
      return true;
    }
    if (acc.profile && typeof acc.profile === "object") {
      acc.profile.bannerExt = null;
      acc.profile.bannerAt = 0;
    }
    flushAccounts(true);
    json(res, 200, { ok: true, banner: null });
    return true;
  }

  json(res, 405, { ok: false, reason: "method_not_allowed" });
  return true;
}
