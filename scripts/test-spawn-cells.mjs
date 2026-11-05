// Клетки спавна: setmap принимает спавны (только трава), новичок появляется
// на случайной свободной клетке спавна, занятые пропускаются.
import { WebSocket } from "ws";

const url = process.env.WS_URL || "ws://127.0.0.1:3782";
// тестовая локация живёт только в TEST_ROOM («demo»)
// тестовая локация живёт только в TEST_ROOM («test»)
const room = "test";

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.inbox = [];
    ws.on("open", () => ws.send(JSON.stringify(["join", { room, login: name }])));
    ws.on("message", (raw) => ws.inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.once("open", () => resolve(ws));
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

const admin = await client("Админ");
await waitFor(admin, "field");
admin.send(JSON.stringify(["setmap", { pass: "1946", map }]));
await new Promise((r) => setTimeout(r, 300));
const err = admin.inbox.find((m) => m[0] === "info");
if (err) throw new Error(`setmap отклонён: ${err[1]}`);
const mapEcho = admin.inbox.find((m) => m[0] === "map");
console.log("map echo keys:", mapEcho ? Object.keys(mapEcho[1] || {}) : "no echo");
console.log("map echo spawns:", JSON.stringify(mapEcho && mapEcho[1] && mapEcho[1].spawns));

// 4 новичка (по числу клеток спавна): каждый должен попасть на клетку спавна
// (x-1,y-1) ∈ spawns, не занятую предыдущими. Сокеты держим открытыми до конца —
// иначе ушедший кот освобождает клетку и doubles не проверить.
const rnd = Date.now().toString(36);
const opened = [];
const spots = new Set();
for (let i = 0; i < 4; i++) {
  const c = await client(`Гость-${rnd}-${i}`);
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
admin.send(JSON.stringify(["setmap", { pass: "1946", map: { ...map, spawns: [{ c: 7, r: 1 }] } }]));
await new Promise((r) => setTimeout(r, 300));
const info = admin.inbox.filter((m) => m[0] === "info").pop();
console.log("battle-cell spawn rejected:", !!(info && String(info[1]).includes("спавна ставится на траве")));

// Спавн вне зелёной зоны тоже отклонён (клетка вне острова).
admin.send(JSON.stringify(["setmap", { pass: "1946", map: { ...map, spawns: [{ c: 11, r: 7 }] } }]));
await new Promise((r) => setTimeout(r, 300));
const info2 = admin.inbox.filter((m) => m[0] === "info").pop();
console.log("off-grass spawn rejected:", !!(info2 && String(info2[1]).includes("спавна ставится на траве")));

// field для новичка несёт spawны в конфиге (клиентский санитайзер их переживёт).
const late = await client("Позже");
const field = await waitFor(late, "field");
const cfg = field[1].map;
console.log("field.map spawns kept:", Array.isArray(cfg?.spawns) && cfg.spawns.length === 4);

for (const c of opened) c.close();
admin.close(); late.close();
process.exit(0);
