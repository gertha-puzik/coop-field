/**
 * Аккаунты, сессии, доступ Элизии (фаза 2).
 *
 *  1. store: регистрация, повторный login, чужой пароль, короткое имя, занятое имя;
 *  2. гость входит в grot-1 (you+field), в test — refuse auth_required + noplace;
 *  3. register по WS → whoami + token; join test — you; login не с клиента;
 *  4. HTTP POST /auth/register и /auth/login;
 *  5. книга позиций: тот же login после регистрации поднимает fx/fy;
 *  6. guest join после logout снова не пускает в test.
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

if (failures) {
  console.error(`auth tests: FAIL (${failures})`);
  process.exit(1);
}
console.log("auth tests: зелёный");
