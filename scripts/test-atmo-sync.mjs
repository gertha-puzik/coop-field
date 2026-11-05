// Проверка часов атмосферы комнаты: непрерывный цикл суток (якорь t/cs/pl/wl/w/ws/dp),
// перемотка кнопкой («atmo»), смена темпа («atmoset») с сохранением позиции суток,
// эхо отправителю, снапшот для новичка, игнор мусора.
import { WebSocket } from "ws";

const url = process.env.WS_URL || "ws://127.0.0.1:3781";
const room = `at${Date.now().toString(36)}`;
const MIN = 60_000;
let fails = 0;
const ok = (name, cond) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) fails++;
};

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.inbox = [];
    ws.on("message", (raw) => ws.inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.once("open", () => {
      ws.send(JSON.stringify(["join", { room, login: name }]));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = await client("A");
const b = await client("B");
const fieldA = await waitFor(a, "field");

// 1) снапшот несёт якорь часов: дефолтные темпы 7/12 минут, комната открывается «днём»
const at = fieldA[1].atmo || {};
ok(
  "field.atmo: якорь (t/cs/pl/wl/w/ws/dp)",
  Number.isFinite(at.t) && Number.isFinite(at.cs) && at.pl === 7 * MIN && at.wl === 12 * MIN && at.w === "sun" && Number.isFinite(at.ws) && at.dp === "day",
);
const dayProgress = ((Date.now() - at.cs) / (at.pl * 4)) % 1;
ok("позиция суток в снапшоте — середина дня (≈0,375)", Math.abs(dayProgress - 0.375) < 0.01);

// 2) перемотка кнопкой: ночь + дождь, всем включая отправителя
a.inbox.length = 0;
b.inbox.length = 0;
a.send(JSON.stringify(["atmo", { dp: "night", w: "rain" }]));
const eA = await waitFor(a, "atmo");
const eB = await waitFor(b, "atmo");
const prog = (m) => ((((Date.now() - m[1].cs) / (m[1].pl * 4)) % 1) + 1) % 1;
ok("эхо A: ночь/дождь", eA[1].dp === "night" && eA[1].w === "rain");
ok("рассылка B: ночь/дождь", eB[1].dp === "night" && eB[1].w === "rain");
ok("перемотка: позиция ≈ середина ночи (0,875)", Math.abs(prog(eA) - 0.875) < 0.01 && Math.abs(prog(eB) - 0.875) < 0.01);

// 3) мусор игнорируется
a.inbox.length = 0;
b.inbox.length = 0;
a.send(JSON.stringify(["atmo", { dp: "storm", w: "meteor" }]));
await sleep(250);
ok("мусорные dp/w игнорируются", !a.inbox.some((m) => m[0] === "atmo") && !b.inbox.some((m) => m[0] === "atmo"));
a.send(JSON.stringify(["atmoset", { pl: "abc", wl: null }]));
await sleep(250);
ok("мусорные длительности игнорируются", !a.inbox.some((m) => m[0] === "atmo") && !b.inbox.some((m) => m[0] === "atmo"));

// 4) смена темпа: позиции суток сохраняются, якорь доезжает всем
const wrapDist = (x, y) => {
  const d = Math.abs(((((x - y) % 1) + 1) % 1));
  return Math.min(d, 1 - d);
};
const posBefore = prog(eB); // текущая позиция суток по якорю перемотки
a.inbox.length = 0;
b.inbox.length = 0;
a.send(JSON.stringify(["atmoset", { pl: 2, wl: 3 }]));
const sA = await waitFor(a, "atmo");
const sB = await waitFor(b, "atmo");
ok("atmoset: новые темпы (2 мин часть, 3 мин погода)", sB[1].pl === 2 * MIN && sB[1].wl === 3 * MIN);
ok("позиция суток не прыгнула", wrapDist(prog(sB), posBefore) < 0.02);

// 5) границы: 0.5 минуты зажимается к 1, 9999 — к 240; нули игнорируются целиком
a.inbox.length = 0;
a.send(JSON.stringify(["atmoset", { pl: 0.5, wl: 9999 }]));
const s2 = await waitFor(a, "atmo");
ok("зажим темпов (1 мин … 240 мин)", s2[1].pl === MIN && s2[1].wl === 240 * MIN);
a.inbox.length = 0;
a.send(JSON.stringify(["atmoset", { pl: 0, wl: 0 }]));
await sleep(250);
ok("нулевые значения не меняют состояние", !a.inbox.some((m) => m[0] === "atmo"));

// 6) новичок получает текущий якорь в снапшоте
const c = await client("C");
const fieldC = await waitFor(c, "field");
const atc = fieldC[1].atmo || {};
ok("новичок: якорь в field (темп 1 мин, погода последняя)", atc.pl === MIN && atc.wl === 240 * MIN && atc.w === "rain" && Number.isFinite(atc.cs));

// 7) погода доезжает сама: интервал 2 минуты — не ждём, но ленивый пересчёт на
// снапшоте новичка обязан вернуть ту же погоду, что и в рассылке (без прыжка).
ok("погода стабильна между рассылками", atc.w === sB[1].w || atc.w === s2[1].w);

a.close();
b.close();
c.close();
process.exit(fails === 0 ? 0 : 1);
