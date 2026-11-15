/** Animated profile GIFs: exact 10 MiB limit, byte parity, restart, replacement and deletion. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import ts from 'typescript';

const root = new URL('..', import.meta.url).pathname;
const data = mkdtempSync(path.join(tmpdir(), 'coop-gif-'));
const free = net.createServer();
await new Promise(resolve => free.listen(0, '127.0.0.1', resolve));
const port = free.address().port;
await new Promise(resolve => free.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const limit = 10 * 1024 * 1024;
let server, logs = '';
async function start() {
  server = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, AUTH_CSRF_STRICT: '1', AUTH_REGISTER_GAP_MS: '1', AUTH_REGISTER_HOURLY_MAX: '100', AUTH_LOGIN_GAP_MS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', chunk => { logs = (logs + chunk).slice(-20_000); });
  server.stderr.on('data', chunk => { logs = (logs + chunk).slice(-20_000); });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${origin}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`server startup failed: ${logs}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const closed = once(server, 'exit'); server.kill('SIGTERM'); await closed;
}
async function json(url, cookie, method = 'GET', body) {
  const res = await fetch(origin + url, { method, headers: { origin, ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { status: res.status, row: await res.json(), cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function account(login) {
  const reg = await json('/auth/register', null, 'POST', { login, pass: 'password1' });
  assert.equal(reg.status, 200, JSON.stringify(reg.row));
  const res = await json('/auth/login', null, 'POST', { login, pass: 'password1' });
  assert.equal(res.status, 200); assert.ok(res.cookie); return res.cookie;
}
async function upload(url, cookie, bytes, name = 'animated.gif') {
  const form = new FormData(); form.append('file', new Blob([bytes], { type: name.endsWith('.gif') ? 'image/gif' : 'image/png' }), name);
  const res = await fetch(origin + url, { method: 'POST', headers: { origin, ...(cookie ? { cookie } : {}) }, body: form, signal: AbortSignal.timeout(15_000) });
  return { status: res.status, row: await res.json() };
}
async function sameGif(url, bytes) {
  const res = await fetch(origin + url);
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/gif');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes, 'animation bytes must be unchanged');
}
const base = readFileSync(path.join(root, 'public/sprites/test1-walk.gif'));
assert.equal(base.at(-1), 0x3b);
assert.ok(base.indexOf(Buffer.from([0x21, 0xf9])) >= 0, 'real animated GIF fixture');
// A valid GIF comment extension pads the file without changing its animation.
function sizedGif(size) {
  let remaining = size - base.length - 3;
  const chunks = [];
  while (remaining > 0) {
    let count = Math.min(256, remaining);
    if (remaining - count === 1) count--;
    assert.ok(count >= 2);
    const chunk = Buffer.alloc(count); chunk[0] = count - 1; chunks.push(chunk); remaining -= count;
  }
  return Buffer.concat([base.subarray(0, -1), Buffer.from([0x21, 0xfe]), ...chunks, Buffer.from([0, 0x3b])]);
}
async function proxyUploads() {
  let requestLimit = 1024 * 1024;
  const bodies = [];
  const proxy = http.createServer(async (req, res) => {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; chunks.push(chunk); }
    bodies.push(size);
    if (size > requestLimit) { res.writeHead(413, { 'content-type': 'text/html' }); res.end('<h1>413 Request Entity Too Large</h1>'); return; }
    const upstream = http.request(origin + req.url, { method: req.method, headers: { ...req.headers, host: new URL(origin).host } }, result => {
      res.writeHead(result.statusCode, result.headers); result.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(502); res.end(); });
    upstream.end(Buffer.concat(chunks));
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyOrigin = `http://127.0.0.1:${proxy.address().port}`;
  const nativeFetch = globalThis.fetch;
  try {
    // Use the actual frontend sender, replacing only its browser origin dependency.
    const source = readFileSync(path.join(root, 'src/lib/net/http-profile-image.ts'), 'utf8')
      .replace("import { httpOrigin } from './coop';", `const httpOrigin = () => ${JSON.stringify(proxyOrigin)};`);
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const { postProfileImage } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
    const exact = sizedGif(limit);
    const file = new File([exact], 'animated.gif', { type: 'image/gif' });
    // Reproduce the old failure: a single multipart request receives nginx-like HTML 413.
    const form = new FormData(); form.append('file', file);
    assert.equal((await nativeFetch(proxyOrigin + '/cfg/banners/mine', { method: 'POST', body: form })).status, 413);
    bodies.length = 0;
    for (const [kind, endpoint] of [['banner', '/cfg/banners/mine'], ['avatar', '/avatars/mine']]) {
      const cookie = await account('chunk_' + kind);
      globalThis.fetch = (url, init = {}) => nativeFetch(url, { ...init, headers: { ...init.headers, origin, cookie } });
      const result = await postProfileImage(endpoint, file);
      assert.equal(result.status, 200, JSON.stringify(result));
      assert.equal(result.row.ok, true);
      await sameGif(result.row[kind], exact);
      assert.ok(bodies.every(bytes => bytes <= 512 * 1024));
      assert.equal(bodies.length, 20); bodies.length = 0;
      globalThis.fetch = nativeFetch;
    }
    const cookie = await account('chunk_invalid');
    const id = crypto.randomUUID();
    const chunkUrl = `/cfg/banners/mine?upload=${id}&part=0&size=${exact.length}`;
    const send = (url, bytes, headers = {}) => nativeFetch(origin + url, { method: 'POST', headers: { 'content-type': 'application/octet-stream', origin, cookie, ...headers }, body: bytes });
    const chunk = exact.subarray(0, 512 * 1024);
    assert.equal((await send(chunkUrl, chunk, { cookie: '' })).status, 401);
    assert.equal((await send(chunkUrl, chunk, { origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await send(chunkUrl, chunk)).status, 202);
    assert.equal((await json('/profiles/me', cookie)).row.banner, null, 'partial file is not published');
    assert.equal((await send(chunkUrl.replace('part=0', 'part=2'), chunk)).status, 409);
    assert.equal((await send(chunkUrl.replace(`size=${limit}`, `size=${limit + 1}`), chunk)).status, 413);
    assert.equal((await send(chunkUrl, chunk.subarray(0, 10))).status, 400);
    assert.equal((await send(chunkUrl.replace('part=0', 'part=1'), chunk)).status, 409, 'failed upload is discarded');
    // A proxy failure must never turn into the vague save-failed message again.
    requestLimit = 1;
    globalThis.fetch = (url, init = {}) => nativeFetch(url, { ...init, headers: { ...init.headers, origin, cookie } });
    const rejected = await postProfileImage('/cfg/banners/mine', new File([base], 'small.gif', { type: 'image/gif' }));
    assert.equal(rejected.status, 413); assert.equal(rejected.row.reason, 'proxy_too_large');
    console.log('profile-gif proxy: PASS — HTML 413 reproduced, actual client uploads 10 MiB through 1 MiB proxy, chunks ≤512 KiB, auth/CSRF/order/cleanup');
  } finally { globalThis.fetch = nativeFetch; await new Promise(resolve => proxy.close(resolve)); }
}
try {
  await start();
  const owner = await account('gif_owner');
  const exact = sizedGif(limit), over = sizedGif(limit + 1);
  assert.equal(exact.length, limit);
  // A common non-banner aspect ratio must not require flattening/resizing GIFs.
  exact.writeUInt16LE(640, 6); exact.writeUInt16LE(480, 8);
  const badDimensions = Buffer.from(base); badDimensions.writeUInt16LE(1501, 6);
  const png = readFileSync(path.join(root, 'public/sprites/trehcvetny.png'));
  const tooBigPng = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 + 1 - png.length)]);
  const urls = {};
  for (const [kind, endpoint] of [['avatar', '/avatars/mine'], ['banner', '/cfg/banners/mine']]) {
    assert.equal((await upload(endpoint, null, base)).status, 401);
    const invalid = await upload(endpoint, owner, badDimensions);
    assert.equal(invalid.status, 400); assert.equal(invalid.row.reason, 'bad_dims');
    const bad = await upload(endpoint, owner, over);
    assert.equal(bad.status, 413); assert.equal(bad.row.reason, 'too_large');
    assert.equal((await upload(endpoint, owner, tooBigPng, 'large.png')).status, 413);
    const res = await upload(endpoint, owner, exact);
    assert.equal(res.status, 200, JSON.stringify(res.row));
    assert.match(res.row[kind], /\.gif\?v=/); urls[kind] = res.row[kind];
    await sameGif(urls[kind], exact);
  }
  await stop(); await start();
  const me = await json('/profiles/me', owner);
  assert.equal(me.row.avatar, urls.avatar); assert.equal(me.row.banner, urls.banner);
  await sameGif(me.row.avatar, exact); await sameGif(me.row.banner, exact);
  const replaced = await upload('/avatars/mine', owner, png, 'avatar.png');
  assert.equal(replaced.status, 200); assert.match(replaced.row.avatar, /\.png\?v=/);
  assert.equal((await fetch(origin + urls.avatar)).status, 404, 'replacing GIF cleans the previous file');
  assert.equal((await json('/cfg/banners/mine', owner, 'DELETE')).status, 200);
  assert.equal((await fetch(origin + urls.banner)).status, 404);

  const deleter = await account('gif_delete');
  const ownGif = await upload('/avatars/mine', deleter, base);
  assert.equal(ownGif.status, 200);
  assert.equal((await json('/avatars/mine', deleter, 'DELETE')).status, 200);
  assert.equal((await fetch(origin + ownGif.row.avatar)).status, 404);

  const removed = await account('gif_account');
  const a = await upload('/avatars/mine', removed, base), b = await upload('/banners/mine', removed, base);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.equal((await json('/profiles/me', removed, 'DELETE', { password: 'password1' })).status, 200);
  assert.equal((await fetch(origin + a.row.avatar)).status, 404);
  assert.equal((await fetch(origin + b.row.banner)).status, 404);
  const id = /file\/([^.]+)\.gif/.exec(a.row.avatar)[1];
  assert.equal(existsSync(path.join(data, 'avatars', `${id}.gif`)), false);
  await proxyUploads();
  console.log('profile-gif: PASS — exact 10 MiB, +1 rejection, animation parity, restart, replacement, deletion');
} finally { await stop(); rmSync(data, { recursive: true, force: true }); }
