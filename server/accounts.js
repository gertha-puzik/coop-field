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
// Динамический каталог спрайтов (менеджер спрайтов): attachSprite принимает
// id из манифеста sprites.js — и загруженные, и базовые. Цикл импортов
// accounts.js ↔ sprites.js здесь осознанный: spriteIdAllowed вызывается
// ТОЛЬКО внутри тел функций (top-level инициализации не пересекаются),
// ESM live-биндинги держат порядок; spriteWearers в sprites.js — обратное
// ребро того же ограничения.
import { spriteIdAllowed } from "./sprites.js";

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
 * аккаунтов. Env MAX_ACCOUNTS (дефолт 500 — решение владелицы 2026-11-08);
 * 0/мусор → дефолт. При достижении createAccount отвечает ошибкой 'full' —
 * вместе с per-IP register-лимитом (server/auth.js) это закрывает и
 * «медленный» флуд с роты адресов.
 */
function maxAccounts() {
  const n = Number(process.env.MAX_ACCOUNTS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 500;
}

/**
 * BOOTSTRAP_ADMIN — МИГРАЦИОННЫЙ список имён (аудит Z.AI S1, 2026-11-08):
 * имена через запятую, каждое приводим к нижнему регистру и обрезаем пробелы.
 * Значение задаёт владелица (systemd-юнит / env тестов), дефолт — пустой.
 *
 * Механика БОЛЬШЕ НЕ назначает роль автоматически: прежний «кто первый занял
 * имя из списка — тот админ» был гонкой (имя мог занять любой игрок раньше
 * владелицы). Теперь env читается только как подсказка: регистрация имени из
 * списка логируется warning'ом, а роль назначает ОДНОРАЗОВЫЙ CLI владелицы
 * `node scripts/make-admin.mjs <login> [pass]` (создаёт аккаунт с ролью admin
 * или повышает существующий, сохраняя его пароль-хеш). Существующие админы из
 * старого механизма при старте НЕ трогаются (migrateStore сохраняет role).
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

/** Снятый с поставки скин не оставляет битую картинку в сессии и профиле. */
function visibleSprite(sprite) {
  return !sprite || spriteIdAllowed(sprite) ? sprite : SPRITES[0];
}

function publicAccount(acc) {
  if (!acc) return null;
  const ch = activeCharacter(acc);
  return {
    accountId: acc.id,
    login: acc.login,
    role: acc.role,
    profile: { displayName: acc.profile?.displayName || acc.login },
    characters: acc.characters.map((c) => ({ id: c.id, name: c.name, sprite: visibleSprite(c.sprite), size: c.size })),
    activeCharacterId: acc.activeCharacterId,
    character: ch ? { id: ch.id, name: ch.name, sprite: visibleSprite(ch.sprite), size: ch.size } : null,
  };
}

/**
 * Публичный DTO профиля (P1 HTTP /profiles/* → P4 каталог/правка): как игрок
 * виден другим игрокам. Единый источник DTO: БЕЗ login, без role и без парольных
 * полей. P4-слоты: bio (строка, пустая по умолчанию) и avatarCharacterId
 * (id персонажа-аватара ИЗ СВОЕГО списка characters либо null; сторонний id
 * сюда не попадает — экспонируем только если он есть в characters аккаунта).
 * Волна «день рождения + аватарка»: birthday — строка «ГГГГ-ММ-ДД» либо null
 * (мусор и отсутствие честно схлопываются в null — полную валидность значения
 * гарантирует profiles.js на PATCH, DTO лишь не выдаёт мусор); avatar —
 * строка-URL «/avatars/file/<accountId>.<png|jpg>?v=<avatarAt>» либо null
 * (строго из пары profile.avatarExt ∈ {png,jpg} и avatarAt > 0 — мусор в
 * полях не изворачивается в ссылку, файловый маршрут — server/avatars.js).
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
    birthday: birthdayOf(acc),
    avatarCharacterId: avatar,
    avatar: avatarUrlOf(acc),
    characters: chars.map((c) => ({
      id: c.id,
      name: c.name,
      sprite: visibleSprite(c.sprite),
      size: c.size,
    })),
    activeCharacterId: acc.activeCharacterId,
    createdAt: Number(acc.createdAt) || 0,
  };
}

/** День рождения профиля: строка «ГГГГ-ММ-ДД» проходит маску формата →
 *  отдаём как есть; мусор/отсутствие → null (честный DTO, как у bio-соседей:
 *  реальность даты проверяет profiles.js на входе, повторно не парсим). */
function birthdayOf(acc) {
  const b = acc?.profile?.birthday;
  return typeof b === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b) ? b : null;
}

/** URL аватарки из PROFILE-полей: avatarExt строго 'png' | 'jpg' и avatarAt —
 *  число > 0 (unix-ms, оно же кэш-бастер «?v=» при каждой замене); иное
 *  (в т.ч. мусор или ноль) → null. Ид файла — id аккаунта: маршрут
 *  /avatars/file/<id>.<ext> никогда не строится из клиентских строк. */
function avatarUrlOf(acc) {
  const p = acc?.profile;
  const ext = p?.avatarExt;
  const at = p?.avatarAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
  if (ext !== "png" && ext !== "jpg") return null;
  return `/avatars/file/${acc.id}.${ext}?v=${at}`;
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

/**
 * Логин при СОЗДАНИИ аккаунта (register v2, мандат владелицы 2026-11-08:
 * «отдельно логин с какими-то ограничениями»): латиница/цифры и ._-, 2–24
 * символа, первый и последний — буква/цифра (края из ./-/ _ запрещены),
 * без пробелов. ТОЛЬКО на пути регистрации: loginAccount не трогаем — вход
 * старых аккаунтов с пробелами/кириллицей («myster syr») обязан работать.
 */
function validateNewLogin(raw) {
  const login = String(raw ?? "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,22}[a-zA-Z0-9]$/.test(login)) return { error: "badlogin" };
  return { login };
}

/**
 * Имя на игровом поле (register v2): любые видимые символы — кириллица и
 * пробелы легальны («Дым Лунный»). Те же примитивы, что у логина (sanitizeLogin:
 * вырез invisible-символов, одинарные пробелы, trim), 2–24 код-поинта.
 * НЕ уникально — однофамильцы допустимы: уникален только логин. Отсутствует/
 * пустая строка → 'no name' (звать логином, полная совместимость со старым
 * клиентом); задан, но мусор (короткое/длинное/пробельно-пустое) → badname.
 */
function validateDisplayName(raw) {
  if (raw === undefined || raw === null || String(raw) === "") return { noName: true };
  const text = String(raw);
  if (Array.from(text).length > LOGIN_MAX) return { error: "badname" };
  const name = sanitizeLogin(text, "");
  if (Array.from(name).length < 2) return { error: "badname" };
  return { name };
}

function validatePassword(raw) {
  const pass = String(raw ?? "");
  if (Array.from(pass).length < PASS_MIN) return { error: "weak" };
  return { pass };
}

async function createAccount(rawLogin, rawPass, rawName) {
  // Register v2: логин — только строгий формат (латиница/цифры/._-),
  // видимое имя — отдельно и опционально (нет → логин, как раньше).
  const L = validateNewLogin(rawLogin);
  if (L.error) return { error: L.error };
  const P = validatePassword(rawPass);
  if (P.error) return { error: P.error };
  const N = validateDisplayName(rawName);
  if (N.error) return { error: N.error };
  const displayName = N.name || L.login;
  if (findByLogin(L.login)) return { error: "taken" };
  // Флуд-предохранитель: глобальный потолок аккаунтов сервера. Считаем ДО
  // создания (учётной записи может добавлять только этот же код — гонок нет).
  if (Object.keys(store.accounts).length >= maxAccounts()) {
    return { error: "full" };
  }
  const id = newId("a");
  // S1 (аудит Z.AI): автоназначение роли admin по BOOTSTRAP_ADMIN УБРАНО —
  // занявший bootstrap-имя игрок получает обычную роль, а владелица видит
  // в логе подсказку и назначает админа одноразовым CLI scripts/make-admin.mjs.
  if (bootstrapLogins().includes(L.login.toLowerCase())) {
    console.warn(
      `bootstrap имя «${L.login}» занято; назначьте роль через scripts/make-admin.mjs`,
    );
  }
  const acc = {
    id,
    login: L.login,
    pass: await hashPassword(P.pass),
    role: "registered",
    createdAt: Date.now(),
    profile: { displayName },
    characters: [newCharacter(displayName)],
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
  // Whitelist — ДИНАМИЧЕСКИЙ каталог (server/sprites.js, менеджер спрайтов):
  // персистим в аккаунт только легальный id — базовый или загруженный админом;
  // произвольная строка из join-payload в стор (и дальше в whoami/поле) не
  // попадает. Проверка по памяти (манифест грузится при старте) — await не нужен.
  const want = typeof sprite === "string" ? sprite.trim() : "";
  if (want && spriteIdAllowed(want)) ch.sprite = want;
  if (Number.isFinite(Number(size))) ch.size = Math.min(100, Math.max(60, Math.round(Number(size))));
  markDirty();
}

/**
 * Внешность из профиля (PATCH /profiles/me): канонический сеттер активного
 * персонажа ВНЕ room-join — спрайт, размер и имя. Спрайт — тот же whitelist
 * динамического каталога, что и attachSprite (невалидный id сюда не попадает:
 * пути profiles.js валидирует его раньше и отвечает 400). Размер — проценты
 * роста 60–100, зажим и округление как в room-join и newCharacter. Имя
 * персонажа синхронно с displayName профиля — «ник на поле» берётся из
 * профиля, а не из легаси-логина регистрации (newCharacter(login)).
 * Отсутствующий ключ не трогает поле (partial), как в остальном PATCH.
 * Обратная совместимость сериализации — normalizeCharacter при загрузке: он
 * дочинит недостающие поля дефолтами (name — clipChars(LOGIN_MAX), sprite→"",
 * size→100) и не сломается от новых значений.
 */
function applyProfileAppearance(acc, patch = {}) {
  const ch = activeCharacter(acc);
  if (!ch) return false;
  if (patch.sprite !== undefined) {
    const want = String(patch.sprite).trim();
    if (!spriteIdAllowed(want)) return false;
    ch.sprite = want;
  }
  if (patch.scale !== undefined) {
    if (!Number.isFinite(Number(patch.scale))) return false;
    ch.size = Math.min(100, Math.max(60, Math.round(Number(patch.scale))));
  }
  if (typeof patch.name === "string" && patch.name.trim()) {
    ch.name = clipChars(patch.name.trim(), LOGIN_MAX);
  }
  markDirty();
  return true;
}

/**
 * Кто носит спрайт (менеджер спрайтов, DELETE /admin/sprites/:id): полный проход
 * по стору аккаунтов — characters И activeCharacterId (одетым считаем любой
 * персонаж с c.sprite === id; активный одет всегда, неактивный — тоже занимает
 * id — смена аватара не должна освобождать занятый скин молча). Результат:
 * [{login: логин аккаунта, character: имя персонажа}] — админ-панель показывает
 * «кол-во + ники», DELETE отказывает с этим же списком.
 */
function spriteWearers(spriteId) {
  const id = String(spriteId || "");
  const out = [];
  if (!id) return out;
  for (const acc of Object.values(store.accounts)) {
    if (!acc || !Array.isArray(acc.characters)) continue;
    for (const ch of acc.characters) {
      if (ch && typeof ch.sprite === "string" && ch.sprite === id) {
        out.push({ login: acc.login, character: ch.name });
      }
    }
  }
  return out;
}

/**
 * S1 (аудит Z.AI): единственный путь повысить роль до admin — этот mutator,
 * который вызывает ТОЛЬКО scripts/make-admin.mjs (CLI владелицы, вне сервера).
 * Существующий аккаунт: role → "admin" с сохранением пароль-хеша и прочих полей;
 * уже админ → no-op c меткой already (idempotent); НИКОГДА не понижает роль и
 * ничего не создаёт — создание делает сам CLI через createAccount + этот же
 * вызов. Запись атомарная (markDirty → flushAccounts → writeFileAtomic).
 */
function promoteToAdmin(login) {
  const acc = findByLogin(login);
  if (!acc) return { error: "no_such_login" };
  if (acc.role === "admin") return { ok: true, already: true, account: acc };
  acc.role = "admin";
  markDirty();
  return { ok: true, account: acc };
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
  avatarUrlOf,
  activeCharacter,
  createAccount,
  promoteToAdmin,
  loginAccount,
  attachSprite,
  applyProfileAppearance,
  spriteWearers,
  verifyPassword,
  hashPassword,
  migrateStore,
};
