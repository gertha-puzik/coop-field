#!/usr/bin/env node
/**
 * Живой тест админ-замены текстур редактора (server/textures.js).
 * Песочница: mkdtemp DATA_DIR, свободный порт, спавн server.js.
 *
 * Позитив: каталог, замена PNG, отдача /tex/file, откат к builtin.
 * Негатив: без сессии 401, не-админ 403, CSRF без Origin, unknown id, не PNG.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { deflateSync } from "node:zlib";

const require = createRequire(import.meta.url);
const PLANT_SPRITES = require("../server/plant-sprites.json");
const EXPECTED = 3 + 10 + PLANT_SPRITES.length + 13 + 2;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coop-tex-"));
const getPort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const port = await getPort();
const origin = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tinyPng(w = 8, h = 8) {
  const stride = w * 4 + 1;
  const pixels = Buffer.alloc(stride * h, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * stride + 1 + x * 4;
      pixels[i] = 40; pixels[i + 1] = 120; pixels[i + 2] = 40; pixels[i + 3] = 255;
    }
  }
  const crc = (b) => {
    let c = 0xffffffff;
    for (const v of b) {
      c ^= v;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, body) => {
    const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    sum.writeUInt32BE(crc(Buffer.concat([t, body])));
    return Buffer.concat([len, t, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function multipart(fileBuf, filename = "tex.png") {
  const boundary = "----cooptexboundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, fileBuf, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

assert.equal(spawnSync(process.execPath, ["scripts/make-admin.mjs", "texadmin", "local-test-pass"], {
  env: { ...process.env, DATA_DIR: dir }, encoding: "utf8",
}).status, 0);

let server;
let logs = "";
async function start() {
  server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: "127.0.0.1", AUTH_CSRF_STRICT: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (x) => { logs += x; });
  server.stderr.on("data", (x) => { logs += x; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + "/health")).ok) return; } catch { /* retry */ }
    await sleep(50);
  }
  throw new Error(logs);
}

try {
  await start();
  const login = await fetch(origin + "/auth/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ login: "texadmin", pass: "local-test-pass" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie().map((s) => s.split(";")[0]).join("; ");

  const pub = await fetch(origin + "/tex/catalog");
  assert.equal(pub.status, 200);
  const pubBody = await pub.json();
  assert.equal(pubBody.items.length, EXPECTED);
  assert.equal(pubBody.items.find((i) => i.id === "tree-1").replaced, false);

  assert.equal((await fetch(origin + "/admin/tex")).status, 401);
  const adminList = await fetch(origin + "/admin/tex", { headers: { Cookie: cookie } });
  assert.equal(adminList.status, 200);
  const listBody = await adminList.json();
  assert.equal(listBody.items.length, EXPECTED);
  assert.equal(listBody.categories.length, 5);

  const noOrigin = await fetch(origin + "/admin/tex/tree-1", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": multipart(tinyPng()).contentType },
    body: multipart(tinyPng()).body,
  });
  assert.equal(noOrigin.status, 403);

  const form = multipart(tinyPng(12, 10));
  const replaced = await fetch(origin + "/admin/tex/tree-1", {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": form.contentType },
    body: form.body,
  });
  const replacedText = await replaced.text();
  assert.equal(replaced.status, 200, replacedText);
  const replacedBody = JSON.parse(replacedText);
  assert.equal(replacedBody.item.id, "tree-1");
  assert.equal(replacedBody.item.replaced, true);
  assert.equal(replacedBody.item.w, 12);
  assert.equal(replacedBody.item.h, 10);
  assert(replacedBody.item.src.startsWith("/tex/file/tree-1.png?v="));

  const fileRes = await fetch(origin + replacedBody.item.src);
  assert.equal(fileRes.status, 200);
  assert.equal(fileRes.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  const badId = await fetch(origin + "/admin/tex/nope-tex", {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": form.contentType },
    body: form.body,
  });
  assert.equal(badId.status, 404);

  const notPng = multipart(Buffer.from("not-a-png"), "x.png");
  const badPng = await fetch(origin + "/admin/tex/rock-1", {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": notPng.contentType },
    body: notPng.body,
  });
  assert.equal(badPng.status, 400);

  const restored = await fetch(origin + "/admin/tex/tree-1", {
    method: "DELETE",
    headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(restored.status, 200);
  const restoredBody = await restored.json();
  assert.equal(restoredBody.restored, true);
  assert.equal(restoredBody.item.replaced, false);
  assert.equal(restoredBody.item.src, "/tex/tree-1.png");
  assert.equal((await fetch(origin + "/tex/file/tree-1.png")).status, 404);

  function multipartCreate(fileBuf, fields) {
    const boundary = "----cooptexcreate";
    const chunks = [];
    for (const [name, value] of Object.entries(fields)) {
      chunks.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ));
    }
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="custom.png"\r\nContent-Type: image/png\r\n\r\n`,
    ));
    chunks.push(fileBuf);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    return {
      body: Buffer.concat(chunks),
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  const createdForm = multipartCreate(tinyPng(16, 20), {
    label: "Дуб свой",
    category: "trees",
    group: "Мои",
  });
  const created = await fetch(origin + "/admin/tex", {
    method: "POST",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": createdForm.contentType },
    body: createdForm.body,
  });
  const createdText = await created.text();
  assert.equal(created.status, 200, createdText);
  const createdBody = JSON.parse(createdText);
  assert.equal(createdBody.item.custom, true);
  assert.equal(createdBody.item.category, "trees");
  assert.equal(createdBody.item.label, "Дуб свой");
  assert.equal(createdBody.item.group, "Мои");
  assert.match(createdBody.item.id, /^x-/);
  assert.equal(createdBody.item.w, 16);
  assert.equal(createdBody.item.h, 20);
  const customId = createdBody.item.id;

  const catAfter = await (await fetch(origin + "/tex/catalog")).json();
  assert.equal(catAfter.items.length, EXPECTED + 1);
  assert(catAfter.items.some((i) => i.id === customId));

  const patched = await fetch(origin + "/admin/tex/" + customId, {
    method: "PATCH",
    headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Дуб переименован", category: "rocks", group: "Камни мои" }),
  });
  assert.equal(patched.status, 200);
  const patchedBody = await patched.json();
  assert.equal(patchedBody.item.label, "Дуб переименован");
  assert.equal(patchedBody.item.category, "rocks");
  assert.equal(patchedBody.item.group, "Камни мои");

  const deleted = await fetch(origin + "/admin/tex/" + customId, {
    method: "DELETE",
    headers: { Origin: origin, Cookie: cookie },
  });
  assert.equal(deleted.status, 200);
  const deletedBody = await deleted.json();
  assert.equal(deletedBody.deleted, true);
  assert.equal((await (await fetch(origin + "/tex/catalog")).json()).items.length, EXPECTED);
  assert.equal((await fetch(origin + "/tex/file/" + customId + ".png")).status, 404);

  console.log("PASS: tex catalog, replace/restore, custom CRUD, file serve, CSRF and validation gates");
} finally {
  if (server) {
    server.kill("SIGTERM");
    await once(server, "exit").catch(() => {});
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
