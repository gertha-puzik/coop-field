// Погода комнаты доезжает до конца: после дождя сервер возвращает солнце/облачно
// и рассылает якорь всем — «наложение погоды» обязано исчезать, а не висеть вечно.
// Сервер для теста — копия с коротким интервалом погоды (8 с вместо минут):
//   PORT=3784 WS_PORT=3784 DATA_DIR=$(mktemp -d) node /tmp/weather-server.js
//   WS_URL=ws://127.0.0.1:3784 node scripts/test-weather-rotation.mjs
import { WebSocket } from "ws";

const url = process.env.WS_URL || "ws://127.0.0.1:3784";
const room = "test";
const rnd = Date.now().toString(36);
let fails = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) fails++;
};

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.inbox = [];
    ws.on("message", (raw) => ws.inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.on("open", () => {
      ws.send(JSON.stringify(["join", { room, login: name }]));
      resolve(ws);
    });
  });
}
const waitFor = (ws, event, ms = 3000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ws.inbox.find((m) => m[0] === event);
      if (hit) return res(hit);
      if (Date.now() - t0 > ms) return rej(new Error(`timeout ${event}`));
      setTimeout(tick, 15);
    };
    tick();
  });
const lastAtmo = (ws) => [...ws.inbox].reverse().find((m) => m[0] === "atmo");

const a = await client(`А-${rnd}`);
await waitFor(a, "you");
const fieldA = await waitFor(a, "field");
ok(!!fieldA[1].atmo, "якорь атмосферы в снапшоте");

// Включаем дождь кнопкой панели (перемотка + погода) — эхо подтверждает.
a.send(JSON.stringify(["atmo", { dp: "day", w: "rain" }]));
const echo = await waitFor(a, "atmo", 4000);
ok(echo[1].w === "rain", "дождь включён (эхо перемотки)");

// Сосед видит тот же дождь (приходит в снапшоте field — событий atmo до смен нет).
const b = await client(`Б-${rnd}`);
await waitFor(b, "you");
const fieldB = await waitFor(b, "field");
ok(fieldB[1].atmo && fieldB[1].atmo.w === "rain", "сосед видит дождь в снапшоте");

// Дождь не вечен: за интервал+тикер сервер меняет погоду и рассылает якорь.
const w1 = lastAtmo(a)[1].w;
const t0 = Date.now();
let rotated = null;
while (Date.now() - t0 < 20_000) {
  const m = lastAtmo(a);
  if (m && m[1].w !== w1) {
    rotated = m[1];
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
ok(!!rotated, `дождь сменился сам (${w1} → ${rotated ? rotated.w : "нет"})`);
ok(!!rotated && rotated.w !== "rain", "после дождя погода ушла с дождя (оверлей исчезает)");

// И дальше цикл продолжается: ещё одна смена за следующий интервал.
const t1 = Date.now();
let rotated2 = null;
while (Date.now() - t1 < 20_000) {
  const m = lastAtmo(a);
  if (m && rotated && (m[1].ws !== rotated.ws || m[1].w !== rotated.w)) {
    rotated2 = m[1];
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
ok(!!rotated2, "погода продолжает сменяться по интервалу");

// Сосед получил те же смены (меньше одной — рассылка работает).
ok(lastAtmo(b) && lastAtmo(b)[1].w === (rotated2 || rotated).w, "сосед синхронно получил смену");

console.log(fails === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `\nПРОВАЛОВ: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
