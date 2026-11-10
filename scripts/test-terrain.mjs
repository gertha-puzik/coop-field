// Рельеф: карта высот переживает setmap/field, шаг на обрыв (перепад ≥ 2)
// отвергается с кодом cliff, прыжок (jump) переносит кота через обрыв.
// Запуск: node scripts/test-terrain.mjs — из чистого клона, сам поднимает свой
// server.js на случайном порту с временным DATA_DIR. Внешний сервер:
// WS_URL=ws://… node scripts/test-terrain.mjs.
// Пароль редактора по умолчанию — 1946 (совпадает с серверным legacy-дефолтом);
// переопределение — env MAP_PASS (спавненному серверу передаётся ADMIN_PASS
// с тем же значением).
import { WebSocket } from "ws";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sendJoin } from "./ws-auth.mjs";

// пароль редактора по умолчанию (совпадает с серверным legacy-дефолтом; переопределение — env MAP_PASS)
const PASS = process.env.MAP_PASS || "1946";

// Аккаунт-редактор: мутации карт (кадр setmap) теперь за админ-гейтом
// (server/testmap.js, гейт как у adminGate в sprites.js), поэтому загрузчик
// карты заходит под админом. Аккаунт создаётся в DATA_DIR ДО старта сервера
// через scripts/make-admin.mjs (лестница S1, см. test-admin-reset).
const ADMIN_LOGIN = "mapboss";
const ADMIN_PASS = "password1";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const PORT = 4033 + Math.floor(Math.random() * 40);
const url = process.env.WS_URL || `ws://127.0.0.1:${PORT}`;
// тестовая локация живёт только в TEST_ROOM («test»)
const room = "test";
const rnd = Date.now().toString(36);

// Свой server.js, если внешний адрес не задан; пароль уходит в spawn-окружение
// тем же значением, что и в кадрах setmap («читает env КАК сервер»). Перед
// стартом — аккаунт-админ для setmap-загрузок теста.
const DATA = mkdtempSync(path.join(tmpdir(), "coop-terrain-"));
if (!process.env.WS_URL) {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), ADMIN_LOGIN, ADMIN_PASS], {
    env: { ...process.env, DATA_DIR: DATA },
    encoding: "utf8",
  });
}
const srv = process.env.WS_URL
  ? null
  : spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        DATA_DIR: DATA,
        ADMIN_PASS: PASS,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
if (srv) {
  srv.stdout.on("data", () => {});
  srv.stderr.on("data", (d) => process.stderr.write(d));
  process.on("exit", () => srv.kill("SIGTERM"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitServer() {
  for (let i = 0; i < 100; i++) {
    const ready = await new Promise((resolve) => {
      const probe = new WebSocket(url);
      probe.once("open", () => {
        probe.terminate();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (ready) return;
    await sleep(100);
  }
  throw new Error("сервер не поднялся");
}
await waitServer();

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.inbox = [];
    ws.on("message", (raw) => {
      try {
        ws.inbox.push(JSON.parse(String(raw)));
      } catch {
        /* мусорный кадр — не наш случай */
      }
    });
    ws.on("error", reject);
    // Комната «test» закрыта (requiresAccount): сначала register/login
    // (ws-auth.mjs), затем join. setmap-загрузчик — админ (см. ADMIN_LOGIN).
    ws.once("open", () => {
      sendJoin(ws, { room, login: name });
      resolve(ws);
    });
  });
}
const waitFor = (ws, event, ms = 2500) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ws.inbox.find((m) => m[0] === event);
      if (hit) return res(hit);
      if (Date.now() - t0 > ms) return rej(new Error(`timeout ${event}: ${JSON.stringify(ws.inbox.map((m) => m[0]))}`));
      setTimeout(tick, 15);
    };
    tick();
  });
const clear = (ws) => {
  ws.inbox.length = 0;
};

/** Локация: боевой полигон 3×3 (клетки 2..4 × 1..3) — коты заходят кнопкой,
 *  но для теста захода не нужно: join ставит новичка на травяной спавн, а
 *  cellsync переводит на боевую клетку. Рельеф: столб уровней по строке 2. */
const map = {
  v: 2,
  cols: 12,
  rows: 8,
  margin: 0.5,
  seed: "test",
  zones: [
    { id: "z1", name: "Лужайка", kind: "green", c0: 0, r0: 0, c1: 6, r1: 3 },
    { id: "z2", name: "Полигон", kind: "cells", c0: 7, r0: 1, c1: 10, r1: 3 },
  ],
  objects: [
    { id: "o1", kind: "entry", c: 6, r: 2, pos: "center", dir: "right" },
  ],
  spawns: [{ c: 1, r: 1 }],
  // плато на боевых клетках (ключи 0-based; строка 0-based 1 = 1-based ряд 2):
  // (9,2)=2, (10,2)=3, (11,2)=1 в 1-based — с ровного (9,2)... см. шаги ниже
  elev: { "8,1": 2, "9,1": 3, "10,1": 1, "10,2": 8 },
};

const admin = await client(ADMIN_LOGIN);
await waitFor(admin, "field");
clear(admin); // выкидываем info «Это имя уже занято» от register в sendJoin (нужен был fallback-логин) — иначе err-check ниже ложно сработает
admin.send(JSON.stringify(["setmap", { pass: PASS, map }])); // первый setmap-кадр сокета — троттлинг не мешает
await new Promise((r) => setTimeout(r, 300));
const mapEcho = admin.inbox.find((m) => m[0] === "map");
// «Редактор: сохранено.» — малый ack автору ДО broadcast-кадра map; игнорируем его в err-скане
const err = admin.inbox.find((m) => m[0] === "info" && m[1] !== "Редактор: сохранено.");
if (err) throw new Error(`setmap отклонён: ${err[1]}`);
if (!mapEcho) throw new Error("setmap не дал кадра map");
const echoElev = mapEcho && mapEcho[1] && mapEcho[1].elev;
console.log("map echo elev kept:", JSON.stringify(echoElev));
if (!echoElev || echoElev["8,1"] !== 2 || echoElev["9,1"] !== 3) {
  throw new Error("карта высот потерялась при сохранении");
}

// Игрок на боевой клетке (7,2) — ровная земля рядом с обрывом.
// Логины регаются (register v2 — только латиница), потому латинские.
const p1 = await client(`walker-${rnd}-1`);
const you1 = await waitFor(p1, "you");
console.log("p1 spawn:", you1[1].x, you1[1].y);
p1.send(JSON.stringify(["cellsync", { x: 8, y: 3 }]));
await waitFor(p1, "update cat");
clear(p1);
p1.send(JSON.stringify(["cellsync", { x: 8, y: 2 }]));
const cat1 = await waitFor(p1, "update cat");
console.log("p1 on plateau edge:", cat1[1].x, cat1[1].y, "elev=2");
if (cat1[1].x !== 8 || cat1[1].y !== 2) throw new Error("p1 не встал на (8,2)");

// Шаг вправо на (9,2) с (8,2): перепад 0→2 = 2 — обрыв, отказ cliff.
clear(p1);
p1.send(JSON.stringify(["move", { x: 1, y: 0 }]));
await new Promise((r) => setTimeout(r, 250));
const refuse1 = p1.inbox.find((m) => m[0] === "refuse");
console.log("cliff refuse:", refuse1 && refuse1[1].code);
if (!refuse1 || refuse1[1].code !== "cliff") throw new Error("обрыв не отвергнут (нет refuse cliff)");

// Прыжок туда же — перепад 2. Тап (нет charge) не берёт, половина шкалы берёт.
clear(p1);
p1.send(JSON.stringify(["jump", { x: 9, y: 2, charge: 0.2 }]));
await new Promise((r) => setTimeout(r, 250));
const weakJ = p1.inbox.find((m) => m[0] === "update cat");
console.log("half-short jump rejected:", !weakJ);
if (weakJ) throw new Error("прыжок на перепад 2 принят без половины заряда");
clear(p1);
p1.send(JSON.stringify(["jump", { x: 9, y: 2, charge: 0.5 }]));
await new Promise((r) => setTimeout(r, 500));
const catJ = p1.inbox.find((m) => m[0] === "update cat");
console.log("jump across cliff:", catJ && `${catJ[1].x},${catJ[1].y}`);
if (!catJ || catJ[1].x !== 9 || catJ[1].y !== 2) throw new Error("прыжок через обрыв не сработал");

// С плато на плато шаг в +1 уровень разрешён: (9,2) [уровень 2] → (10,2) [3].
clear(p1);
p1.send(JSON.stringify(["move", { x: 1, y: 0 }]));
await waitFor(p1, "update cat");
console.log("step +1 level allowed: yes");

// Шаг вниз с обрывом 3→1: (10,2)→(11,2) — тоже отказ cliff.
clear(p1);
p1.send(JSON.stringify(["move", { x: 1, y: 0 }]));
await new Promise((r) => setTimeout(r, 250));
const refuse2 = p1.inbox.find((m) => m[0] === "refuse");
console.log("down-cliff refuse:", refuse2 && refuse2[1].code);
if (!refuse2 || refuse2[1].code !== "cliff") throw new Error("спуск с обрыва не отвергнут");

// Прыжок по кривой (не прямая) — молча отвергается.
clear(p1);
p1.send(JSON.stringify(["jump", { x: 9, y: 4 }]));
await new Promise((r) => setTimeout(r, 200));
const badJ = p1.inbox.find((m) => m[0] === "update cat");
console.log("crooked jump rejected:", !badJ);
if (badJ) throw new Error("кривой прыжок принят");

// Прыжок дальше 3 клеток — отвергается.
clear(p1);
p1.send(JSON.stringify(["jump", { x: 14, y: 2 }]));
await new Promise((r) => setTimeout(r, 200));
const farJ = p1.inbox.find((m) => m[0] === "update cat");
console.log("too-far jump rejected:", !farJ);
if (farJ) throw new Error("дальний прыжок принят");

// Прыжок вверх на 4+ невозможен даже с полным зарядом: (11,2)=1 → (11,3)=8.
// Сначала спуск 3→1 полным зарядом (перепад 2 вниз берёт и половина, здесь полный).
clear(p1);
p1.send(JSON.stringify(["jump", { x: 11, y: 2, charge: 1 }]));
await new Promise((r) => setTimeout(r, 500));
const downJ = p1.inbox.find((m) => m[0] === "update cat" && m[1].x === 11 && m[1].y === 2);
console.log("jump down 3→1:", !!downJ);
if (!downJ) throw new Error("спуск прыжком с полным зарядом не прошёл");
clear(p1);
p1.send(JSON.stringify(["jump", { x: 11, y: 3, charge: 1 }]));
await new Promise((r) => setTimeout(r, 500));
const highJ = p1.inbox.find((m) => m[0] === "update cat" && m[1].y === 3);
console.log("jump up 4+ rejected:", !highJ);
if (highJ) throw new Error("прыжок вверх на 4+ принят");
// На клетку вне мира сервер молча отвергает.
clear(p1);
p1.send(JSON.stringify(["jump", { x: 20, y: 2 }]));
await new Promise((r) => setTimeout(r, 200));
const outJ = p1.inbox.find((m) => m[0] === "update cat");
console.log("out-of-world jump rejected:", !outJ);
if (outJ) throw new Error("прыжок за мир принят");

// Второй клиент: field несёт elev новичку (снапшот для поздних подключений).
const p2 = await client(`walker-${rnd}-2`);
const field2 = await waitFor(p2, "field");
const elev2 = field2[1].map && field2[1].map.elev;
console.log("field.map elev for newcomer:", JSON.stringify(elev2));
if (!elev2 || elev2["9,1"] !== 3) throw new Error("снапшот field потерял карту высот");

// freemove с jp=1 доезжает до соседа (мирный прыжок виден другим).
p2.send(JSON.stringify(["cellsync", { x: 8, y: 3 }]));
await waitFor(p2, "update cat");
clear(p2);
p1.send(JSON.stringify(["freemove", { x: 3.5, y: 2.5, jp: 1 }]));
await new Promise((r) => setTimeout(r, 250));
const fm = p2.inbox.find((m) => m[0] === "freemove");
console.log("freemove jp relayed:", fm && fm[1].jp === 1);
if (!fm || fm[1].jp !== 1) throw new Error("jp-флаг не разослан соседям");

p1.close();
p2.close();
admin.close();
process.exit(0);
