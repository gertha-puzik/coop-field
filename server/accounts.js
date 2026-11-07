/**
 * Account / profile / character JSON store in DATA_DIR/accounts.json.
 * Passwords never leave this module as plaintext. Writes are atomic (same
 * helper as the map file). v1 is the first on-disk shape; missing files
 * start empty — cat-book logins are NOT turned into accounts (no passwords).
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DATA_DIR, SPRITES } from "./config.js";

const INVISIBLE_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function clipChars(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("");
}

function sanitizeLogin(raw, fallback) {
  const text = clipChars(
    String(raw ?? "")
      .replace(INVISIBLE_RE, "")
      .replace(/\s+/g, " ")
      .trim(),
    LOGIN_MAX,
  );
  return text || fallback;
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const scryptAsync = promisify(scrypt);
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const PASS_MIN = 8;
const LOGIN_MAX = 24;

let store = loadStore();
let dirty = false;

function emptyStore() {
  return { v: 1, accounts: {} };
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    if (!raw || typeof raw !== "object" || typeof raw.accounts !== "object") return emptyStore();
    if (raw.v !== 1) return migrateStore(raw);
    return { v: 1, accounts: raw.accounts };
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("accounts file read failed:", e?.message || e);
    return emptyStore();
  }
}

/** Unknown versions collapse to v1 without dropping recognizable account rows. */
function migrateStore(raw) {
  const accounts = raw && typeof raw.accounts === "object" ? raw.accounts : {};
  const next = { v: 1, accounts: {} };
  for (const [id, row] of Object.entries(accounts)) {
    if (!row || typeof row !== "object" || !row.login || !row.pass) continue;
    next.accounts[id] = normalizeAccount(row, id);
  }
  dirty = true;
  return next;
}

function normalizeAccount(row, id) {
  const login = String(row.login);
  const characters = Array.isArray(row.characters) && row.characters.length
    ? row.characters.map(normalizeCharacter).filter(Boolean)
    : [newCharacter(login, row.sprite, row.size)];
  const active = characters.some((c) => c.id === row.activeCharacterId)
    ? row.activeCharacterId
    : characters[0].id;
  return {
    id: String(row.id || id),
    login,
    pass: row.pass,
    role: row.role === "admin" ? "admin" : "registered",
    createdAt: Number(row.createdAt) || Date.now(),
    profile: {
      displayName: String(row.profile?.displayName || login),
    },
    characters,
    activeCharacterId: active,
  };
}

function normalizeCharacter(row) {
  if (!row || typeof row !== "object") return null;
  const name = clipChars(String(row.name || "").trim(), LOGIN_MAX);
  if (!name) return null;
  return {
    id: String(row.id || newId("c")),
    name,
    sprite: typeof row.sprite === "string" ? row.sprite : "",
    size: Number.isFinite(Number(row.size)) ? Math.min(100, Math.max(60, Math.round(Number(row.size)))) : 100,
  };
}

function newId(prefix) {
  return prefix + randomBytes(8).toString("hex");
}

function newCharacter(name, sprite, size) {
  return {
    id: newId("c"),
    name,
    sprite: typeof sprite === "string" ? sprite : "",
    size: Number.isFinite(Number(size)) ? Math.min(100, Math.max(60, Math.round(Number(size)))) : 100,
  };
}

function flushAccounts(force = false) {
  if (!dirty && !force) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(ACCOUNTS_FILE, JSON.stringify(store, null, 2));
    dirty = false;
  } catch (e) {
    console.warn("accounts save failed:", e?.message || e);
  }
}

function markDirty() {
  dirty = true;
  flushAccounts();
}

function findByLogin(login) {
  const key = String(login || "").toLowerCase();
  if (!key) return null;
  for (const acc of Object.values(store.accounts)) {
    if (String(acc.login).toLowerCase() === key) return acc;
  }
  return null;
}

function findById(id) {
  return store.accounts[id] || null;
}

/**
 * Глобальный предохранитель от флуда регистрациями: потолок общего числа
 * аккаунтов. Env MAX_ACCOUNTS (дефолт 2000); 0/мусор → дефолт. При достижении
 * createAccount отвечает ошибкой 'full' — вместе с per-IP register-лимитом
 * (server/auth.js) это закрывает и «медленный» флуд с роты адресов.
 */
function maxAccounts() {
  const n = Number(process.env.MAX_ACCOUNTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2000;
}

/**
 * BOOTSTRAP_ADMIN — СПИСОК предустановленных админов: имена через запятую,
 * каждое приводим к нижнему регистру и обрезаем пробелы. Значение задаёт
 * владелица (systemd-юнит / env тестов), дефолт — пустой список (никто).
 *
 * Механика создания админа (прежняя защита от подделки, обобщённая на список):
 * админ — ТОТ, КТО ПЕРВЫМ ЗААНЯЛ имя из списка. Каждый элемент списка
 * НЕЗАВИСИМО становится admin при своей первой регистрации: наличие другого
 * админа НЕ мешает остальным именам списка (все они декларированы владелицей
 * и должны получить роль при регистрации). Имя уже занято кем-то другим → это
 * чужой аккаунт, роли admin он не получит (проверка 'taken' срабатывает раньше).
 */
function bootstrapLogins() {
  return String(process.env.BOOTSTRAP_ADMIN || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return {
    algo: "scrypt",
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    keylen: SCRYPT.keylen,
    salt: salt.toString("hex"),
    hash: Buffer.from(hash).toString("hex"),
  };
}

async function verifyPassword(password, rec) {
  if (!rec || rec.algo !== "scrypt" || typeof rec.hash !== "string" || typeof rec.salt !== "string") {
    return false;
  }
  const keylen = Number(rec.keylen) || SCRYPT.keylen;
  const hash = await scryptAsync(password, Buffer.from(rec.salt, "hex"), keylen, {
    N: Number(rec.N) || SCRYPT.N,
    r: Number(rec.r) || SCRYPT.r,
    p: Number(rec.p) || SCRYPT.p,
  });
  const a = Buffer.from(rec.hash, "hex");
  const b = Buffer.from(hash);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function publicAccount(acc) {
  if (!acc) return null;
  const ch = activeCharacter(acc);
  return {
    accountId: acc.id,
    login: acc.login,
    role: acc.role,
    profile: { displayName: acc.profile?.displayName || acc.login },
    characters: acc.characters.map((c) => ({ id: c.id, name: c.name, sprite: c.sprite, size: c.size })),
    activeCharacterId: acc.activeCharacterId,
    character: ch ? { id: ch.id, name: ch.name, sprite: ch.sprite, size: ch.size } : null,
  };
}

/**
 * Публичный DTO профиля (P1 HTTP /profiles/* → P4 каталог/правка): как игрок
 * виден другим игрокам. Единый источник DTO: БЕЗ login, без role и без парольных
 * полей. P4-слоты: bio (строка, пустая по умолчанию) и avatarCharacterId
 * (id персонажа-аватара ИЗ СВОЕГО списка characters либо null; сторонний id
 * сюда не попадает — экспонируем только если он есть в characters аккаунта).
 */
function publicProfile(acc) {
  if (!acc) return null;
  const chars = Array.isArray(acc.characters) ? acc.characters : [];
  const wanted = acc.profile?.avatarCharacterId;
  const avatar =
    typeof wanted === "string" && chars.some((c) => c && c.id === wanted) ? wanted : null;
  return {
    displayName: acc.profile?.displayName || acc.login,
    bio: typeof acc.profile?.bio === "string" ? acc.profile.bio : "",
    avatarCharacterId: avatar,
    characters: chars.map((c) => ({
      id: c.id,
      name: c.name,
      sprite: c.sprite,
      size: c.size,
    })),
    activeCharacterId: acc.activeCharacterId,
    createdAt: Number(acc.createdAt) || 0,
  };
}

function activeCharacter(acc) {
  if (!acc) return null;
  return acc.characters.find((c) => c.id === acc.activeCharacterId) || acc.characters[0] || null;
}

function validateLogin(raw) {
  const login = sanitizeLogin(raw, "");
  if (!login || login.length < 2) return { error: "short" };
  return { login };
}

function validatePassword(raw) {
  const pass = String(raw ?? "");
  if (Array.from(pass).length < PASS_MIN) return { error: "weak" };
  return { pass };
}

async function createAccount(rawLogin, rawPass) {
  const L = validateLogin(rawLogin);
  if (L.error) return { error: L.error };
  const P = validatePassword(rawPass);
  if (P.error) return { error: P.error };
  if (findByLogin(L.login)) return { error: "taken" };
  // Флуд-предохранитель: глобальный потолок аккаунтов сервера. Считаем ДО
  // создания (учётной записи может добавлять только этот же код — гонок нет).
  if (Object.keys(store.accounts).length >= maxAccounts()) {
    return { error: "full" };
  }
  const id = newId("a");
  // Bootstrap-список: логин совпал с одним из предустановленных имён → admin.
  const wantAdmin = bootstrapLogins().includes(L.login.toLowerCase());
  const acc = {
    id,
    login: L.login,
    pass: await hashPassword(P.pass),
    role: wantAdmin ? "admin" : "registered",
    createdAt: Date.now(),
    profile: { displayName: L.login },
    characters: [newCharacter(L.login)],
    activeCharacterId: null,
  };
  acc.activeCharacterId = acc.characters[0].id;
  store.accounts[id] = acc;
  markDirty();
  return { account: acc };
}

async function loginAccount(rawLogin, rawPass) {
  const L = validateLogin(rawLogin);
  if (L.error) return { error: "bad" };
  const P = validatePassword(rawPass);
  if (P.error) return { error: "bad" };
  const acc = findByLogin(L.login);
  if (!acc) {
    await hashPassword(P.pass);
    return { error: "bad" };
  }
  const ok = await verifyPassword(P.pass, acc.pass);
  if (!ok) return { error: "bad" };
  return { account: acc };
}

function attachSprite(acc, sprite, size) {
  const ch = activeCharacter(acc);
  if (!ch) return;
  // Тот же whitelist, что в pickSprite (server/room.js): персистим в аккаунт
  // только легальный id спрайта — чужой join-payload не может протащить произвольную
  // строку в сторе (и дальше в whoami/поле).
  const want = typeof sprite === "string" ? sprite.trim() : "";
  if (want && SPRITES.includes(want)) ch.sprite = want;
  if (Number.isFinite(Number(size))) ch.size = Math.min(100, Math.max(60, Math.round(Number(size))));
  markDirty();
}

export {
  ACCOUNTS_FILE,
  PASS_MIN,
  loadStore,
  flushAccounts,
  findByLogin,
  findById,
  publicAccount,
  publicProfile,
  activeCharacter,
  createAccount,
  loginAccount,
  attachSprite,
  verifyPassword,
  hashPassword,
  migrateStore,
};
