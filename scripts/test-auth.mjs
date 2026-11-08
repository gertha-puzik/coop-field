/**
 * Аккаунты, сессии, доступ Элизии (фаза 2 + pr-41 харднинг + P1 сплит доменов).
 *
 *  1. store: регистрация, повторный login, чужой пароль, короткое имя, занятое имя;
 *  2. гость входит в grot-1 (you+field), в test — refuse auth_required + noplace;
 *  3. register по WS → whoami + token; join test — you; login не с клиента;
 *  4. HTTP POST /auth/register и /auth/login;
 *  5. книга позиций: тот же login после регистрации поднимает fx/fy;
 *  6. guest join после logout снова не пускает в test;
 *  7. (pr-41→S1) второй sandbox с заниженными порогами: BOOTSTRAP_ADMIN-СПИСОК
 *     (оба имени → роль registered, автоназначения admin больше нет;
 *     роль даёт только CLI make-admin), register-флуд с подделанным XFF ловится по
 *     ПОСЛЕДНЕМУ хопу, MAX_ACCOUNTS → 'full', per-LOGIN замок неудачных
 *     входов (успех сбрасывает, окно отпускает), roomsinfo-«призрак»
 *     (гость не видит ЗАНИМАЕМОСТЬ закрытой комнаты — комната как бы не
 *     существует: count 0 без имён; аккаунт видит реальный состав);
 *  8. (P1) третий sandbox с PUBLIC_HOSTS/ELYRIA_HOSTS: HTTP-гейт public-хоста
 *     (/auth, POST /cfg, /profiles → 404, GET /cfg жив), WS-кадры register/
 *     login на public — отказ без деталей (hello/logout гостя живы), CSRF
 *     Origin (чужой → 403 csrf, белый → доходит до логина), матрица токенов
 *     на elyria (тела без token, приём ?t= выключен, cookie работает),
 *     https-cookie SameSite=Lax+Secure; join по коду combat → поле room
 *     grot-1 (снятая комната алиасится в RETIRED_ROOMS);
 *  9. (P2) там же: admin-маршруты конфига — /cfg/admin и /cfg/export на
 *     public-хосте 404, гость/не-админ на elyria 403, админ 200 с registry.
 *
 * Запуск: node scripts/test-auth.mjs (сам спавнит server.js в песочнице DATA_DIR).
 */
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-auth-"));
const PORT = 3920 + Math.floor(Math.random() * 40);
const HOST = "127.0.0.1";
const WS = `ws://${HOST}:${PORT}`;
const HTTP = `http://${HOST}:${PORT}`;

process.env.DATA_DIR = DATA;
process.env.BOOTSTRAP_ADMIN = "Герта";

const accounts = await import("../server/accounts.js");
const modes = await import("../server/modes.js");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(query = "") {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS + query);
    const inbox = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.inbox = inbox;
    ws.once("open", () => resolve(ws));
  });
}

const waitFor = (ws, pred, ms = 4000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ws.inbox.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) {
        return reject(new Error(`timeout; inbox=${JSON.stringify(ws.inbox.slice(-10))}`));
      }
      setTimeout(tick, 15);
    };
    tick();
  });

/** Ждём, пока сервер на wsUrl начнёт принимать сокеты (прогрев после spawn). */
async function waitReady(wsUrl) {
  for (let i = 0; i < 80; i += 1) {
    const ok = await new Promise((resolve) => {
      const probe = new WebSocket(wsUrl);
      probe.once("open", () => {
        probe.terminate();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(80);
  }
  throw new Error(`server not ready: ${wsUrl}`);
}

check(modes.requiresAccount("test") === true, "modes: test closed");
check(modes.requiresAccount("grot-1") === false, "modes: grot open");
check(modes.requiresAccount("combat") === false, "modes: combat open");
check(modes.requiresAccount("hunger") === false, "modes: hunger open");
check(modes.requiresAccount("custom-xyz") === false, "modes: unknown code open");

const made = await accounts.createAccount("Сырь", "password1");
check(!!made.account, "store: register Сырь");
check(made.account?.role === "registered" || made.account?.role === "admin", "store: role set");
const again = await accounts.createAccount("Сырь", "password1");
check(again.error === "taken", "store: duplicate login");
const weak = await accounts.createAccount("Пух", "123");
check(weak.error === "weak", "store: short password");
const short = await accounts.createAccount("Я", "password1");
check(short.error === "short", "store: short login");
const bad = await accounts.loginAccount("Сырь", "wrongpass");
check(bad.error === "bad", "store: bad password");
const okLogin = await accounts.loginAccount("Сырь", "password1");
check(!!okLogin.account, "store: login ok");

mkdirSync(DATA, { recursive: true });
writeFileSync(
  path.join(DATA, "test-cats.json"),
  JSON.stringify({
    v: 1,
    cats: {
      сырь: { login: "Сырь", fm: 1, fx: 3.25, fy: 2.5, x: 4, y: 3, ts: Date.now() },
    },
  }),
);

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST, DATA_DIR: DATA, BOOTSTRAP_ADMIN: "Герта" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));

try {
  for (let i = 0; i < 80; i += 1) {
    const ok = await new Promise((resolve) => {
      const probe = new WebSocket(WS);
      probe.once("open", () => {
        probe.terminate();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (ok) break;
    await sleep(80);
  }

  const guest = await client();
  await waitFor(guest, (m) => m[0] === "whoami");
  guest.send(JSON.stringify(["join", { room: "grot-1", login: "ГостьГрот" }]));
  const youGrot = await waitFor(guest, (m) => m[0] === "you");
  check(!!youGrot[1]?.id, "guest: grot-1 you");
  guest.close();
  const guest2 = await client();
  await waitFor(guest2, (m) => m[0] === "whoami");
  guest2.send(JSON.stringify(["join", { room: "test", login: "ГостьГрот" }]));
  const refuse = await waitFor(guest2, (m) => m[0] === "refuse" && m[1]?.code === "auth_required");
  const noplace = await waitFor(guest2, (m) => m[0] === "noplace" && m[1]?.reason === "auth_required");
  check(!!refuse, "guest: test refuse auth_required");
  check(!!noplace, "guest: test noplace auth_required");
  check(
    /недоступна без входа/.test(String(refuse[1]?.text || "")) && !/элизия/i.test(String(refuse[1]?.text || "")),
    "guest: текст отказа обобщён (не называет Элизию)",
  );
  guest2.close();

  const authed = await client();
  authed.send(JSON.stringify(["auth", { action: "register", login: "Элис", pass: "password1" }]));
  const who = await waitFor(authed, (m) => m[0] === "whoami" && m[1]?.ok && m[1]?.accountId);
  check(!!who[1].token, "ws register: token");
  check(who[1].login === "Элис", "ws register: login");
  authed.send(JSON.stringify(["join", { room: "test", login: "Хакер", sprite: "blestyashka", size: 80 }]));
  const youTest = await waitFor(authed, (m) => m[0] === "you");
  check(youTest[1].login === "Элис", "ws join test: identity from account, not payload.login");
  authed.close();

  const gertha = await client();
  gertha.send(JSON.stringify(["auth", { action: "register", login: "Герта", pass: "password1" }]));
  const whoAdmin = await waitFor(gertha, (m) => m[0] === "whoami" && m[1]?.login === "Герта");
  // S1 (аудит Z.AI): регистрация имени из BOOTSTRAP_ADMIN больше НЕ назначает
  // роль admin — кто угодно мог занять имя раньше владелицы и стать админом.
  check(whoAdmin[1].role !== "admin", "S1: bootstrap-имя регистрируется БЕЗ роли admin");
  gertha.close();

  const resReg = await fetch(`${HTTP}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: "HttpKot", pass: "password1" }),
  });
  const httpReg = await resReg.json();
  check(resReg.ok && httpReg.ok && httpReg.token, "http register");

  const resLogin = await fetch(`${HTTP}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: "HttpKot", pass: "password1" }),
  });
  const httpLogin = await resLogin.json();
  check(resLogin.ok && httpLogin.ok && httpLogin.token, "http login");

  const resBad = await fetch(`${HTTP}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: "HttpKot", pass: "nope-nope" }),
  });
  const httpBad = await resBad.json();
  check(resBad.status === 401 && httpBad.ok === false, "http bad password");

  // (P1-б) https-сессия через x-forwarded-proto: Set-Cookie обязан стать
  // Secure + SameSite=Lax (не None — кросс-сайт перенос кук больше не нужен).
  const resSecure = await fetch(`${HTTP}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
    body: JSON.stringify({ login: "HttpsKot", pass: "password1" }),
  });
  const setCookie = resSecure.headers.get("set-cookie") || "";
  check(
    setCookie.includes("SameSite=Lax") && setCookie.includes("Secure") && !setCookie.includes("None"),
    "http register https: cookie SameSite=Lax + Secure (без None)",
  );

  const withTok = await client(`/?t=${httpLogin.token}`);
  const hello = await waitFor(withTok, (m) => m[0] === "whoami" && m[1]?.accountId);
  check(hello[1].login === "HttpKot", "handshake query t binds session");
  withTok.send(JSON.stringify(["join", { room: "test" }]));
  const youTok = await waitFor(withTok, (m) => m[0] === "you");
  check(youTok[1].login === "HttpKot", "join test with handshake token");
  withTok.close();

  const pos = await client();
  pos.send(JSON.stringify(["auth", { action: "login", login: "Сырь", pass: "password1" }]));
  await waitFor(pos, (m) => m[0] === "whoami" && m[1]?.ok && m[1]?.login === "Сырь");
  pos.send(JSON.stringify(["join", { room: "test" }]));
  const youPos = await waitFor(pos, (m) => m[0] === "you");
  const restored = youPos[1].fm === 1 && Math.abs(youPos[1].fx - 3.25) < 0.05 && Math.abs(youPos[1].fy - 2.5) < 0.05;
  check(restored || Number.isInteger(youPos[1].x), "elision join after migrate: you arrived (peace point if map allows)");
  pos.send(JSON.stringify(["auth", { action: "logout" }]));
  await waitFor(pos, (m) => m[0] === "whoami" && m[1]?.role === "guest");
  pos.close();
  const after = await client();
  await waitFor(after, (m) => m[0] === "whoami");
  after.send(JSON.stringify(["join", { room: "test", login: "Сырь" }]));
  const afterOut = await waitFor(after, (m) => m[0] === "refuse" || m[0] === "noplace");
  check(afterOut[1]?.code === "auth_required" || afterOut[1]?.reason === "auth_required", "logout: test closed again");
  after.close();

  const combatGuest = await client();
  await waitFor(combatGuest, (m) => m[0] === "whoami");
  combatGuest.send(JSON.stringify(["join", { room: "combat", login: "Боец" }]));
  const youCombat = await waitFor(combatGuest, (m) => m[0] === "you");
  check(youCombat[1].login === "Боец", "guest: combat you");
  const fieldCombat = await waitFor(combatGuest, (m) => m[0] === "field");
  check(
    fieldCombat[1]?.room === "grot-1",
    "retired combat: join по коду combat привёл в grot-1 (RETIRED_ROOMS)",
  );
  combatGuest.close();

  const hungerGuest = await client();
  await waitFor(hungerGuest, (m) => m[0] === "whoami");
  hungerGuest.send(JSON.stringify(["join", { room: "hunger", login: "Голод" }]));
  const youHunger = await waitFor(hungerGuest, (m) => m[0] === "you");
  check(youHunger[1].login === "Голод", "guest: hunger you");
  hungerGuest.close();

  const cfgGet = await fetch(`${HTTP}/cfg`);
  const cfgBody = await cfgGet.json();
  check(cfgGet.ok && cfgBody.atmo && cfgBody.atmo.phaseMin >= 1, "cfg get public");
  const cfgGuest = await fetch(`${HTTP}/cfg`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ atmo: { phaseMin: 9, weatherMin: 20 } }),
  });
  check(cfgGuest.status === 403, "cfg post guest forbidden");

  // ---------- S1: назначение admin одноразовым CLI (как владелица на проде).
  // Сервер останавливаем: он держит сте в памяти и перезапишет файл; CLI
  // повышает существующий bootstrap-аккаунт, повтор — idempotent.
  const waitExit = (child) =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once("exit", resolve);
    });
  server.kill("SIGTERM");
  await waitExit(server);
  const cliEnv = { ...process.env, DATA_DIR: DATA };
  const cli1 = execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), "Герта"], {
    env: cliEnv,
    encoding: "utf8",
  });
  check(/повышен/.test(cli1), "S1: make-admin повышает существующий аккаунт (CLI, код возврата 0)");
  const cli2 = execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), "Герта"], {
    env: cliEnv,
    encoding: "utf8",
  });
  check(/уже админ/.test(cli2), "S1: make-admin повтор — idempotent (уже admin, код возврата 0)");
  let cli3Code = 0;
  try {
    execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), "Никогда-не-существует"], {
      env: cliEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (e) {
    cli3Code = e.status ?? 1;
  }
  check(cli3Code !== 0, "S1: make-admin без пароля для нового имени — отказ (не создаёт вслепую)");

  const serverB = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST, DATA_DIR: DATA, BOOTSTRAP_ADMIN: "Герта" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverB.stderr.on("data", (d) => process.stderr.write(d));
  try {
    await waitReady(WS);
    const resAdminLogin = await fetch(`${HTTP}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ login: "Герта", pass: "password1" }),
    });
    const adminLogin = await resAdminLogin.json();
    check(
      resAdminLogin.ok && adminLogin.role === "admin" && adminLogin.login === "Герта",
      "S1: после make-admin вход даёт роль admin (пароль-хеш сохранён)",
    );
    const cfgAdmin = await fetch(`${HTTP}/cfg?t=${adminLogin.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ atmo: { phaseMin: 9, weatherMin: 20 } }),
    });
    const cfgSaved = await cfgAdmin.json();
    check(cfgAdmin.ok && cfgSaved.atmo?.phaseMin === 9, "cfg post admin");
  } finally {
    serverB.kill("SIGTERM");
  }
} catch (e) {
  failures += 1;
  console.error("FAIL exception", e);
} finally {
  server.kill("SIGTERM");
}

/* ---------- pr-41: изоляция Элизии и auth-харднинг (второй sandbox) ----------
 * Свой server.js со заниженными порогами — детерминированные проверки без
 * sleep-магии: BOOTSTRAP_ADMIN="Герта, лИзА" (список), MAX_ACCOUNTS=8,
 * per-login замок = 2 неудачи за окно 300 мс. Порт — отдельный свободный. */
const DATA2 = mkdtempSync(path.join(tmpdir(), "coop-auth-hard-"));
const PORT2 = 3960 + Math.floor(Math.random() * 30);
const WS2 = `ws://${HOST}:${PORT2}`;

const server2 = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT2),
    HOST,
    DATA_DIR: DATA2,
    BOOTSTRAP_ADMIN: "Герта, лИзА",
    MAX_ACCOUNTS: "8",
    AUTH_LOGIN_FAIL_MAX: "2",
    AUTH_LOGIN_FAIL_WINDOW_MS: "300",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server2.stderr.on("data", (d) => process.stderr.write(d));

try {
  await waitReady(WS2);

  /** Клиент на второй сервер с произвольными заголовками (XFF-пробы). */
  const client2 = (headers) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(WS2, { headers: headers || {} });
      const inbox = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
      ws.on("error", reject);
      ws.inbox = inbox;
      ws.once("open", () => resolve(ws));
    });

  /** waitFor от индекса from: на одном сокете несколько auth-кадров подряд. */
  const waitForFrom = (ws, pred, from, ms = 4000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const hit = ws.inbox.slice(from).find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) {
          return reject(new Error(`timeout; inbox=${JSON.stringify(ws.inbox.slice(-10))}`));
        }
        setTimeout(tick, 15);
      };
      tick();
    });

  const registerFrame = (ws, login) =>
    ws.send(JSON.stringify(["auth", { action: "register", login, pass: "password1" }]));
  const loginFrame = (ws, login, pass) =>
    ws.send(JSON.stringify(["auth", { action: "login", login, pass }]));
  const registeredOk = (m) => m[0] === "whoami" && m[1]?.ok && m[1]?.accountId;

  // (в) BOOTSTRAP_ADMIN-СПИСОК (S1, аудит Z.AI): регистрация имени из списка
  // больше НЕ даёт роли — у каждого НЕзависимо от списка обычная роль; роль
  // назначает только CLI владелицы. Пробелы/регистр по-прежнему: trim+lower.
  const gA = await client2();
  registerFrame(gA, "  гЕРТА "); // пробелы и регистр: список сравнивается после trim+lower
  const whoGA = await waitForFrom(gA, registeredOk, 0);
  check(whoGA[1]?.role === "registered", "S1 list: имя №1 из BOOTSTRAP_ADMIN → роль НЕ admin");
  gA.close();

  const gB = await client2();
  registerFrame(gB, "  лИзА ");
  const whoGB = await waitForFrom(gB, registeredOk, 0);
  check(whoGB[1]?.role === "registered", "S1 list: имя №2 из списка → тоже НЕ admin (независимо)");
  gB.close();

  // (б) register-флуд с ПОДДЕЛАННЫМ XFF: loopback-сокет + XFF → лимит
  // ключуется ПОСЛЕДНИМ хопом. Первый хоп — клиентская подделка: смена его
  // (9.9.9.9 → 4.4.4.4) не должна обходить лимит (старый код доверял первому).
  const XFF_LAST = "203.0.113.7";
  const x1 = await client2({ "x-forwarded-for": `9.9.9.9, ${XFF_LAST}` });
  registerFrame(x1, "Люся1");
  const x1r = await waitForFrom(x1, registeredOk, 0);
  check(!!x1r, "xff-харднинг: регистрация через «прокси» прошла");
  x1.close();

  const x2 = await client2({ "x-forwarded-for": `4.4.4.4, ${XFF_LAST}` });
  registerFrame(x2, "Люся2");
  const x2r = await waitForFrom(x2, (m) => m[0] === "whoami" && m[1]?.ok === false, 0);
  check(x2r[1]?.reason === "rate", "xff-харднинг: тот же последний хоп → rate (подмена первого не помогает)");
  x2.close();

  const x3 = await client2({ "x-forwarded-for": "4.4.4.4, 198.51.100.77" });
  registerFrame(x3, "Люся3");
  const x3r = await waitForFrom(x3, registeredOk, 0);
  check(!!x3r, "xff-харднинг: другой последний хоп — лимит чужой записи не задел");
  x3.close();

  // Контроль: прямой коннект БЕЗ XFF (локальная разработка) — байпас лимитов
  // остался только для этого случая.
  const d1 = await client2();
  registerFrame(d1, "Прямой1");
  const d1r = await waitForFrom(d1, registeredOk, 0);
  check(!!d1r, "dev-байпас: прямой loopback без XFF не лимитируется (№1)");
  const d2 = await client2();
  registerFrame(d2, "Прямой2");
  const d2r = await waitForFrom(d2, registeredOk, 0);
  check(!!d2r, "dev-байпас: прямой loopback подряд (№2)");
  d1.close();
  d2.close();

  // (г) MAX_ACCOUNTS=8: счёт 6 — ещё две в потолок, дальше 'full'.
  const f1 = await client2();
  registerFrame(f1, "ЕщёМесто");
  const f1r = await waitForFrom(f1, registeredOk, 0);
  check(!!f1r, "max-accounts: 7-я регистрация внутри потолка");
  f1.close();
  const f2 = await client2();
  registerFrame(f2, "ВосьмойКот");
  const f2r = await waitForFrom(f2, registeredOk, 0);
  check(!!f2r, "max-accounts: 8-я регистрация — последняя в потолке");
  f2.close();
  const f3 = await client2();
  registerFrame(f3, "ДевятыйКот");
  const f3r = await waitForFrom(f3, (m) => m[0] === "whoami" && m[1]?.ok === false, 0);
  check(f3r[1]?.reason === "full", "max-accounts: за потолком WS-регистрация → 'full'");
  f3.close();

  const res2Full = await fetch(`http://${HOST}:${PORT2}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ login: "ХттпПолный", pass: "password1" }),
  });
  const http2Full = await res2Full.json();
  check(res2Full.status === 400 && http2Full?.reason === "full", "max-accounts: HTTP-регистрация → 400 'full'");

  // (д) per-LOGIN замок: 2 неудачи за окно 300 мс → 'rate' для любого адреса;
  // успех сбрасывает счётчик; окно отпускает (лок поствременный).
  const lk = await client2();
  let mark = lk.inbox.length;
  loginFrame(lk, "лИзА", "wrong-password");
  const bad1 = await waitForFrom(lk, (m) => m[0] === "whoami" && m[1]?.ok === false && m[1]?.reason === "bad", mark);
  check(!!bad1, "per-login: неудача №1 → 'bad'");
  mark = lk.inbox.length;
  loginFrame(lk, "лИзА", "wrong-password");
  const bad2 = await waitForFrom(lk, (m) => m[0] === "whoami" && m[1]?.ok === false && m[1]?.reason === "bad", mark);
  check(!!bad2, "per-login: неудача №2 → 'bad' (счётчик на пороге)");
  mark = lk.inbox.length;
  loginFrame(lk, "лИзА", "password1"); // верный пароль под замком
  const locked = await waitForFrom(lk, (m) => m[0] === "whoami" && m[1]?.ok === false && m[1]?.reason === "rate", mark);
  check(!!locked, "per-login: верный пароль при замке → 'rate'");
  await sleep(350); // окно 300 мс истекло — счётчик сгорел
  mark = lk.inbox.length;
  loginFrame(lk, "лИзА", "password1");
  const unlocked = await waitForFrom(lk, registeredOk, mark);
  check(!!unlocked && unlocked[1]?.login === "лИзА", "per-login: окно отпустило — верный пароль входит");
  lk.close();

  // Состав закрытой комнаты: аккаунту — реальный счётчик и имена; гость
  // ниже получает «призрак» (count 0, пустые logins) — см. rooms-ghost.
  const sitter = await client2();
  let sMark = sitter.inbox.length;
  loginFrame(sitter, "лИзА", "password1");
  const sLogin = await waitForFrom(sitter, registeredOk, sMark);
  check(!!sLogin, "rooms-count: сиделка вошла в аккаунт");
  sitter.send(JSON.stringify(["join", { room: "test" }]));
  const sitYou = await waitForFrom(sitter, (m) => m[0] === "you", 0);
  check(!!sitYou, "rooms-count: сиделка внутри «test»");
  sitter.send(JSON.stringify(["rooms", { ids: ["test"] }]));
  const ownView = await waitForFrom(sitter, (m) => m[0] === "roomsinfo", 0);
  check(ownView[1]?.[0]?.id === "test" && ownView[1]?.[0]?.count >= 1, "rooms-count: сокет с аккаунтом видит occupancy");
  check(
    Array.isArray(ownView[1]?.[0]?.logins) && ownView[1][0].logins.length >= 1,
    "rooms-count: сокет с аккаунтом видит имена",
  );

  const spy = await client2();
  await waitForFrom(spy, (m) => m[0] === "whoami" && m[1]?.role === "guest", 0);
  spy.send(JSON.stringify(["rooms", { ids: ["test", "no-such-room"] }]));
  const lie = await waitForFrom(spy, (m) => m[0] === "roomsinfo", 0);
  const lieTest = lie[1]?.[0];
  const lieGhost = lie[1]?.[1];
  // P1 roomsinfo-ghost: гость не может даже СОСЧИТАТЬ сидящих закрытой комнаты —
  // ответ неотличим от несуществующей (count 0, без имён; спек §11).
  check(
    lieTest?.id === "test" && lieTest?.count === 0 && Array.isArray(lieTest?.logins) && lieTest.logins.length === 0,
    "rooms-ghost: гость в закрытой комнате видит «пустую» (count 0, без имён)",
  );
  check(
    lieGhost?.count === 0 && Array.isArray(lieGhost?.logins) && lieGhost.logins.length === 0,
    "rooms-ghost: несуществующая комната по-прежнему пустая",
  );
  spy.close();
  sitter.close();
} catch (e) {
  failures += 1;
  console.error("FAIL exception (hardening sandbox)", e);
} finally {
  server2.kill("SIGTERM");
}

/* ---------- P1: домен-гейты, CSRF и матрица токенов (третий sandbox) ----------
 * PUBLIC_HOSTS=pub.example + ELYRIA_HOSTS=ely.example (+ белый Origin из
 * ALLOWED_ORIGINS). Пробы шлют явный Host-заголовок (node:http — fetch его не
 * переопределяет), поэтому один сервер показывает все три класса хоста. */
const DATA3 = mkdtempSync(path.join(tmpdir(), "coop-auth-host-"));
const PORT3 = 4015 + Math.floor(Math.random() * 40);
const WS3 = `ws://${HOST}:${PORT3}`;
const LOCAL3 = `127.0.0.1:${PORT3}`;

// S1 (аудит Z.AI): админа для /cfg/admin-проб создаём ДО старта сервера
// одноразовым CLI make-admin (создание аккаунта сразу с ролью admin);
// регистрация bootstrap-имени роль больше не даёт.
const ADMIN3_PASS = "b7-elision-admin1";
const cliS3 = execFileSync(
  process.execPath,
  [path.join(ROOT, "scripts", "make-admin.mjs"), "Герта", ADMIN3_PASS],
  { env: { ...process.env, DATA_DIR: DATA3 }, encoding: "utf8" },
);
check(/создан с ролью admin/.test(cliS3), "S1: make-admin создаёт новый аккаунт с ролью admin (до старта сервера)");

const server3 = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT3),
    HOST,
    DATA_DIR: DATA3,
    PUBLIC_HOSTS: "pub.example",
    ELYRIA_HOSTS: "ely.example",
    ALLOWED_ORIGINS: "https://ely.example",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server3.stderr.on("data", (d) => process.stderr.write(d));

/** HTTP-проба с ЯВНЫМ Host-заголовком (и, по желанию, Origin/cookie/proto). */
function probe3({ method = "GET", path = "/", host = LOCAL3, origin, proto, cookie, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { host };
    if (payload) headers["content-type"] = "application/json";
    if (origin) headers.origin = origin;
    if (proto) headers["x-forwarded-proto"] = proto;
    if (cookie) headers.cookie = cookie;
    const req = http.request({ host: HOST, port: PORT3, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const setCookie = res.headers["set-cookie"] || [];
        try {
          resolve({ status: res.statusCode, json: JSON.parse(text), setCookie });
        } catch {
          resolve({ status: res.statusCode, json: null, setCookie });
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

try {
  await waitReady(WS3);

  // (P1-а) HTTP-гейт public-хоста: зоны Элизии «не существуют»…
  const gateReg = await probe3({
    method: "POST", path: "/auth/register", host: "pub.example",
    body: { login: "PubBlocked", pass: "password1" },
  });
  check(
    gateReg.status === 404 && gateReg.json?.reason === "not_found",
    "host-gate: POST /auth/register на public → 404 not_found",
  );
  const gateCfgPost = await probe3({
    method: "POST", path: "/cfg", host: "pub.example",
    body: { atmo: { phaseMin: 9, weatherMin: 20 } },
  });
  check(
    gateCfgPost.status === 404 && gateCfgPost.json?.reason === "not_found",
    "host-gate: POST /cfg на public → 404 (конфиг на гротах read-only)",
  );
  const gateCfgGet = await probe3({ method: "GET", path: "/cfg", host: "pub.example" });
  check(
    gateCfgGet.status === 200 && gateCfgGet.json?.ok === true,
    "host-gate: GET /cfg на public жив (публичный конфиг)",
  );
  const gateProfiles = await probe3({ method: "GET", path: "/profiles", host: "pub.example" });
  check(
    gateProfiles.status === 404 && gateProfiles.json?.reason === "not_found",
    "host-gate: GET /profiles на public → 404",
  );

  // …а elyria-хост — рабочая зона: регистрация доходит до исполнения.
  const elyReg = await probe3({
    method: "POST", path: "/auth/register", host: "ely.example",
    body: { login: "ElyHost", pass: "password1" },
  });
  check(
    elyReg.status === 200 && elyReg.json?.ok === true && elyReg.json?.login === "ElyHost",
    "host-gate: register на elyria проходит до исполнения (200, не 404)",
  );
  // Матрица токенов P1: elyria — cookie-only, token в теле не выдаётся.
  check(elyReg.json?.token === undefined, "token-matrix: elyria register — без token в теле (cookie-only)");
  const elyTok = (String(elyReg.setCookie[0] || "").match(/coop_session=([0-9a-f]+)/) || [])[1] || "";
  check(!!elyTok, "token-matrix: elyria register прислал куку с сессией");

  // ?t= на elyria по умолчанию игнорируется; кука та же сессию поднимает.
  const elyByQ = await probe3({ method: "GET", path: `/auth/me?t=${elyTok}`, host: "ely.example" });
  check(elyByQ.json?.ok === true && elyByQ.json?.role === "guest", "token-matrix: elyria игнорирует ?t= (легаси выключено)");
  const elyByCookie = await probe3({
    method: "GET", path: "/auth/me", host: "ely.example", cookie: `coop_session=${elyTok}`,
  });
  check(
    elyByCookie.json?.ok === true && elyByCookie.json?.login === "ElyHost",
    "token-matrix: cookie-сессия на elyria работает",
  );
  const localByQ = await probe3({ method: "GET", path: `/auth/me?t=${elyTok}`, host: LOCAL3 });
  check(
    localByQ.json?.ok === true && localByQ.json?.login === "ElyHost",
    "token-matrix: local-класс по-прежнему принимает ?t= (тесты/dev)",
  );

  // /profiles на elyria: DTO из сессии без login/role; гость — 401.
  const elyProf = await probe3({
    method: "GET", path: "/profiles/me", host: "ely.example", cookie: `coop_session=${elyTok}`,
  });
  check(
    elyProf.status === 200 && elyProf.json?.ok === true && elyProf.json?.displayName === "ElyHost"
      && !("login" in (elyProf.json || {})) && !("role" in (elyProf.json || {})),
    "profiles: /profiles/me отдаёт DTO без login/role (accounts.publicProfile)",
  );
  const elyProfGuest = await probe3({ method: "GET", path: "/profiles/me", host: "ely.example" });
  check(
    elyProfGuest.status === 401 && elyProfGuest.json?.reason === "auth_required",
    "profiles: гость /profiles/me → 401 auth_required",
  );
  const elyCat = await probe3({ method: "GET", path: "/profiles", host: "ely.example" });
  const elyCatItems = elyCat.json?.items || [];
  check(
    elyCat.status === 200 && elyCat.json?.ok === true && Array.isArray(elyCatItems)
      && elyCatItems.length === elyCat.json?.total && elyCatItems.length >= 1
      && elyCatItems.every((it) => !("login" in it) && !("role" in it) && !("pass" in it)),
    "profiles: GET /profiles — рабочий каталог публичных карточек (без login/role)",
  );
  const elyOne = await probe3({ method: "GET", path: "/profiles/some-id", host: "ely.example" });
  check(
    elyOne.status === 404 && elyOne.json?.reason === "unknown",
    "profiles: GET /profiles/:id — заглушка 404 unknown до P4",
  );
  const elyPatch = await probe3({
    method: "PATCH", path: "/profiles/me", host: "ely.example", body: { displayName: "NewName" },
  });
  check(
    elyPatch.status === 401 && elyPatch.json?.reason === "auth_required",
    "profiles: PATCH /profiles/me без сессии → 401 auth_required (P4: правка живая)",
  );
  const elyProf404 = await probe3({ method: "PUT", path: "/profiles/me", host: "ely.example", body: {} });
  check(
    elyProf404.status === 404 && elyProf404.json?.ok === false && !!elyProf404.json?.reason,
    "profiles: мусорный метод/суб-путь — JSON-404 от обработчика, не статика",
  );

  // (P1-в) CSRF: пишущие POST с чужим Origin → 403 csrf, белый Origin —
  // доходит до проверки пароля (401 bad, не 403).
  const csrfLogin = await probe3({
    method: "POST", path: "/auth/login", host: "ely.example",
    origin: "https://evil.example", body: { login: "ElyHost", pass: "password1" },
  });
  check(
    csrfLogin.status === 403 && csrfLogin.json?.reason === "csrf_origin_mismatch",
    "csrf: login с чужим Origin → 403 csrf_origin_mismatch (B1: per-destination)",
  );
  const csrfCfg = await probe3({
    method: "POST", path: "/cfg", host: "ely.example",
    origin: "https://evil.example", body: {},
  });
  check(
    csrfCfg.status === 403 && csrfCfg.json?.reason === "csrf_origin_mismatch",
    "csrf: POST /cfg с чужим Origin → 403 csrf_origin_mismatch (B1)",
  );
  const csrfOk = await probe3({
    method: "POST", path: "/auth/login", host: "ely.example",
    origin: "https://ely.example", body: { login: "ElyHost", pass: "wrong-wrong" },
  });
  check(
    csrfOk.status === 401 && csrfOk.json?.reason === "bad",
    "csrf: Origin из ALLOWED_ORIGINS доводит до проверки пароля (401 bad, не 403)",
  );

  // (P2) Новые admin-маршруты /cfg: на public-хосте их «не существует»,
  // гость/юзер на elyria получают 403, админ — 200 с метаданными реестра.
  const gateCfgAdmin = await probe3({ method: "GET", path: "/cfg/admin", host: "pub.example" });
  const gateCfgExport = await probe3({ method: "GET", path: "/cfg/export", host: "pub.example" });
  check(
    gateCfgAdmin.status === 404 && gateCfgAdmin.json?.reason === "not_found" &&
      gateCfgExport.status === 404 && gateCfgExport.json?.reason === "not_found",
    "host-gate: GET /cfg/admin и /cfg/export на public → 404 (админ-зоны конфига скрыты)",
  );
  const cfgAdminGuest = await probe3({ method: "GET", path: "/cfg/admin", host: "ely.example" });
  const cfgAdminUser = await probe3({
    method: "GET", path: "/cfg/admin", host: "ely.example", cookie: `coop_session=${elyTok}`,
  });
  check(
    cfgAdminGuest.status === 403 && cfgAdminGuest.json?.reason === "auth_required" &&
      cfgAdminUser.status === 403 && cfgAdminUser?.json?.reason === "auth_required",
    "cfg-admin: гость и не-админ на /cfg/admin → 403 auth_required",
  );
  const adminLogin3 = await probe3({
    method: "POST", path: "/auth/login", host: "ely.example",
    body: { login: "Герта", pass: ADMIN3_PASS },
  });
  const adminTok3 = (String(adminLogin3.setCookie[0] || "").match(/coop_session=([0-9a-f]+)/) || [])[1] || "";
  check(adminLogin3.json?.role === "admin" && !!adminTok3, "cfg-admin: make-admin-аккаунт входит, роль admin (cookie-only на elyria)");
  const cfgAdminOk = await probe3({
    method: "GET", path: "/cfg/admin", host: "ely.example", cookie: `coop_session=${adminTok3}`,
  });
  check(
    cfgAdminOk.status === 200 && cfgAdminOk.json?.ok === true &&
      Object.keys(cfgAdminOk.json?.registry || {}).length === 7 && Array.isArray(cfgAdminOk.json?.history),
    "cfg-admin: админ на /cfg/admin → 200 + registry (7 параметров: 5 глобальных + atmo.allowPlayerAtmosphereControl + combat.armorCurve — мандат 2026-11-08) + history",
  );

  // (P1-3) WS-кадры: на public-хосте register/login — отказ без деталей;
  // hello/logout прежние. На elyria-хосте вход работает и выдаёт токен кадром.
  const client3 = (headers) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(WS3, { headers: headers || {} });
      const inbox = [];
      ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
      ws.on("error", reject);
      ws.inbox = inbox;
      ws.once("open", () => resolve(ws));
    });
  const waitForIdx = (ws, pred, from, ms = 4000) =>
    new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        const hit = ws.inbox.slice(from).find(pred);
        if (hit) return resolve(hit);
        if (Date.now() - t0 > ms) {
          return reject(new Error(`timeout; inbox=${JSON.stringify(ws.inbox.slice(-8))}`));
        }
        setTimeout(tick, 15);
      };
      tick();
    });

  const pubWs = await client3({ host: "pub.example" });
  const pubMark = pubWs.inbox.length;
  pubWs.send(JSON.stringify(["auth", { action: "register", login: "WsPub", pass: "password1" }]));
  const pubRefusal = await waitForIdx(pubWs, (m) => m[0] === "whoami" && m[1]?.ok === false, pubMark);
  check(
    pubRefusal[1]?.reason === "error",
    "ws-gate: register на public-хосте — спокойный отказ (whoami reason:error)",
  );
  let markHello = pubWs.inbox.length;
  pubWs.send(JSON.stringify(["auth", { action: "hello" }]));
  const pubHello = await waitForIdx(pubWs, (m) => m[0] === "whoami" && m[1]?.ok === true, markHello);
  check(
    pubHello[1]?.role === "guest",
    "ws-gate: hello на public-хосте жив (гость получает whoami guest)",
  );
  pubWs.close();

  const elyWs = await client3({ host: "ely.example", origin: "https://ely.example" });
  const elyMark = elyWs.inbox.length;
  elyWs.send(JSON.stringify(["auth", { action: "register", login: "WsEly", pass: "password1" }]));
  const elyFrame = await waitForIdx(elyWs, (m) => m[0] === "whoami" && m[1]?.ok === true && m[1]?.accountId, elyMark);
  check(!!elyFrame, "ws-gate: register кадром на elyria-хосте по-прежнему работает");
  check(!!elyFrame[1]?.token, "token-matrix: WS-кадр на elyria выдаёт токен whoami (матрица — про HTTP-тела)");
  elyWs.close();
} catch (e) {
  failures += 1;
  console.error("FAIL exception (host-policy sandbox)", e);
} finally {
  server3.kill("SIGTERM");
}

if (failures) {
  console.error(`auth tests: FAIL (${failures})`);
  process.exit(1);
}
console.log("auth tests: зелёный");
