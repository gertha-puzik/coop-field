/** Real HTTP inventory regression with isolated data, never production. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
const root = process.cwd(),
  data = mkdtempSync(path.join(tmpdir(), "inventory-"));
const probe = net.createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
const origin = `http://127.0.0.1:${port}`,
  env = {
    ...process.env,
    DATA_DIR: data,
    PORT: String(port),
    HOST: "127.0.0.1",
    AUTH_CSRF_STRICT: "1",
    AUTH_REGISTER_GAP_MS: "1",
    AUTH_LOGIN_GAP_MS: "1",
    AUTH_REGISTER_HOURLY_MAX: "100",
  };
let server,
  logs = "";
async function start() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (c) => (logs = (logs + c).slice(-10000)));
  server.stderr.on("data", (c) => (logs = (logs + c).slice(-10000)));
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(origin + "/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 60));
  }
  throw Error(logs);
}
async function stop() {
  if (!server || server.exitCode !== null || server.signalCode) return;
  const done = once(server, "exit");
  server.kill("SIGTERM");
  await done;
}
async function req(url, cookie, method = "GET", body, extra = {}) {
  const response = await fetch(origin + url, {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    row: await response.json(),
    cookie: response.headers.get("set-cookie")?.split(";")[0],
  };
}
async function account(login) {
  assert.equal(
    (await req("/auth/register", null, "POST", { login, pass: "password1" }))
      .status,
    200,
  );
  const auth = await req("/auth/login", null, "POST", {
    login,
    pass: "password1",
  });
  return {
    cookie: auth.cookie,
    id: auth.row.accountId,
    characterId: auth.row.activeCharacterId,
  };
}
try {
  await start();
  const admin = await account("inventory_admin"),
    a = await account("inventory_a"),
    b = await account("inventory_b");
  await stop();
  const promoted = spawnSync(
    process.execPath,
    ["scripts/make-admin.mjs", "inventory_admin"],
    { cwd: root, env, encoding: "utf8" },
  );
  assert.equal(promoted.status, 0, promoted.stderr);
  const accountFile = path.join(data, "accounts.json"),
    accounts = JSON.parse(readFileSync(accountFile, "utf8"));
  const secondId = "inventory-second-character";
  accounts.accounts[a.id].characters.push({
    ...accounts.accounts[a.id].characters[0],
    id: secondId,
    name: "Второй персонаж",
  });
  writeFileSync(accountFile, JSON.stringify(accounts));
  await start();
  assert.equal((await req("/cfg/inventory", null)).status, 401);
  assert.equal((await req("/cfg/items", a.cookie)).status, 403);
  assert.equal(
    (await req("/cfg/items/grant", a.cookie, "POST", {})).status,
    403,
  );
  assert.equal(
    (await req("/cfg/inventory?characterId=" + b.characterId, a.cookie)).status,
    404,
  );
  const hidden = await new Promise((resolve) => {
    const r = http.request(
      origin + "/cfg/inventory",
      { headers: { host: "abnocw.phainonsmilk.ru", cookie: a.cookie } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      },
    );
    r.end();
  });
  assert.equal(hidden, 404);
  const initial = (await req("/cfg/items", admin.cookie)).row.items.find(
    (item) => item.id === "nugget",
  );
  assert.equal(initial.name, "Наггетс");
  assert.equal(initial.weight, 3);
  assert.equal(initial.sprite, "/items/nugget.png");
  assert.equal(
    (await req("/cfg/items", admin.cookie, "POST", initial)).status,
    200,
    "built-in sprite survives metadata edits",
  );
  const original = readFileSync(path.join(root, "public/items/nugget.png"));
  assert.equal(original.readUInt32BE(16), 30);
  assert.equal(original.readUInt32BE(20), 30);
  const png = readFileSync(path.join(root, "public/tex/grass-ground.png"));
  const uploaded = await fetch(origin + "/cfg/items/sprite", {
    method: "POST",
    headers: { origin, cookie: admin.cookie },
    body: png,
  });
  assert.equal(uploaded.status, 200);
  const { sprite } = await uploaded.json();
  const file = await fetch(origin + sprite);
  assert.equal(file.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  assert.equal(
    (
      await fetch(origin + "/cfg/items/sprite", {
        method: "POST",
        headers: { origin, cookie: admin.cookie },
        body: '<svg onload="alert(1)"/>',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await fetch(origin + "/cfg/items/sprite", {
        method: "POST",
        headers: { origin, cookie: admin.cookie },
        body: Buffer.alloc(2 * 1024 * 1024 + 1),
      })
    ).status,
    413,
  );
  assert.equal(
    (
      await req("/cfg/items", admin.cookie, "POST", {
        id: "nugget",
        name: "Наггетс",
        weight: 3,
        sprite,
        glows: true,
        glowIntensity: 1.8,
        glowPeriod: 8,
        sparkle: true,
      })
    ).status,
    200,
  );
  for (const bad of [
    { glowIntensity: -1 },
    { glowIntensity: 4 },
    { glowPeriod: 0.1 },
    { glowPeriod: 61 },
    { sparkle: "yes" },
  ]) {
    assert.equal(
      (
        await req("/cfg/items", admin.cookie, "POST", {
          id: "nugget",
          name: "Наггетс",
          weight: 3,
          sprite,
          ...bad,
        })
      ).status,
      400,
    );
  }
  assert.equal(
    (await req("/cfg/items", admin.cookie)).row.items.find(
      (i) => i.id === "nugget",
    ).glows,
    true,
  );
  const restoredGlow = (await req("/cfg/items", admin.cookie)).row.items.find(
    (i) => i.id === "nugget",
  );
  assert.equal(
    restoredGlow.glowIntensity,
    1.8,
    "brightness survives legacy edits and restart",
  );
  assert.equal(restoredGlow.glowPeriod, 8);
  assert.equal(restoredGlow.sparkle, true);

  assert.equal(
    (
      await req("/cfg/items", admin.cookie, "POST", {
        id: "nugget",
        name: "Наггетс",
        weight: 3,
        sprite,
        glows: "yes",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await req("/cfg/items", admin.cookie, "POST", {
        id: "invalid",
        name: "Invalid",
        weight: -1,
        sprite,
      })
    ).status,
    400,
  );
  let snapshot = (await req("/cfg/inventory", a.cookie)).row.inventory;
  assert.equal(snapshot.bag.length, 10);
  assert.equal(snapshot.hotbar.length, 5);
  assert.equal(snapshot.weight, 0);
  const grant = (owner, char, itemId, quantity, id = crypto.randomUUID()) =>
    req("/cfg/items/grant", admin.cookie, "POST", {
      accountId: owner,
      characterId: char,
      itemId,
      quantity,
      operationId: id,
    });
  assert.equal(
    (
      await req(
        "/cfg/items/grant",
        admin.cookie,
        "POST",
        {
          accountId: a.id,
          characterId: a.characterId,
          itemId: "nugget",
          quantity: 1,
          operationId: crypto.randomUUID(),
        },
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const op = crypto.randomUUID(),
    both = await Promise.all([
      grant(a.id, a.characterId, "nugget", 6, op),
      grant(a.id, a.characterId, "nugget", 6, op),
    ]);
  assert.ok(both.every((r) => r.status === 200));
  assert.equal(both.filter((r) => r.row.replayed).length, 1);
  snapshot = (await req("/cfg/inventory", a.cookie)).row.inventory;
  assert.equal(snapshot.weight, 18);
  assert.equal(snapshot.bag[0].quantity, 6);
  assert.equal(
    (await grant(a.id, a.characterId, "nugget", 5)).row.reason,
    "weight_limit",
  );
  assert.equal((await grant(a.id, a.characterId, "nugget", 4)).status, 200);
  snapshot = (await req("/cfg/inventory", a.cookie)).row.inventory;
  assert.equal(snapshot.weight, 30);
  assert.equal(snapshot.bag[0].quantity, 10);
  assert.equal(
    (await grant(a.id, a.characterId, "nugget", 1)).row.reason,
    "weight_limit",
  );
  assert.equal(
    (
      await req(
        "/cfg/inventory/move",
        a.cookie,
        "POST",
        {
          characterId: a.characterId,
          version: snapshot.version,
          from: { area: "bag", index: 0 },
          quick: true,
        },
        { origin: "https://evil.example" },
      )
    ).status,
    403,
  );
  const moved = await req("/cfg/inventory/move", a.cookie, "POST", {
    characterId: a.characterId,
    version: snapshot.version,
    from: { area: "bag", index: 0 },
    quick: true,
  });
  assert.equal(moved.status, 200);
  snapshot = moved.row.inventory;
  assert.equal(snapshot.bag[0], null);
  assert.equal(snapshot.hotbar[0].quantity, 10);
  assert.equal(snapshot.weight, 30);
  assert.equal(
    (
      await req("/cfg/inventory/move", b.cookie, "POST", {
        characterId: a.characterId,
        version: snapshot.version,
        from: { area: "hotbar", index: 0 },
        quick: true,
      })
    ).status,
    404,
  );
  const version = snapshot.version,
    moveBody = {
      characterId: a.characterId,
      version,
      from: { area: "hotbar", index: 0 },
      to: { area: "bag", index: 5 },
    };
  const race = await Promise.all([
    req("/cfg/inventory/move", a.cookie, "POST", moveBody),
    req("/cfg/inventory/move", a.cookie, "POST", moveBody),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  snapshot = (await req("/cfg/inventory", a.cookie)).row.inventory;
  assert.equal(snapshot.bag[5].quantity, 10);
  assert.equal(snapshot.hotbar[0], null);
  assert.equal(snapshot.weight, 30);
  assert.equal(
    (
      await req("/cfg/items", admin.cookie, "POST", {
        id: "nugget",
        name: "Наггетс",
        weight: 4,
        sprite,
      })
    ).row.reason,
    "weight_in_use",
  );
  assert.equal((await grant(a.id, secondId, "nugget", 1)).status, 200);
  assert.equal(
    (await req("/cfg/inventory?characterId=" + secondId, a.cookie)).row
      .inventory.weight,
    3,
  );
  assert.equal(
    (await req("/cfg/inventory", a.cookie)).row.inventory.weight,
    30,
  );
  // All fifteen slots are available, stacking does not consume an extra slot, and full inventories reject new types.
  for (let i = 0; i < 16; i++) {
    assert.equal(
      (
        await req("/cfg/items", admin.cookie, "POST", {
          id: "item-" + i,
          name: "Предмет " + i,
          weight: 0.1,
          sprite,
        })
      ).status,
      200,
    );
    if (i < 15)
      assert.equal(
        (await grant(b.id, b.characterId, "item-" + i, 1)).status,
        200,
      );
  }
  assert.equal(
    (await grant(b.id, b.characterId, "item-15", 1)).row.reason,
    "no_free_slot",
  );
  assert.equal((await grant(b.id, b.characterId, "item-0", 1)).status, 200);
  let bv = (await req("/cfg/inventory", b.cookie)).row.inventory;
  assert.equal(bv.weight, 1.6);
  const swap = await req("/cfg/inventory/move", b.cookie, "POST", {
    characterId: b.characterId,
    version: bv.version,
    from: { area: "bag", index: 0 },
    to: { area: "hotbar", index: 0 },
  });
  assert.equal(swap.status, 200);
  assert.equal(swap.row.inventory.hotbar[0].itemId, "item-0");
  assert.equal(swap.row.inventory.bag[0].itemId, "item-10");
  await stop();
  await start();
  assert.equal(
    (await req("/cfg/inventory", a.cookie)).row.inventory.weight,
    30,
  );
  assert.equal(
    (await req("/cfg/inventory?characterId=" + secondId, a.cookie)).row
      .inventory.weight,
    3,
  );
  assert.equal(
    (await grant(a.id, a.characterId, "nugget", 6, op)).row.replayed,
    true,
    "grant idempotency survives restart",
  );
  assert.equal(
    (await req("/cfg/items", admin.cookie)).row.items.find(
      (i) => i.id === "nugget",
    ).glows,
    true,
    "glow survives edits by old clients and restart",
  );
  assert.equal((await fetch(origin + sprite)).status, 200);
  const log = (await req("/cfg/console", admin.cookie)).row.items;
  assert.ok(
    log.some((row) => row.group === "items" && row.text.includes("Выдано:")),
  );
  assert.equal(
    (await req("/profiles/me", b.cookie, "DELETE", { password: "password1" }))
      .status,
    200,
  );
  const remaining = JSON.parse(
    readFileSync(path.join(data, "inventories.json"), "utf8"),
  );
  assert.equal(
    Object.keys(remaining.inventories).some((key) =>
      key.startsWith(b.id + ":"),
    ),
    false,
    "account deletion erases inventories",
  );
  await stop();
  remaining.items.nugget.sprite = null;
  writeFileSync(path.join(data, "inventories.json"), JSON.stringify(remaining));
  await start();
  assert.equal(
    (await req("/cfg/items", admin.cookie)).row.items.find(
      (item) => item.id === "nugget",
    ).sprite,
    "/items/nugget.png",
    "existing missing sprites migrate to the supplied original",
  );
  assert.equal(
    (await req("/cfg/inventory", a.cookie)).row.inventory.weight,
    30,
    "sprite migration preserves stacks",
  );
  console.log(
    "inventory: PASS — ownership, fifteen slots, stacks, shared weight, transactions, replay protection, sprites, logs and restart",
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await stop();
  rmSync(data, { recursive: true, force: true });
}
