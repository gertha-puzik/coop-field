#!/usr/bin/env node
/**
 * Живой тест админ-операции «сброс положения игрока на поле» (server/admin-ops.js,
 * /admin/players*). Песочница: mkdtemp-DATA_DIR (никаких записей в data репо),
 * свободный порт, спавн server.js. Стенд под AUTH_CSRF_STRICT=1 — так отрицание
 * «POST без Origin» проверяется без второго стенда (1337-хост не нужен).
 *
 * Позитив:
 *   1. админ повышается лестницей S1 (регистр → стоп → make-admin → старт);
 *   2. WS-кот садится в «тест» и уходит freemove в точку (8.4, 5.7) — точка
 *      попадает в книгу data/test-cats.json (троттлинг 3 с);
 *   3. GET /admin/players видит комнату и кота: живые координаты x/y + точка fx/fy;
 *   4. POST /admin/players/reset переносит кота на свежую клетку спавна:
 *      ответ 200 с новыми координатами, кадр EV.MOVE доезжает WS-клиенту,
 *      координаты меняются, персистная запись кота стирается из книги;
 *   5. повторный join с тем же логином НЕ возвращает прежнюю точку freemove.
 *
 * Негатив:
 *   - GET без сессии → 401 auth_required;
 *   - GET сессией не-админа → 403 forbidden;
 *   - POST сброса без Origin (CSRF-щит apiZone) → 403 csrf_origin_required;
 *   - POST сброса с несуществующей комнатой → 400 unknown_room (message читаем);
 *   - POST сброса с несуществующим котом → 400 unknown_cat (message читаем);
 *   - POST сброса с лишним полем → 400 unexpected_fields;
 *   - POST promote без Origin → 403 csrf_origin_required;
 *   - POST promote не-админом → 403 forbidden;
 *   - POST promote неизвестного логина → 400 no_such_login.
 *
 * Promote (права admin):
 *   - POST /admin/players/promote {login} выдаёт роль; повтор — already;
 *   - GET /admin/players у аккаунтного кота отдаёт accountLogin/accountRole.
 *
 * Ошибка «нет свободной клетки спавна» покрыта кодом роута (reason no_free_cell),
 * в живом тесте не разыгрывается: для неё нужно заполнить поле ногами (30 котов).
 *
 * Запуск: node scripts/test-admin-reset.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { sendJoin } from "./ws-auth.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-admin-reset-"));
const PORT = 4300 + Math.floor(Math.random() * 60);
const HOST = "127.0.0.1";
const HTTP = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;
const ORIGIN = `http://${HOST}:${PORT}`; // цикличный origin: классу local разрешён
// qa-логин приведён к строгому формату создания (register v2, мандат 2026-11-08:
// кириллица в логине регистрации больше не проходит; видимым именем «Герта»
// тест-аккаунт подписывается через поле name профиля).
const ADMIN = "gertha_q";
const USER = "pivnoy_q";
const CAT = `reset-target-${Math.floor(Math.random() * 1e6)}`;
const FM = { x: 8.4, y: 5.7 }; // дальняя точка freemove (та же, что в test-position-persist)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
};

let server = null;
let serverLog = "";
function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST,
      DATA_DIR: DATA,
      ADMIN_PASS: "1946",
      AUTH_CSRF_STRICT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { serverLog += String(d); });
  server.stderr.on("data", (d) => { serverLog += String(d); process.stderr.write(d); });
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

/** HTTP-хелпер: JSON-запрос с опциональной cookie-сессией и Origin —
 *  положительные POST-ы строятся как браузер (Origin обязателен при strict). */
const httpJson = async (pathname, { method = "GET", body, token, origin } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.cookie = `coop_session=${token}`;
  if (origin) headers.origin = origin;
  const res = await fetch(`${HTTP}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

/** WS-клиент: в «тест» через sendJoin (register/login → join), inbox-осмотр. */
function wsClient(name, roomCode = "test") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.inbox = [];
    ws.on("message", (raw) => ws.inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.once("open", () => {
      sendJoin(ws, { room: roomCode, login: name });
      resolve(ws);
    });
  });
}
const waitFor = (ws, pred, ms = 5000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ws.inbox.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout; inbox=${JSON.stringify(ws.inbox.slice(-8))}`));
      setTimeout(tick, 15);
    };
    tick();
  });

const catsFile = path.join(DATA, "test-cats.json");
const readBook = () => JSON.parse(readFileSync(catsFile, "utf8"));

try {
  startServer();
  await waitReady();

  // Аккаунты: обычный игрок (403-ветка) и будущий админ.
  const userReg = await httpJson("/auth/register", { method: "POST", body: { login: USER, pass: "password1", name: "Пивной" } });
  const userTok = userReg.json?.token;
  check(!!userTok, "регистрация не-админа");
  const adminReg = await httpJson("/auth/register", { method: "POST", body: { login: ADMIN, pass: "password1" } });
  check(!!adminReg.json?.token, "регистрация будущего админа (role=registered)");
  await stopServer();
  const cliOut = execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), ADMIN], {
    env: { ...process.env, DATA_DIR: DATA },
    encoding: "utf8",
  });
  check(/повышен|уже админ/.test(cliOut), "make-admin повышает аккаунт (лестница S1)");
  startServer();
  await waitReady();
  const adminLogin = await httpJson("/auth/login", { method: "POST", body: { login: ADMIN, pass: "password1" } });
  const adminTok = adminLogin.json?.token;
  check(!!adminTok, "вход админа");

  // Негатив-гейты ДО геймплея: без сессии 401, не-админ 403.
  const anonList = await httpJson("/admin/players");
  check(anonList.status === 401 && anonList.json?.reason === "auth_required", "GET список без сессии → 401 auth_required");
  const userList = await httpJson("/admin/players", { token: userTok });
  check(userList.status === 403 && userList.json?.reason === "forbidden", "GET список не-админом → 403 forbidden");

  // Кот на поле: join в «тест», freemove в дальнюю точку.
  const ws = await wsClient(CAT);
  const field = await waitFor(ws, ([ev, p]) => ev === "field" && p.format === "test");
  const me = (field[1].cats || []).find((c) => c.login === CAT);
  check(!!me, "кот вошёл в «тест» (кадр field)");
  ws.send(JSON.stringify(["freemove", { x: FM.x, y: FM.y, stop: true }]));
  await waitFor(ws, ([ev, p]) => ev === "info" || (ev === "freemove" && p.stop), 800).catch(() => {});
  await sleep(3400); // троттлинг книги точек: 3 с
  check(existsSync(catsFile), "книга точек записана на диск");
  let book = readBook();
  const rec0 = book.cats[CAT.toLowerCase()];
  check(!!rec0 && rec0.fm === 1 && Math.abs(rec0.fx - FM.x) < 0.01 && Math.abs(rec0.fy - FM.y) < 0.01,
    `точка freemove в книге: ${JSON.stringify(rec0)}`);

  // Список занятости: комната, кот, живые координаты и точка.
  const list1 = await httpJson("/admin/players", { token: adminTok });
  const room1 = list1.json?.rooms?.find((r) => r.room === "test");
  const row1 = room1?.cats?.find((c) => c.login === CAT);
  check(list1.status === 200 && !!room1 && room1.count === 1, "список видит комнату «тест» с котом");
  check(!!row1 && row1.id === me.id && typeof row1.x === "number" && typeof row1.y === "number" && !!row1.sprite,
    `строка кота с координатами и спрайтом: ${JSON.stringify(row1)}`);
  check(!!row1 && row1.fm === 1 && Math.abs(row1.fx - FM.x) < 0.01 && Math.abs(row1.fy - FM.y) < 0.01,
    "список отдаёт freemove-точку кота");

  // Негатив: CSRF-щит apiZone — POST с cookie, но без Origin.
  const noOrigin = await httpJson("/admin/players/reset", {
    method: "POST",
    body: { room: "test", login: CAT },
    token: adminTok,
  });
  check(noOrigin.status === 403 && noOrigin.json?.reason === "csrf_origin_required",
    "сброс без Origin отклонён (CSRF-щит) → 403 csrf_origin_required");

  // Негатив: несуществующие комната/кот, мусорное поле.
  const badRoom = await httpJson("/admin/players/reset", {
    method: "POST",
    body: { room: "marja", login: CAT },
    token: adminTok,
    origin: ORIGIN,
  });
  check(badRoom.status === 400 && badRoom.json?.reason === "unknown_room" && typeof badRoom.json?.message === "string",
    "несуществующая комната → 400 unknown_room с человекочитаемым message");
  const badCat = await httpJson("/admin/players/reset", {
    method: "POST",
    body: { room: "test", login: "no-such-cat" },
    token: adminTok,
    origin: ORIGIN,
  });
  check(badCat.status === 400 && badCat.json?.reason === "unknown_cat" && typeof badCat.json?.message === "string",
    "несуществующий кот → 400 unknown_cat с человекочитаемым message");
  const extraField = await httpJson("/admin/players/reset", {
    method: "POST",
    body: { room: "test", login: CAT, force: true },
    token: adminTok,
    origin: ORIGIN,
  });
  check(extraField.status === 400 && extraField.json?.reason === "unexpected_fields",
    "лишнее поле тела → 400 unexpected_fields");

  // Позитив: сброс. Прежнюю клетку замерили выше (row1.x/row1.y).
  const preX = row1.x;
  const preY = row1.y;
  const moveSeen = waitFor(ws, ([ev, p]) => ev === "move" && p.id === me.id);
  const resetRes = await httpJson("/admin/players/reset", {
    method: "POST",
    body: { room: "test", login: CAT },
    token: adminTok,
    origin: ORIGIN,
  });
  check(resetRes.status === 200 && resetRes.json?.ok === true &&
    typeof resetRes.json?.x === "number" && typeof resetRes.json?.y === "number" && !!resetRes.json?.sprite,
    `сброс отвечает ок с новыми координатами: ${JSON.stringify(resetRes.json)}`);
  check(resetRes.json?.x !== preX || resetRes.json?.y !== preY,
    `координаты изменились (${preX},${preY} → ${resetRes.json?.x},${resetRes.json?.y})`);
  const frame = await moveSeen;
  check(frame[1].x === resetRes.json?.x && frame[1].y === resetRes.json?.y && frame[1].id === me.id,
    `кадр EV.MOVE с новыми координатами дошёл WS-клиенту: ${JSON.stringify(frame[1])}`);

  // Персистная точка кота стёрта из книги, список отдаёт новую клетку.
  book = readBook();
  check(book.cats[CAT.toLowerCase()] === undefined, "freemove-точка стёрта из книги точек");
  const list2 = await httpJson("/admin/players", { token: adminTok });
  const row2 = list2.json?.rooms?.find((r) => r.room === "test")?.cats?.find((c) => c.login === CAT);
  check(!!row2 && row2.x === resetRes.json?.x && row2.y === resetRes.json?.y,
    "список после сброса отдаёт свежую клетку");

  // Повторный join тем же логином: прежняя точка НЕ восстанавливается.
  ws.close();
  await sleep(300);
  const ws2 = await wsClient(CAT);
  const field2 = await waitFor(ws2, ([ev, p]) => ev === "field" && p.format === "test");
  const me2 = (field2[1].cats || []).find((c) => c.login === CAT);
  check(!!me2, "повторный join с тем же логином");
  const backToOldPoint = me2 && me2.fm === 1 &&
    Math.abs(me2.fx - FM.x) < 0.02 && Math.abs(me2.fy - FM.y) < 0.02;
  check(!backToOldPoint,
    `прежняя точка freemove не вернулась после повторного join: ${JSON.stringify({ fm: me2?.fm, fx: me2?.fx, fy: me2?.fy })}`);
  ws2.close();

  // Promote: CSRF / роль / неизвестный логин / позитив + already.
  const promoteNoOrigin = await httpJson("/admin/players/promote", {
    method: "POST",
    body: { login: USER },
    token: adminTok,
  });
  check(promoteNoOrigin.status === 403 && promoteNoOrigin.json?.reason === "csrf_origin_required",
    "promote без Origin → 403 csrf_origin_required");
  const promoteUser = await httpJson("/admin/players/promote", {
    method: "POST",
    body: { login: ADMIN },
    token: userTok,
    origin: ORIGIN,
  });
  check(promoteUser.status === 403 && promoteUser.json?.reason === "forbidden",
    "promote не-админом → 403 forbidden");
  const promoteMissing = await httpJson("/admin/players/promote", {
    method: "POST",
    body: { login: "no_such_account_xyz" },
    token: adminTok,
    origin: ORIGIN,
  });
  check(promoteMissing.status === 400 && promoteMissing.json?.reason === "no_such_login",
    "promote неизвестного логина → 400 no_such_login");
  const promoteOk = await httpJson("/admin/players/promote", {
    method: "POST",
    body: { login: USER },
    token: adminTok,
    origin: ORIGIN,
  });
  check(promoteOk.status === 200 && promoteOk.json?.ok === true && promoteOk.json?.role === "admin" &&
    promoteOk.json?.login === USER && promoteOk.json?.already !== true,
    `promote выдаёт admin: ${JSON.stringify(promoteOk.json)}`);
  const promoteAgain = await httpJson("/admin/players/promote", {
    method: "POST",
    body: { login: USER },
    token: adminTok,
    origin: ORIGIN,
  });
  check(promoteAgain.status === 200 && promoteAgain.json?.already === true && promoteAgain.json?.role === "admin",
    "promote повтор — already");
  // Аккаунт USER после promote входит как admin.
  const userRelog = await httpJson("/auth/login", { method: "POST", body: { login: USER, pass: "password1" } });
  check(userRelog.status === 200 && userRelog.json?.role === "admin",
    "после promote вход USER даёт role=admin");

  // Аккаунтный кот на поле: список несёт accountLogin/accountRole.
  const wsAcc = await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.inbox = [];
    ws.on("message", (raw) => ws.inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.once("open", () => resolve(ws));
  });
  wsAcc.send(JSON.stringify(["auth", { action: "login", login: USER, pass: "password1" }]));
  await waitFor(wsAcc, ([ev, p]) => ev === "whoami" && p?.ok === true && p?.role === "admin" && p?.accountId);
  wsAcc.send(JSON.stringify(["join", { room: "test" }]));
  await waitFor(wsAcc, ([ev]) => ev === "field");
  const listAcc = await httpJson("/admin/players", { token: adminTok });
  const rowAcc = (listAcc.json?.rooms || [])
    .flatMap((r) => r.cats || [])
    .find((c) => c.accountLogin === USER);
  check(!!rowAcc && rowAcc.accountRole === "admin",
    `список отдаёт accountLogin/accountRole для аккаунтного кота: ${JSON.stringify(rowAcc)}`);
  wsAcc.close();

  await stopServer();
} catch (e) {
  failures += 1;
  console.log("FAIL  исключение теста:", e.message);
  await stopServer();
} finally {
  // Песочница одноразовая: сервер остановлен выше, mkdtemp-каталог удаляем сами.
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* уже нет */ }
}

if (failures) {
  console.log(`admin-reset: ${failures} FAIL`);
  process.exit(1);
}
console.log("admin-reset: OK");
