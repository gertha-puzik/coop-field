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
  TERRAIN_MAX_LEVEL: 3,
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
  JUMP_MAX_DROP: 3,
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
if ([...serverProtocol.CLIENT_EVENTS].length !== 22 || [...serverProtocol.SERVER_EVENTS].length !== 22) {
  fail.push(`FAIL счётчик событий: CLIENT_EVENTS=${serverProtocol.CLIENT_EVENTS.length}, SERVER_EVENTS=${serverProtocol.SERVER_EVENTS.length} — должно быть 22+22 (см. AGENTS.md).`);
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

if (fail.length) {
  console.error(`Протокольный паритет: расхождений — ${fail.length}.`);
  for (const line of fail) console.error("  " + line);
  process.exit(1);
}

console.log(
  `protocol parity — зелёный: событий 22+22, зеркал-констант 25, EV-имён ${Object.keys(serverProtocol.EV).length}; ` +
    `server/protocol.js == src/lib/net/protocol.ts == golden.`
);
