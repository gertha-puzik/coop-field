/** Multiplayer ownership, distance and consent regression; isolated temporary data only. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { WebSocket } from "ws";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "world-items-")),
  clients = [];
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((r) => probe.close(r));
const origin = `http://127.0.0.1:${port}`,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const map = {
  v: 2,
  cols: 12,
  rows: 11,
  margin: 0.5,
  seed: "items",
  place: { id: 1, name: "Долина", zoneId: 1, zoneName: "Средиземье" },
  zones: [
    { id: "grass", kind: "green", name: "Трава", c0: 0, r0: 0, c1: 11, r1: 10 },
  ],
  objects: [],
  spawns: [
    { c: 2, r: 5 },
    { c: 3, r: 5 },
    { c: 4, r: 5 },
  ],
  passages: [
    {
      id: "forest",
      x: 2,
      y: 4,
      w: 3,
      h: 3,
      targetId: 2,
      link: "trail",
      direction: "right",
    },
  ],
};
fs.writeFileSync(path.join(data, "test-map.json"), JSON.stringify(map));
let server,
  logs = "";
async function start() {
  server = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      DATA_DIR: data,
      PORT: String(port),
      HOST: "127.0.0.1",
      AUTH_REGISTER_GAP_MS: "1",
      AUTH_LOGIN_GAP_MS: "1",
      AUTH_CSRF_STRICT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (c) => (logs += c));
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(origin + "/health")).ok) return;
    } catch {}
    await sleep(40);
  }
  throw Error(logs);
}
async function stop() {
  if (server?.exitCode === null && !server.signalCode) {
    const done = once(server, "exit");
    server.kill("SIGTERM");
    await done;
  }
}
async function req(url, who, method = "GET", body) {
  const r = await fetch(origin + url, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...(who ? { cookie: who.cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: r.status,
    ...(await r.json()),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
async function account(login) {
  assert.equal(
    (await req("/auth/register", null, "POST", { login, pass: "password1" }))
      .status,
    200,
  );
  const row = await req("/auth/login", null, "POST", {
    login,
    pass: "password1",
  });
  return {
    cookie: row.cookie,
    id: row.accountId,
    characterId: row.activeCharacterId,
  };
}
const inv = async (a) =>
  (await req("/cfg/inventory?characterId=" + a.characterId, a)).inventory;
const world = async (a) =>
  (await req("/cfg/inventory/world?characterId=" + a.characterId, a)).world;
async function act(a, raw) {
  return req("/cfg/inventory/world", a, "POST", {
    characterId: a.characterId,
    version: (await inv(a)).version,
    ...raw,
  });
}
async function connect(a) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin, cookie: a.cookie },
    }),
    frames = [];
  clients.push(ws);
  ws.on("message", (c) => frames.push(JSON.parse(String(c))));
  await once(ws, "open");
  const wait = async (fn, from = 0) => {
    for (let i = 0; i < 150; i++) {
      const frame = frames.slice(from).find(fn);
      if (frame) return frame[1];
      await sleep(25);
    }
    throw Error("missing frame " + JSON.stringify(frames.slice(-4)));
  };
  const send = (e, p) => ws.send(JSON.stringify([e, p]));
  send("join", { room: "test", login: "cat" });
  await wait((f) => f[0] === "field");
  return { ws, frames, wait, send };
}
async function move(client, x, y) {
  client.send("freemove", { x, y, foot: { dx: 0.45, dy: 0.95 }, stop: true });
  await sleep(100);
}
try {
  await start();
  const a = await account("item_a"),
    b = await account("item_b"),
    c = await account("item_c");
  await stop();
  const items = {
    nugget: {
      id: "nugget",
      name: "Наггетс",
      sprite: "/items/nugget.png",
      weight: 3,
    },
  };
  const empty = () => ({
    version: 0,
    bag: Array(10).fill(null),
    hotbar: Array(5).fill(null),
  });
  const ia = empty(),
    ib = empty();
  ia.bag[0] = { itemId: "nugget", quantity: 10 };
  ib.bag[0] = { itemId: "nugget", quantity: 10 };
  fs.writeFileSync(
    path.join(data, "inventories.json"),
    JSON.stringify({
      v: 1,
      items,
      inventories: {
        [`${a.id}:${a.characterId}`]: ia,
        [`${b.id}:${b.characterId}`]: ib,
      },
      operations: {},
    }),
  );
  await start();
  assert.equal(
    (
      await act(a, {
        action: "drop",
        from: { area: "bag", index: 0 },
        x: 3,
        y: 6,
      })
    ).reason,
    "not_on_field",
  );
  const ca = await connect(a),
    cb = await connect(b),
    cc = await connect(c);
  await move(ca, 2, 5);
  await move(cb, 3, 5);
  await move(cc, 8, 8);
  assert.equal((await req("/cfg/inventory/world", null)).status, 401);
  assert.equal(
    (
      await req("/cfg/inventory/world", b, "POST", {
        characterId: a.characterId,
        action: "drop",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await act(a, {
        action: "drop",
        from: { area: "bag", index: 0 },
        x: -500,
        y: 4,
      })
    ).reason,
    "invalid_point",
  );
  assert.equal((await inv(a)).weight, 30);
  const prior = (await inv(a)).version;
  assert.equal(
    (
      await act(a, {
        action: "drop",
        from: { area: "bag", index: 0 },
        x: 3,
        y: 6,
      })
    ).status,
    200,
  );
  assert.equal((await inv(a)).bag[0].quantity, 9, "drop removes one unit");
  assert.equal(
    (
      await req("/cfg/inventory/world", a, "POST", {
        characterId: a.characterId,
        version: prior,
        action: "drop",
        from: { area: "bag", index: 0 },
        x: 3,
        y: 6,
      })
    ).reason,
    "stale_inventory",
  );
  let dropped = (await world(a)).ground[0];
  assert.equal(dropped.x, 3);
  assert.equal((await world(b)).ground[0].id, dropped.id);
  assert.equal(
    (await act(c, { action: "take", id: dropped.id })).reason,
    "too_far",
  );
  assert.equal(
    (await act(b, { action: "take", id: dropped.id })).reason,
    "weight_limit",
  );
  assert.equal(
    (await act(b, { action: "mouth", id: dropped.id })).status,
    200,
    "mouth bypasses weight",
  );
  assert.equal((await inv(b)).weight, 30);
  assert.equal((await inv(b)).mouth.quantity, 1);
  assert.equal(
    (await act(a, { action: "take", id: dropped.id })).reason,
    "item_gone",
  );
  assert.equal(
    (
      await act(a, {
        action: "drop",
        from: { area: "bag", index: 0 },
        x: 3,
        y: 6,
      })
    ).status,
    200,
  );
  dropped = (await world(a)).ground[0];
  assert.equal(
    (await act(b, { action: "mouth", id: dropped.id })).reason,
    "mouth_full",
  );
  assert.equal((await act(a, { action: "mouth", id: dropped.id })).status, 200);
  const bId = (await world(b)).selfId;
  assert.equal(
    (await act(a, { action: "offer", targetId: bId })).reason,
    "mouth_full",
  );
  assert.equal(
    (await act(b, { action: "drop", from: "mouth", x: 3, y: 6 })).status,
    200,
  );
  assert.equal((await act(a, { action: "offer", targetId: bId })).status, 200);
  let offer = (await world(b)).offers[0];
  assert(offer);
  assert((await inv(a)).mouth, "offering does not transfer");
  assert(!(await inv(b)).mouth);
  assert.equal(
    (await act(c, { action: "accept", offerId: offer.id })).reason,
    "offer_expired",
    "third party cannot accept",
  );
  assert.equal(
    (await act(b, { action: "cancel", offerId: offer.id })).status,
    200,
  );
  assert((await inv(a)).mouth);
  assert.equal((await act(a, { action: "offer", targetId: bId })).status, 200);
  offer = (await world(b)).offers[0];
  assert.equal(
    (await act(b, { action: "accept", offerId: offer.id })).status,
    200,
  );
  assert(!(await inv(a)).mouth);
  assert.equal((await inv(b)).mouth.itemId, "nugget");
  assert.equal(
    (await act(b, { action: "accept", offerId: offer.id })).reason,
    "offer_expired",
  );
  // Competing pickup requests can never duplicate one world item.
  await move(cc, 3.5, 5);
  dropped = (await world(a)).ground[0];
  const race = await Promise.all([
    act(a, { action: "take", id: dropped.id }),
    act(c, { action: "take", id: dropped.id }),
  ]);
  assert.equal(race.filter((r) => r.status === 200).length, 1);
  assert.equal(race.filter((r) => r.reason === "item_gone").length, 1);
  // Hotbar drops are also one unit; F uses the first empty bag slot.
  const bagBefore = await inv(a);
  assert.equal(
    (
      await req("/cfg/inventory/move", a, "POST", {
        characterId: a.characterId,
        version: bagBefore.version,
        from: { area: "bag", index: 0 },
        to: { area: "hotbar", index: 0 },
      })
    ).status,
    200,
  );
  const hotbarCount = (await inv(a)).hotbar[0].quantity;
  assert.equal(
    (
      await act(a, {
        action: "drop",
        from: { area: "hotbar", index: 0 },
        x: 3,
        y: 6,
      })
    ).status,
    200,
  );
  assert.equal((await inv(a)).hotbar[0]?.quantity || 0, hotbarCount - 1);
  dropped = (await world(a)).ground[0];
  assert.equal((await act(a, { action: "take", id: dropped.id })).status, 200);
  assert.equal((await inv(a)).bag[0].quantity, 1);
  // Consent expires when either player leaves proximity.
  assert.equal(
    (await act(b, { action: "offer", targetId: (await world(a)).selfId }))
      .status,
    200,
  );
  offer = (await world(a)).offers[0];
  await move(ca, 8, 8);
  assert.equal(
    (await act(a, { action: "accept", offerId: offer.id })).reason,
    "offer_expired",
  );
  assert((await inv(b)).mouth);
  assert.equal(
    (
      await act(a, {
        action: "drop",
        from: { area: "hotbar", index: 0 },
        x: 3,
        y: 6,
      })
    ).status,
    200,
  );
  const persistentGround = (await world(a)).ground[0];
  // Trusted passage travel carries the mouth, but leaves ground in its original room.
  await move(cb, 2, 5);
  await sleep(1100);
  const n = cb.frames.length;
  cb.send("join", { passageId: "forest" });
  await cb.wait((f) => f[0] === "field", n);
  assert.equal((await world(b)).room, "test-loc-2");
  assert((await inv(b)).mouth);
  assert.equal((await world(b)).ground.length, 0);
  for (const client of clients) client.close();
  await stop();
  await start();
  assert.equal(
    (await inv(b)).mouth.itemId,
    "nugget",
    "mouth survives server restart",
  );
  const restored = await connect(a);
  assert.equal(
    (await world(a)).ground[0].id,
    persistentGround.id,
    "ground survives restart in its original room",
  );
  restored.ws.close();
  const groundCount = Object.keys(
    JSON.parse(fs.readFileSync(path.join(data, "inventories.json"), "utf8"))
      .ground,
  ).length;
  const total = [a, b, c].reduce((sum, p) => {
    const rows = JSON.parse(
      fs.readFileSync(path.join(data, "inventories.json"), "utf8"),
    ).inventories[`${p.id}:${p.characterId}`];
    return (
      sum +
      (rows
        ? [...rows.bag, ...rows.hotbar, rows.mouth].reduce(
            (n, s) => n + (s?.quantity || 0),
            0,
          )
        : 0)
    );
  }, 0);
  assert.equal(total + groundCount, 20, "all item units conserved");
  console.log(
    "world items: PASS — single-unit drops, race safety, proximity, weight, mouth, consent, travel and restart",
  );
} catch (error) {
  console.error(logs.slice(-3500));
  throw error;
} finally {
  for (const client of clients) client.terminate();
  await stop();
  fs.rmSync(data, { recursive: true, force: true });
}
