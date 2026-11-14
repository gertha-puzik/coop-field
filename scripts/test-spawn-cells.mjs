// Клетки спавна: setmap принимает спавны (только трава), новичок появляется
// на случайной свободной клетке спавна, занятые пропускаются.
// Запуск: node scripts/test-spawn-cells.mjs — из чистого клона, сам поднимает
// свой server.js на случайном порту с временным DATA_DIR. Внешний сервер:
// WS_URL=ws://… node scripts/test-spawn-cells.mjs.
// Каждая setmap-правка уходит со своего НОВОГО сокета: сервер троттлит любые
// setmap-кадры раз в 10 с НА СОКЕТ. Пароля редактора нет: setmap сохраняет
// только admin-роль.
import { WebSocket } from "ws";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sendJoin } from "./ws-auth.mjs";

// Аккаунт-редактор: мутации карт (setmap) за админ-гейтом (server/testmap.js),
// все setmap-загрузчики теста логинятся админом. Аккаунт создаётся в DATA_DIR
// ДО старта сервера через scripts/make-admin.mjs (лестница S1, test-admin-reset).
const ADMIN_LOGIN = "mapboss";
const ADMIN_ACCOUNT_PASS = "password1";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const PORT = 4013 + Math.floor(Math.random() * 40);
const url = process.env.WS_URL || `ws://127.0.0.1:${PORT}`;
// тестовая локация живёт только в TEST_ROOM («test»)
const room = "test";
// Уникальный суффикс прогона: логины «Админ»/«Позже» без суффикса восстанавливали
// сохранённую позицию из data/test-cats.json и занимали клетку спавна — прогон
// на «грязном» состоянии падал. Уникальные логины делают тест повторяемым.
const rnd = Date.now().toString(36);

// Свой server.js, если внешний адрес не задан; пароль уходит в spawn-окружение
// тем же значением, что и в кадрах setmap («читает env КАК сервер»). Перед
// стартом — аккаунт-админ для setmap-загрузок теста.
const DATA = mkdtempSync(path.join(tmpdir(), "coop-spawn-cells-"));
if (!process.env.WS_URL) {
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), ADMIN_LOGIN, ADMIN_ACCOUNT_PASS], {
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
    // Комната «test» закрыта (requiresAccount): register/login через ws-auth.mjs,
    // затем join. setmap-загрузчики — админ (ADMIN_LOGIN).
    ws.once("open", () => {
      sendJoin(ws, { room, login: name });
      resolve(ws);
    });
  });
}
const waitFor = (ws, event, ms = 2000) =>
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

// Локация: одна зелёная зона 0..5 × 0..3, спавны на (1,1), (2,1), (3,1), (4,1).
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
  objects: [],
  spawns: [
    { c: 1, r: 1 },
    { c: 2, r: 1 },
    { c: 3, r: 1 },
    { c: 4, r: 1 },
  ],
};

// Установка локации — setmap с нового сокета; админа закрываем ДО прихода
// гостей, чтобы его кот не занял клетку спавна. setmap — мутация за
// админ-гейтом: сокет логинится подготовленным админом (ADMIN_LOGIN).
const admin = await client(ADMIN_LOGIN);
await waitFor(admin, "field");
admin.inbox.length = 0; // регистрация админа уходит в fallback-логин (имя занято) — её info «имя занято» не должна попадать в err-скан ниже
admin.send(JSON.stringify(["setmap", { map }])); // первый setmap-кадр сокета — троттлинг не мешает
await new Promise((r) => setTimeout(r, 300));
const mapEcho = admin.inbox.find((m) => m[0] === "map");
// ack «Редактор: сохранено.» уходит автору ДО broadcast-кадра map — не считаем его ошибкой
const err = admin.inbox.find((m) => m[0] === "info" && m[1] !== "Редактор: сохранено.");
if (err) throw new Error(`setmap отклонён: ${err[1]}`);
if (!mapEcho) throw new Error("setmap не дал кадра map");
console.log("map echo keys:", mapEcho ? Object.keys(mapEcho[1] || {}) : "no echo");
console.log("map echo spawns:", JSON.stringify(mapEcho && mapEcho[1] && mapEcho[1].spawns));
admin.close();
await sleep(200); // дать серверу отработать close — кот админа освобождает клетку

// 4 новичка (по числу клеток спавна): каждый должен попасть на клетку спавна
// (x-1,y-1) ∈ spawns, не занятую предыдущим. Сокеты держим открытыми до конца —
// иначе ушедший кот освобождает клетку и doubles не проверить. Логины —
// латиница (register v2 не принимает кириллицу).
const opened = [];
const spots = new Set();
for (let i = 0; i < 4; i++) {
  const c = await client(`guest-${rnd}-${i}`);
  opened.push(c);
  const you = await waitFor(c, "you");
  const x = you[1].x, y = you[1].y;
  const key = `${x - 1},${y - 1}`;
  const ok = map.spawns.some((s) => `${s.c},${s.r}` === key);
  console.log(`join ${i + 1}: cell (${x},${y}) -> 0-based ${key}, on spawn cell: ${ok}`);
  if (!ok) throw new Error(`новичок появился не на клетке спавна: ${key}`);
  if (spots.has(key)) throw new Error(`двое на одной клетке спавна: ${key}`);
  spots.add(key);
}
if (spots.size !== map.spawns.length) throw new Error("не все клетки спавна использованы");
console.log("all spawn cells from the list, no doubles");

// Спавн на боевой клетке сервер должен отклонить.
// setmap с НОВОГО сокета (троттлинг 10 с — на сокет, см. шапку), сокет — админ:
// негатив здесь про санитайзер карты, а не про админ-гейт.
const bad1 = await client(ADMIN_LOGIN);
await waitFor(bad1, "field");
bad1.send(JSON.stringify(["setmap", { map: { ...map, spawns: [{ c: 7, r: 1 }] } }]));
await new Promise((r) => setTimeout(r, 300));
const info = bad1.inbox.filter((m) => m[0] === "info").pop();
console.log("battle-cell spawn rejected:", !!(info && String(info[1]).includes("спавна ставится на траве")));
bad1.close();

// Спавн вне зелёной зоны тоже отклонён (клетка вне острова). Сокет — тоже
// подготовленный админ: проверяем санитайзер, а не гейт.
const bad2 = await client(ADMIN_LOGIN);
await waitFor(bad2, "field");
bad2.send(JSON.stringify(["setmap", { map: { ...map, spawns: [{ c: 11, r: 7 }] } }]));
await new Promise((r) => setTimeout(r, 300));
const info2 = bad2.inbox.filter((m) => m[0] === "info").pop();
console.log("off-grass spawn rejected:", !!(info2 && String(info2[1]).includes("спавна ставится на траве")));
bad2.close();

// field для новичка несёт спавны в конфиге (клиентский санитайзер их переживёт).
const late = await client(`late-${rnd}`);
const field = await waitFor(late, "field");
const cfg = field[1].map;
console.log("field.map spawns kept:", Array.isArray(cfg?.spawns) && cfg.spawns.length === 4);

for (const c of opened) c.close();
late.close();
process.exit(0);
