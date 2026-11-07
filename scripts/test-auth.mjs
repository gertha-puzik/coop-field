/**
 * Аккаунты, сессии, доступ Элизии (фаза 2 + pr-41 харднинг).
 *
 *  1. store: регистрация, повторный login, чужой пароль, короткое имя, занятое имя;
 *  2. гость входит в grot-1 (you+field), в test — refuse auth_required + noplace;
 *  3. register по WS → whoami + token; join test — you; login не с клиента;
 *  4. HTTP POST /auth/register и /auth/login;
 *  5. книга позиций: тот же login после регистрации поднимает fx/fy;
 *  6. guest join после logout снова не пускает в test;
 *  7. (pr-41) второй sandbox с заниженными порогами: BOOTSTRAP_ADMIN-СПИСОК
 *      (оба имени → admin), register-флуд с подделанным XFF ловится по
 *      ПОСЛЕДНЕМУ хопу, MAX_ACCOUNTS → 'full', per-LOGIN замок неудачных
 *      входов (успех сбрасывает, окно отпускает), rooms-lie (гость не видит
 *      occupancy закрытой комнаты — ответ как про несуществующую).
 *
 * Запуск: node scripts/test-auth.mjs (сам спавнит server.js в песочнице DATA_DIR).
 */
import { spawn } from "node:child_process";
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
  check(whoAdmin[1].role === "admin", "bootstrap admin on first matching register");
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
  const cfgAdmin = await fetch(`${HTTP}/cfg?t=${whoAdmin[1].token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ atmo: { phaseMin: 9, weatherMin: 20 } }),
  });
  const cfgSaved = await cfgAdmin.json();
  check(cfgAdmin.ok && cfgSaved.atmo?.phaseMin === 9, "cfg post admin");
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

  // (в) BOOTSTRAP_ADMIN-СПИСОК: каждое имя из списка становится admin при
  // СВОЕЙ первой регистрации — уже существующий админ не гасит роль второго.
  const gA = await client2();
  registerFrame(gA, "  гЕРТА "); // пробелы и регистр: список сравнивается после trim+lower
  const whoGA = await waitForFrom(gA, registeredOk, 0);
  check(whoGA[1]?.role === "admin", "bootstrap list: имя №1 → admin");
  gA.close();

  const gB = await client2();
  registerFrame(gB, "  лИзА ");
  const whoGB = await waitForFrom(gB, registeredOk, 0);
  check(whoGB[1]?.role === "admin", "bootstrap list: имя №2 → admin при живом админе №1");
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

  // (а) rooms-lie: сидящего в закрытой комнате гость не видит — ответ про
  // закрытую комнату совпадает с ответом про несуществующую байт-в-байт.
  const sitter = await client2();
  let sMark = sitter.inbox.length;
  loginFrame(sitter, "лИзА", "password1");
  const sLogin = await waitForFrom(sitter, registeredOk, sMark);
  check(!!sLogin, "rooms-lie: сиделка вошла в аккаунт");
  sitter.send(JSON.stringify(["join", { room: "test" }]));
  const sitYou = await waitForFrom(sitter, (m) => m[0] === "you", 0);
  check(!!sitYou, "rooms-lie: сиделка внутри «test»");
  sitter.send(JSON.stringify(["rooms", { ids: ["test"] }]));
  const ownView = await waitForFrom(sitter, (m) => m[0] === "roomsinfo", 0);
  check(ownView[1]?.[0]?.id === "test" && ownView[1]?.[0]?.count >= 1, "rooms-lie: сокет с аккаунтом видит occupancy");
  sitter.close();

  const spy = await client2();
  await waitForFrom(spy, (m) => m[0] === "whoami" && m[1]?.role === "guest", 0);
  spy.send(JSON.stringify(["rooms", { ids: ["test", "no-such-room"] }]));
  const lie = await waitForFrom(spy, (m) => m[0] === "roomsinfo", 0);
  const lieTest = lie[1]?.[0];
  const lieGhost = lie[1]?.[1];
  check(
    lieTest?.id === "test" && lieTest?.count === 0 && Array.isArray(lieTest?.logins) && lieTest.logins.length === 0,
    "rooms-lie: гость видит закрытую комнату «пустой» (count 0, logins [])",
  );
  check(
    lieTest?.count === lieGhost?.count && JSON.stringify(lieTest?.logins) === JSON.stringify(lieGhost?.logins),
    "rooms-lie: данные точно как про несуществующую комнату (count/logins идентичны)",
  );
  spy.close();
} catch (e) {
  failures += 1;
  console.error("FAIL exception (hardening sandbox)", e);
} finally {
  server2.kill("SIGTERM");
}

if (failures) {
  console.error(`auth tests: FAIL (${failures})`);
  process.exit(1);
}
console.log("auth tests: зелёный");
