/**
 * Реплей реального боя из HAR через исправленный сервер.
 *
 * Берёт тайминги move-отправок обоих игроков (extract_replay.py) и
 * воспроизводит их 1:1 (паузы > 2 с сжаты до 2 с). Метрика — как в разборе
 * боя: каждый отправленный ход должен получить ответ (эхо или refuse).
 * До фикса сервер молча глотал 5 (сыр) + 19 (вп) ходов.
 *
 * node scripts/replay-har-moves.mjs /tmp/replay.json
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

const replay = JSON.parse(readFileSync(process.argv[2] || "/tmp/replay.json", "utf-8"));
const PORT = 3840 + Math.floor(Math.random() * 40);
const WS_ADDR = `ws://127.0.0.1:${PORT}`;
const GAP_CAP = 2000;

const server = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => {});
server.stderr.on("data", (d) => process.stderr.write(d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(login) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_ADDR);
    const inbox = [];
    ws.on("open", () => ws.send(JSON.stringify(["join", { room: "har-replay", login }])));
    ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.inbox = inbox;
    ws.once("open", () => resolve(ws));
  });
}

const waitFor = (ws, pred, ms = 5000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ws.inbox.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error("timeout"));
      setTimeout(tick, 15);
    };
    tick();
  });

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};

try {
  for (let i = 0; i < 100; i += 1) {
    const ok = await new Promise((resolve) => {
      const probe = new WebSocket(WS_ADDR);
      probe.once("open", () => { probe.terminate(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (ok) break;
    await sleep(100);
  }

  const a = await connect("сыр");
  const youA = await waitFor(a, (m) => m[0] === "you");
  const b = await connect("вп");
  const youB = await waitFor(b, (m) => m[0] === "you");

  const stats = {
    a: { sent: 0, echo: 0, refuse: 0 },
    b: { sent: 0, echo: 0, refuse: 0 },
  };
  a.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m[0] === "update cat" && m[1] && m[1].id === youA[1].id && "x" in m[1]) stats.a.echo += 1;
    if (m[0] === "refuse") stats.a.refuse += 1;
  });
  b.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m[0] === "update cat" && m[1] && m[1].id === youB[1].id && "x" in m[1]) stats.b.echo += 1;
    if (m[0] === "refuse") stats.b.refuse += 1;
  });

  // планируем отправки: объединяем оба потока, сжимаем паузы > GAP_CAP
  const plan = [];
  for (const s of replay.syr) plan.push({ dt: s.dt, who: a, st: "a", x: s.x, y: s.y, deg: s.deg });
  for (const s of replay.vp) plan.push({ dt: s.dt, who: b, st: "b", x: s.x, y: s.y, deg: s.deg });
  plan.sort((p, q) => p.dt - q.dt);

  let clock = 0;
  let prev = 0;
  const t0 = Date.now();
  for (const step of plan) {
    let gap = step.dt - prev;
    if (gap > GAP_CAP) gap = GAP_CAP;
    prev = step.dt;
    if (gap > 0) await sleep(gap);
    clock += gap;
    step.who.send(JSON.stringify(["move", { x: step.x, y: step.y, deg: step.deg }]));
    stats[step.st].sent += 1;
  }
  // даём хвосту очереди доехать
  await sleep(1500);
  const wall = (Date.now() - t0) / 1000;

  console.log(`реплей: ${plan.length} ходов за ${wall.toFixed(0)} с (сжатые паузы)`);
  for (const [who, label, wasDropped] of [["a", "сыр", 5], ["b", "вп", 19]]) {
    const s = stats[who];
    const missing = s.sent - s.echo - s.refuse;
    check(missing === 0, `${label}: отправлено ${s.sent}, отвечено ${s.echo + s.refuse} (эхо ${s.echo}, refuse ${s.refuse}) — потеряно ${missing} (до фикса терялось ${wasDropped})`);
  }
  a.terminate();
  b.terminate();
} catch (err) {
  failures += 1;
  console.error("FAIL", err);
} finally {
  server.kill("SIGTERM");
}

console.log(failures === 0 ? "\nPASS: ни один ход боя не потерян" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
