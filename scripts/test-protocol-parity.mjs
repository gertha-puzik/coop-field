#!/usr/bin/env node
/**
 * Golden parity протокола (W3): единственный тест, который держит ЗЕРКАЛА
 * клиент-серверных констант и имён событий. Общего кода у сторон нет, поэтому
 * сверяются два независимых реестра:
 *   - сервер:      server/protocol.js  (импорт напрямую, любой node)
 *   - клиент:      src/lib/net/protocol.ts (через зонд protocol-parity-probe.mts
 *                  под node --experimental-strip-types; зонд выкатывает JSON)
 * Сверяются три вещи:
 *   1. имена событий: клиентский реестр == серверный (22 + 22, включая «update cat»);
 *   2. константы: серверные значения == клиентские значения (включая выводимые из
 *      settings.ts / test-map.ts — там живой источник клиентской стороны);
 *   3. golden-числа: ключевые лимиты равны зафиксированным значениям — защита от
 *      «обе стороны уехали вместе, тест зелёный».
 *
 * node < 22.6 не умеет strip-types: честный SKIP с exit 0 (как run-unit-tests.mjs);
 * CI (node 22) исполняет по-настоящему. Запуск: node scripts/test-protocol-parity.mjs
 * (npm-раннер: npm run test:protocol-parity).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as serverProtocol from "../server/protocol.js";
import * as cfgReg from "../server/cfg-registry.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROBE = path.join(ROOT, "scripts", "protocol-parity-probe.mts");

const [major, minor] = process.versions.node.split(".").map(Number);
const supportsStripTypes = major > 22 || (major === 22 && minor >= 6);
if (!supportsStripTypes) {
  console.log(`SKIP: requires node >=22.6 for --experimental-strip-types + .ts import, локальный node ${process.versions.node}`);
  process.exit(0);
}

const res = spawnSync(process.execPath, ["--experimental-strip-types", PROBE], {
  cwd: ROOT,
  encoding: "utf8",
  stdout: "pipe",
  stderr: "inherit",
});
if (res.error) {
  console.error(`FAIL: зонд паритета не поднялся: ${res.error.message}`);
  process.exit(1);
}
if (res.status !== 0) {
  console.error(`FAIL: зонд паритета упал (exit ${res.status}).`);
  process.exit(1);
}

let client;
try {
  const lines = res.stdout.trim().split("\n");
  client = JSON.parse(lines[lines.length - 1]);
} catch (e) {
  console.error(`FAIL: вывод зонда не парсится как JSON: ${e.message}\n--- зонд печатал: ---\n${res.stdout.slice(0, 400)}`);
  process.exit(1);
}

/** Значения волны W3, зафиксированные задачей канонизации (AGENTS.md, таблицы
 *  протокола и раздел зеркал docs/ARCHITECTURE.md §4). Изменение любого числа —
 *  осознанная правка канона: менять здесь и в обеих сторонах одним PR. */
const GOLDEN = {
  MAX_PLAYERS: 30,
  MOVE_COOLDOWN_MS: 80,
  MOVE_QUEUE_MAX: 3,
  JOIN_COOLDOWN_MS: 1000,
  AIM_MIN_GAP_MS: 20,
  STRIKE_CATCH_MS: 170,
  STRIKE_CATCH_MAX_MS: 600,
  CHAT_MAX_LEN: 200,
  CHAT_COOLDOWN_MS: 450,
  CHAT_HISTORY: 40,
  TERRAIN_MAX_LEVEL: 20,
  ELEV_STEP_MAX: 1,
  JUMP_CHARGE_HALF: 0.5,
  JUMP_CHARGE_FULL: 1,
  JUMP_MAX_UP: 3,
  DUMMY_DEFAULT: { x: 7, y: 2 },
  RAB_CELL: { x: 4, y: 2 },
  ATMO_PHASE_LIST: ["morning", "day", "evening", "night"],
  ATMO_WEATHER_LIST: ["sun", "cloud", "rain"],
  ATMO_PHASE_MS_DEF: 7 * 60_000,
  ATMO_WEATHER_MS_DEF: 12 * 60_000,
  ATMO_PHASE_MS_MIN: 60_000,
  ATMO_PHASE_MS_MAX: 120 * 60_000,
  ATMO_WEATHER_MS_MIN: 2 * 60_000,
  ATMO_WEATHER_MS_MAX: 240 * 60_000,
  JUMP_COOLDOWN_MS: 450,
  JUMP_MAX_CELLS: 3,
  JUMP_DIRECTIONS: 8,
  JUMP_MAX_DROP: 20,
  TEST_MAP_LIMITS: { colsMin: 6, colsMax: 60, rowsMin: 3, rowsMax: 40, zonesMax: 48, objectsMax: 2000, spawnsMax: 64, nameMax: 24 },
  GROUND_COVER_IDS_COUNT: 13, // grass×2 + flower×4 + slab×4 + floor×3 (источник: test-map.ts GROUND_COVER_OPTS)
  ARMOR_CURVE: [
    [0.0, 40.0],
    [0.1, 38.67],
    [0.12, 37.64],
    [0.2, 34.62],
    [0.35, 31.62],
    [0.66, 26.55],
    [0.78, 20.93],
  ],
  STRIKE_ZONES: {
    tail: { part: "Хвост", damage: 2 },
    paws: { part: "Лапы", damage: 6 },
    back: { part: "Спина", damage: 12 },
    muzzle: { part: "Морда", damage: 18 },
    belly: { part: "Живот", damage: 25 },
    neck: { part: "Шея", damage: 30 },
    throat: { part: "Горло", damage: 42 },
  },
};

const fail = [];
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fmt = (v) => (typeof v === "object" ? JSON.stringify(v) : String(v));

function check(label, serverValue, clientValue) {
  if (!deepEq(serverValue, clientValue)) {
    fail.push(`FAIL ${label}: server/protocol.js = ${fmt(serverValue)}, клиент (src/lib/net/protocol.ts) = ${fmt(clientValue)} — правь обе стороны одним PR.`);
  }
}
function checkGolden(label, serverValue, goldenValue) {
  if (!deepEq(serverValue, goldenValue)) {
    fail.push(`FAIL ${label} (golden): server/protocol.js = ${fmt(serverValue)}, ожидается ${fmt(goldenValue)} — правка канона: обнови GOLDEN здесь и обе стороны осознанно.`);
  }
}

/* 1. Имена событий — реестры сторон равны (в порядке док-таблиц). */
check("CLIENT_EVENTS", [...serverProtocol.CLIENT_EVENTS], client.CLIENT_TO_SERVER);
check("SERVER_EVENTS", [...serverProtocol.SERVER_EVENTS], client.SERVER_TO_CLIENT);
check("EV-словарь имён", serverProtocol.EV, client.EV);
if ([...serverProtocol.CLIENT_EVENTS].length !== 23 || [...serverProtocol.SERVER_EVENTS].length !== 23) {
  fail.push(`FAIL счётчик событий: CLIENT_EVENTS=${serverProtocol.CLIENT_EVENTS.length}, SERVER_EVENTS=${serverProtocol.SERVER_EVENTS.length} — должно быть 23+23 (см. AGENTS.md).`);
}

/* 2. Зеркалируемые константы — сервер == клиент (клиент — свой источник значений). */
for (const key of [
  "MAX_PLAYERS",
  "MOVE_COOLDOWN_MS",
  "MOVE_QUEUE_MAX",
  "JOIN_COOLDOWN_MS",
  "AIM_MIN_GAP_MS",
  "STRIKE_CATCH_MS",
  "STRIKE_CATCH_MAX_MS",
  "CHAT_MAX_LEN",
  "CHAT_COOLDOWN_MS",
  "CHAT_HISTORY",
  "TERRAIN_MAX_LEVEL",
  "ELEV_STEP_MAX",
  "JUMP_CHARGE_HALF",
  "JUMP_CHARGE_FULL",
  "JUMP_MAX_UP",
  "JUMP_COOLDOWN_MS",
  "JUMP_MAX_CELLS",
  "JUMP_DIRECTIONS",
  "JUMP_MAX_DROP",
  "ATMO_PHASE_MS_DEF",
  "ATMO_WEATHER_MS_DEF",
  "ATMO_PHASE_MS_MIN",
  "ATMO_PHASE_MS_MAX",
  "ATMO_WEATHER_MS_MIN",
  "ATMO_WEATHER_MS_MAX",
]) {
  check(key, serverProtocol[key], client[key]);
}
check("GROUND_COVER_IDS", [...serverProtocol.GROUND_COVER_IDS], client.GROUND_COVER_IDS);
check("ATMO_PHASE_LIST", [...serverProtocol.ATMO_PHASE_LIST], client.ATMO_PHASE_LIST);
check("ATMO_WEATHER_LIST", [...serverProtocol.ATMO_WEATHER_LIST], client.ATMO_WEATHER_LIST);
check("TEST_MAP_LIMITS", serverProtocol.TEST_MAP_LIMITS, client.TEST_MAP_LIMITS);
check("DUMMY_DEFAULT", { x: serverProtocol.DUMMY_DEFAULT.x, y: serverProtocol.DUMMY_DEFAULT.y }, client.DUMMY_DEFAULT);
check("RAB_CELL", serverProtocol.RAB_CELL, client.RAB_CELL);
check("ARMOR_CURVE", serverProtocol.ARMOR_CURVE.map((p) => [...p]), client.ARMOR_CURVE);
check("STRIKE_ZONES", serverProtocol.STRIKE_ZONES, client.STRIKE_ZONES);

/* 3. Golden: серверные значения равны канону W3 (защита от синхронного дрейфа). */
for (const key of Object.keys(GOLDEN)) {
  if (key === "GROUND_COVER_IDS_COUNT") continue;
  // Спрайт дефолта манекена — серверный факт, клиент его не зеркалит: сверяем x/y.
  const serverValue =
    key === "DUMMY_DEFAULT"
      ? { x: serverProtocol.DUMMY_DEFAULT.x, y: serverProtocol.DUMMY_DEFAULT.y }
      : serverProtocol[key];
  checkGolden(key, serverValue, GOLDEN[key]);
}
checkGolden("GROUND_COVER_IDS", [...serverProtocol.GROUND_COVER_IDS].length, GOLDEN.GROUND_COVER_IDS_COUNT);
checkGolden("ARMOR_CURVE", serverProtocol.ARMOR_CURVE.map((p) => [...p]), GOLDEN.ARMOR_CURVE);
checkGolden("STRIKE_ZONES", serverProtocol.STRIKE_ZONES, GOLDEN.STRIKE_ZONES);
// Спрайт дефолта манекена — серверный факт (клиент его не зеркалит), фиксируем и его.
checkGolden("DUMMY_DEFAULT.sprite", serverProtocol.DUMMY_DEFAULT.sprite, "puhlyashik");

/* 4. Golden-пины P2: whitelist-реестр параметров server/cfg-registry.js ↔
 *    зеркало src/lib/cfg-registry.ts. Общего кода у сторон нет, поэтому пиним
 *    по-полю: ключи, подписи/описания, юниверсы значений, дефолты, apply-
 *    политики; плюс снапшот дефолтных значений и формульные числа клэмпа
 *    урона (защита от «обе стороны уехали вместе»). ARMOR_CURVE и STRIKE_ZONES
 *    как константы движка уже запинены выше — реестр лежит ПОВЕРХ них. */
const CFG_KEYS_EXPECTED = [
  "atmo.phaseMin", "atmo.weatherMin", "atmo.playerControl", "atmo.allowPlayerAtmosphereControl",
  "universes.strikeDamage", "universes.armor", "universes.arrowSpeed",
  // Мандат владелицы 2026-11-08 («Броня: уровни защиты и тп — сделай чтоб
  // можно было добавлять значения»): 7-й ключ — points-кривая брони.
  "combat.armorCurve",
];
if (!deepEq([...cfgReg.KEYS], CFG_KEYS_EXPECTED)) {
  fail.push(`FAIL cfg-registry: набор ключей сервера = ${fmt([...cfgReg.KEYS])}, ожидается ${fmt(CFG_KEYS_EXPECTED)}.`);
}
const clientCfgKeys = Object.keys(client.CFG_REGISTRY || {});
if (!deepEq(clientCfgKeys, CFG_KEYS_EXPECTED)) {
  fail.push(`FAIL cfg-registry: набор ключей зеркала = ${fmt(clientCfgKeys)}, ожидается ${fmt(CFG_KEYS_EXPECTED)}.`);
}
const CFG_PIN_FIELDS = [
  "key", "label", "description", "unit", "kind", "values", "default", "engineCap",
  // custom — границы своих значений ВНЕ пресетов (universes.arrowSpeed, мандат
  // 2026-11-08): клиент валидирует ввод теми же числами, что и сервер.
  "custom",
  "applyPolicy", "applyHint", "visibility", "scope",
];
for (const key of cfgReg.KEYS) {
  const s = cfgReg.REGISTRY[key];
  const c = (client.CFG_REGISTRY || {})[key];
  if (!c) {
    fail.push(`FAIL cfg-registry: ключ ${key} есть на сервере, в зеркале его нет.`);
    continue;
  }
  for (const field of CFG_PIN_FIELDS) {
    if (!deepEq(s[field], c[field])) {
      fail.push(`FAIL cfg-registry ${key}.${field}: server/cfg-registry.js = ${fmt(s[field])}, зеркало (src/lib/cfg-registry.ts) = ${fmt(c[field])} — правь обе стороны одним PR.`);
    }
  }
}
const GOLDEN_CFG_DEFAULTS = {
  v: 1,
  // Гейты atmoset живут в atmo (bool): глобальный master atmo.playerControl
  // (мандат владелицы 2026-11-08) + per-room F2 §3.4; отсутствие override =
  // true (поведение комнат без миграции не меняется). F2 §4: universes несут
  // явный playerSelectable (тройка allowedValues/defaultValue/selectable).
  atmo: { phaseMin: 7, weatherMin: 12, playerControl: true, allowPlayerAtmosphereControl: true },
  universes: {
    strikeDamage: { levels: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], default: 0, playerSelectable: true },
    armor: { tenths: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9], default: 0, playerSelectable: true },
    arrowSpeed: { periods: [1.8, 2.5, 3.5, 4, 4.5, 5], default: 5, playerSelectable: true },
  },
  // Мандат владелицы 2026-11-08: дефолт points-кривой брони = канон W3
  // (GOLDEN.ARMOR_CURVE запинен выше — это ОДНИ и те же 7 замеров).
  combat: { armorCurve: GOLDEN.ARMOR_CURVE.map((p) => [p[0], p[1]]) },
};
if (!deepEq(cfgReg.defaultsFor(), GOLDEN_CFG_DEFAULTS)) {
  fail.push(`FAIL cfg-registry defaults: server/cfg-registry.js = ${fmt(cfgReg.defaultsFor())}, ожидается ${fmt(GOLDEN_CFG_DEFAULTS)}.`);
}
if (!deepEq(client.CFG_DEFAULTS, GOLDEN_CFG_DEFAULTS)) {
  fail.push(`FAIL cfg-registry defaults зеркала: src/lib/cfg-registry.ts = ${fmt(client.CFG_DEFAULTS)}, ожидается ${fmt(GOLDEN_CFG_DEFAULTS)}.`);
}
const GOLDEN_DAMAGE_CLAMPS = [
  ["throat", 0, 42], ["throat", 9, 75], ["muzzle", 9, 32], ["paws", 4, 8], ["tail", 9, 4],
];
for (const [zone, level, want] of GOLDEN_DAMAGE_CLAMPS) {
  if (cfgReg.maxStrikeDamage(zone, level) !== want) {
    fail.push(`FAIL cfg-registry maxStrikeDamage(${zone}, ${level}) = ${cfgReg.maxStrikeDamage(zone, level)}, ожидается ${want} (формула зон: горло 42 + 3,67·уровень, остальные — база зоны × рост горла).`);
  }
}

if (fail.length) {
  console.error(`Протокольный паритет: расхождений — ${fail.length}.`);
  for (const line of fail) console.error("  " + line);
  process.exit(1);
}

console.log(
  `protocol parity — зелёный: событий 23+23, зеркал-констант 25, EV-имён ${Object.keys(serverProtocol.EV).length}; ` +
    `server/protocol.js == src/lib/net/protocol.ts == golden; ` +
    `cfg-registry: ключей ${cfgReg.KEYS.length}, сервер == зеркало == golden.`
);
