import { WebSocket } from "ws";

/**
 * Живая проверка брони против указанного сервера.
 * Использование: node scripts/check-armor.mjs [wsUrl]
 *   по умолчанию — локальный сервер ws://127.0.0.1:3780;
 *   прод — ТОЛЬКО явным флагом: node scripts/check-armor.mjs --prod
 *   (endpoint wss://coop.89-232-184-77.sslip.io, перед стартом печатается
 *   предупреждение «–– ПРАВКА ПРОДА»; env-override прод-адреса не предусмотрен).
 * Правило: броня цели (пресет 0,0–0,9) режет получаемый урон по кривой замеров
 * владельца — множитель = урон(броня) / урон(0,0): 0,9 ≈ 0,38275, 0,5 ≈ 0,72917.
 * Режет любой входящий удар, включая хвост (блок хвост не ловит, а броня режет).
 * Контрактные тесты тех же правил — в scripts/test-ws.mjs (секция «Броня»). */
const LOCAL_URL = "ws://127.0.0.1:3780";
const PROD_URL = "wss://coop.89-232-184-77.sslip.io";
const wantProd = process.argv.includes("--prod");
if (wantProd) console.log("–– ПРАВКА ПРОДА:", PROD_URL);
if (!wantProd && process.argv[2] === PROD_URL) {
  console.error("прод-эндпоинт доступен только с явным флагом --prod");
  process.exit(1);
}
const url = wantProd ? PROD_URL : (process.argv[2] || LOCAL_URL);
const room = `armchk-${Date.now().toString(36)}`;

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

let fails = 0;
function expect(label, cond) {
  console.log(`${label} → ${cond ? "OK" : "БАГ"}`);
  if (!cond) fails += 1;
}

const atk = await client("ЗондПробойник");
const def = await client("ЗондПанцирь");
const aYou = (await waitFor(atk, "you"))[1];
const dYou = (await waitFor(def, "you"))[1];
const angle = (Math.atan2(dYou.y - aYou.y, dYou.x - aYou.x) * 180) / Math.PI;
console.log(`server=${url} room=${room} atk=${aYou.x},${aYou.y} def=${dYou.x},${dYou.y} angle=${angle.toFixed(0)}`);
await sleep(80);

/** Бросок. Клиентский урон 999 игнорируется: гость бьёт таблицей уровня 0. */
async function hit(zone, extra = {}) {
  await sleep(120);
  atk.inbox.length = 0;
  def.inbox.length = 0;
  atk.send(JSON.stringify(["strike", { target: dYou.id, zone, angle, damage: 999, pawsDamage: 999, ...extra }]));
  return (await waitFor(def, "fight"))[1];
}

// 1) Броня 0,9: таблица горла 42 проходит как round(42·0,38275) = 16. Клиентский 999 не применяется.
def.send(JSON.stringify(["armor", { armor: 0.9 }]));
await sleep(80);
let r = await hit("throat");
expect(`1) броня 0,9: горло 42 → ${fmt(r)}`, r.zone === "throat" && r.damage === 16);

// 2) Броня 0,5: горло 42 проходит как 31.
def.send(JSON.stringify(["armor", { armor: 0.5 }]));
await sleep(80);
r = await hit("throat");
expect(`2) броня 0,5: горло 42 → ${fmt(r)}`, r.zone === "throat" && r.damage === 31);

// 3) Броня снята (0,0) — урон проходит целиком.
def.send(JSON.stringify(["armor", { armor: 0 }]));
await sleep(80);
r = await hit("throat");
expect(`3) броня 0,0: горло 42 → ${fmt(r)}`, r.zone === "throat" && r.damage === 42);

// 4) Броня 0,9 + блок: морда переводится в «Лапы», таблица лап 6 проходит как 2.
def.send(JSON.stringify(["armor", { armor: 0.9 }]));
def.send(JSON.stringify(["block", { on: true }]));
await waitFor(atk, "block");
r = await hit("muzzle");
expect(`4) броня 0,9 + блок: морда → ${fmt(r)}`, r.zone === "paws" && r.part === "Лапы" && r.damage === 2);

// 5) Хвост по бронированному блокирующему: остаётся хвостом, таблица 2 × 0,9 → 1.
r = await hit("tail");
expect(`5) броня 0,9 + блок, хвост таблицы → ${fmt(r)}`, r.zone === "tail" && r.part === "Хвост" && r.damage === 1);
def.send(JSON.stringify(["block", { on: false }]));
await waitFor(atk, "block");

// 6) Зажим: armor 5 ведёт себя как 0,9 (16).
def.send(JSON.stringify(["armor", { armor: 5 }]));
await sleep(80);
r = await hit("throat");
expect(`6) armor 5 зажат в 0,9: горло 42 → ${fmt(r)}`, r.damage === 16);

atk.close();
def.close();
process.exit(fails ? 1 : 0);
