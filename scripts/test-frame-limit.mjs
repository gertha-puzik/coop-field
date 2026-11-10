/**
 * Контракт общего потолка кадров block/space/atmo/dummy/rab.
 *
 * 1. Чистый бакет: запас 2, третий кадр в том же миллисекундном окне — отказ,
 *    через 50 мс снова можно. Один слот на сокет, не отдельный на событие.
 * 2. Живой сервер: пачка block не размножается в комнату 1:1; после паузы
 *    кадр снова доходит. Песочница со своим портом и DATA_DIR.
 *
 * Запуск: node scripts/test-frame-limit.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import {
  allowBroadcastFrame,
  BROADCAST_FRAME_BURST,
  BROADCAST_FRAME_GAP_MS,
} from "../server/frame-limit.js";

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};

{
  const ws = {};
  const t0 = 1_000_000;
  const accepted = [];
  for (let i = 0; i < 5; i++) accepted.push(allowBroadcastFrame(ws, t0));
  check(accepted.slice(0, BROADCAST_FRAME_BURST).every(Boolean), "burst: первые 2 кадра проходят");
  check(accepted.slice(BROADCAST_FRAME_BURST).every((v) => v === false), "burst: кадры сверх запаса молча не проходят");
  check(allowBroadcastFrame(ws, t0 + BROADCAST_FRAME_GAP_MS - 1) === false, "зазор: 49 мс ещё рано");
  check(allowBroadcastFrame(ws, t0 + BROADCAST_FRAME_GAP_MS) === true, "зазор: ровно 50 мс снова можно");
  const other = {};
  check(allowBroadcastFrame(other, t0) === true, "другой сокет имеет свой бакет");
}

const PORT = 18600 + Math.floor(Math.random() * 1000);
const DATA_DIR = mkdtempSync(path.join(tmpdir(), "coop-frame-"));
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", DATA_DIR },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));
server.stdout.on("data", () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WS_ADDR = `ws://127.0.0.1:${PORT}`;

function client(name, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_ADDR);
    const inbox = [];
    ws.on("open", () => ws.send(JSON.stringify(["join", { room, login: name }])));
    ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.inbox = inbox;
    ws.once("open", () => resolve(ws));
  });
}

function countEvent(ws, event) {
  return ws.inbox.filter((m) => m[0] === event).length;
}

try {
  for (let i = 0; i < 50; i += 1) {
    const up = await new Promise((resolve) => {
      const probe = new WebSocket(WS_ADDR);
      probe.once("open", () => { probe.terminate(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (up) break;
    await sleep(50);
    if (i === 49) throw new Error("server did not accept websocket");
  }

  const room = `fl${Date.now().toString(36)}`;
  const sender = await client("Шлёт", room);
  const peer = await client("Слышит", room);
  await sleep(200);
  peer.inbox.length = 0;

  const flood = 24;
  for (let i = 0; i < flood; i++) sender.send(JSON.stringify(["block", { on: i % 2 === 0 }]));
  await sleep(120);
  const relayed = countEvent(peer, "block");
  check(relayed >= 1 && relayed < flood / 2, `пачка ${flood} block ушла соседу ${relayed} раз, не 1:1`);

  peer.inbox.length = 0;
  await sleep(BROADCAST_FRAME_GAP_MS + 30);
  sender.send(JSON.stringify(["block", { on: false }]));
  await sleep(150);
  check(countEvent(peer, "block") === 1, "после паузы честный block off доходит");

  sender.close();
  peer.close();
} catch (err) {
  failures += 1;
  console.error("FAIL", err && err.message ? err.message : err);
} finally {
  server.kill("SIGTERM");
}

console.log(failures === 0 ? "\nPASS: frame limit" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
