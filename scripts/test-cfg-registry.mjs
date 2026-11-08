#!/usr/bin/env node
/**
 * Reестр параметров P2 (спек §6): whitelist-модель end-to-end.
 *
 *  Юнит (без сети, чистый import server/cfg-registry.js):
 *   - ключи/дефолты реестра, клэмпы диапазонов, unknown_keys с перечислением,
 *     invalid-списки (мусор/пусто/дефолт мимо списка), формулы клэмпов урона
 *     (golden) и снап брони к разрешённым десятым.
 *  HTTP (sandbox server.js, локальный класс хоста):
 *   - GET /cfg публичен: v+atmo+universes+apply-hint БЕЗ history (утечка P2);
 *   - read-time миграция: старый atmo-only файл читается, universes — дефолты,
 *     файл не переписывается до первого admin-POST;
 *   - роли: гость/юзер → 403 на POST /cfg и GET /cfg/admin, админ → 200;
 *   - POST /cfg: патч по ключам реестра, unknown → 400 + перечисление;
 *   - POST /cfg/restore: только имя из listHistory (path-guard), иначе 404;
 *   - GET /cfg/export + POST /cfg/import: roundtrip и отказ без частичного
 *     применения;
 *   - reset → дефолты реестра;
 *   - (B2, §4) списочные админ-мутации: сузить/расширить/убрать значение,
 *     toggle «выбор игроками» = список {default}-only, дефолт вне списка → 400,
 *     пустой список → 400, публичный /cfg отражает сужение, export/import
 *     и restore поверх суженных списков.
 *
 * Запуск: node scripts/test-cfg-registry.mjs (npm-раннер: npm run test:cfg).
 */
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-cfg-"));
const FILE = path.join(DATA, "runtime-config.json");
const PORT = 4180 + Math.floor(Math.random() * 60);
const HOST = "127.0.0.1";
const HTTP = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;

process.env.BOOTSTRAP_ADMIN = "gertha_q";

const reg = await import("../server/cfg-registry.js");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- Юнит: реестр (без сети) ---------- */
check(
  JSON.stringify(reg.KEYS) ===
    JSON.stringify(["atmo.phaseMin", "atmo.weatherMin", "atmo.playerControl", "atmo.allowPlayerAtmosphereControl", "universes.strikeDamage", "universes.armor", "universes.arrowSpeed", "combat.armorCurve"]),
  "unit: 8 ключей реестра в каноническом порядке (master-гейт atmoset после погоды, потом per-room гейт — мандат 2026-11-08; points-кривая брони в хвосте)",
);
const defs = reg.defaultsFor();
check(defs.v === 1 && defs.atmo.phaseMin === 7 && defs.atmo.weatherMin === 12 && defs.atmo.playerControl === true && defs.atmo.allowPlayerAtmosphereControl === true, "unit: дефолтальные длительности 7/12; оба гейта atmoset default=true (прежний геймплей без миграции)");
const masterGlobal = reg.sanitizeValues({ atmo: { playerControl: false } });
check(masterGlobal.values?.atmo?.playerControl === false && masterGlobal.error === undefined, "unit: глобальный мастер-гейт atmo.playerControl пишется глобальным POST /cfg (scope global)");
const masterBadStr = reg.sanitizeValues({ atmo: { playerControl: "вкл" } });
check(masterBadStr.error?.reason === "invalid", "unit: мастер-гейт atmoset — строго boolean (строка → invalid)");
const masterBadNum = reg.sanitizeValues({ atmo: { playerControl: 1 } });
check(masterBadNum.error?.reason === "invalid", "unit: мастер-гейт atmoset — число 1 → invalid (нужен явный true/false, не 1/0)");
check(defs.universes.arrowSpeed.periods.length === 6 && defs.universes.arrowSpeed.default === 5, "unit: пресеты стрелы 6 шт, дефолт 5");
const clamped = reg.sanitizeValues({ atmo: { phaseMin: 999, weatherMin: 0 } }).values;
check(clamped.atmo.phaseMin === 120 && clamped.atmo.weatherMin === 2, "unit: диапазон клэмпится 999→120, 0→2 (толерантность прежняя)");
const unknown = reg.sanitizeValues({ marja: 1, atmo: { marja: 2, phaseMin: 8 } });
check(
  unknown.error?.reason === "unknown_keys" && JSON.stringify(unknown.error.unknown) === JSON.stringify(["marja", "atmo.marja"]),
  "unit: неизвестная секция/поле → unknown_keys",
);
check(unknown.error?.allowed?.length === 8, "unit: отказ перечисляет разрешённые ключи (полный список, 8 шт)");
const badLevel = reg.sanitizeValues({ universes: { strikeDamage: { levels: [0, 27], default: 0 } } });
check(badLevel.error?.reason === "invalid" && badLevel.error.invalid[0].key === "universes.strikeDamage", "unit: уровень вне движкового юниверса → invalid");
const emptyList = reg.sanitizeValues({ universes: { armor: { tenths: [], default: 0 } } });
check(emptyList.error?.reason === "invalid", "unit: пустой список брони → invalid");
const badDefault = reg.sanitizeValues({ universes: { armor: { tenths: [0.3], default: 0.9 } } });
check(badDefault.error?.reason === "invalid", "unit: дефолт не из списка → invalid");
const goodList = reg.sanitizeValues({ universes: { strikeDamage: { levels: [1, 0, 1], default: 1 } } }).values;
check(JSON.stringify(goodList.universes.strikeDamage.levels) === "[0,1]", "unit: дубликаты уровней снимаются, список сортируется");
const halfFields = reg.universesForPublic(goodList);
check(JSON.stringify(halfFields.strikeDamage) === '{"levels":[0,1],"default":1,"playerSelectable":true}', "unit: universesForPublic отдаёт списки+дефолт+явный флаг выбора");
check(
  reg.maxStrikeDamage("throat", 0) === 42 && reg.maxStrikeDamage("throat", 9) === 75 &&
    reg.maxStrikeDamage("muzzle", 9) === 32 && reg.maxStrikeDamage("paws", 4) === 8,
  "unit: maxStrikeDamage — формульные golden (42/75/32/8)",
);
check(
  reg.snapArmorToUniverse(0.55, [0.3, 0.9]) === 0.3 && reg.snapArmorToUniverse(0.2, [0.3]) === 0 &&
    reg.snapArmorToUniverse("мусор", [0, 0.9]) === 0 && reg.snapArmorToUniverse(-1, [0, 0.9]) === 0,
  "unit: снап брони вниз к разрешённым (0,55→0,3; ниже списка → 0)",
);
check(
  reg.snapArmorToUniverse(0.55, reg.defaultsFor().universes.armor.tenths) === 0.5 &&
    reg.snapArmorToUniverse(0.56, reg.defaultsFor().universes.armor.tenths) === 0.5 &&
    reg.snapArmorToUniverse(0.30000000000004, reg.defaultsFor().universes.armor.tenths) === 0.3,
  "unit: снап не квантует вверх по полному списку (0,55/0,56→0,5; float-пыль→0,3)",
);
// F2 §3.4 в реестре: 6-й ключ — room-scope, глобальный слой его НЕ принимает
// (заморозка POST /cfg), слой per-room (opts.room) принимает строго bool.
const roomKeyGlobal = reg.sanitizeValues({ atmo: { allowPlayerAtmosphereControl: false } });
check(
  roomKeyGlobal.error?.reason === "unknown_keys" && JSON.stringify(roomKeyGlobal.error?.unknown) === JSON.stringify(["atmo.allowPlayerAtmosphereControl"]),
  "unit: гейт atmoset глобальным POST /cfg отвергнут (scope room — per-room only)",
);
const roomKeyRoom = reg.sanitizeValues({ atmo: { allowPlayerAtmosphereControl: false } }, reg.defaultsFor(), { room: true });
check(
  roomKeyRoom.values?.atmo?.allowPlayerAtmosphereControl === false && roomKeyRoom.values?.atmo?.phaseMin === 7 && roomKeyRoom.values?.atmo?.weatherMin === 12,
  "unit: opts.room принимает гейт atmoset поверх движковых дефолтов (остальные поля целы)",
);
const roomBadBool = reg.sanitizeValues({ atmo: { allowPlayerAtmosphereControl: "выкл" } }, reg.defaultsFor(), { room: true });
check(roomBadBool.error?.reason === "invalid", "unit: гейт atmoset — строго true/false (строка → invalid)");

/* ---------- Юнит: кривая брони combat.armorCurve (мандат владелицы 2026-11-08) ----------
 * Дефолт = канон W3 (ARMOR_CURVE из protocol.js — замеры владелицы); валидатор
 * жёсткий — только отказ с reason, «доводить» кривую нельзя (по ней считается
 * урон живых ударов). Здесь же fail-safe armorCurveFor: мусор → канон W3. */
const proto = await import("../server/protocol.js");
const canonCurve = proto.ARMOR_CURVE.map((p) => [p[0], p[1]]);
check(
  JSON.stringify(defs.combat.armorCurve) === JSON.stringify(canonCurve),
  "unit: дефолт кривой брони = канон W3 (7 замеров владелицы, побайтово ARMOR_CURVE)",
);
const curveOk = reg.sanitizeValues({ combat: { armorCurve: [[0.1, 35], [0.45, 30], [0.9, 20]] } }).values;
check(
  JSON.stringify(curveOk.combat.armorCurve) === JSON.stringify([[0.1, 35], [0.45, 30], [0.9, 20]]),
  "unit: отсортированная points-кривая принимается как есть (клиент сортирует сам, сервер только валидирует)",
);
const curveOne = reg.sanitizeValues({ combat: { armorCurve: [[0.2, 30]] } });
check(curveOne.error?.reason === "invalid", "unit: кривая < 2 точек → invalid");
const curveMany = reg.sanitizeValues({ combat: { armorCurve: Array.from({ length: 17 }, (_, i) => [i * 0.05, 55 - i]) } });
check(curveMany.error?.reason === "invalid", "unit: кривая > 16 точек → invalid");
const curveUnsorted = reg.sanitizeValues({ combat: { armorCurve: [[0.2, 30], [0.9, 20], [0.1, 35]] } });
check(curveUnsorted.error?.reason === "invalid", "unit: несортированный x (0,2 < 0,9 > 0,1) → invalid без доводки");
const curveDup = reg.sanitizeValues({ combat: { armorCurve: [[0.1, 35], [0.1, 30]] } });
check(curveDup.error?.reason === "invalid", "unit: дубликат x 0,1 → invalid");
const curveXOut = reg.sanitizeValues({ combat: { armorCurve: [[0.95, 20], [0.1, 35]] } });
check(curveXOut.error?.reason === "invalid", "unit: x вне [0; 0,9] → invalid");
const curveYOut = reg.sanitizeValues({ combat: { armorCurve: [[0.1, 35], [0.9, 61]] } });
check(curveYOut.error?.reason === "invalid", "unit: урон% вне [5; 60] → invalid");
const curveGarbage = reg.sanitizeValues({ combat: { armorCurve: [["ноль", 35], [0.1, "тридцать"]] } });
check(curveGarbage.error?.reason === "invalid", "unit: не-числа в точках → invalid");
const curveRise = reg.sanitizeValues({ combat: { armorCurve: [[0.1, 20], [0.2, 30]] } });
check(curveRise.error?.reason === "invalid", "unit: урон% растёт по кривой защиты → invalid (кривая не усиливает урон)");
const canonBack = reg.armorCurveFor({ combat: { armorCurve: [["мусор"]] } });
check(JSON.stringify(canonBack) === JSON.stringify(canonCurve), "unit: fail-safe armorCurveFor — битая кривая → канон W3, не фантазия");
const canonAbsent = reg.armorCurveFor({});
check(JSON.stringify(canonAbsent) === JSON.stringify(canonCurve), "unit: armorCurveFor без значения → канон W3 (дефолт реестра)");

/* ---------- HTTP: sandbox со старым atmo-only файлом ---------- */
mkdirSync(DATA, { recursive: true });
// Сид: «старый» persisted-формат ДО §4: playerSelectable нет; arrowSpeed
// сужен до {default}-only — прежняя косвенная семантика «выбор выключен».
writeFileSync(FILE, JSON.stringify({ v: 1, atmo: { phaseMin: 5, weatherMin: 12 }, universes: { arrowSpeed: { periods: [5], default: 5 } } }, null, 2));

let server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST, DATA_DIR: DATA, BOOTSTRAP_ADMIN: "gertha_q" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));

function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST, DATA_DIR: DATA, BOOTSTRAP_ADMIN: "gertha_q" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(d));
}

async function stopServer() {
  if (server.exitCode !== null || server.signalCode) return;
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
      probe.once("open", () => {
        probe.terminate();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(80);
  }
  throw new Error(`server not ready: ${WS}`);
}

const httpJson = async (pathname, { method = "GET", body, token, origin } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.cookie = `coop_session=${token}`;
  if (origin) headers.origin = origin;
  const url = token && !headers.cookie ? `${HTTP}${pathname}?t=${token}` : `${HTTP}${pathname}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* not json */
  }
  return { status: res.status, json };
};

try {
  await waitReady();

  // (а) Публичный GET /cfg: миграция старого файла + universes дефолтами,
  //     НИКАКОЙ истории (утечка админ-мета закрыта в P2).
  const pub0 = await httpJson("/cfg");
  check(pub0.status === 200 && pub0.json?.ok === true && pub0.json?.atmo?.phaseMin === 5, "cfg: GET /cfg читает старый atmo-only файл (миграция на лету)");
  check(pub0.json?.universes?.strikeDamage?.levels?.length === 10, "cfg: universes добирается дефолтами реестра");
  check(!("history" in (pub0.json || {})), "cfg: публичный GET /cfg больше НЕ отдаёт history (имён бэкапов игрокам не видно)");
  check(
    JSON.stringify(Object.keys(pub0.json.universes.strikeDamage)) === JSON.stringify(["levels", "default", "playerSelectable"]),
    "cfg: публичный блок universes — списки, дефолт и флаг выбора (меты нет)",
  );
  // F2 §4.3: read-time миграция старого persisted-формата (без флага) —
  // флаг выводится из списка; узкий [5]-only => выбор выключен, полный => true.
  check(pub0.json?.universes?.arrowSpeed?.playerSelectable === false && JSON.stringify(pub0.json?.universes?.arrowSpeed?.periods) === "[5]", "cfg: legacy [5]-only стрелы мигрируется как playerSelectable=false (деривация из списка)");
  check(pub0.json?.universes?.strikeDamage?.playerSelectable === true && pub0.json?.universes?.strikeDamage?.levels?.length === 10, "cfg: полномасштабный юниверса урона мигрируется как playerSelectable=true");
  check(pub0.json?.apply?.["atmo.phaseMin"] === "new-room" && pub0.json?.apply?.["universes.strikeDamage"] === "on-next-event", "cfg: apply-политики приходят по ключам реестра");
  check(readFileSync(FILE, "utf8").includes('"phaseMin": 5') && !readFileSync(FILE, "utf8").includes('"playerSelectable"'), "cfg: файл на диске НЕ переписан до первого admin-POST (миграция только на чтении)");

  // (б) Роли: гость и юзер не пишут и не видят админ-данные.
  const guestPost = await httpJson("/cfg", { method: "POST", body: { atmo: { phaseMin: 3 } } });
  check(guestPost.status === 403 && guestPost.json?.reason === "auth_required", "cfg: POST /cfg гость → 403");
  const guestAdmin = await httpJson("/cfg/admin");
  check(guestAdmin.status === 403 && guestAdmin.json?.reason === "auth_required", "cfg: GET /cfg/admin гость → 403");

  const regRes = await httpJson("/auth/register", { method: "POST", body: { login: "ordinary_q", pass: "password1" } });
  const userTok = regRes.json?.token;
  check(!!userTok, "cfg: регистрация обычного юзера");
  const userPost = await httpJson("/cfg", { method: "POST", body: { atmo: { phaseMin: 3 } }, token: userTok });
  check(userPost.status === 403, "cfg: POST /cfg юзер (не админ) → 403");
  const userAdmin = await httpJson("/cfg/admin", { token: userTok });
  check(userAdmin.status === 403, "cfg: GET /cfg/admin юзер (не админ) → 403");
  const userExport = await httpJson("/cfg/export", { token: userTok });
  check(userExport.status === 403, "cfg: GET /cfg/export юзер (не админ) → 403");

  // S1: bootstrap-имя при регистрации НЕ даёт роли — единственный путь admin
  // теперь одноразовый CLI make-admin.mjs (как владелица на проде):
  // стоп сервера → повышение → рестарт с тем же DATA_DIR → логин.
  const adminReg = await httpJson("/auth/register", { method: "POST", body: { login: "gertha_q", pass: "password1" } });
  check(!!adminReg.json?.token, "cfg: регистрация будущего админа прошла");
  const plainWho = await httpJson("/auth/me", { token: adminReg.json?.token });
  check(plainWho.json?.role === "registered", "cfg: S1 — bootstrap-имя зарегистрировано БЕЗ роли (registered)");
  await stopServer();
  const cliOut = execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), "gertha_q"], {
    env: { ...process.env, DATA_DIR: DATA },
    encoding: "utf8",
  });
  check(/повышен|уже админ/.test(cliOut), "cfg: make-admin повышает аккаунт (CLI, код возврата 0)");
  startServer();
  await waitReady();
  const adminLogin = await httpJson("/auth/login", { method: "POST", body: { login: "gertha_q", pass: "password1" } });
  const adminTok = adminLogin.json?.token;
  check(!!adminTok, "cfg: логин админа после CLI-повышения");
  const adminWho = await httpJson("/auth/me", { token: adminTok });
  check(adminWho.json?.role === "admin", "cfg: роль админа на сессии (после make-admin)");

  // (в) POST /cfg: whitelist-патч.
  const saved = await httpJson("/cfg", { method: "POST", body: { atmo: { phaseMin: 9 } }, token: adminTok });
  check(saved.status === 200 && saved.json?.atmo?.phaseMin === 9 && saved.json?.atmo?.weatherMin === 12 && !("allowPlayerAtmosphereControl" in saved.json.atmo), "cfg: админ-патч применён (условные клэмпы), room-ключ глобальному слою не виден");
  check(readFileSync(FILE, "utf8").includes('"universes"'), "cfg: первый admin-POST переписал файл расширенной схемой (v:1 + universes)");
  check(!("history" in (saved.json || {})), "cfg: ответ POST /cfg без history");

  const unknownKeys = await httpJson("/cfg", { method: "POST", body: { marja: { x: 1 }, atmo: { phaseMin: 8, marja: 2 } }, token: adminTok });
  check(unknownKeys.status === 400 && unknownKeys.json?.reason === "unknown_keys" && unknownKeys.json?.unknown?.includes("marja"), "cfg: POST /cfg с чужими ключами → 400 + перечисление");
  const still9 = await httpJson("/cfg");
  check(still9.json?.atmo?.phaseMin === 9, "cfg: после отказа значения НЕ изменились (всё или ничего)");

  const badNum = await httpJson("/cfg", { method: "POST", body: { atmo: { phaseMin: "мусор" } }, token: adminTok });
  check(badNum.status === 400 && badNum.json?.reason === "invalid", "cfg: нечисловое значение → 400 invalid");
  const level27 = await httpJson("/cfg", { method: "POST", body: { universes: { strikeDamage: { levels: [0, 27], default: 0 } } }, token: adminTok });
  check(level27.status === 400 && level27.json?.reason === "invalid", "cfg: уровень 27 вне движкового юниверса → 400");

  // (г) Сужение юниверса брони + экспорт/импорт roundtrip.
  const armorPatch = await httpJson("/cfg", { method: "POST", body: { universes: { armor: { tenths: [0.3, 0.5], default: 0.5 } } }, token: adminTok });
  check(armorPatch.status === 200 && JSON.stringify(armorPatch.json?.universes?.armor) === '{"tenths":[0.3,0.5],"default":0.5,"playerSelectable":true}', "cfg: сужение брони до [0.3,0.5] (флаг выбора выведен из списка — старое тело, косвенная семантика)");

  const exportRes = await httpJson("/cfg/export", { token: adminTok });
  check(exportRes.status === 200 && exportRes.json?.atmo?.phaseMin === 9 && exportRes.json?.universes?.armor?.tenths?.length === 2 && !("apply" in (exportRes.json || {})), "cfg: GET /cfg/export — значения одним JSON");

  const mutate = structuredClone(exportRes.json);
  mutate.ok = true;
  mutate.v = 1;
  mutate.atmo.phaseMin = 11;
  const importOk = await httpJson("/cfg/import", { method: "POST", body: mutate, token: adminTok });
  check(importOk.status === 200 && importOk.json?.atmo?.phaseMin === 11, "cfg: POST /cfg/import принимает экспорт (roundtrip)");
  const badImport = await httpJson("/cfg/import", { method: "POST", body: { ok: true, atmo: { phaseMin: "му" }, universes: {} }, token: adminTok });
  check(badImport.status === 400, "cfg: битый импорт → 400");
  const afterBad = await httpJson("/cfg");
  check(afterBad.json?.atmo?.phaseMin === 11, "cfg: после битого импорта применяется прежний конфиг (без частичного)");

  // (д) Restore: path-guard и восстановление.
  const restoreEscape = await httpJson("/cfg/restore", { method: "POST", body: { name: "../../etc/passwd" }, token: adminTok });
  check(restoreEscape.status === 404 && restoreEscape.json?.reason === "unknown_backup", "cfg: restore по пути наружу → отказ (path-guard)");
  const restoreGhost = await httpJson("/cfg/restore", { method: "POST", body: { name: "zzz-несуществует.json" }, token: adminTok });
  check(restoreGhost.status === 404, "cfg: restore по незнакомому имени → отказ");

  const adminCfg = await httpJson("/cfg/admin", { token: adminTok });
  check(adminCfg.status === 200 && Object.keys(adminCfg.json?.registry || {}).length === 8, "cfg: GET /cfg/admin отдаёт метаданные реестра (8 параметров)");
  check(
    adminCfg.json?.registry?.["combat.armorCurve"]?.kind === "points" &&
      JSON.stringify(adminCfg.json?.values?.combat?.armorCurve) === JSON.stringify(canonCurve),
    "cfg: админ-снапшот несёт kind points и канон W3 в values.combat (дефолт-состояние)",
  );
  check(Array.isArray(adminCfg.json?.history) && adminCfg.json.history.length >= 1, "cfg: админ видит историю бэкапов");
  const hist = adminCfg.json.history;
  // Самый старый бэкап — снимок засеянного старого файла ( rotated at first POST).
  const oldest = hist[hist.length - 1];
  const oldestText = readFileSync(path.join(DATA, "cfg-backups", oldest), "utf8");
  check(oldestText.includes('"phaseMin": 5'), "cfg: старейший бэкап — исходный atmo-only файл");
  const restored = await httpJson("/cfg/restore", { method: "POST", body: { name: oldest }, token: adminTok });
  check(restored.status === 200 && restored.json?.restored === oldest && restored.json?.atmo?.phaseMin === 5, "cfg: restore по имени из истории вернул phaseMin 5");
  check(restored.json?.universes?.armor?.tenths?.length === 10 && restored.json?.universes?.armor?.playerSelectable === true, "cfg: restore старого формата восстанавливает universes дефолтами (миграция, флаг выведен из списка = true)");
  check(restored.json?.universes?.arrowSpeed?.playerSelectable === false && JSON.stringify(restored.json?.universes?.arrowSpeed?.periods) === "[5]", "cfg: restore наследует legacy-снапшот [5]-only стрелы без резетов (мигрировано playerSelectable=false)");

  // (д′) Кривая брони combat.armorCurve (мандат владелицы 2026-11-08):
  // POST points-кривой → публичный GET /cfg несёт её игрокам (канал cfg-live) →
  // серверный расчёт удара реально идёт по новой кривой (живой стенд ниже),
  // отказные кривые → 400 без доводки, канон в файле не трогается.
  const curveHttpPost = await httpJson("/cfg", { method: "POST", body: { combat: { armorCurve: [[0, 40], [0.5, 20], [0.9, 5]] } }, token: adminTok });
  check(
    curveHttpPost.status === 200 && JSON.stringify(curveHttpPost.json?.combat?.armorCurve) === JSON.stringify([[0, 40], [0.5, 20], [0.9, 5]]),
    "cfg-кривая: POST 3-точечной кривой принят и отражён в ответе",
  );
  const curvePub = await httpJson("/cfg");
  check(
    JSON.stringify(curvePub.json?.combat?.armorCurve) === JSON.stringify([[0, 40], [0.5, 20], [0.9, 5]]),
    "cfg-кривая: публичный GET /cfg отдаёт кривую игрокам (HUD-прогноз по ней же)",
  );
  const curveHttpBad = await httpJson("/cfg", { method: "POST", body: { combat: { armorCurve: [[0.5, 20], [0.1, 35]] } }, token: adminTok });
  check(curveHttpBad.status === 400 && curveHttpBad.json?.reason === "invalid", "cfg-кривая: несортированный x в POST → 400 invalid (валидатор не доводит)");
  const curveHttpDup = await httpJson("/cfg", { method: "POST", body: { combat: { armorCurve: [[0.1, 35], [0.1, 30]] } }, token: adminTok });
  check(curveHttpDup.status === 400 && curveHttpDup.json?.reason === "invalid", "cfg-кривая: дубликат x в POST → 400 invalid");
  const curveHttpFew = await httpJson("/cfg", { method: "POST", body: { combat: { armorCurve: [[0.1, 35]] } }, token: adminTok });
  check(curveHttpFew.status === 400 && curveHttpFew.json?.reason === "invalid", "cfg-кривая: 1 точка в POST → 400 invalid");
  const curveHttpMany = await httpJson("/cfg", { method: "POST", body: { combat: { armorCurve: Array.from({ length: 17 }, (_, i) => [i * 0.05, 55 - i]) } }, token: adminTok });
  check(curveHttpMany.status === 400 && curveHttpMany.json?.reason === "invalid", "cfg-кривая: 17 точек в POST → 400 invalid");
  const curveHttpRise = await httpJson("/cfg", { method: "POST", body: { combat: { armorCurve: [[0.1, 20], [0.2, 30]] } }, token: adminTok });
  check(curveHttpRise.status === 400 && curveHttpRise.json?.reason === "invalid", "cfg-кривая: растущий урон% в POST → 400 invalid");
  const curveHttpStill = await httpJson("/cfg");
  check(
    JSON.stringify(curveHttpStill.json?.combat?.armorCurve) === JSON.stringify([[0, 40], [0.5, 20], [0.9, 5]]),
    "cfg-кривая: после отказов кривая НЕ изменилась (всё или ничего)",
  );

  // Живой стенд расчёта удара: СВЕЖИЙ процесс серверных модулей читает
  // runtime-config (файл с POST-нутой кривой) и считает armorMultiplier.
  // Кривая [[0,40],[0.5,20],[0.9,5]]: урон% при броне 0,45 = 40 + (20−40)·(0,45/0,5)
  // = 22 → множитель 22/40 = 0,55 (первая точка — масштаб, её урон% = 100%).
  const stand = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'const m = await import("./server/combat.js"); console.log(m.armorMultiplier(0.45));'],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATA_DIR: DATA } },
  );
  const standMul = Number(String(stand.stdout || "").trim());
  check(
    stand.status === 0 && Math.abs(standMul - 0.55) < 1e-9,
    "cfg-кривая: серверный armorMultiplier(0,45) = 0,55 по POST-нутой кривой (живой расчёт удара), не по канону",
  );

  // (е) Reset.
  const resetRes = await httpJson("/cfg", { method: "POST", body: { reset: true }, token: adminTok });
  check(resetRes.status === 200 && resetRes.json?.atmo?.phaseMin === 7 && resetRes.json?.atmo?.playerControl === true && resetRes.json?.universes?.armor?.tenths?.length === 10, "cfg: reset возвращает дефолты реестра (в т.ч. мастер-гейт playerControl=true)");
  check(JSON.stringify(resetRes.json?.universes?.armor?.tenths) === JSON.stringify(defs.universes.armor.tenths), "cfg: reset совпадает с defaultsFor()");

  // (ж) Списочные админ-мутации (B2, спек §4): управление СПИСКАМИ разрешённых
  //     значений тем же POST /cfg; «выключение выбора игроками» = список из
  //     одного дефолта (серверной disabled-модели нет — контракт заморожен).
  const narrow = await httpJson("/cfg", { method: "POST", body: { universes: { strikeDamage: { levels: [0, 2, 3, 2], default: 2 } } }, token: adminTok });
  check(
    narrow.status === 200 && JSON.stringify(narrow.json?.universes?.strikeDamage) === '{"levels":[0,2,3],"default":2,"playerSelectable":true}',
    "cfg-список: сужение уровней урона до [0,2,3] (дубликат снят сервером)",
  );
  const pubNarrow = await httpJson("/cfg");
  check(
    pubNarrow.json?.universes?.strikeDamage?.levels?.length === 3 && pubNarrow.json?.universes?.strikeDamage?.default === 2,
    "cfg-список: публичный /cfg отражает сужение (клиент видит меньше вариантов)",
  );
  const widen = await httpJson("/cfg", { method: "POST", body: { universes: { strikeDamage: { levels: [0, 1, 2, 3], default: 2 } } }, token: adminTok });
  check(
    widen.status === 200 && JSON.stringify(widen.json?.universes?.strikeDamage?.levels) === JSON.stringify([0, 1, 2, 3]),
    "cfg-список: добавление значения назад ([0,2,3]→[0,1,2,3])",
  );
  const defOutside = await httpJson("/cfg", { method: "POST", body: { universes: { strikeDamage: { levels: [0, 1, 3], default: 2 } } }, token: adminTok });
  check(defOutside.status === 400 && defOutside.json?.reason === "invalid", "cfg-список: дефолт вне списка → 400 invalid (контракт §4.3)");
  const emptyList = await httpJson("/cfg", { method: "POST", body: { universes: { strikeDamage: { levels: [], default: 0 } } }, token: adminTok });
  check(emptyList.status === 400 && emptyList.json?.reason === "invalid", "cfg-список: пустой список → 400 invalid");
  const stillWide = await httpJson("/cfg");
  check(JSON.stringify(stillWide.json?.universes?.strikeDamage?.levels) === JSON.stringify([0, 1, 2, 3]), "cfg-список: после отказов значения НЕ изменились (всё или ничего)");
  const removeOne = await httpJson("/cfg", { method: "POST", body: { universes: { strikeDamage: { levels: [0, 1, 2], default: 0 } } }, token: adminTok });
  check(
    removeOne.status === 200 && JSON.stringify(removeOne.json?.universes?.strikeDamage) === '{"levels":[0,1,2],"default":0,"playerSelectable":true}',
    "cfg-список: точечное удаление значения со сдвигом дефолта ([0,1,2,3]→[0,1,2])",
  );
  const toggleOff = await httpJson("/cfg", { method: "POST", body: { universes: { arrowSpeed: { periods: [5], default: 5 } } }, token: adminTok });
  check(
    toggleOff.status === 200 && JSON.stringify(toggleOff.json?.universes?.arrowSpeed) === '{"periods":[5],"default":5,"playerSelectable":false}',
    "cfg-список: старое тело [5]-only → playerSelectable=false (косвенная семантика сохранена)",
  );
  const expNarrow = await httpJson("/cfg/export", { token: adminTok });
  check(
    expNarrow.status === 200 &&
      JSON.stringify(expNarrow.json?.universes?.strikeDamage?.levels) === JSON.stringify([0, 1, 2]) &&
      expNarrow.json?.universes?.arrowSpeed?.periods?.length === 1,
    "cfg-список: export несёт суженные списки",
  );
  const impNarrow = await httpJson("/cfg/import", { method: "POST", body: { v: 1, atmo: expNarrow.json?.atmo, universes: expNarrow.json?.universes }, token: adminTok });
  check(
    impNarrow.status === 200 &&
      JSON.stringify(impNarrow.json?.universes?.strikeDamage?.levels) === JSON.stringify([0, 1, 2]) &&
      impNarrow.json?.universes?.arrowSpeed?.periods?.length === 1,
    "cfg-список: import roundtrip сохраняет суженные списки",
  );
  const histNarrow = await httpJson("/cfg/admin", { token: adminTok });
  const latestBackup = histNarrow.json?.history?.[0];
  check(!!latestBackup, "cfg-список: история бэкапов продолжает пополняться после списочных мутаций");
  const restoreNarrow = await httpJson("/cfg/restore", { method: "POST", body: { name: latestBackup }, token: adminTok });
  check(
    restoreNarrow.status === 200 &&
      JSON.stringify(restoreNarrow.json?.universes?.strikeDamage?.levels) === JSON.stringify([0, 1, 2]) &&
      restoreNarrow.json?.universes?.arrowSpeed?.periods?.length === 1,
    "cfg-список: restore последнего бэкапа жив поверх списочных мутаций",
  );

  // (з) F2 §4: явный playerSelective поверх сохранённого allowedValues.
  //     Кураторский список живёт на сервере отдельно от флага: выключение
  //     выбора НЕ режет список, повторное включение возвращает его (не юниверс).
  const curated = await httpJson("/cfg", { method: "POST", body: { universes: { arrowSpeed: { periods: [2.5, 3.5, 4, 5], default: 5 } } }, token: adminTok });
  check(
    curated.status === 200 &&
      JSON.stringify(curated.json?.universes?.arrowSpeed?.periods) === JSON.stringify([2.5, 3.5, 4, 5]) &&
      curated.json?.universes?.arrowSpeed?.playerSelectable === true,
    "cfg-§4: кураторский список [2.5,3.5,4,5] сохранён (список>1 => выбор включён)",
  );
  const flagOff = await httpJson("/cfg", { method: "POST", body: { universes: { arrowSpeed: { playerSelectable: false } } }, token: adminTok });
  check(
    flagOff.status === 200 &&
      JSON.stringify(flagOff.json?.universes?.arrowSpeed?.periods) === "[5]" &&
      flagOff.json?.universes?.arrowSpeed?.playerSelectable === false,
    "cfg-§4: тело-только-флаг: ответ — замороженная публичная проекция (игроку [default]), allowedValues живёт в файле/admin-виде",
  );
  const pubOff = await httpJson("/cfg");
  check(
    JSON.stringify(pubOff.json?.universes?.arrowSpeed?.periods) === "[5]" && pubOff.json?.universes?.arrowSpeed?.playerSelectable === false,
    "cfg-§4: при выключенном выборе игроку отдаётся только defaultValue",
  );
  const storedNow = JSON.parse(readFileSync(FILE, "utf8"));
  check(
    storedNow?.universes?.arrowSpeed?.periods?.length === 4 && storedNow?.universes?.arrowSpeed?.playerSelectable === false,
    "cfg-§4: persisted-файл хранит полный кураторский список + явный флаг (список не стирается)",
  );
  const badFlagStr = await httpJson("/cfg", { method: "POST", body: { universes: { arrowSpeed: { playerSelectable: "false" } } }, token: adminTok });
  check(badFlagStr.status === 400 && badFlagStr.json?.reason === "invalid", "cfg-§4: playerSelectable строкой → 400 invalid (строго true/false)");
  const badFlagNum = await httpJson("/cfg", { method: "POST", body: { universes: { arrowSpeed: { playerSelectable: 1 } } }, token: adminTok });
  check(badFlagNum.status === 400 && badFlagNum.json?.reason === "invalid", "cfg-§4: playerSelectable числом → 400 invalid");
  const flagOn = await httpJson("/cfg", { method: "POST", body: { universes: { arrowSpeed: { playerSelectable: true } } }, token: adminTok });
  check(
    flagOn.status === 200 &&
      JSON.stringify(flagOn.json?.universes?.arrowSpeed?.periods) === JSON.stringify([2.5, 3.5, 4, 5]) &&
      flagOn.json?.universes?.arrowSpeed?.playerSelectable === true,
    "cfg-§4: повторное включение возвращает кураторский список [2.5,3.5,4,5], а НЕ весь юниверс (фикс off-then-on)",
  );
  const openAdmin = await httpJson("/cfg/admin", { token: adminTok });
  check(
    JSON.stringify(openAdmin.json?.values?.universes?.arrowSpeed?.periods) === JSON.stringify([2.5, 3.5, 4, 5]),
    "cfg-§4: админ-дашборд видит полный список даже при выключенном/включённом выборе (playerView=false)",
  );
  // Рестарт сервера: custom list + флаг переживают процесс (persisted, не UI-состояние).
  await stopServer();
  startServer();
  await waitReady();
  const afterRestart = await httpJson("/cfg");
  check(
    JSON.stringify(afterRestart.json?.universes?.arrowSpeed?.periods) === JSON.stringify([2.5, 3.5, 4, 5]) &&
      afterRestart.json?.universes?.arrowSpeed?.playerSelectable === true,
    "cfg-§4: кураторский список цел после рестарта сервера (reload = новый fetch с сервера)",
  );

  const finalReset = await httpJson("/cfg", { method: "POST", body: { reset: true }, token: adminTok });
  check(
    finalReset.status === 200 &&
      finalReset.json?.universes?.strikeDamage?.levels?.length === 10 &&
      finalReset.json?.universes?.arrowSpeed?.periods?.length === 6 &&
      finalReset.json?.universes?.strikeDamage?.playerSelectable === true &&
      finalReset.json?.universes?.armor?.playerSelectable === true,
    "cfg-список: финальный reset возвращает полные движковые юниверсы с выбором (дефолтное состояние реестра)",
  );
} catch (e) {
  failures += 1;
  console.error("FAIL exception", e);
} finally {
  server.kill("SIGTERM");
}

if (failures) {
  console.error(`cfg-registry tests: FAIL (${failures})`);
  process.exit(1);
}
console.log("cfg-registry tests: зелёный");
