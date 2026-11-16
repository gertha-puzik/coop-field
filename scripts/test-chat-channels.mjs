/** Global/near chat isolation over real authenticated room sockets. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { WebSocket } from "ws";
const data = mkdtempSync(path.join(tmpdir(), "chat-channels-")),
  sockets = [];
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const origin = `http://127.0.0.1:${port}`,
  pause = (ms) => new Promise((r) => setTimeout(r, ms));
for (const id of [1, 2])
  writeFileSync(
    path.join(data, id === 1 ? "test-map.json" : `location-${id}.json`),
    JSON.stringify({
      v: 2,
      cols: 12,
      rows: 10,
      margin: 0.5,
      seed: "chat",
      place: { id, name: "Локация " + id, zoneId: 1, zoneName: "Средиземье" },
      zones: [
        {
          id: "grass",
          kind: "green",
          name: "Трава",
          c0: 0,
          r0: 0,
          c1: 11,
          r1: 9,
        },
      ],
      objects: [],
      spawns: [
        { c: 3, r: 3 },
        { c: 5, r: 5 },
        { c: 7, r: 7 },
      ],
    }),
  );
const server = spawn(process.execPath, ["server.js"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DATA_DIR: data,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_REGISTER_GAP_MS: "1",
    AUTH_LOGIN_GAP_MS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
server.stderr.on("data", (c) => (logs += c));
async function account(login) {
  const headers = { origin, "content-type": "application/json" };
  assert.equal(
    (
      await fetch(origin + "/auth/register", {
        method: "POST",
        headers,
        body: JSON.stringify({ login, pass: "password1" }),
      })
    ).status,
    200,
  );
  const r = await fetch(origin + "/auth/login", {
    method: "POST",
    headers,
    body: JSON.stringify({ login, pass: "password1" }),
  });
  assert.equal(r.status, 200);
  return r.headers.get("set-cookie").split(";")[0];
}
async function client(login, room) {
  const cookie = login ? await account(login) : "",
    ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin, ...(cookie ? { cookie } : {}) },
    }),
    frames = [];
  sockets.push(ws);
  ws.on("message", (raw) => frames.push(JSON.parse(String(raw))));
  await once(ws, "open");
  const wait = async (predicate) => {
    for (let i = 0; i < 120; i++) {
      const match = frames.find(predicate);
      if (match) return match;
      await pause(30);
    }
    throw Error("frame not received " + JSON.stringify(frames));
  };
  ws.send(JSON.stringify(["join", { room, login: login || "public_guest" }]));
  await wait(([event]) => event === "field");
  return {
    ws,
    frames,
    wait,
    send: (channel, text) =>
      ws.send(JSON.stringify(["chat", { channel, text }])),
  };
}
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(origin + "/health")).ok) break;
    } catch {}
    await pause(50);
  }
  const a = await client("chat_a", "test"),
    b = await client("chat_b", "test-loc-2"),
    c = await client("chat_c", "test"),
    g = await client(null, "grot-1");
  a.send("global", "GLOBAL across locations");
  await b.wait(
    ([event, row]) =>
      event === "chat" && row.text === "GLOBAL across locations",
  );
  await c.wait(
    ([event, row]) =>
      event === "chat" && row.text === "GLOBAL across locations",
  );
  assert.equal(
    g.frames.some(
      ([event, row]) =>
        event === "chat" && row.text === "GLOBAL across locations",
    ),
    false,
    "public grotto never receives account global messages",
  );
  a.send("near", "COOLDOWN");
  await a.wait(([event, row]) => event === "info" && row.includes("частые"));
  assert.equal(
    c.frames.some(
      ([event, row]) => event === "chat" && row.text === "COOLDOWN",
    ),
    false,
  );
  await pause(500);
  a.send("near", "NEAR local only");
  await c.wait(
    ([event, row]) => event === "chat" && row.text === "NEAR local only",
  );
  assert.equal(
    b.frames.some(
      ([event, row]) => event === "chat" && row.text === "NEAR local only",
    ),
    false,
  );
  g.send("global", "PUBLIC cannot broadcast");
  await g.wait(
    ([event, row]) =>
      event === "chat" && row.text === "PUBLIC cannot broadcast",
  );
  await pause(60);
  assert.equal(
    a.frames.some(
      ([event, row]) =>
        event === "chat" && row.text === "PUBLIC cannot broadcast",
    ),
    false,
  );
  const d = await client("chat_d", "test-loc-2");
  const history = await d.wait(([event]) => event === "chatlog");
  assert.ok(
    history[1].some(
      (row) =>
        row.channel === "global" && row.text === "GLOBAL across locations",
    ),
  );
  assert.equal(
    history[1].some((row) => row.text === "NEAR local only"),
    false,
  );
  await pause(500);
  b.send("global", "GLOBAL second");
  await a.wait(
    ([event, row]) => event === "chat" && row.text === "GLOBAL second",
  );
  assert.ok(
    a.frames.some(
      ([event, row]) =>
        event === "chat" && row.channel === "near" && row.room === "test",
    ),
  );
  console.log(
    "chat-channels: PASS — global across locations, near isolation, room history, public host separation and shared rate limit",
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  for (const ws of sockets) ws.terminate();
  const done = once(server, "exit");
  server.kill("SIGTERM");
  await done;
  rmSync(data, { recursive: true, force: true });
}
