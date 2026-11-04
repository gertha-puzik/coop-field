// Проверка релея приседа на пробеле: A жмёт/отпускает пробел — B видит
// ["space", { id, on, hold?, cancel? }]; sender эхо не получает; sq в publicCat.
import { WebSocket } from "ws";

const url = process.env.WS_URL || "ws://127.0.0.1:3781";
const room = `sp${Date.now().toString(36)}`;

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await client("A");
const b = await client("B");
await Promise.all([waitFor(a, "field"), waitFor(b, "field")]);
b.inbox.length = 0;

// 1) нажатие: B получает space on, A — нет
a.send(JSON.stringify(["space", { on: true }]));
const on = await waitFor(b, "space");
b.inbox.length = 0;
console.log("B got on:", JSON.stringify(on[1]), "->", on[1].on === true && Number.isInteger(on[1].id));
await sleep(250);
console.log("A got no echo:", !a.inbox.some((m) => m[0] === "space"));

// 2) отпускание с hold: B получает hold в [0..4000]
a.send(JSON.stringify(["space", { on: false, hold: 2500 }]));
const off = await waitFor(b, "space");
b.inbox.length = 0;
console.log("B got off:", JSON.stringify(off[1]), "->", off[1].on === false && off[1].hold === 2500 && off[1].cancel === false);

// 3) cancel (потеря фокуса)
a.send(JSON.stringify(["space", { on: true }]));
await waitFor(b, "space");
b.inbox.length = 0;
a.send(JSON.stringify(["space", { on: false, cancel: true }]));
const off2 = await waitFor(b, "space");
console.log("B got cancel:", JSON.stringify(off2[1]), "->", off2[1].cancel === true);

// 4) мусорный hold режется до 4000
b.inbox.length = 0;
a.send(JSON.stringify(["space", { on: false, hold: 999999 }]));
const off3 = await waitFor(b, "space");
console.log("hold clamped:", off3[1].hold === 4000);

// 5) sq в снапшоте для новичка: C заходит, пока A держит пробел
a.send(JSON.stringify(["space", { on: true }]));
await waitFor(b, "space");
const c = await client("C");
await waitFor(c, "field");
const field = c.inbox.find((m) => m[0] === "field");
const catA = (field[1].cats || []).find((x) => x.login === "A");
console.log("C sees A sq=1:", catA && catA.sq === 1);

a.close(); b.close(); c.close();
process.exit(0);
