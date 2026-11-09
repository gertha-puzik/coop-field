/**
 * Личные окрасы игроков — #83: сессионная загрузка PNG в каталог «Мои окрасы».
 *
 *   POST   /sprites/mine        — multipart {file (один PNG), name 2–24} →
 *                                 201 {ok, sprite:{id,name,category,src,w,h,bytes}};
 *                                 дедуп тела (sha256 своего же окраса) → 200
 *                                 существующий sprite, слот НЕ тратится;
 *   GET    /sprites/mine        — {ok, limit, count, items:[sprite + addedAt +
 *                                 hidden]} — только свои (владелец из сессии);
 *   DELETE /sprites/mine/:id    — владелец или админ; «одет» → 409 worn
 *                                 «сначала переоденьте кота».
 *
 * Стек защиты — как у сессионных ручек профилей: cookie-сессия (401), Origin/
 * CSRF-гейт unsafe-cookie (apiZone в net.js + перепроверка общей политикой
 * csrfDecision как в profiles.js), роль админа НЕ нужна. Имена/id/категории
 * из запроса игнорируются: id — транслит-слаг имени (никогда из uploaded
 * filename), категория — константа, владелец — из сессии.
 *
 * Отказы {ok:false, reason, message}: auth 401, csrf 403, no_file 400,
 * bad_magic 400, bad_name 400, bad_dims 400, too_large 413, limit 409
 * («У вас уже 3 окраса — удалите один в профиле»), rate 429, capacity 503,
 * io 500 (гейты и валидации — в этом порядке).
 *
 * Манифест — канон в sprites.js: подсчёт лимита и вставка — в ОДНОЙ
 * критической секции mutateSprites(ops) (общая очередь с админскими
 * мутациями), сюда мутации приходят только через ops-коммиты. Валидаторы,
 * парсер и общий порядок коммитов переиспользуются импортом из sprites.js.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  DATA_DIR,
  MAX_SPRITES_PER_ACCOUNT,
  originAllowedHere,
  csrfDecision,
  siteClassOfRequest,
} from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, setCors } from "./runtime-config.js";
import { spriteWearers } from "./accounts.js";
import {
  readBody,
  parseMultipart,
  validName,
  PNG_MAGIC,
  srcOf,
  mutateSprites,
  allSpriteRows,
} from "./sprites.js";

/** Категория личных окрасов: свободный ввод категории игроку не открыт. */
const MINE_CATEGORY = "Мои окрасы";
/** Потолок тела загрузки: 1 МБ (админский MAX_UPLOAD 3 МБ не трогаем).
 *  Проверяется при чтении тела, не по Content-Length. */
const MAX_MINE_UPLOAD = 1024 * 1024;
/** IHDR-габариты: экспорт редактора 300×200 укладывается с запасом; миниатюры
 *  и гиганты рвут и карусель, и ватлист-рендер движка. */
const DIM_MIN = 100;
const DIM_MAX = 1000;
/** Максимум пикселей: 1000×700 уже перебор — холст не резиновый. */
const AREA_MAX = 600_000;
/** Минимальный вес файла: пустой цельнопрозрачный холст 300×200 жмётся в
 *  сотни байт — такой png к unittest-пустышкам и относим (IDAT не декодируем:
 *  силуэт-чек остаётся за редактором-источником, а не за сервером). */
const MIN_FILE_BYTES = 1536;
/** Rate на аккаунт: скользящие окна in-memory (сброс при рестарте — норма:
 *  это щит от зацикленного клиента, а не бухгалтерия). */
const RATE_PER_HOUR = 5;
const RATE_PER_DAY = 20;
/** Потолок НЕ-builtin строк каталога (анти-блоат на диск; при переполнении
 *  честный 503, без тихого отсеивания игроков по одному). */
const UPLOAD_CATALOG_CAPACITY = 2000;
/** Аудит заливок — append-only строка на каждую загрузку /sprites/mine. */
const AUDIT_FILE = path.join(DATA_DIR, "sprites", "sprites-audit.jsonl");

/** Тот же класс невидимых/bidi-символов, что в sanitize.js/profiles.js:
 *  имя окраса игрок вводит руками — чистим до валидатора sprites.js. */
const INVISIBLE_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Имя окраса: NFC → без невидимых/управляющих → общие правила sprites.js
 *  (trim, 2–24 кодпоинта). null = брак. */
function mineName(raw) {
  const cleaned = String(raw ?? "")
    .normalize("NFC")
    .replace(INVISIBLE_RE, "");
  return validName(cleaned);
}

/** Габариты из IHDR (big-endian w/h сразу после 8-байтовой подписи и длины
 *  чанка 'IHDR' на offset 12): буфер < 24 байт или не PNG-раскладка → null. */
function pngDimsOf(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) return null;
  // подпись — как в админ-флоу sprites.js: константа.compare(данные, 0, 8)
  // (аргументы с обеих сторон — интервал, иначе сравнится весь буфер).
  if (PNG_MAGIC.compare(data, 0, 8) !== 0) return null;
  if (data.toString("latin1", 12, 16) !== "IHDR") return null;
  return { w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
}

/** Скользящие окна загрузок на аккаунт (ts — момент УЧЁТА, т.е. только
 *  обработанные загрузки: осевшие в каталоге или честный дедуп-ответ). */
const rateBuckets = new Map();

function rateAllow(accountId) {
  const now = Date.now();
  const b = rateBuckets.get(accountId);
  if (!b) return true;
  const hour = b.filter((ts) => now - ts < 3_600_000).length;
  const day = b.filter((ts) => now - ts < 86_400_000).length;
  return hour < RATE_PER_HOUR && day < RATE_PER_DAY;
}

function rateRecord(accountId) {
  const now = Date.now();
  let b = rateBuckets.get(accountId);
  if (!b) {
    b = [];
    rateBuckets.set(accountId, b);
  }
  b.push(now);
}

/** DTO строки в ответах /sprites/mine (ownerAccountId наружу не отдаётся). */
function spriteOf(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    src: srcOf(row),
    w: row.w,
    h: row.h,
    bytes: row.bytes,
  };
}

/** Аудит заливки: append-only jsonl рядом с манифестом; сбой записи не рушит
 *  загрузку (окрас уже в каталоге) — громкий warning в лог. */
function auditUpload(accountId, row) {
  try {
    fs.appendFileSync(
      AUDIT_FILE,
      `${JSON.stringify({ ts: Date.now(), accountId, id: row.id, name: row.name, bytes: row.bytes })}\n`,
    );
  } catch (e) {
    console.warn("sprites audit append failed:", e?.message || e);
  }
}

function isMinePath(p) {
  return p === "/sprites/mine" || p.startsWith("/sprites/mine/");
}

/** Маршруты личной зоны: true — наш (ответ отписан), false — чужой. */
export async function handleMineSpritesHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  if (!isMinePath(p)) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // Сессия — единственный источник владельца (стек /profiles/me).
  const session = sessionFromRequest(req);
  if (!session) {
    json(res, 401, { ok: false, reason: "auth_required", message: "Личные окрасы доступны после входа в аккаунт." });
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
      json(res, csrfBad.status, { ok: false, reason: csrfBad.reason, message: "Запрос отклонён — обновите страницу и попробуйте снова." });
      return true;
    }
  }

  const accountId = String(session.account?.id || "");

  /* ---------------- список своих (GET /sprites/mine) ---------------- */
  if (req.method === "GET" && p === "/sprites/mine") {
    const rows = allSpriteRows();
    const items = rows
      .filter((r) => r.ownerAccountId === accountId)
      .map((r) => ({
        ...spriteOf(r),
        addedAt: Number(r.addedAt) || 0,
        hidden: r.hidden === true,
      }));
    json(res, 200, { ok: true, limit: MAX_SPRITES_PER_ACCOUNT, count: items.length, items });
    return true;
  }

  /* ---------------- загрузка (POST /sprites/mine) ---------------- */
  if (req.method === "POST" && p === "/sprites/mine") {
    if (!rateAllow(accountId)) {
      json(res, 429, { ok: false, reason: "rate", message: "Слишком много загрузок подряд — немного подождите и попробуйте снова." });
      return true;
    }
    const contentType = String(req.headers["content-type"] || "");
    if (!/^multipart\/form-data/i.test(contentType)) {
      json(res, 400, { ok: false, reason: "bad_content_type", message: "Ожидается multipart/form-data." });
      return true;
    }
    let buf;
    try {
      buf = await readBody(req, MAX_MINE_UPLOAD);
    } catch (e) {
      if (e && e.code === "too_large") {
        json(res, 413, { ok: false, reason: "too_large", message: "Файл больше 1 МБ не принимается — уменьшите PNG." });
        return true;
      }
      json(res, 400, { ok: false, reason: "invalid", message: "Тело запроса не читается." });
      return true;
    }
    const form = parseMultipart(buf, contentType);
    if (!form) {
      json(res, 400, { ok: false, reason: "no_file", message: "Форма загрузки не читается — файл не найден." });
      return true;
    }
    // Имя — из поля формы; category/id/owner из запроса ИГНОРИРУЮТСЯ.
    const name = mineName(form.fields.name);
    if (!name) {
      json(res, 400, { ok: false, reason: "bad_name", message: "Имя окраса: 2–24 символа." });
      return true;
    }
    if (!form.file || !form.file.data || !form.file.data.length) {
      json(res, 400, { ok: false, reason: "no_file", message: "Файл PNG не приложен." });
      return true;
    }
    const png = form.file.data;
    if (PNG_MAGIC.compare(png, 0, 8) !== 0) {
      json(res, 400, { ok: false, reason: "bad_magic", message: "Файл не похож на PNG — нужен PNG-рисунок из редактора окрасов." });
      return true;
    }
    const dims = pngDimsOf(png);
    if (
      !dims ||
      dims.w < DIM_MIN || dims.w > DIM_MAX ||
      dims.h < DIM_MIN || dims.h > DIM_MAX ||
      dims.w * dims.h > AREA_MAX ||
      png.length < MIN_FILE_BYTES
    ) {
      json(res, 400, {
        ok: false,
        reason: "bad_dims",
        message: `Картинка не подходит: сторона 100–1000 px, до 600 000 px всего, файл от 1,5 КБ (экспорт редактора окрасов — 300×200).`,
      });
      return true;
    }

    // Критическая секция: дедуп → capacity → лимит → slug+вставка — один
    // синхронный блок в общей очереди манифеста (контракт #83: подсчёт и
    // вставка не разлучаются).
    const verdict = await mutateSprites((ops) => {
      const sha = createHash("sha256").update(png).digest("hex");
      // Дедуп даблклика: то же тело от того же аккаунта → существующий окрас,
      // новый слот НЕ тратится (гонки мутаций нет — мы внутри очереди).
      const twin = ops.rows.find((r) => r.ownerAccountId === accountId && r.sha256 === sha);
      if (twin) return { dedup: true, row: twin };
      const uploadedCount = ops.rows.filter((r) => !r.builtin).length;
      if (uploadedCount >= UPLOAD_CATALOG_CAPACITY) {
        return { fail: { code: 503, reason: "capacity", message: "Каталог окрасов переполнен — попробуйте позже." } };
      }
      const mineCount = ops.rows.filter((r) => r.ownerAccountId === accountId).length;
      if (mineCount >= MAX_SPRITES_PER_ACCOUNT) {
        return { fail: { code: 409, reason: "limit", message: `У вас уже ${MAX_SPRITES_PER_ACCOUNT} окраса — удалите один в профиле.` } };
      }
      const row = {
        id: ops.freeSlugFor(name),
        name,
        category: MINE_CATEGORY,
        builtin: false,
        addedAt: Date.now(),
        ownerAccountId: accountId,
        sha256: sha,
        w: dims.w,
        h: dims.h,
        bytes: png.length,
      };
      const commit = ops.commitAppend(row, png);
      if (commit.io) {
        return { fail: { code: 500, reason: "io", message: "Не удалось сохранить файл окраса." }, error: commit.error };
      }
      return { row: commit.row };
    });

    if (verdict.fail) {
      if (verdict.error) console.warn("mine sprite upload failed:", verdict.error?.message || verdict.error);
      json(res, verdict.fail.code, { ok: false, reason: verdict.fail.reason, message: verdict.fail.message });
      return true;
    }
    rateRecord(accountId);
    if (verdict.dedup) {
      json(res, 200, { ok: true, dedup: true, sprite: spriteOf(verdict.row) });
      return true;
    }
    auditUpload(accountId, verdict.row);
    json(res, 201, { ok: true, sprite: spriteOf(verdict.row) });
    return true;
  }

  /* ---------------- удаление (DELETE /sprites/mine/:id) ---------------- */
  const delMatch = /^\/sprites\/mine\/([a-z0-9-]{1,64})$/.exec(p);
  if (req.method === "DELETE" && delMatch) {
    const id = delMatch[1];
    const isAdmin = session.account?.role === "admin";
    const verdict = await mutateSprites((ops) => {
      const row = ops.rowById(id);
      // builtin и админ-заливки (ownerAccountId null) — вне личной зоны.
      if (!row || row.builtin || !row.ownerAccountId) {
        return { code: 404, reason: "unknown_sprite", message: "Такого личного окраса нет." };
      }
      if (row.ownerAccountId !== accountId && !isAdmin) {
        return { code: 403, reason: "forbidden", message: "Это окрас другого игрока." };
      }
      const wornBy = spriteWearers(row.id);
      if (wornBy.length) {
        return { code: 409, reason: "worn", message: "Этот окрас сейчас надет — сначала переоденьте кота.", wornBy };
      }
      const commit = ops.commitRemove(row);
      if (commit.io) {
        return { code: 500, reason: "io", message: "Не удалось удалить файл окраса.", error: commit.error };
      }
      return { code: 200, id: row.id };
    });
    if (verdict.code === 200) {
      json(res, 200, { ok: true, id: verdict.id });
      return true;
    }
    if (verdict.error) console.warn("mine sprite delete failed:", verdict.error?.message || verdict.error);
    json(res, verdict.code, verdict.wornBy
      ? { ok: false, reason: verdict.reason, message: verdict.message, wornBy: verdict.wornBy }
      : { ok: false, reason: verdict.reason, message: verdict.message });
    return true;
  }

  res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, reason: "method_not_allowed" }));
  return true;
}
