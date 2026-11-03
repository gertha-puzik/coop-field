import { WebSocket } from "ws";

/**
 * Живая проверка «хвост против блока» против указанного сервера.
 * Использование: node scripts/check-tail-block.mjs [wsUrl]
 *   по умолчанию — прод (wss://coop.89-232-184-77.sslip.io); для локали:
 *   node scripts/check-tail-block.mjs ws://127.0.0.1:3780
 * Сценарии: удар в хвост по стоящему блоку (→ Лапы), без блока (→ Хвост)
 * и с блоком, вставшим в полёте (→ Лапы). Регресс-тесты тех же правил —
 * в scripts/test-ws.mjs (блок «Хвост и блок»). */
const url = process.argv[2] || "wss://coop.89-232-184-77.sslip.io";
const room = `tailchk-${Date.now().toString(36)}`;

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on("open", () => ws.send(JSON.stringify(["join", { room, login: name }])));
    ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.inbox = inbox;
    ws.once("open", () => resolve(ws));
  });
}
function waitFor(ws, event, ms = 4000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = ws.inbox.find((m) => m[0] === event);
      if (hit) return resolve(hit);
      if (Date.now() - start > ms) return reject(new Error(`timeout ${event}: ${JSON.stringify(ws.inbox.slice(-4))}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (f) => `zone=${f.zone} part=${f.part} damage=${f.damage}`;

const atk = await client("ЗондБьющий");
const def = await client("ЗондСтоящий");
const aYou = (await waitFor(atk, "you"))[1];
const dYou = (await waitFor(def, "you"))[1];
const angle = (Math.atan2(dYou.y - aYou.y, dYou.x - aYou.x) * 180) / Math.PI;
console.log(`server=${url} room=${room} atk=${aYou.x},${aYou.y} def=${dYou.x},${dYou.y} angle=${angle.toFixed(0)}`);
await sleep(80);

// 1) Блок стоит → удар в хвост должен прийти «Лапы» с лаповым уроном (5).
def.send(JSON.stringify(["block", { on: true }]));
await waitFor(atk, "block");
atk.inbox.length = 0;
def.inbox.length = 0;
atk.send(JSON.stringify(["strike", { target: dYou.id, zone: "tail", angle, damage: 33, pawsDamage: 5 }]));
const r1 = (await waitFor(def, "fight"))[1];
console.log(`1) хвост по стоящему блоку: ${fmt(r1)} → ${r1.zone === "paws" ? "OK редирект" : "БАГ: хвост прошёл"}`);

// 2) Без блока → хвост остаётся хвостом (урон бьющего 33).
def.send(JSON.stringify(["block", { on: false }]));
await waitFor(atk, "block");
await sleep(120);
atk.inbox.length = 0;
def.inbox.length = 0;
atk.send(JSON.stringify(["strike", { target: dYou.id, zone: "tail", angle, damage: 33 }]));
const r2 = (await waitFor(def, "fight"))[1];
console.log(`2) хвост без блока:        ${fmt(r2)} → ${r2.zone === "tail" ? "OK хвост" : "неожиданно"}`);

// 3) Блок встаёт, пока удар летит → на касании «Лапы» с уроном 5.
await sleep(120);
atk.inbox.length = 0;
def.inbox.length = 0;
atk.send(JSON.stringify(["strike", { target: dYou.id, zone: "tail", angle, damage: 33, pawsDamage: 5, flightMs: 200 }]));
def.send(JSON.stringify(["block", { on: true }]));
const r3 = (await waitFor(def, "fight"))[1];
console.log(`3) хвост, блок в полёте:   ${fmt(r3)} → ${r3.zone === "paws" ? "OK ловля в полёте" : "БАГ: пролетел"}`);

def.send(JSON.stringify(["block", { on: false }]));
atk.close();
def.close();
process.exit(0);
