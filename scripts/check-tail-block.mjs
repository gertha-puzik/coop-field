import { WebSocket } from "ws";

/**
 * Живая проверка «хвост против блока» против указанного сервера.
 * Использование: node scripts/check-tail-block.mjs [wsUrl]
 *   по умолчанию — локальный сервер ws://127.0.0.1:3780;
 *   прод — ТОЛЬКО явным флагом: node scripts/check-tail-block.mjs --prod
 *   (endpoint wss://coop.89-232-184-77.sslip.io, перед стартом печатается
 *   предупреждение «–– ПРАВКА ПРОДА»; env-override прод-адреса не предусмотрен).
 * Правило: блок проводит любой удар в «Лапы», КРОМЕ хвоста — удар в хвост
 * проходит хвостом и по стоящему блоку, и когда блок встал в полёте.
 * Регресс-тесты тех же правил — в scripts/test-ws.mjs (блок «Хвост и блок»). */
const LOCAL_URL = "ws://127.0.0.1:3780";
const PROD_URL = "wss://coop.89-232-184-77.sslip.io";
const wantProd = process.argv.includes("--prod");
if (wantProd) console.log("–– ПРАВКА ПРОДА:", PROD_URL);
if (!wantProd && process.argv[2] === PROD_URL) {
  console.error("прод-эндпоинт доступен только с явным флагом --prod");
  process.exit(1);
}
const url = wantProd ? PROD_URL : (process.argv[2] || LOCAL_URL);
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

// 1) Блок стоит → удар в хвост должен пройти ХВОСТОМ.
//    Клиентский урон игнорируется (гость: таблица уровня 0). Блок хвост не ловит.
def.send(JSON.stringify(["block", { on: true }]));
await waitFor(atk, "block");
atk.inbox.length = 0;
def.inbox.length = 0;
atk.send(JSON.stringify(["strike", { target: dYou.id, zone: "tail", angle, damage: 999, pawsDamage: 999 }]));
const r1 = (await waitFor(def, "fight"))[1];
console.log(`1) хвост по стоящему блоку: ${fmt(r1)} → ${r1.zone === "tail" ? "OK исключение" : "БАГ: блок перехватил хвост"}`);

// 2) Без блока → хвост остаётся хвостом (таблица уровня 0, не число клиента).
def.send(JSON.stringify(["block", { on: false }]));
await waitFor(atk, "block");
await sleep(120);
atk.inbox.length = 0;
def.inbox.length = 0;
atk.send(JSON.stringify(["strike", { target: dYou.id, zone: "tail", angle, damage: 999 }]));
const r2 = (await waitFor(def, "fight"))[1];
console.log(`2) хвост без блока:        ${fmt(r2)} → ${r2.zone === "tail" ? "OK хвост" : "неожиданно"}`);

// 3) Блок встаёт, пока удар летит → хвост всё равно проходит хвостом.
await sleep(120);
atk.inbox.length = 0;
def.inbox.length = 0;
atk.send(JSON.stringify(["strike", { target: dYou.id, zone: "tail", angle, damage: 999, pawsDamage: 999, flightMs: 200 }]));
def.send(JSON.stringify(["block", { on: true }]));
const r3 = (await waitFor(def, "fight"))[1];
console.log(`3) хвост, блок в полёте:   ${fmt(r3)} → ${r3.zone === "tail" ? "OK исключение" : "БАГ: блок перехватил хвост"}`);

// 4) Контраст: морда по стоящему блоку → «Лапы» таблицы уровня 0, не pawsDamage клиента.
await sleep(120);
atk.inbox.length = 0;
def.inbox.length = 0;
atk.send(JSON.stringify(["strike", { target: dYou.id, zone: "muzzle", angle, damage: 999, pawsDamage: 999 }]));
const r4 = (await waitFor(def, "fight"))[1];
console.log(`4) морда по стоящему блоку: ${fmt(r4)} → ${r4.zone === "paws" ? "OK редирект" : "неожиданно"}`);

def.send(JSON.stringify(["block", { on: false }]));
atk.close();
def.close();
process.exit(0);
