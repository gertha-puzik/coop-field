/**
 * Статусы на поле: сид Тестер / Глав. Администратор, CRUD /admin/statuses*,
 * publicCat.status + accountLogin на join, live-assign через update cat.
 *
 * Запуск: node scripts/test-statuses.mjs (сам спавнит server.js в DATA_DIR-песочнице).
 */
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-statuses-"));
const PORT = 4020 + Math.floor(Math.random() * 40);
const HOST = "127.0.0.1";
const WS = `ws://${HOST}:${PORT}`;
const HTTP = `http://${HOST}:${PORT}`;

mkdirSync(DATA, { recursive: true });
writeFileSync(
  path.join(DATA, "accounts.json"),
  JSON.stringify({
    v: 1,
    accounts: {
      a34d8da4: {
        id: "a34d8da4",
        login: "chief_one",
        pass: { algo: "scrypt", N: 16384, r: 8, p: 1, salt: "00", hash: "00" },
        role: "registered",
        createdAt: Date.now(),
        profile: { displayName: "Chief One" },
        characters: [{ id: "c1", name: "ChiefCat", sprite: "puhlyashik", size: 100 }],
        activeCharacterId: "c1",
      },
      plain01: {
        id: "plain01",
        login: "plain_user",
        pass: { algo: "scrypt", N: 16384, r: 8, p: 1, salt: "00", hash: "00" },
        role: "registered",
        createdAt: Date.now(),
        profile: { displayName: "Plain" },
        characters: [{ id: "c2", name: "PlainCat", sprite: "puhlyashik", size: 100 }],
        activeCharacterId: "c2",
      },
    },
  }),
);

process.env.DATA_DIR = DATA;
process.env.AUTH_INVITE_ENFORCE = "0";

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpReq(method, urlPath, { cookie, body, origin } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, HTTP);
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
          ...(origin ? { origin } : { origin: HTTP }),
          ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            /* ignore */
          }
          resolve({ status: res.statusCode || 0, json, text, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieOf(res) {
  const raw = res.headers["set-cookie"];
  if (!raw) return "";
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((c) => String(c).split(";")[0]).join("; ");
}

async function waitHealth(ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await httpReq("GET", "/health");
      if (r.status === 200 && r.json?.ok) return;
    } catch {
      /* retry */
    }
    await sleep(100);
  }
  throw new Error("health timeout");
}

const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
  env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST },
  stdio: ["ignore", "pipe", "pipe"],
});
let bootLog = "";
child.stdout.on("data", (d) => {
  bootLog += d;
});
child.stderr.on("data", (d) => {
  bootLog += d;
});

try {
  await waitHealth();

  // Сид на старте: crown → chief, остальные → tester.
  const disk = JSON.parse(readFileSync(path.join(DATA, "accounts.json"), "utf8"));
  check(disk.accounts.a34d8da4.profile.statusId === "chief-admin", "seed: a34d8da4 → Глав. Администратор");
  check(disk.accounts.plain01.profile.statusId === "tester", "seed: plain01 → Тестер");
  const catFile = JSON.parse(readFileSync(path.join(DATA, "statuses.json"), "utf8"));
  check(catFile.assignedDefault === true, "statuses.json: assignedDefault после сида");
  check(
    catFile.statuses.some((s) => s.id === "tester" && s.label === "Тестер"),
    "каталог содержит Тестер",
  );
  check(
    catFile.statuses.some((s) => s.id === "chief-admin" && s.label === "Глав. Администратор"),
    "каталог содержит Глав. Администратор",
  );

  // make-admin требует остановленный сервер.
  child.kill("SIGTERM");
  await sleep(500);
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), "admin_st", "admin-pass-123"], {
    env: { ...process.env, DATA_DIR: DATA },
    encoding: "utf8",
  });
  const child2 = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: { ...process.env, DATA_DIR: DATA, PORT: String(PORT), HOST },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stop2 = () => {
    try {
      child2.kill("SIGTERM");
    } catch {
      /* */
    }
  };
  process.on("exit", stop2);
  await waitHealth();

  const login = await httpReq("POST", "/auth/login", {
    body: { login: "admin_st", pass: "admin-pass-123" },
  });
  check(login.status === 200 && login.json?.ok === true, "login admin_st");
  const cookie = cookieOf(login);
  check(!!cookie, "session cookie");

  const guestGet = await httpReq("GET", "/cfg/statuses");
  check(guestGet.status === 401 || guestGet.json?.reason === "auth_required", "GET /cfg/statuses без сессии → 401");
  const guestAdmin = await httpReq("GET", "/admin/statuses");
  check(guestAdmin.status === 401 || guestAdmin.json?.reason === "auth_required", "GET /admin/statuses без сессии → 401");

  const list = await httpReq("GET", "/cfg/statuses", { cookie });
  check(list.status === 200 && list.json?.ok === true, "GET /cfg/statuses admin");
  check(Array.isArray(list.json?.statuses) && list.json.statuses.length >= 2, "каталог ≥2");
  const plain = (list.json?.accounts || []).find((a) => a.accountId === "plain01");
  check(plain?.statusId === "tester", "snapshot: plain01 = tester");
  const chief = (list.json?.accounts || []).find((a) => a.accountId === "a34d8da4");
  check(chief?.statusId === "chief-admin", "snapshot: a34d8da4 = chief-admin");

  const created = await httpReq("POST", "/cfg/statuses", {
    cookie,
    body: { label: "Модератор" },
  });
  check(created.status === 200 && created.json?.ok === true, "POST /cfg/statuses создать Модератор");
  const modId = created.json?.status?.id;
  check(typeof modId === "string" && modId.length >= 2, "новый id статуса");

  const assigned = await httpReq("POST", "/cfg/statuses/assign", {
    cookie,
    body: { accountId: "plain01", statusId: modId },
  });
  check(assigned.status === 200 && assigned.json?.statusId === modId, "assign Модератор → plain01");

  const renamed = await httpReq("PATCH", `/cfg/statuses/${modId}`, {
    cookie,
    body: { label: "Модер" },
  });
  check(renamed.status === 200 && renamed.json?.status?.label === "Модер", "PATCH переименовать");

  const playerReg = await httpReq("POST", "/auth/register", {
    body: { login: "livecat", pass: "livecat-pass-1", name: "ЖивойКот" },
  });
  check(playerReg.status === 200 && playerReg.json?.ok === true, "register livecat");
  const playerCookie = cookieOf(playerReg) || cookieOf(await httpReq("POST", "/auth/login", {
    body: { login: "livecat", pass: "livecat-pass-1" },
  }));
  check(!!playerCookie, "livecat cookie");

  const fieldFrames = await new Promise((resolve, reject) => {
    const sock = new WebSocket(WS, { headers: { cookie: playerCookie } });
    const got = [];
    const t = setTimeout(() => {
      try {
        sock.close();
      } catch {
        /* */
      }
      resolve(got);
    }, 2500);
    sock.on("open", () => {
      sock.send(JSON.stringify(["auth", { action: "hello" }]));
      setTimeout(() => {
        sock.send(JSON.stringify(["join", { room: "test" }]));
      }, 150);
    });
    sock.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (Array.isArray(msg)) got.push(msg);
      } catch {
        /* */
      }
    });
    sock.on("error", reject);
  });
  const you = fieldFrames.find((f) => f[0] === "you");
  check(!!you, "WS you после join test");
  check(you?.[1]?.accountLogin === "livecat", "you.accountLogin = livecat");
  check(you?.[1]?.status === "Тестер", "you.status = Тестер (дефолт нового аккаунта)");
  check(typeof you?.[1]?.login === "string" && you[1].login.length > 0, "you.login = имя персонажа");

  const delProt = await httpReq("DELETE", "/cfg/statuses/tester", { cookie });
  check(delProt.status === 400 && delProt.json?.reason === "protected", "DELETE tester запрещён");

  const delMod = await httpReq("DELETE", `/cfg/statuses/${modId}`, { cookie });
  check(delMod.status === 200 && delMod.json?.ok === true, "DELETE Модер");
  const afterDel = JSON.parse(readFileSync(path.join(DATA, "accounts.json"), "utf8"));
  check(afterDel.accounts.plain01.profile.statusId === "tester", "после удаления статуса → tester");

  stop2();
  await sleep(200);
} catch (e) {
  console.error(e);
  failures += 1;
  console.error("bootLog tail:\n", bootLog.slice(-2000));
} finally {
  try {
    child.kill("SIGTERM");
  } catch {
    /* */
  }
}

if (failures) {
  console.error(`\nFAIL ${failures}`);
  process.exit(1);
}
console.log("\nok statuses");
process.exit(0);
