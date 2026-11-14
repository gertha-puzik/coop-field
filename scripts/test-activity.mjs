#!/usr/bin/env node
/**
 * Живой тест ленты «Последние действия» (server/activity.js).
 * Песочница mkdtemp + свободный порт (как test-profile-social.mjs).
 * Запуск: npm run test:activity
 *
 * Сценарии:
 *   1. новый аккаунт → лента = [joined_site] (синтез из createdAt), /cfg-обход тот же;
 *      неизвестный id → 404, не GET → 405, public Host → 404;
 *      порченый activity.json на старте не роняет сервер;
 *   2. entered_game (heartbeat game), схлопывание;
 *   3. друзья: accept → friend_added обоим, переименование подхватывается,
 *      remove → записи исчезают у обоих;
 *   4. banner_changed + схлопывание;
 *   5. удаление аккаунта → его лента 404, у друга «кто-то»;
 *   6. лимит 20 (импорт модуля в отдельном процессе).
 */
import { randomFillSync } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DATA = mkdtempSync(path.join(tmpdir(), "coop-activity-"));
const PORT = 4700 + Math.floor(Math.random() * 60);
const HOST = "127.0.0.1";
const HTTP = `http://${HOST}:${PORT}`;
const ORIGIN = HTTP;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
};

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}
function buildPng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rowLen = 1 + w * 4;
  const raw = Buffer.alloc(h * rowLen);
  const px = Buffer.alloc(w * h * 4);
  randomFillSync(px);
  for (let y = 0; y < h; y += 1) {
    raw[y * rowLen] = 0;
    px.copy(raw, y * rowLen + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 1 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function multipart(data) {
  const boundary = `----coopact${Math.random().toString(36).slice(2)}`;
  return {
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="b.png"\r\ncontent-type: image/png\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function httpJson(pathname, { method = "GET", body, token } = {}) {
  const headers = { "content-type": "application/json", origin: ORIGIN };
  if (token) headers.cookie = `coop_session=${token}`;
  const res = await fetch(`${HTTP}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { status: res.status, json };
}
async function uploadBanner(token) {
  const mp = multipart(buildPng(1200, 400));
  const res = await fetch(`${HTTP}/cfg/banners/mine`, {
    method: "POST",
    headers: { "content-type": mp.contentType, cookie: `coop_session=${token}`, origin: ORIGIN },
    body: mp.body,
  });
  return res.status;
}
function probeWithHost(pathname, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: pathname, method: "GET", headers: { host } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}

let server = null;
function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST, DATA_DIR: DATA, AUTH_CSRF_STRICT: "1", AUTH_INVITE_ENFORCE: "0" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(d));
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode) return;
  server.kill("SIGTERM");
  await sleep(300);
}
async function waitReady() {
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`${HTTP}/health`)).ok) return true;
    } catch {
      /* */
    }
    await sleep(100);
  }
  return false;
}
async function register(login) {
  await httpJson("/auth/register", { method: "POST", body: { login, pass: "password1", name: login } });
  const res = await fetch(`${HTTP}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ login, pass: "password1" }),
  });
  const m = /coop_session=([0-9a-f]+)/i.exec(String(res.headers.get("set-cookie") || ""));
  const row = await res.json().catch(() => null);
  return { token: m?.[1] || "", accountId: String(row?.accountId || "") };
}
const feed = async (id, prefix = "") => (await httpJson(`${prefix}/activity/${id}`)).json?.items || [];
const ofType = (items, type) => items.filter((it) => it.type === type);

async function main() {
  // Порченый журнал до старта сервера.
  writeFileSync(path.join(DATA, "activity.json"), "{oops");
  startServer();
  try {
    check(await waitReady(), "server starts with a corrupt activity.json");
    const a = await register("act_alice");
    const b = await register("act_bob");
    check(!!a.token && !!b.token, "two accounts registered");

    /* ---- 1. маршрут ---- */
    const card = await httpJson(`/profiles/${a.accountId}`);
    const createdAt = card.json?.createdAt;
    const f1 = await httpJson(`/activity/${a.accountId}`);
    check(f1.status === 200 && f1.json?.ok === true, "GET /activity/:id → 200");
    const items1 = f1.json?.items || [];
    check(items1.length === 1 && items1[0].type === "joined_site", "fresh feed = [joined_site]");
    check(items1[0]?.at === createdAt, "joined_site.at = createdAt");
    const f1cfg = await httpJson(`/cfg/activity/${a.accountId}`);
    check(f1cfg.status === 200 && JSON.stringify(f1cfg.json?.items) === JSON.stringify(items1), "/cfg/activity same as canon");
    check((await httpJson("/activity/nope")).status === 404, "unknown account → 404");
    check((await httpJson(`/activity/${a.accountId}`, { method: "POST", body: {} })).status === 405, "POST → 405");
    check((await probeWithHost(`/activity/${a.accountId}`, "abnocw.phainonsmilk.ru")) === 404, "public host → 404");
    check((await probeWithHost(`/cfg/activity/${a.accountId}`, "abnocw.phainonsmilk.ru")) === 404, "public host /cfg → 404");

    if (process.env.ACTIVITY_TASK === "1") return;

    /* ---- 2. entered_game ---- */
    await httpJson("/presence/heartbeat", { method: "POST", token: a.token, body: { where: "game", active: true } });
    await httpJson("/presence/heartbeat", { method: "POST", token: a.token, body: { where: "game", active: true } });
    const eg = ofType(await feed(a.accountId), "entered_game");
    check(eg.length === 1, "two game heartbeats → one entered_game");
    check(typeof eg[0]?.data?.label === "string", "entered_game carries a location label");

    /* ---- 3. друзья ---- */
    await httpJson("/friends/request", { method: "POST", token: a.token, body: { accountId: b.accountId } });
    await httpJson("/friends/accept", { method: "POST", token: b.token, body: { accountId: a.accountId } });
    const faA = ofType(await feed(a.accountId), "friend_added");
    const faB = ofType(await feed(b.accountId), "friend_added");
    check(faA.length === 1 && faA[0].data?.friendName === "act_bob", "accept → friend_added for A (name of B)");
    check(faB.length === 1 && faB[0].data?.friendName === "act_alice", "accept → friend_added for B (name of A)");
    await httpJson("/profiles/me", { method: "PATCH", token: b.token, body: { displayName: "Бобик" } });
    check(ofType(await feed(a.accountId), "friend_added")[0]?.data?.friendName === "Бобик", "rename is picked up");
    await httpJson("/friends/remove", { method: "POST", token: a.token, body: { accountId: b.accountId } });
    check(ofType(await feed(a.accountId), "friend_added").length === 0, "remove → no friend_added for A");
    check(ofType(await feed(b.accountId), "friend_added").length === 0, "remove → no friend_added for B");

    /* ---- 4. banner_changed ---- */
    check((await uploadBanner(a.token)) === 200, "banner upload 200");
    check(ofType(await feed(a.accountId), "banner_changed").length === 1, "upload → banner_changed");
    await sleep(10_200);
    check((await uploadBanner(a.token)) === 200, "second banner upload 200");
    check(ofType(await feed(a.accountId), "banner_changed").length === 1, "repeat upload collapses");

    /* ---- 5. удаление аккаунта ---- */
    await httpJson("/friends/request", { method: "POST", token: a.token, body: { accountId: b.accountId } });
    await httpJson("/friends/accept", { method: "POST", token: b.token, body: { accountId: a.accountId } });
    const del = await httpJson("/profiles/me", { method: "DELETE", token: b.token, body: { password: "password1" } });
    check(del.status === 200, "B deletes account");
    check((await httpJson(`/activity/${b.accountId}`)).status === 404, "deleted account feed → 404");
    const faGone = ofType(await feed(a.accountId), "friend_added");
    check(faGone.length >= 1 && faGone.every((it) => it.data?.friendName === "кто-то"), "deleted friend → «кто-то»");
  } finally {
    await stopServer();
  }

  if (process.env.ACTIVITY_TASK === "1") return;

  /* ---- 6. лимит 20 (модуль напрямую) ---- */
  const LIM = mkdtempSync(path.join(tmpdir(), "coop-activity-lim-"));
  const code = `
    const m = await import(${JSON.stringify(path.join(ROOT, "server/activity.js"))});
    for (let i = 0; i < 25; i++) m.pushActivity("acc1", "moved", { locationId: i });
    const items = m.activityOf("acc1");
    console.log(JSON.stringify({ n: items.length, first: items[0]?.data?.locationId }));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: LIM },
    encoding: "utf8",
  });
  let lim = null;
  try {
    lim = JSON.parse(run.stdout.trim().split("\n").pop());
  } catch {
    console.error(run.stderr);
  }
  check(lim?.n === 20 && lim?.first === 24, "journal keeps the newest 20");
  rmSync(LIM, { recursive: true, force: true });

  /* ---- 7. разные друзья подряд не схлопываются; мусор в журнале не роняет писателя ---- */
  const BAD = mkdtempSync(path.join(tmpdir(), "coop-activity-bad-"));
  writeFileSync(
    path.join(BAD, "activity.json"),
    JSON.stringify({ v: 1, byAccount: { acc3: [null, { type: "moved" }, 7], acc4: "oops" } }),
  );
  const code2 = `
    const m = await import(${JSON.stringify(path.join(ROOT, "server/activity.js"))});
    const out = {};
    m.pushActivity("acc2", "friend_added", { friendId: "b" });
    m.pushActivity("acc2", "friend_added", { friendId: "c" });
    out.friends = m.activityOf("acc2").map((it) => it.data.friendId);
    try { m.pushActivity("acc3", "banner_changed"); m.pushActivity("acc4", "avatar_changed"); out.threw = false; }
    catch (e) { out.threw = String(e); }
    out.acc3 = m.activityOf("acc3").map((it) => it.type);
    out.acc4 = m.activityOf("acc4").map((it) => it.type);
    console.log(JSON.stringify(out));`;
  const run2 = spawnSync(process.execPath, ["--input-type=module", "-e", code2], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: BAD },
    encoding: "utf8",
  });
  let r2 = null;
  try {
    r2 = JSON.parse(run2.stdout.trim().split("\n").pop());
  } catch {
    console.error(run2.stderr);
  }
  check(JSON.stringify(r2?.friends) === JSON.stringify(["c", "b"]), "two new friends within 2 min → two entries");
  check(r2?.threw === false, "garbage items in activity.json never make pushActivity throw");
  check(JSON.stringify(r2?.acc3) === JSON.stringify(["banner_changed"]), "garbage items dropped, new event kept");
  check(JSON.stringify(r2?.acc4) === JSON.stringify(["avatar_changed"]), "non-array account list replaced");
  rmSync(BAD, { recursive: true, force: true });
}

main()
  .catch((e) => {
    console.error(e);
    failures += 1;
  })
  .finally(() => {
    rmSync(DATA, { recursive: true, force: true });
    console.log(failures ? `\n${failures} FAILED` : "\nall OK");
    process.exit(failures ? 1 : 0);
  });
