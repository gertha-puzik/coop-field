#!/usr/bin/env node
/**
 * F2 «Per-room configuration» — сквозной харнесс (спек владелицы §3+E).
 *
 *  Модель (юнит, без сети, import server/room-config.js на tmp DATA_DIR):
 *   - слои resolver: engine ← global ← per-room (наследование/override/флаг);
 *   - strictRoomValue: диапазоны и bool, out-of-range/не-bool → invalid;
 *   - unknown_key / unsupported_combo (universes per-room = v2);
 *   - unknown_room + path-traversal строка → отказ mутатора;
 *   - RETIRED-алиас (combat → grot-1) канонизируется;
 *   - persistence: atomic write (0600), бэкапы room-configs.backup.<ts>.json
 *     растут с каждым write, restore только по имени из листинга.
 *
 *  HTTP+WS (spawn server.js, DATA_DIR=/tmp, стоп → make-admin → старт → login —
 *  та же лестница S1, что test-cfg):
 *   - /cfg/rooms* только для admin (гость/юзер → 403, и на чтение тоже);
 *   - полный цикл: список → глобальный слой наследуется → override → бейдж
 *     overridden → reset one → наследует → reset all → history → restore;
 *   - ректры: unknown_room / unknown_key / unsupported_combo / invalid /
 *     values_expected / unexpected_fields / unknown_backup (path-guard);
 *   - РЕСТАРТ сервера → overrides пережили процесс;
 *   - РАНТАЙМ: НОВАЯ комната инициализируется из effective (override 30/13);
 *     RETIRED-алиас combat → та же комната grot-1 с override-якорем;
 *   - ATOSET-ШТУРМ (§3.4): при выключенном allowPlayerAtmosphereControl кадры
 *     atmo/atmoset игроков МОЛЧА отбрасываются; соседняя комната управляется
 *     как раньше; persistent-файл room-configs.json штурмом НЕ меняется
 *     (архитектурная изоляция живого края от админского слоя).
 *
 *  Миграция и защита от порченого файла (поздние фазы, свои DATA-каталоги):
 *   - файл без v, но с rooms → принимается как v1 (без переписывания);
 *   - мусорный JSON → warn + room-configs.corrupt-<ts>.json + пустые overrides,
 *     сервер продолжает работать.
 *
 * Запуск: node scripts/test-room-config.mjs (npm-раннер: npm run test:room-config).
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = new URL("..", import.meta.url).pathname;
const HOST = "127.0.0.1";
const PORT = 4240 + Math.floor(Math.random() * 80);
const HTTP = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;
const MIN = 60_000;

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= ФАЗА 1: модель (юнит) ================= */
const DATA_M = mkdtempSync(path.join(tmpdir(), "coop-room-conf-"));
process.env.DATA_DIR = DATA_M; // ДО импорта: room-config читает DATA_DIR единожды
writeFileSync(
  path.join(DATA_M, "room-configs.json"),
  JSON.stringify({ v: 1, rooms: { "grot-1": { "atmo.phaseMin": 30 } } }, null, 2),
);

const rc = await import("../server/room-config.js");

check(
  JSON.stringify(rc.SUPPORTED_ROOM_KEYS) === JSON.stringify(["atmo.phaseMin", "atmo.weatherMin", "atmo.allowPlayerAtmosphereControl"]),
  "unit: per-room whitelist v1 — 3 ключа (atmo.* + гейт atmoset)",
);
check(rc.isPlayerAtmoControlAllowed("grot-1") === true, "unit: гейт atmoset default true — override отсутствует, геймплей прежний");

const layered = rc.resolveRoomAtmo({ phaseMin: 9, weatherMin: 12 }, { "atmo.phaseMin": 30 });
check(
  layered.phaseMin === 30 && layered.weatherMin === 12 && layered.allowPlayerAtmosphereControl === true,
  "unit: слои resolver — override 30 поверх глобального 9; погода наследует 12; гейт наследует true",
);
const noOv = rc.resolveRoomAtmo({ phaseMin: 9, weatherMin: 12 }, {});
check(noOv.phaseMin === 9 && noOv.weatherMin === 12, "unit: без overrides — чистый глобальный слой");

check(rc.strictRoomValue("atmo.phaseMin", 999).error !== undefined, "unit: out-of-range 999 → отказ (положение «доводим» только у глобального POST /cfg)");
check(rc.strictRoomValue("atmo.phaseMin", 7.4).value === 7, "unit: дробный диапазон → строгий int");
check(rc.canonicalRoomId("combat") === "grot-1", "unit: RETIRED-алиас combat канонизируется в grot-1");
check(rc.canonicalRoomId("../etc/passwd") === null, "unit: path traversal '../../etc/passwd' → null (не зарегистрирована)");
check(rc.canonicalRoomId("no-such-room") === null, "unit: незарегистрированный код → null");

const badRoom = rc.updateRoom("../nope", { "atmo.phaseMin": 5 });
check(badRoom.error?.reason === "unknown_room", "unit: мутатор сам отвергает unknown_room (модель безвредна при прямом вызове)");
const badKey = rc.updateRoom("grot-2", { "atmo.marja": 5 });
check(badKey.error?.reason === "unknown_key" && JSON.stringify(badKey.error?.unknown) === '["atmo.marja"]', "unit: неизвестный ключ → unknown_key с перечислением");
const unsupported = rc.updateRoom("grot-2", { "universes.strikeDamage": { levels: [0, 1], default: 0 } });
check(
  unsupported.error?.reason === "unsupported_combo" && JSON.stringify(unsupported.error?.unsupported) === '["universes.strikeDamage"]',
  "unit: universes per-room → 400 unsupported_combo (v2 — после боевой интеграции)",
);
const outOfRange = rc.updateRoom("grot-2", { "atmo.phaseMin": 999 });
check(outOfRange.error?.reason === "invalid", "unit: out-of-range в updateRoom → invalid");
const badBool = rc.updateRoom("grot-2", { "atmo.allowPlayerAtmosphereControl": "выкл" });
check(badBool.error?.reason === "invalid", "unit: гейт atmoset не-bool → invalid");

const upd = rc.updateRoom("grot-2", { "atmo.weatherMin": 13, "atmo.allowPlayerAtmosphereControl": false });
check(upd.room?.overrides?.["atmo.weatherMin"] === 13 && upd.room?.overrideCount === 2, "unit: updateRoom пишет merge + счётчик");
check(
  JSON.parse(readFileSync(path.join(DATA_M, "room-configs.json"), "utf8")).rooms["grot-2"]["atmo.allowPlayerAtmosphereControl"] === false,
  "unit: файл room-configs.json отражает overrides (persisted)",
);
const mode0600 = statSync(path.join(DATA_M, "room-configs.json")).mode & 0o777;
check(mode0600 === 0o600, "unit: файл записан с правами 0600 (конвенция data-каталога)");

const hist1 = rc.listHistoryNames().length;
rc.updateRoom("grot-2", { "atmo.phaseMin": 4 });
const hist2 = rc.listHistoryNames().length;
check(hist2 === hist1 + 1, "unit: каждый успешный write добавляет бэкап room-configs.backup.<ts>.json");

const resetOne = rc.resetRoomKey("grot-2", "atmo.phaseMin");
check(resetOne.had === true && resetOne.room?.overrideCount === 2, "unit: reset одного override (phaseMin=4) → осталось 2, счётчик честный");
rc.updateRoom("grot-3", { "atmo.phaseMin": 8 });
const resetHad = rc.resetRoomKey("grot-3", "atmo.phaseMin");
check(resetHad.had === true && resetHad.room?.overrideCount === 0, "unit: reset одного override → комната наследует глобальный слой");
const resetAll = rc.resetRoom("grot-2");
check(resetAll.had === true && resetAll.room?.hasOverrides === false, "unit: reset всех → hasOverrides false");

const restoreName = rc.listHistoryNames()[0];
const bogus = rc.restoreRoom("grot-3", "marja-абы-какой.json");
check(bogus.error?.reason === "unknown_backup", "unit: restore по незнакомому имени → unknown_backup (листинг — единственный источник)");
const badSnapshot = rc.restoreRoom("grot-3", restoreName);
check(badSnapshot.ok !== false && (badSnapshot.error === undefined || badSnapshot.error === null) === true, "unit: restore по действующему имени обрабатывается валидно");

/* ================= ФАЗА 2: HTTP+WS на живом сервере ================= */
const DATA = mkdtempSync(path.join(tmpdir(), "coop-room-live-"));
const ROOM_FILE = path.join(DATA, "room-configs.json");
process.env.DATA_DIR = DATA; // spawned-процессы берут env теста
process.env.BOOTSTRAP_ADMIN = "gertha_q";

let server = null;
let stderrBuf = "";
function startServer(dataDir = DATA) {
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST, DATA_DIR: dataDir, BOOTSTRAP_ADMIN: "gertha_q" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => {
    stderrBuf += String(d);
    process.stderr.write(d);
  });
  server.stdout.on("data", (d) => stderrBuf += String(d));
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode) return;
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode) return resolve();
    server.once("exit", resolve);
  });
}
async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    const ok = await new Promise((resolve) => {
      const probe = new WebSocket(WS);
      probe.once("open", () => { probe.terminate(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(80);
  }
  throw new Error(`server not ready: ${WS}`);
}

const httpJson = async (pathname, { method = "GET", body, token } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.cookie = `coop_session=${token}`;
  const res = await fetch(`${HTTP}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

function wsClient(name, roomCode) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.inbox = [];
    ws.on("message", (raw) => ws.inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.once("open", () => {
      ws.send(JSON.stringify(["join", { room: roomCode, login: name }]));
      resolve(ws);
    });
  });
}
const waitFor = (ws, event, ms = 3000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const tick = () => {
    const hit = ws.inbox.find((m) => m[0] === event);
    if (hit) return res(hit);
    if (Date.now() - t0 > ms) return rej(new Error(`timeout ${event}`));
    setTimeout(tick, 15);
  };
  tick();
});

try {
  startServer();
  await waitReady();

  // (а) Роли: и чтение, и запись /cfg/rooms* — только admin на сервере.
  const guestList = await httpJson("/cfg/rooms");
  check(guestList.status === 403 && guestList.json?.reason === "auth_required", "room: GET /cfg/rooms гость → 403 auth_required");
  const regRes = await httpJson("/auth/register", { method: "POST", body: { login: "beer_q", pass: "password1" } });
  const userTok = regRes.json?.token;
  check(!!userTok, "room: регистрация обычного юзера");
  const userList = await httpJson("/cfg/rooms", { token: userTok });
  check(userList.status === 403, "room: GET /cfg/rooms юзер (не админ) → 403");
  const userPut = await httpJson("/cfg/rooms/grot-1", { method: "PUT", body: { values: { "atmo.phaseMin": 30 } }, token: userTok });
  check(userPut.status === 403, "room: PUT /cfg/rooms/<id> юзер → 403");

  // Лестница S1: регистрируем будущего админа → стоп → make-admin CLI → старт → login.
  const adminRegRes = await httpJson("/auth/register", { method: "POST", body: { login: "gertha_q", pass: "password1" } });
  check(!!adminRegRes.json?.token, "room: регистрация будущего админа (bootstrap-роль НЕ назначается)");
  await stopServer();
  const cliOut = execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), "gertha_q"], {
    env: { ...process.env, DATA_DIR: DATA },
    encoding: "utf8",
  });
  check(/повышен|уже админ/.test(cliOut), "room: make-admin повышает аккаунт (CLI)");
  startServer();
  await waitReady();
  const login = await httpJson("/auth/login", { method: "POST", body: { login: "gertha_q", pass: "password1" } });
  const adminTok = login.json?.token;
  check(!!adminTok, "room: логин админа после CLI-повышения");

  // (б) Глобальный слой: admin-POST /cfg phaseMin 9; комната наследует.
  const globalSet = await httpJson("/cfg", { method: "POST", body: { atmo: { phaseMin: 9 } }, token: adminTok });
  check(globalSet.status === 200 && globalSet.json?.atmo?.phaseMin === 9, "room: глобальный слой phaseMin=9 (замороженный POST /cfg)");
  const list0 = await httpJson("/cfg/rooms", { token: adminTok });
  check(
    list0.status === 200 && Array.isArray(list0.json?.rooms) && list0.json.rooms.every((r) => r.hasOverrides === false),
    "room: список комнат без overrides (файл не существует = пустое состояние)",
  );
  const grot1 = list0.json.rooms.find((r) => r.id === "grot-1");
  check(!!grot1 && typeof grot1.title === "string" && typeof grot1.mode === "string", "room: элемент списка несёт id/title/mode реестра комнат");
  check(
    JSON.stringify(grot1?.supportedKeys) === JSON.stringify(["atmo.phaseMin", "atmo.weatherMin", "atmo.allowPlayerAtmosphereControl"]),
    "room: список несёт supportedKeys (whitelist per-room v1)",
  );

  const room0 = await httpJson("/cfg/rooms/grot-1", { token: adminTok });
  check(
    room0.status === 200 &&
      room0.json?.room?.keys?.["atmo.phaseMin"]?.state === "inherited" &&
      room0.json?.room?.keys?.["atmo.phaseMin"]?.global === 9 &&
      room0.json?.room?.keys?.["atmo.phaseMin"]?.effective === 9,
    "room: без overrides — бейдж «наследует», effective = глобальный 9",
  );
  check(room0.json?.room?.keys?.["atmo.allowPlayerAtmosphereControl"]?.effective === true, "room: гейт atmoset effective=true (default сохраняет геймплей)");

  const aliasRoom = await httpJson("/cfg/rooms/combat", { token: adminTok });
  check(aliasRoom.status === 200 && aliasRoom.json?.room?.id === "grot-1", "room: RETIRED-алиас /cfg/rooms/combat → комната grot-1");

  // (в) Валidационные отказы.
  const unknownRoom = await httpJson("/cfg/rooms/marja-room", { method: "PUT", body: { values: { "atmo.phaseMin": 30 } }, token: adminTok });
  check(unknownRoom.status === 400 && unknownRoom.json?.reason === "unknown_room" && Array.isArray(unknownRoom.json?.allowed), "room: неизвестный roomId → 400 unknown_room");
  const trav = await httpJson("/cfg/rooms/..%2F..%2Fetc%2Fpasswd", { method: "PUT", body: { values: { "atmo.phaseMin": 30 } }, token: adminTok });
  check(trav.status === 400 && trav.json?.reason === "unknown_room", "room: path traversal в roomId → 400 (нормализация убивает слэши)");
  const unknownKey = await httpJson("/cfg/rooms/grot-1", { method: "PUT", body: { values: { "atmo.marja": 1 } }, token: adminTok });
  check(unknownKey.status === 400 && unknownKey.json?.reason === "unknown_key", "room: неизвестный ключ → 400 unknown_key");
  const univ = await httpJson("/cfg/rooms/grot-1", { method: "PUT", body: { values: { "universes.strikeDamage": 3 } }, token: adminTok });
  check(univ.status === 400 && univ.json?.reason === "unsupported_combo" && univ.json?.note?.includes("v2"), "room: universes per-room → 400 unsupported_combo (v2 примечание)");
  const big = await httpJson("/cfg/rooms/grot-1", { method: "PUT", body: { values: { "atmo.phaseMin": 999 } }, token: adminTok });
  check(big.status === 400 && big.json?.reason === "invalid", "room: out-of-range 999 → 400 invalid");
  const badGate = await httpJson("/cfg/rooms/grot-1", { method: "PUT", body: { values: { "atmo.allowPlayerAtmosphereControl": "no" } }, token: adminTok });
  check(badGate.status === 400 && badGate.json?.reason === "invalid", "room: гейт строкой → 400 invalid (bool strict)");
  const noValues = await httpJson("/cfg/rooms/grot-1", { method: "PUT", body: { atmo: { phaseMin: 30 } }, token: adminTok });
  check(noValues.status === 400 && noValues.json?.reason === "values_expected", "room: тело без values → 400 values_expected");
  const extra = await httpJson("/cfg/rooms/grot-1", { method: "PUT", body: { values: {}, meta: 1 }, token: adminTok });
  check(extra.status === 400 && extra.json?.reason === "unexpected_fields", "room: посторонние поля тела → 400 unexpected_fields");
  const restGhost = await httpJson("/cfg/rooms/grot-1/restore", { method: "POST", body: { name: "marja.json" }, token: adminTok });
  check(restGhost.status === 404 && restGhost.json?.reason === "unknown_backup", "room: restore незнакомого бэкапа → 404 (path-guard листингом)");
  check(!existsSync(ROOM_FILE), "room: отказы ничего не создали — файла нет (ленивая запись)");

  // (г) Полный цикл: override → бейдж → reset one → reset all → history → restore.
  const put = await httpJson("/cfg/rooms/grot-1", { method: "PUT", body: { values: { "atmo.phaseMin": 30, "atmo.weatherMin": 13, "atmo.allowPlayerAtmosphereControl": false } }, token: adminTok });
  check(
    put.status === 200 && put.json?.room?.overrideCount === 3 && put.json?.room?.keys?.["atmo.phaseMin"]?.state === "overridden",
    "room: PUT трёх значений → overrideCount 3, бейдж overridden",
  );
  check(
    put.json?.room?.keys?.["atmo.phaseMin"]?.global === 9 && put.json?.room?.keys?.["atmo.phaseMin"]?.effective === 30 &&
      put.json?.room?.keys?.["atmo.weatherMin"]?.global === 12 && put.json?.room?.keys?.["atmo.weatherMin"]?.effective === 13,
    "room: global 9/12 vs effective 30/13 одновременно видны (честный дашборд)",
  );
  check(put.json?.room?.effective?.allowPlayerAtmosphereControl === false, "room: гейт effective=false после PUT");
  const listNow = await httpJson("/cfg/rooms", { token: adminTok });
  const grot1Now = listNow.json?.rooms?.find((r) => r.id === "grot-1");
  check(grot1Now?.hasOverrides === true && grot1Now?.overrideCount === 3, "room: список комнат показывает бейдж и счётчик overrides");

  const resetKey = await httpJson("/cfg/rooms/grot-1/atmo.phaseMin", { method: "DELETE", token: adminTok });
  check(
    resetKey.status === 200 && resetKey.json?.inherited === 9 && resetKey.json?.room?.keys?.["atmo.phaseMin"]?.state === "inherited",
    "room: reset одного ключа → наследует глобальный 9",
  );
  const resetAll = await httpJson("/cfg/rooms/grot-1/all", { method: "DELETE", token: adminTok });
  check(resetAll.status === 200 && resetAll.json?.room?.hasOverrides === false && resetAll.json?.had === true, "room: reset всех (с подтверждением модальным на клиенте) → наследует");

  const hist0 = await httpJson("/cfg/rooms/grot-1/history", { token: adminTok });
  check(hist0.status === 200 && Array.isArray(hist0.json?.history) && hist0.json.history.length >= 2, "room: history листится после серии writes");
  const backupName = hist0.json.history[hist0.json.history.length - 1]; // старейший = состояние с полными 3 overrides (до reset)
  const restore = await httpJson("/cfg/rooms/grot-1/restore", { method: "POST", body: { name: backupName }, token: adminTok });
  check(
    restore.status === 200 && restore.json?.room?.overrideCount === 3 && restore.json?.room?.overrides?.["atmo.phaseMin"] === 30 && restore.json?.restoredFrom === backupName,
    "room: restore возвращает overrides комнаты из бэкапа (валидация прошла)",
  );

  // (д) РЕСТАРТ сервера → overrides пережили.
  await stopServer();
  startServer();
  await waitReady();
  const relogin = await httpJson("/auth/login", { method: "POST", body: { login: "gertha_q", pass: "password1" } });
  const tok2 = relogin.json?.token;
  check(!!tok2, "room: повторный логин после рестарта");
  const after = await httpJson("/cfg/rooms/grot-1", { token: tok2 });
  check(
    after.json?.room?.overrideCount === 3 && after.json?.room?.effective?.phaseMin === 30 && after.json?.room?.effective?.allowPlayerAtmosphereControl === false,
    "room: overrides пережили рестарт (persisted v1)",
  );

  // (е) РАНТАЙМ: НОВАЯ комната инициализируется из effective; алиас combat → grot-1.
  const wsA = await wsClient("РунА", "combat");
  const fieldA = await waitFor(wsA, "field");
  const atA = fieldA[1].atmo || {};
  check(atA.pl === 30 * MIN && atA.wl === 13 * MIN, "room: field.atmo НОВОЙ комнаты — override 30/13 мин (алиас combat → grot-1)");
  const dayPos = ((Date.now() - atA.cs) / (atA.pl * 4)) % 1;
  check(Math.abs(dayPos - 0.375) < 0.02, "room: якорь продолжает открываться серединой дня (≈0,375)");

  // (ж) ATOSET-ШТУРМ: гейт выключен (restore вернул false) → кадры игроков
  //     молча отбрасываются; файл room-configs.json не меняется; соседняя
  //     комната (grot-2, без overrides) управляется как раньше.
  const fileBefore = readFileSync(ROOM_FILE, "utf8");
  const wsB = await wsClient("РунБ", "combat");
  await waitFor(wsB, "field");
  const wsC = await wsClient("РунВ", "grot-2");
  await waitFor(wsC, "field");
  const before = JSON.parse(readFileSync(ROOM_FILE, "utf8")).rooms["grot-1"];

  wsB.inbox.length = 0;
  wsA.inbox.length = 0;
  wsB.send(JSON.stringify(["atmo", { dp: "night", w: "rain" }]));
  wsB.send(JSON.stringify(["atmoset", { pl: 2, wl: 3 }]));
  await sleep(400);
  check(
    !wsA.inbox.some((m) => m[0] === "atmo") && !wsB.inbox.some((m) => m[0] === "atmo"),
    "room-§3.4: кадры atmo/atmoset игроков комнаты с гейтом=false — молчаливый drop (без рассылки и ответа)",
  );
  check(readFileSync(ROOM_FILE, "utf8") === fileBefore, "room-§3.4: atmoset-штурм НЕ пишет room-configs.json (изоляция слоёв)");
  check(JSON.stringify(JSON.parse(readFileSync(ROOM_FILE, "utf8")).rooms["grot-1"]) === JSON.stringify(before), "room-§3.4: overrides не изменились штурмом");

  wsC.inbox.length = 0;
  wsC.send(JSON.stringify(["atmo", { dp: "night", w: "rain" }]));
  const echo = await waitFor(wsC, "atmo");
  check(echo[1].dp === "night" && echo[1].w === "rain", "room-§3.4: соседняя комната без гейта управляется атмосферой как раньше");
  wsA.close();
  wsB.close();
  wsC.close();

  await stopServer();

  /* ===== ФАЗА 3: миграция (файл без v) и защита от порченого JSON ===== */
  const DATA_LEG = mkdtempSync(path.join(tmpdir(), "coop-room-leg-"));
  const LEG_FILE = path.join(DATA_LEG, "room-configs.json");
  writeFileSync(LEG_FILE, JSON.stringify({ rooms: { "grot-3": { "atmo.phaseMin": 20 } } }, null, 2));
  startServer(DATA_LEG);
  await waitReady();
  // для чтения нужен админ — регистрируем «Герту» и повышаем через CLI (лестница S1)
  await httpJson("/auth/register", { method: "POST", body: { login: "gertha_q", pass: "password1" } });
  await stopServer();
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), "gertha_q"], {
    env: { ...process.env, DATA_DIR: DATA_LEG },
    encoding: "utf8",
  });
  startServer(DATA_LEG);
  await waitReady();
  const legTok = (await httpJson("/auth/login", { method: "POST", body: { login: "gertha_q", pass: "password1" } })).json?.token;
  check(!!legTok, "migrate: логин админа во втором data-каталоге");
  const legacy = await httpJson("/cfg/rooms/grot-3", { token: legTok });
  check(
    legacy.status === 200 && legacy.json?.room?.keys?.["atmo.phaseMin"]?.state === "overridden" && legacy.json?.room?.effective?.phaseMin === 20,
    "migrate: файл БЕЗ v (старый формат) читается как v1 — override 20 жив, без переписывания файла",
  );
  check(readFileSync(LEG_FILE, "utf8") === JSON.stringify({ rooms: { "grot-3": { "atmo.phaseMin": 20 } } }, null, 2), "migrate: старый файл НЕ переписан на чтении");
  await stopServer();

  // Порченый JSON: warn + room-configs.corrupt-<ts>.json + пустые overrides.
  stderrBuf = "";
  writeFileSync(LEG_FILE, "йцукен — не JSON");
  startServer(DATA_LEG);
  await waitReady();
  const brokenTok = (await httpJson("/auth/login", { method: "POST", body: { login: "gertha_q", pass: "password1" } })).json?.token;
  const broken = await httpJson("/cfg/rooms/grot-3", { token: brokenTok });
  check(
    broken.status === 200 && broken.json?.room?.hasOverrides === false && broken.json?.room?.effective?.phaseMin === 7,
    "corrupt: порченый файл → пустые overrides, сервер жив (effective = движковые дефолты)",
  );
  const corruptFiles = readdirSync(DATA_LEG).filter((f) => f.startsWith("room-configs.corrupt-"));
  check(corruptFiles.length === 1, "corrupt: порченый контент отложен в room-configs.corrupt-<ts>.json");
  check(/room-config:/.test(stderrBuf), "corrupt: warn-лог о порче зафиксирован в stderr сервера");
  await stopServer();
} catch (e) {
  failures += 1;
  console.error("FAIL exception", e);
} finally {
  if (server && server.exitCode === null && !server.signalCode) server.kill("SIGTERM");
}

if (failures) {
  console.error(`room-config tests: FAIL (${failures})`);
  process.exit(1);
}
console.log("room-config tests: зелёный");
