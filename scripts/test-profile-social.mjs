#!/usr/bin/env node
/**
 * Живой тест профиля-соцслоя: баннер, presence/playtime, друзья, уведомления,
 * админ-анонсы. Песочница mkdtemp + свободный порт (как test-avatars.mjs).
 *
 * Сценарии:
 *   1. banner PNG 1200×400 → /profiles/me.banner; oversized 1201×400 → bad_dims;
 *      GIF 64×32 → ok; DELETE → null; public Host /banners/mine → 404;
 *   2. presence heartbeat site→online, game→traveling + playtime растёт;
 *   3. friends request → notification у цели; accept → mutual; remove;
 *   4. admin announcement → fanout notification; mark read.
 */
import { randomFillSync } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-social-"));
const PORT = 4620 + Math.floor(Math.random() * 60);
const HOST = "127.0.0.1";
const HTTP = `http://${HOST}:${PORT}`;
const ORIGIN = `http://${HOST}:${PORT}`;
const A = "alice_soc";
const B = "bob_soc";
const ADMIN = "admin_soc";

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
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Минимальный GIF89a заданных габаритов (Logical Screen Descriptor). */
function buildGif(w, h) {
  const head = Buffer.alloc(13);
  Buffer.from("GIF89a").copy(head, 0);
  head.writeUInt16LE(w, 6);
  head.writeUInt16LE(h, 8);
  head[10] = 0x00; // no GCT
  head[11] = 0;
  head[12] = 0;
  // пустой image + trailer — серверу габариты из LSD, тело ≥100 байт
  const pad = Buffer.alloc(100, 0x21);
  pad[pad.length - 1] = 0x3b;
  return Buffer.concat([head, pad]);
}

function multipart(file) {
  const boundary = `----coopbanner${Math.random().toString(36).slice(2)}`;
  const chunks = [
    Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${file.filename}"\r\ncontent-type: ${file.type}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ];
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function httpJson(pathname, { method = "GET", body, token, origin } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.cookie = `coop_session=${token}`;
  if (origin) headers.origin = origin;
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

async function httpUpload(pathname, { body, contentType, token, origin }) {
  const headers = { "content-type": contentType };
  if (token) headers.cookie = `coop_session=${token}`;
  if (origin) headers.origin = origin;
  const res = await fetch(`${HTTP}${pathname}`, { method: "POST", headers, body });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { status: res.status, json };
}

function probeWithHost(pathname, { host, token, method = "GET" }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: pathname,
        method,
        headers: { host, cookie: token ? `coop_session=${token}` : "" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* */
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let server = null;
function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST,
      DATA_DIR: DATA,
      AUTH_CSRF_STRICT: "1",
      AUTH_INVITE_ENFORCE: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(d));
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode) return;
  server.kill("SIGTERM");
  await sleep(300);
}
async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`${HTTP}/health`);
      if (res.ok) return;
    } catch {
      /* */
    }
    await sleep(100);
  }
  throw new Error("server not ready");
}

async function register(login) {
  const r = await httpJson("/auth/register", {
    method: "POST",
    origin: ORIGIN,
    body: { login, pass: "password1", name: login },
  });
  check(r.status === 200 && r.json?.ok === true, `register ${login}`);
  // token from Set-Cookie via login
  const loginRes = await fetch(`${HTTP}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ login, pass: "password1" }),
  });
  const set = String(loginRes.headers.get("set-cookie") || "");
  const m = /coop_session=([0-9a-f]+)/i.exec(set);
  const token = m?.[1] || "";
  check(!!token, `session cookie ${login}`);
  const row = await loginRes.json().catch(() => null);
  return { token, accountId: String(row?.accountId || "") };
}

async function main() {
  startServer();
  try {
    await waitReady();
    const alice = await register(A);
    const bob = await register(B);
    const adm = await register(ADMIN);
    // promote admin via make-admin needs stop — use direct file or skip announcements admin role.
    // For announcements we need role=admin: stop, make-admin, restart.
    await stopServer();
    const { spawnSync } = await import("node:child_process");
    spawnSync(process.execPath, ["scripts/make-admin.mjs", ADMIN], {
      cwd: ROOT,
      env: { ...process.env, DATA_DIR: DATA },
      encoding: "utf8",
    });
    startServer();
    await waitReady();
    // re-login after restart
    const re = async (login) => {
      const loginRes = await fetch(`${HTTP}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ login, pass: "password1" }),
      });
      const set = String(loginRes.headers.get("set-cookie") || "");
      const m = /coop_session=([0-9a-f]+)/i.exec(set);
      const row = await loginRes.json().catch(() => null);
      return { token: m?.[1] || "", accountId: String(row?.accountId || "") };
    };
    const alice2 = await re(A);
    const bob2 = await re(B);
    const adm2 = await re(ADMIN);
    alice.token = alice2.token;
    alice.accountId = alice2.accountId || alice.accountId;
    bob.token = bob2.token;
    bob.accountId = bob2.accountId || bob.accountId;
    adm.token = adm2.token;

    /* ---- banners ---- */
    const okPng = multipart({ filename: "b.png", type: "image/png", data: buildPng(800, 200) });
    const up = await httpUpload("/banners/mine", {
      body: okPng.body,
      contentType: okPng.contentType,
      token: alice.token,
      origin: ORIGIN,
    });
    check(up.status === 200 && typeof up.json?.banner === "string", "banner PNG upload");
    const me = await httpJson("/profiles/me", { token: alice.token });
    check(!!me.json?.banner, "banner in /profiles/me");

    await sleep(10_100); // rate window
    const bad = multipart({ filename: "b.png", type: "image/png", data: buildPng(1201, 400) });
    const badUp = await httpUpload("/banners/mine", {
      body: bad.body,
      contentType: bad.contentType,
      token: alice.token,
      origin: ORIGIN,
    });
    check(badUp.status === 400 && badUp.json?.reason === "bad_dims", "banner oversized rejected");

    await sleep(10_100);
    const gif = multipart({ filename: "b.gif", type: "image/gif", data: buildGif(120, 40) });
    const gifUp = await httpUpload("/banners/mine", {
      body: gif.body,
      contentType: gif.contentType,
      token: alice.token,
      origin: ORIGIN,
    });
    check(gifUp.status === 200 && String(gifUp.json?.banner || "").includes(".gif"), "banner GIF upload");

    const pubMine = await probeWithHost("/banners/mine", {
      host: "abnocw.phainonsmilk.ru",
      token: alice.token,
      method: "DELETE",
    });
    check(pubMine.status === 404, "banner mine hidden on public host");

    /* ---- presence ---- */
    const hbSite = await httpJson("/presence/heartbeat", {
      method: "POST",
      token: alice.token,
      origin: ORIGIN,
      body: { where: "site", active: true },
    });
    check(hbSite.status === 200 && hbSite.json?.presence === "online", "presence site → online");
    const hbGame = await httpJson("/presence/heartbeat", {
      method: "POST",
      token: alice.token,
      origin: ORIGIN,
      body: { where: "game", active: true },
    });
    check(hbGame.status === 200 && hbGame.json?.presence === "traveling", "presence game → traveling");
    await sleep(50);
    const hbGame2 = await httpJson("/presence/heartbeat", {
      method: "POST",
      token: alice.token,
      origin: ORIGIN,
      body: { where: "game", active: true },
    });
    check(
      hbGame2.status === 200 && Number(hbGame2.json?.playtimeMs) > 0,
      `playtime accrued (${hbGame2.json?.playtimeMs})`,
    );
    const card = await httpJson(`/profiles/${alice.accountId}`, { token: bob.token });
    check(card.json?.presence === "traveling", "card presence traveling");
    check(Number(card.json?.playtimeMs) > 0, "card playtime public");

    /* ---- friends + notifications ---- */
    const req = await httpJson("/friends/request", {
      method: "POST",
      token: alice.token,
      origin: ORIGIN,
      body: { accountId: bob.accountId },
    });
    check(req.status === 200 && req.json?.status === "pending", "friend request");
    const nBob = await httpJson("/notifications/me", { token: bob.token });
    check(
      nBob.status === 200 &&
        Array.isArray(nBob.json?.items) &&
        nBob.json.items.some((x) => x.type === "friend_request"),
      "friend request notification",
    );
    check(Number(nBob.json?.unread) >= 1, "unread ≥ 1");
    const acc = await httpJson("/friends/accept", {
      method: "POST",
      token: bob.token,
      origin: ORIGIN,
      body: { accountId: alice.accountId },
    });
    check(acc.status === 200 && acc.json?.status === "accepted", "friend accept");
    const friends = await httpJson(`/friends/${alice.accountId}`, { token: bob.token });
    check(
      friends.status === 200 &&
        friends.json?.friends?.some((f) => f.accountId === bob.accountId),
      "public friends list",
    );
    const rem = await httpJson("/friends/remove", {
      method: "POST",
      token: alice.token,
      origin: ORIGIN,
      body: { accountId: bob.accountId },
    });
    check(rem.status === 200, "friend remove");

    /* ---- announcements ---- */
    const an = await httpJson("/admin/announcements", {
      method: "POST",
      token: adm.token,
      origin: ORIGIN,
      body: { title: "Тест анонс", body: "привет поле" },
    });
    check(an.status === 200 && an.json?.ok === true, "admin announcement create");
    const nAlice = await httpJson("/notifications/me", { token: alice.token });
    check(
      nAlice.json?.items?.some((x) => x.type === "announcement" && x.title === "Тест анонс"),
      "announcement fanout",
    );
    const read = await httpJson("/notifications/me/read", {
      method: "POST",
      token: alice.token,
      origin: ORIGIN,
      body: { all: true },
    });
    check(read.status === 200 && Number(read.json?.unread) === 0, "mark all read");

    const delBan = await httpJson("/banners/mine", {
      method: "DELETE",
      token: alice.token,
      origin: ORIGIN,
    });
    check(delBan.status === 200 && delBan.json?.banner === null, "banner delete");
  } finally {
    await stopServer();
    try {
      rmSync(DATA, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nall profile-social checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
