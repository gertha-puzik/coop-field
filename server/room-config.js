/**
 * Per-room config overrides (F2, спек владелицы §3) — слоеная модель поверх
 * замороженного глобального реестра B2 (server/cfg-registry.js, ключи/юниверсы/
 * sanitizeValues ре-используются, глобальные роуты не тронуты).
 *
 * Слои (детерминированно на СЕРВЕРЕ, resolveEffective):
 *   engine defaults (cfg-registry defaultsFor) ← global runtime (runtime-config
 *   publicConfig) ← [mode-level: v1-хук, данными не заполнен] ← per-room map.
 *
 * Хранилище: DATA_DIR/room-configs.json, { v: 1, rooms: { [id]: { [key]: value } } }.
 * Комната без overrides наследует глобальный слой (пустая карта = пустое
 * состояние; файл пишется лениво при первом admin-write, absence = OK).
 * Запись атомарная (tmp+rename, 0600), перед каждым успешным write — снимок
 * room-configs.backup.<ts>.json (вращение BACKUP_KEEP), порченый JSON на
 * загрузке уносится в room-configs.corrupt-<ts>.json + warn + пустое состояние,
 * данные админа не теряются. Явных миграций версии пока нет: файл без v, но с
 * rooms-объектом принимается как v1 (безопасная миграция на чтении).
 *
 * Whitelist per-room v1 (explicit overrides only — весь глобальный конфиг на
 * комнату НЕ дублируется):
 *   atmo.phaseMin, atmo.weatherMin — стартовые длины НОВОЙ комнаты (политика
 *     new-rooms-only досталась от глобального слоя: живущая комната не
 *     меняется, override вступает при (пере)создании объекта комнаты;
 *     живой краевой механизм atmoset — отдельная сущность, см. ключ ниже);
 *   atmo.allowPlayerAtmosphereControl — живой гейт кадров atmo/atmoset от
 *     ИГРОКОВ (§3.4): false → сервер молча отбрасывает их (формат ответа —
 *     прежний silent-drop невалидных кадров atmo.js); ПЕРСИСТЕНТНЫЕ конфиги
 *     atmoset-кадрами НЕ пишет никто (архитектурная изоляция слоёв); отсутствие
 *     override = true — существующий геймплей комнат не меняется без решения
 *     админа. Глобального слоя у ключа нет (scope: "room"); над ним —
 *     ГЛОБАЛЬНЫЙ master-ключ atmo.playerControl (мандат владелицы 2026-11-08,
 *     живёт в server/cfg-registry.js + runtime-слое): гейт =
 *     master && (override ?? true), см. isPlayerAtmoControlAllowed.
 *   universes.* — ключи реестра известные, но per-room НЕ поддержаны в v1:
 *     их потребители (server/combat.js клэмпы через combatCaps) не получают
 *     контекст комнаты и вне зон этой волны; запись → 400 unsupported_combo
 *     (v2 — после боевой интеграции).
 *
 * Валидация: room ID — только зарегистрированные (server/modes.js, нормализация
 * через RETIRED-алиас — точное зеркало normalizeRoomCode из room.js; path
 * traversal исключён сам собой: слэш/точки вырезаются нормализацией до
 * сравнения с каталогом), unknown_room → 400; unknown_key → 400; out-of-range /
 * не-bool → 400 invalid (числа пер-room строгие: диапазон отсекается, «доводим»
 * только глобальный POST /cfg по его замороженному контракту).
 *
 * HTTP (ВСЕ маршруты — admin-роль на сервере через гейт /cfg-домена, requireAdmin
 * из runtime-config.js: HttpOnly-сессия; host-гейт на public-классе прячет
 * /cfg/rooms* целиком — net.js; CSRF/Origin — общий щит net.js для /cfg-зоны):
 *   GET    /cfg/rooms                  — список комнат + override-счётчики;
 *   GET    /cfg/rooms/<id>             — effective + overrides + маркеры per-key;
 *   PUT    /cfg/rooms/<id>             — {values:{key:value}} ONLY (merge);
 *   DELETE /cfg/rooms/<id>/<key>       — reset одного override (→ наследует);
 *   DELETE /cfg/rooms/<id>/all         — reset всех overrides комнаты;
 *   GET    /cfg/rooms/<id>/history     — имена бэкапов + keep;
 *   POST   /cfg/rooms/<id>/restore     — восстановить overrides комнаты из
 *                                        бэкапа (только имя из листинга; снимок
 *                                        валидируется ЦЕЛИКОМдо записи).
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { REGISTRY } from "./cfg-registry.js";
import { MODE_ROOMS, RETIRED_ROOMS, modeOf } from "./modes.js";
import { publicConfig, requireAdmin, readJson, json, setCors, playerAtmoControl } from "./runtime-config.js";

const FILE = path.join(DATA_DIR, "room-configs.json");
const BACKUP_KEEP = 8;
// Штамп ISO завершается Z; суффикс -N различает бэкапы одной миллисекунды.
const BACKUP_RE = /^room-configs\.backup\.[0-9TZ:.-]+(-[0-9]+)?\.json$/;

/** Уникальное имя бэкапа (даже при двух write в одну миллисекунду). */
function backupName() {
  let name = `room-configs.backup.${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  let i = 0;
  while (fs.existsSync(path.join(DATA_DIR, name))) {
    name = `room-configs.backup.${new Date().toISOString().replace(/[:.]/g, "-")}-${++i}.json`;
  }
  return name;
}

/** Whitelist per-room v1 (см. докблок). Порядок = порядок ключей реестра. */
export const SUPPORTED_ROOM_KEYS = Object.freeze([
  "atmo.phaseMin",
  "atmo.weatherMin",
  "atmo.allowPlayerAtmosphereControl",
]);

/* ---------------- Канонизация room ID ---------------- */

/** Нормализация кода комнаты — ТОЧНОЕ зеркало normalizeRoomCode (server/room.js):
 *  латиница/цифры/дефис/подчёркивание, до 24 символов, нижний регистр.
 *  Дублирование сознательное: импорт из room.js создал бы цикл комнат →
 *  комнаты (room.js импортирует initialRoomAtmo отсюда). */
function normalizeRoomCode(code) {
  return (
    String(code || "demo")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 24) || "demo"
  );
}

/** Канонный id: нормализация → RETIRED-алиас → зарегистрированность.
 *  Path traversal умирает на normalizeRoomCode («../x» → «x» → «demo»), а
 *  незарегистрированные коды отсекаются сравнением с каталогом MODE_ROOMS. */
function canonicalRoomId(raw) {
  const key = RETIRED_ROOMS[normalizeRoomCode(raw)] || normalizeRoomCode(raw);
  const hit = modeOf(key);
  return hit ? hit.id : null;
}

function roomIds() {
  return MODE_ROOMS.map((r) => r.id);
}

/* ---------------- Строгая валидация значений ---------------- */

/** Значение per-room override: ЧИСЛО в пределах движкового диапазона (без
 *  «доводки» — пер-room конфиг админский, out-of-range честный отказ) или
 *  строгий bool. Границы/тип — из метаданных реестра (юниверсы B2). */
export function strictRoomValue(key, raw) {
  const def = REGISTRY[key];
  if (!def) return { error: "unknown_key" };
  if (def.kind === "bool") {
    return typeof raw === "boolean" ? { value: raw } : { error: "значение — строго true/false" };
  }
  if (def.kind === "range") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return { error: "не число" };
    const v = Math.round(n);
    const { min, max } = def.values;
    if (v < min || v > max) return { error: `вне диапазона ${min}..${max}` };
    return { value: v };
  }
  return { error: "неподдерживаемый тип per-room" };
}

/** Классификация ключа patch-тела: null = ок, иначе reason для 400. */
function classifyRoomKey(key) {
  if (!(key in REGISTRY)) return "unknown_key";
  if (!SUPPORTED_ROOM_KEYS.includes(key)) return "unsupported_combo";
  return null;
}

/* ---------------- Хранилище: load / save / backups ---------------- */

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

function emptyState() {
  return { v: 1, rooms: {} };
}

/** Слой engine defaults для per-room ключей (нижний слой resolver). */
function engineLayer() {
  const atmo = {};
  for (const key of SUPPORTED_ROOM_KEYS) {
    const [field] = key.split(".").slice(1);
    atmo[field] = REGISTRY[key].default;
  }
  return { atmo };
}

/** Одна зарезервированная комната из файла: канонизации id + строгая
 *  валидация каждого значения; мусор выбрасывается с warn (файл — данные,
 *  не доверенный ввод: пересборка возвращает только известное и валидное). */
function sanitizeRoomEntries(id, body, warn) {
  const canon = canonicalRoomId(id);
  if (!canon) {
    warn(`room-configs: комната «${id}» не в каталоге — override пропущен`);
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const out = {};
  for (const [key, raw] of Object.entries(body)) {
    if (classifyRoomKey(key)) {
      warn(`room-configs: ключ «${key}» (комната ${canon}) не поддержан — пропущен`);
      continue;
    }
    const res = strictRoomValue(key, raw);
    if (res.error) {
      warn(`room-configs: значение «${key}» комнаты ${canon} (${JSON.stringify(raw)}) — ${res.error}; пропущено`);
      continue;
    }
    out[key] = res.value;
  }
  return Object.keys(out).length ? out : null;
}

/** Чтение файла: ENOENT = пустое состояние; порченый JSON → переименовать в
 *  room-configs.corrupt-<ts>.json + пустые overrides + warn; без v, но с
 *  rooms-объектом — миграция v0→v1 на чтении (файл не переписываем). */
function loadOverrides() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") return emptyState();
    // Парс-fail: контент спасаем в side-car, состояние честно пустое.
    const name = `room-configs.corrupt-${stamp()}.json`;
    try {
      fs.renameSync(FILE, path.join(DATA_DIR, name));
      console.warn(`room-config: файл не распарсился как JSON — отложен как ${name}, overrides пусты`);
    } catch {
      console.warn("room-config: порченый файл не удалось отложить — overrides пусты");
    }
    return emptyState();
  }
  if (!raw || typeof raw !== "object" || !raw.rooms || typeof raw.rooms !== "object") {
    console.warn("room-config: схема файла не распознана — overrides пусты");
    return emptyState();
  }
  if (raw.v !== undefined && raw.v !== 1) {
    console.warn(`room-config: версия схемы v=${raw.v} новее — overrides пусты, файл оставлен`);
    return emptyState();
  }
  const rooms = {};
  for (const [id, body] of Object.entries(raw.rooms)) {
    const clean = sanitizeRoomEntries(id, body, console.warn);
    if (clean) rooms[canonicalRoomId(id)] = clean;
  }
  return { v: 1, rooms };
}

/** Текущие override-карты in-memory (роли не хранят: файл — единственный источник). */
let state = loadOverrides();

function listHistoryNames() {
  try {
    return fs
      .readdirSync(DATA_DIR)
      .filter((f) => BACKUP_RE.test(f))
      .sort()
      .reverse()
      .slice(0, BACKUP_KEEP);
  } catch {
    return [];
  }
}

/** Снимок текущего файла перед write (до атомарной записи) + вращение. */
function rotateBackup() {
  try {
    const snap = fs.readFileSync(FILE, "utf8");
    fs.writeFileSync(path.join(DATA_DIR, backupName()), snap, { mode: 0o600 });
  } catch {
    /* первый write — снимать нечего */
  }
  const stale = listHistoryNames();
  while (stale.length > BACKUP_KEEP - 1) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, stale.pop()));
    } catch {
      /* гонка с параллельным бэкапом — не страшно */
    }
  }
}

/** Атомарная запись (tmp+rename, 0600) — конвенция data-каталога. */
function saveState(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(FILE)) rotateBackup();
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  state = next;
}

/* ---------------- Resolver: слои на сервере ---------------- */

/** Глобальный слой (atmo) из публичного блока runtime-config; master-гейт
 *  atmoset — значение глобального ключа atmo.playerControl (мандат
 *  владелицы 2026-11-08; в старых файлах до 7-го ключа — true). */
function globalLayer() {
  return { atmo: { ...publicConfig().atmo } };
}

/** Слои движок ← глобал ← per-room по поддержанным ключам. Чистая.
 *  Гейт atmoset считается по master-модели: effective = глобальный &&
 *  (per-room override ?? true) — глобальное ВЫКЛ глушит всех, ВКЛ возвращает
 *  per-room ключу текущее поведение (семантика мандата владелицы 2026-11-08). */
export function resolveRoomAtmo(globalAtmo, roomOverrides = {}) {
  const eng = engineLayer().atmo;
  const master = globalAtmo.playerControl !== false;
  const out = {
    phaseMin: globalAtmo.phaseMin ?? eng.phaseMin,
    weatherMin: globalAtmo.weatherMin ?? eng.weatherMin,
    allowPlayerAtmosphereControl: master && (roomOverrides["atmo.allowPlayerAtmosphereControl"] !== false),
  };
  if (Number.isFinite(roomOverrides["atmo.phaseMin"])) out.phaseMin = roomOverrides["atmo.phaseMin"];
  if (Number.isFinite(roomOverrides["atmo.weatherMin"])) out.weatherMin = roomOverrides["atmo.weatherMin"];
  return out;
}

function overridesOf(id) {
  return state.rooms[id] || {};
}

/** Живой гейт atmoset/atmo-кадров игроков комнаты (§3.4). MASTER-МОДЕЛЬ
 *  (мандат владелицы 2026-11-08): сначала глобальный ключ atmo.playerControl
 *  (live-значение из runtime-слоя) — его ВЫКЛ глушит ВСЕ комнаты даже при
 *  per-room ВКЛ; поверх — per-room override (отсутствие = true). */
export function isPlayerAtmoControlAllowed(roomCode) {
  if (!playerAtmoControl()) return false;
  const id = canonicalRoomId(roomCode);
  if (!id) return true; // легаси-код вне каталога — настраивать нельзя, геймплей прежний
  return overridesOf(id)["atmo.allowPlayerAtmosphereControl"] !== false;
}

/** Стартовый якорь атмосферы НОВОЙ комнаты (зеркало atmoDefaults из
 *  server/atmo.js: cs = now − 1.5·pl → «день», погода sun, отсчёт сейчас).
 *  Переопределённые phaseMin/weatherMin, или null — тогда ленивая
 *  инициализация из глобального слоя остаётся как есть (мин-дифф поведения). */
export function initialRoomAtmo(roomCode, now = Date.now()) {
  const id = canonicalRoomId(roomCode);
  if (!id) return null;
  const ov = overridesOf(id);
  if (!Number.isFinite(ov["atmo.phaseMin"]) && !Number.isFinite(ov["atmo.weatherMin"])) return null;
  const eff = resolveRoomAtmo(globalLayer().atmo, ov);
  const pl = eff.phaseMin * 60_000;
  const wl = eff.weatherMin * 60_000;
  return { cs: now - Math.round(1.5 * pl), pl, wl, w: "sun", ws: now };
}

/* ---------------- API-слой модели (вызывают роуты) ---------------- */

function applyHintFor(key) {
  return key === "atmo.allowPlayerAtmosphereControl"
    ? "Действует сразу на живую комнату: при «выкл» кадры atmo/atmoset игроков молча отбрасываются сервером."
    : "Вступает только в НОВОЙ комнате (политика new-rooms-only глобального слоя): уже открытая комната едет на своём цикле; живую комнату крутят игроки (кадры atmo/atmoset, если не выключены ключом ниже).";
}

function roomState(id) {
  const meta = modeOf(id);
  const ov = overridesOf(id);
  const glob = globalLayer().atmo;
  const eff = resolveRoomAtmo(glob, ov);
  const keys = {};
  for (const key of SUPPORTED_ROOM_KEYS) {
    const overridden = Object.prototype.hasOwnProperty.call(ov, key);
    // «Глобально» для гейта = значение master-ключа atmo.playerControl
    // (мандат владелицы 2026-11-08); effective resolveRoomAtmo уже считает
    // master && (override ?? true) — панель показывает честный итог.
    const gateGlobal = glob.playerControl !== false;
    const global = key === "atmo.allowPlayerAtmosphereControl" ? gateGlobal : glob[key.split(".")[1]];
    keys[key] = {
      state: overridden ? "overridden" : "inherited",
      global,
      override: overridden ? ov[key] : null,
      effective: key === "atmo.allowPlayerAtmosphereControl" ? eff.allowPlayerAtmosphereControl : eff[key.split(".")[1]],
      applyHint: applyHintFor(key),
    };
  }
  return {
    id,
    title: meta.title,
    mode: meta.mode,
    access: meta.access,
    format: meta.format,
    overrides: { ...ov },
    overrideCount: Object.keys(ov).length,
    hasOverrides: Object.keys(ov).length > 0,
    effective: eff,
    keys,
    supportedKeys: [...SUPPORTED_ROOM_KEYS],
  };
}

export function listRooms() {
  return MODE_ROOMS.map((r) => {
    const ov = overridesOf(r.id);
    return {
      id: r.id,
      title: r.title,
      mode: r.mode,
      access: r.access,
      format: r.format,
      hasOverrides: Object.keys(ov).length > 0,
      overrideCount: Object.keys(ov).length,
      supportedKeys: [...SUPPORTED_ROOM_KEYS],
    };
  });
}

/** PUT: merge validated поверх существующих; всё-или-ничего. Мутатор сам
 *  канонизирует/проверяет id (HTTP-слой делает то же, но модель должна быть
 *  безопасной и при прямом программном вызове). */
function asRoomIdOrError(raw) {
  const canon = canonicalRoomId(raw);
  return canon ? { id: canon } : { error: { reason: "unknown_room", allowed: roomIds() } };
}

export function updateRoom(rawId, values) {
  const guard = asRoomIdOrError(rawId);
  if (guard.error) return { error: guard.error };
  const id = guard.id;
  const unknown = [];
  const unsupported = [];
  const invalid = [];
  for (const [key, raw] of Object.entries(values || {})) {
    const why = classifyRoomKey(key);
    if (why === "unknown_key") unknown.push(key);
    else if (why) unsupported.push(key);
    else {
      const res = strictRoomValue(key, raw);
      if (res.error) invalid.push({ key, error: res.error });
    }
  }
  if (unknown.length) return { error: { reason: "unknown_key", unknown, allowed: [...SUPPORTED_ROOM_KEYS] } };
  if (unsupported.length) {
    return {
      error: {
        reason: "unsupported_combo",
        unsupported,
        allowed: [...SUPPORTED_ROOM_KEYS],
        note: "universes пер-room — v2, после интеграции боевого контекста комнаты",
      },
    };
  }
  if (invalid.length) return { error: { reason: "invalid", invalid, allowed: [...SUPPORTED_ROOM_KEYS] } };
  const rooms = { ...state.rooms };
  const next = { ...(rooms[id] || {}) };
  for (const [key, raw] of Object.entries(values || {})) {
    const res = strictRoomValue(key, raw);
    if (res.value !== undefined) next[key] = res.value;
  }
  if (Object.keys(next).length) rooms[id] = next;
  else delete rooms[id];
  saveState({ v: 1, rooms });
  return { room: roomState(id) };
}

/** DELETE одного ключа: убрали override → комната наследует глобальный слой. */
export function resetRoomKey(rawId, key) {
  const guard = asRoomIdOrError(rawId);
  if (guard.error) return { error: guard.error };
  const id = guard.id;
  if (classifyRoomKey(key)) {
    // сброс не поддержанного ключа — только «наследует» без изменений файла.
    if (key in REGISTRY) return { room: roomState(id), reset: key, inherited: null };
    return { error: { reason: "unknown_key", unknown: [key], allowed: [...SUPPORTED_ROOM_KEYS] } };
  }
  const rooms = { ...state.rooms };
  const cur = { ...(rooms[id] || {}) };
  const had = Object.prototype.hasOwnProperty.call(cur, key);
  delete cur[key];
  if (Object.keys(cur).length) rooms[id] = cur;
  else delete rooms[id];
  saveState({ v: 1, rooms });
  const glob = globalLayer().atmo;
  // Наследуемое пер-room гейтом — значение master-ключа atmo.playerControl.
  const inherited = key === "atmo.allowPlayerAtmosphereControl" ? glob.playerControl !== false : glob[key.split(".")[1]];
  return { room: roomState(id), reset: key, had, inherited };
}

export function resetRoom(rawId) {
  const guard = asRoomIdOrError(rawId);
  if (guard.error) return { error: guard.error };
  const id = guard.id;
  const rooms = { ...state.rooms };
  const had = Object.prototype.hasOwnProperty.call(rooms, id);
  delete rooms[id];
  saveState({ v: 1, rooms });
  return { room: roomState(id), had };
}

/** Restore комнаты из файлового бэкапа: имя только из листинга (path-guard),
 *  снимок валидируется ТЕМ ЖЕ strictRoomValues до записи — всё-или-ничего
 *  (частичного восстановления из мусорного снимка нет). */
export function restoreRoom(rawId, name) {
  const guard = asRoomIdOrError(rawId);
  if (guard.error) return { error: guard.error };
  const id = guard.id;
  const history = listHistoryNames();
  if (typeof name !== "string" || !history.includes(name)) {
    return { error: { reason: "unknown_backup", allowed: history } };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
  } catch {
    return { error: { reason: "unknown_backup", allowed: history } };
  }
  const body = raw?.rooms?.[id];
  if (!body || typeof body !== "object") {
    // В снимке этой комнаты нет — честная интерпретация: пустые overrides.
    const rooms = { ...state.rooms };
    delete rooms[id];
    saveState({ v: 1, rooms });
    return { room: roomState(id), restoredFrom: name, empty: true };
  }
  const invalid = [];
  const clean = {};
  for (const [key, value] of Object.entries(body)) {
    const why = classifyRoomKey(key);
    if (why) invalid.push({ key, error: why });
    else {
      const res = strictRoomValue(key, value);
      if (res.error) invalid.push({ key, error: res.error });
      else clean[key] = res.value;
    }
  }
  if (invalid.length) return { error: { reason: "invalid", invalid, allowed: [...SUPPORTED_ROOM_KEYS] } };
  const rooms = { ...state.rooms };
  if (Object.keys(clean).length) rooms[id] = clean;
  else delete rooms[id];
  saveState({ v: 1, rooms });
  return { room: roomState(id), restoredFrom: name };
}

export { listHistoryNames, canonicalRoomId };

/* ---------------- HTTP: admin-роуты /cfg/rooms* ---------------- */

/** Разбор пути после /cfg/rooms/: [id] | [id, «all»] | [id, key] |
 *  [id, «history»] — вложенность>2 мусор. */
function tailOf(p) {
  return p.slice("/cfg/rooms/".length).split("/").filter(Boolean);
}

export async function handleRoomCfgHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  if (p !== "/cfg/rooms" && !p.startsWith("/cfg/rooms/")) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  // Все /cfg/rooms*-маршруты — только admin-роль (тот же гейт, что /cfg/admin).
  if (!requireAdmin(req, res)) return true;
  const tail = tailOf(p);
  const id = tail[0] ? canonicalRoomId(tail[0]) : null;
  if (p === "/cfg/rooms" && req.method === "GET") {
    json(res, 200, { ok: true, rooms: listRooms(), supportedKeys: [...SUPPORTED_ROOM_KEYS] });
    return true;
  }
  if (!id) {
    json(res, 400, { ok: false, reason: "unknown_room", allowed: roomIds() });
    return true;
  }
  const second = tail[1];
  if (tail.length === 1) {
    if (req.method === "GET") {
      json(res, 200, { ok: true, room: roomState(id) });
      return true;
    }
    if (req.method === "PUT") {
      try {
        const body = await readJson(req);
        const values = body?.values;
        if (!values || typeof values !== "object" || Array.isArray(values)) {
          json(res, 400, { ok: false, reason: "values_expected", allowed: [...SUPPORTED_ROOM_KEYS] });
          return true;
        }
        const extra = Object.keys(body).filter((k) => k !== "values");
        if (extra.length) {
          json(res, 400, { ok: false, reason: "unexpected_fields", unexpected: extra, expected: ["values"] });
          return true;
        }
        const out = updateRoom(id, values);
        if (out.error) json(res, 400, { ok: false, ...out.error });
        else json(res, 200, { ok: true, ...out });
        return true;
      } catch {
        json(res, 400, { ok: false, reason: "json" });
        return true;
      }
    }
    json(res, 404, { ok: false, reason: "not_found" });
    return true;
  }
  if (tail.length === 2 && req.method === "DELETE" && second === "all") {
    json(res, 200, { ok: true, ...resetRoom(id) });
    return true;
  }
  if (tail.length === 2 && req.method === "DELETE") {
    const out = resetRoomKey(id, second);
    if (out.error) json(res, 400, { ok: false, ...out.error });
    else json(res, 200, { ok: true, ...out });
    return true;
  }
  if (tail.length === 2 && req.method === "GET" && second === "history") {
    const history = listHistoryNames();
    json(res, 200, { ok: true, id, history, keep: BACKUP_KEEP, hint: "Снимки всего файла room-configs.json перед каждым успешным изменением; restore восстанавливает из снимка OVERRIDES именно этой комнаты." });
    return true;
  }
  if (tail.length === 2 && req.method === "POST" && second === "restore") {
    try {
      const body = await readJson(req);
      const out = restoreRoom(id, body?.name);
      if (out.error) json(res, Number(out.error.reason === "unknown_backup" ? 404 : 400), { ok: false, ...out.error });
      else json(res, 200, { ok: true, ...out });
      return true;
    } catch {
      json(res, 400, { ok: false, reason: "json" });
      return true;
    }
  }
  json(res, 404, { ok: false, reason: "not_found" });
  return true;
}
