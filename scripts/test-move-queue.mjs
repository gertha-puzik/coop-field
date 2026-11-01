/**
 * Тест очереди шагов на сервере (фикс «молчаливого поглощения» ходов).
 *
 * Воспроизводит сценарий из HAR реального боя: клиент после отката предикта
 * стреляет ходами чаще серверного кулдауна (80 мс). Раньше такие ходы
 * терялись без ответа — предикт клиента расходился, и следующий эхо
 * откатывал кота на клетку назад («телепорт»).
 *
 * Проверяется:
 *  1. залп из 6 ходов с интервалом 30 мс: каждый получает ответ
 *     (эхо или refuse), очередь глубиной 3 ограничивает залп;
 *  2. гонка двух котов за одну пустую клетку: ровно один занимает,
 *     второй — cell_busy;
 *  3. сервер никогда не ставит двух котов в одну клетку;
 *  4. залп из 10 ходов подряд отвечает полностью.
 *
 * Запуск: node scripts/test-move-queue.mjs
 */
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const PORT = 3793 + Math.floor(Math.random() * 50);
const WS_ADDR = `ws://127.0.0.1:${PORT}`;

const server = spawn(process.execPath, ["server.js"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", () => {});
server.stderr.on("data", (d) => process.stderr.write(d));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const waitFor = (ws, pred, ms = 3000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ws.inbox.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout; inbox=${JSON.stringify(ws.inbox.slice(-8))}`));
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

  // --- 1. залп из 6 ходов с интервалом 30 мс, поле свободно ---
  const a = await client("бurst", "burst1");
  const youA = await waitFor(a, (m) => m[0] === "you");
  const idA = youA[1].id;
  const startX = youA[1].x;
  a.inbox.length = 0;

  const BURST = 6;
  for (let i = 0; i < BURST; i += 1) {
    a.send(JSON.stringify(["move", { x: 1, y: 0, deg: 0 }]));
    await sleep(30);
  }
  await sleep(1200); // очередь разгоняется по 80 мс на шаг

  const echoes = a.inbox.filter((m) => m[0] === "update cat" && m[1].id === idA && "x" in m[1]);
  const refusals = a.inbox.filter((m) => m[0] === "refuse");
  check(echoes.length + refusals.length === BURST,
    `каждый ход отвечен: ${echoes.length} эхо + ${refusals.length} refuse = ${BURST}`);
  check(refusals.every((m) => m[1] && m[1].code === "cooldown"),
    `все отказы с кодом cooldown: ${JSON.stringify(refusals.map((m) => m[1] && m[1].code))}`);
  // математика залпа (интервал 30 мс, кулдаун 80 мс, очередь 3):
  // m1 сразу, m2 в момент +80, m3 в +160, m4 в +240, m5 в +320, m6 — refuse.
  check(echoes.length === 5 && refusals.length === 1,
    `очередь ограничила залп: принято 5, отказано 1 (получено ${echoes.length}/${refusals.length})`);
  const sequential = echoes.every((m, i) => m[1].x === startX + i + 1);
  check(sequential, `эха идут по клеткам подряд от x=${startX}: ${JSON.stringify(echoes.map((m) => m[1].x))}`);
  a.terminate();

  // --- 2. гонка за одну пустую клетку ---
  // спавны: первый (4,3), второй (5,3). Оба целятся в (5,4).
  const p = await client("левый", "race2");
  const youP = await waitFor(p, (m) => m[0] === "you");
  const q = await client("правый", "race2");
  const youQ = await waitFor(q, (m) => m[0] === "you");
  check(youP[1].x === 4 && youP[1].y === 3 && youQ[1].x === 5 && youQ[1].y === 3,
    `спавны по плану: P=(${youP[1].x},${youP[1].y}) Q=(${youQ[1].x},${youQ[1].y})`);
  p.inbox.length = 0;
  q.inbox.length = 0;
  p.send(JSON.stringify(["move", { x: 1, y: 1, deg: 0 }]));  // (4,3) -> (5,4)
  q.send(JSON.stringify(["move", { x: 0, y: 1, deg: 0 }]));  // (5,3) -> (5,4)
  await sleep(500);

  const echoP = p.inbox.filter((m) => m[0] === "update cat" && m[1].id === youP[1].id && "x" in m[1]);
  const echoQ = q.inbox.filter((m) => m[0] === "update cat" && m[1].id === youQ[1].id && "x" in m[1]);
  const refP = p.inbox.filter((m) => m[0] === "refuse");
  const refQ = q.inbox.filter((m) => m[0] === "refuse");
  const inCell54 = echoP.length + echoQ.length;
  check(inCell54 === 1, `ровно один занял (5,4): P эхо=${echoP.length}, Q эхо=${echoQ.length}`);
  check(refP.length + refQ.length === 1,
    `второму — cell_busy: refuse P=${JSON.stringify(refP.map((m) => m[1].code))} Q=${JSON.stringify(refQ.map((m) => m[1].code))}`);

  const probe = await client("зонд", "race2");
  const fp = await waitFor(probe, (m) => m[0] === "field");
  const cells = fp[1].cats.map((c) => `${c.x}:${c.y}`);
  check(new Set(cells).size === cells.length, `нет двух котов в одной клетке: ${JSON.stringify(cells)}`);
  p.terminate();
  q.terminate();
  probe.terminate();

  // --- 3. залп из 10 без пауз ---
  const z = await client("пулемёт", "overflow3");
  const youZ = await waitFor(z, (m) => m[0] === "you");
  const idZ = youZ[1].id;
  z.inbox.length = 0;
  for (let i = 0; i < 10; i += 1) {
    z.send(JSON.stringify(["move", { x: i % 2 ? -1 : 1, y: 0, deg: 0 }]));
  }
  await sleep(1500);
  const ez = z.inbox.filter((m) => m[0] === "update cat" && m[1].id === idZ && "x" in m[1]);
  const rz = z.inbox.filter((m) => m[0] === "refuse");
  check(ez.length + rz.length >= 10, `залп из 10 отвечен полностью: ${ez.length}+${rz.length}`);
  check(rz.length >= 6, `большая часть честно отказана cooldown: refuse=${rz.length}`);
  z.terminate();
} catch (err) {
  failures += 1;
  console.error("FAIL", err.message);
} finally {
  server.kill("SIGTERM");
}

console.log(failures === 0 ? "\nPASS: очередь шагов работает, потерь нет" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
