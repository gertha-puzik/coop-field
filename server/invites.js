/**
 * Одноразовые инвайт-коды регистрации (закрытый сайт Wanderpaws/Elyria):
 * регистрация аккаунта — только по приглашению администрации. Домен живёт
 * здесь ЦЕЛИКОМ: журнал-хранилище DATA_DIR/invites.json, генерация и TTL,
 * policy-переключатель enforcement и admin-роуты /admin/invites*.
 *
 * Хранилище — журнал выдачи/активации: записи НИКОГДА не удаляются, админ
 * видит и потраченные, и отозванные, и просроченные коды. Форма записи:
 *   code («XXXX-XXXX», канонический вид), createdAt/expiresAt (epoch ms),
 *   note (комментарий админа | null), claimedById/claimedByLogin/claimedAt
 *   (кем и когда активирован | null), revokedAt (ms отзыва | null).
 * Плейтекст-хранение кодов осознанное: DATA_DIR и так crown-jewels уровня
 * accounts.json (там пароль-хэши и сессии), отдельный шифр ничего не добавляет.
 * Запись атомарная (writeFileAtomic: tmp + rename) — как accounts.json.
 *
 * Формат кода: 8 символов алфавита без визуально-похожих знаков (исключены
 * 0, 1, O, I, L, U) + дефис после 4-го символа. Генерация только randomBytes
 * (node:crypto), никаких Math.random. Нормализация ввода терпит человеческий
 * набор: trim, uppercase, выкидывает пробелы/дефисы/точки — сравнение
 * «пользовательский ввод vs CANONICALIZED-сторог» идёт по нормализованным
 * строкам, поэтому «test-test» и « TEST-TEST » — один и тот же код.
 *
 * policy enforcement (env AUTH_INVITE_ENFORCE, зеркало register v2 /
 * REGISTER_CLASS_LIMITS в server/auth.js):
 *   '1'  → инвайт требуется на ЛЮБОМ классе инстанса;
 *   '0'  → не требуется нигде;
 *   пусто → по классу инстанса (instanceEnvClass из server/config.js):
 *          production → требуется, preview/local/test → нет.
 * Так смоук-регистрации QA на превью и тест-стендах не ломаются, и
 * курица-яйцо bootstrap-админов избегается: первый админ регистрируется
 * до включения требования (роль назначает scripts/make-admin.mjs).
 *
 * HTTP-стык — handleInvitesHttp, паттерн 1-в-1 server/admin-ops.js:
 * host-гейт (net.js) прячет /admin ЦЕЛИКОМ на public-классе, сессия
 * 401/403 проверяется здесь, CSRF держит общий apiZone-щит net.js.
 * Роуты:
 *   POST /admin/invites/generate — {count? 1..10, note? ≤80 симв} → новые записи;
 *   GET  /admin/invites        — весь журнал, каждая запись + вычисляемое
 *                                status: 'active' | 'used' | 'expired' | 'revoked';
 *   POST /admin/invites/revoke  — {code} отказ кода (использованный отозвать нельзя).
 *
 * Цикл импортов auth.js ↔ invites.js осознанный (как accounts.js ↔ sprites.js):
 * auth.js нужен гейт регистрации (invitesEnforced/checkInviteCode/claimInvite),
 * сюда нужен sessionFromRequest для adminGate. Top-level инициализации не
 * пересекаются (здесь стор грузится до auth-функций, их вызовы — только в
 * телах функций), ESM live-биндинги держат порядок.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR, instanceEnvClass } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, readJson, setCors } from "./runtime-config.js";
import { writeFileAtomic } from "./atomic-file.js";

const INVITES_FILE = path.join(DATA_DIR, "invites.json");
/** TTL кода по умолчанию: 24 часа. Env AUTH_INVITE_TTL_MS переопределяет
 *  (короткие коды для тестов и подстройка стенда владельцем). */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
/** 8-символьный алфавит без визуально-похожих знаков: исключены 0, 1, O, I,
 *  L, U. Дефис в storage не входит — вставляется при выводе (канон XXXX-XXXX). */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const NOTE_MAX = 80;
const ROUTES = {
  LIST: "/admin/invites",
  GENERATE: "/admin/invites/generate",
  REVOKE: "/admin/invites/revoke",
};

let store = loadStore();

/* ---------- хранилище-журнал ---------- */

function emptyStore() {
  return { v: 1, invites: [] };
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(INVITES_FILE, "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.invites)) {
      return { v: 1, invites: raw.invites.filter(Boolean) };
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("invites file read failed:", e?.message || e);
  }
  return emptyStore();
}

/** Атомарный слив журнала (tmp + rename, тот же helper, что accounts.json). */
function flushInvites() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(INVITES_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.warn("invites save failed:", e?.message || e);
  }
}

/* ---------- коды: нормализация и генерация ---------- */

/** Ввод человека → сравнительная форма: trim, uppercase, выкинуть пробелы,
 *  дефисы и точки. « test-tesT » → «TESTTEST» — каноничное сравнение. */
function normalizeCode(raw) {
  return String(raw ?? "").trim().toUpperCase().replace(/[\s.-]/g, "");
}

/** Канонический вид для вывода/хранения: дефис после 4-го символа. */
function canonicalCode(norm) {
  return `${norm.slice(0, 4)}-${norm.slice(4)}`;
}

function isValidNormalized(norm) {
  return new RegExp(`^[${CODE_ALPHABET}]{8}$`).test(norm);
}

/** Новый код: только randomBytes (node:crypto). Поиск по алфавиту через
 *  % length даёт ничтожный modulo- bias (алфавит 30, байт 256) — для
 *  одноразовых 8-символьных кодов это заведомо вне угроз; уникальность
 *  против живого журнала проверяется перегенерацией (коллизии ~30^8). */
function newCode() {
  const buf = randomBytes(8);
  let norm = "";
  for (let i = 0; i < 8; i += 1) norm += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return norm;
}

/** Уникальный в рамках журнала код (перегенерация при редчайшей коллизии). */
function nonCollisionCode() {
  const taken = new Set(store.invites.map((r) => normalizeCode(r.code)));
  for (let i = 0; i < 8; i += 1) {
    const norm = newCode();
    if (!taken.has(norm)) return norm;
  }
  // Практически недостижимо (8 полных коллизий подряд); честный бросок,
  //  выданный как есть — лучше редкий дубликат-запись, чем зависание.
  return newCode();
}

/** Создать count записей (генерация админа). Возвращает новые записи. */
function generateInvites(count, note) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const norm = nonCollisionCode();
    const rec = {
      code: canonicalCode(norm),
      createdAt: Date.now(),
      expiresAt: Date.now() + inviteTtlMs(),
      note,
      claimedById: null,
      claimedByLogin: null,
      claimedAt: null,
      revokedAt: null,
    };
    store.invites.push(rec);
    out.push(rec);
  }
  flushInvites();
  return out;
}

/** TTL кода: env AUTH_INVITE_TTL_MS (число > 0) > дефолт 24 часа.
 *  Читается на вызов — тесты перезаписывают env, как в registerLimits. */
function inviteTtlMs() {
  const n = Number(process.env.AUTH_INVITE_TTL_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MS;
}

/* ---------- enforcement-гейт для auth.js ---------- */

/**
 * Требуется ли инвайт при регистрации: env AUTH_INVITE_ENFORCE='1' — на
 * любом классе; '0' — нигде; пусто/мусор — по классу инстанса (production
 * → требуется). Mirror register v2: смоуки и локальная разработка живут.
 */
function invitesEnforced() {
  const v = String(process.env.AUTH_INVITE_ENFORCE ?? "").trim();
  if (v === "1") return true;
  if (v === "0") return false;
  return instanceEnvClass() === "production";
}

/**
 * Валидация кода для регистрации: { error: "invite" } — пустой/мусорный/
 * неизвестный/просроченный/использованный/отозванный; иначе { invite } —
 * живая запись стора. Вызывается ДО createAccount: занятый логин ('taken')
 * не сжигает валидный код — захват (claimInvite) идёт только после успеха.
 */
function checkInviteCode(raw) {
  const norm = normalizeCode(raw);
  if (!isValidNormalized(norm)) return { error: "invite" };
  const rec = store.invites.find((r) => normalizeCode(r?.code) === norm) || null;
  if (!rec) return { error: "invite" };
  if (Number(rec.claimedAt)) return { error: "invite" };
  if (Number(rec.revokedAt)) return { error: "invite" };
  if (Date.now() > Number(rec.expiresAt)) return { error: "invite" };
  return { invite: rec };
}

/**
 * Захват кода новым аккаунтом — ТОЛЬКО после успешного createAccount:
 * claimedById/claimedByLogin/claimedAt + persist. Повторный захват
 * (гонка параллельных регистраций одного кода) отвергается здесь же:
 * первый вошедший забирает код, второй получает false — его регистрация
 * уже случилась, но журнал остаётся честным (владелица видит единственного
 * активатора и warning в логе).
 */
function claimInvite(rec, account) {
  if (!rec || Number(rec.claimedAt) || Number(rec.revokedAt)) {
    console.warn("invite claim потерян (уже занят или отозван):", rec?.code || "?");
    return false;
  }
  rec.claimedById = String(account?.id || "");
  rec.claimedByLogin = String(account?.login || "");
  rec.claimedAt = Date.now();
  flushInvites();
  return true;
}

/* ---------- admin-роуты (паттерн server/admin-ops.js) ---------- */

/** Сессия → админ: null = нет сессии (401), false = не админ (403). */
function adminGate(req, res) {
  const session = sessionFromRequest(req);
  if (!session) {
    json(res, 401, { ok: false, reason: "auth_required", message: "Нужен вход в аккаунт администратора." });
    return null;
  }
  if (session.account?.role !== "admin") {
    json(res, 403, { ok: false, reason: "forbidden", message: "Раздел открыт только администраторам." });
    return null;
  }
  return session;
}

/** Вычисляемое на чтении status журнала: active | used | expired | revoked.
 *  Приоритет: активация сильнее отзыва (использованный код не отзывается).
 */
function inviteStatus(rec) {
  if (Number(rec?.claimedAt)) return "used";
  if (Number(rec?.revokedAt)) return "revoked";
  if (Date.now() > Number(rec?.expiresAt)) return "expired";
  return "active";
}

/** Запись наружу: копия + status (админ-маршрут, все поля видны админу). */
function publicInvite(rec) {
  return { ...rec, status: inviteStatus(rec) };
}

/** Тело JSON-роута или 400 (тот же человеко-русский отказ, что в admin-ops). */
async function readJsonBody(req, res) {
  try {
    return await readJson(req);
  } catch {
    json(res, 400, { ok: false, reason: "json", message: "Тело запроса не читается как JSON." });
    return null;
  }
}

/**
 * Разбор маршрута: true — запрос наш (ответ отписан), false — чужой (пусть
 * дальше в цепи net.js). Непредусмотренные ветки — 404 not_found, как в
 * admin-ops.js. Все три роута — под host-гейтом и apiZone-щитом net.js.
 */
async function handleInvitesHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  if (p !== ROUTES.LIST && p !== ROUTES.GENERATE && p !== ROUTES.REVOKE) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  const session = adminGate(req, res);
  if (!session) return true;
  if (p === ROUTES.GENERATE && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const extra = Object.keys(body).filter((k) => k !== "count" && k !== "note");
    if (extra.length) {
      json(res, 400, { ok: false, reason: "unexpected_fields", unexpected: extra, expected: ["count", "note"] });
      return true;
    }
    const rawCount = body.count === undefined ? 1 : body.count;
    if (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 10) {
      json(res, 400, { ok: false, reason: "invalid", message: "count — целое число от 1 до 10 (по умолчанию 1)." });
      return true;
    }
    let note = null;
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== "string") {
        json(res, 400, { ok: false, reason: "invalid", message: "note — строка до 80 символов либо пусто." });
        return true;
      }
      // Комментарий админа: trim, невидимые символы не копим,ужимаем до
      // 80 код-поинтов — длина мягко ограничена, а не отвергается.
      note = Array.from(body.note.trim().replace(/[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")).slice(0, NOTE_MAX).join("") || null;
      // Чрезмерный комментарий остаётся виден админу в ответе (усечение
      // честно сожмётся до NOTE_MAX), пустая строка -> null (без комментария).
    }
    const made = generateInvites(rawCount, note);
    console.log(
      `invites generate: by=${session.account?.login || "?"} count=${made.length}` +
        (note ? ` note="${note}"` : ""),
    );
    json(res, 200, { ok: true, invites: made.map(publicInvite) });
    return true;
  }
  if (p === ROUTES.LIST && req.method === "GET") {
    json(res, 200, { ok: true, invites: store.invites.map(publicInvite) });
    return true;
  }
  if (p === ROUTES.REVOKE && req.method === "POST") {
    const body = await readJsonBody(req, res);
    if (!body) return true;
    const extra = Object.keys(body).filter((k) => k !== "code");
    if (extra.length) {
      json(res, 400, { ok: false, reason: "unexpected_fields", unexpected: extra, expected: ["code"] });
      return true;
    }
    const norm = normalizeCode(body.code);
    if (!isValidNormalized(norm)) {
      json(res, 400, { ok: false, reason: "invalid", message: "Нужен корректный код приглашения (поле code)." });
      return true;
    }
    const rec = store.invites.find((r) => normalizeCode(r?.code) === norm) || null;
    if (!rec) {
      json(res, 400, { ok: false, reason: "no_such_invite", message: "Такой код не выдавался." });
      return true;
    }
    if (Number(rec.claimedAt)) {
      json(res, 400, { ok: false, reason: "used", message: "Код уже активирован — отозвать использованный нельзя." });
      return true;
    }
    if (Number(rec.revokedAt)) {
      json(res, 400, { ok: false, reason: "revoked", message: "Код уже отозван." });
      return true;
    }
    rec.revokedAt = Date.now();
    flushInvites();
    console.log(`invites revoke: by=${session.account?.login || "?"} code=${rec.code}`);
    json(res, 200, { ok: true, invite: publicInvite(rec) });
    return true;
  }
  json(res, 404, { ok: false, reason: "not_found" });
  return true;
}

export { handleInvitesHttp, invitesEnforced, checkInviteCode, claimInvite };
