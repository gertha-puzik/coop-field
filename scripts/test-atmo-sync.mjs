// Проверка общей атмосферы комнаты (время суток + погода): A меняет — B и C видят
// ["atmo", { dp, w }]; отправитель получает эхо-подтверждение; новичок C заходит
// в комнату и получает атмосферу в снапшоте field; мусорные значения игнорируются.
import { WebSocket } from "ws";

const url = process.env.WS_URL || "ws://127.0.0.1:3781";
const room = `at${Date.now().toString(36)}`;

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
const fieldA = await waitFor(a, "field");
console.log("field.atmo default:", JSON.stringify(fieldA[1].atmo), "->", fieldA[1].atmo && fieldA[1].atmo.dp === "day" && fieldA[1].atmo.w === "sun");
await waitFor(b, "field");
a.inbox.length = 0;
b.inbox.length = 0;

// 1) смена атмосферы: B получает, A получает эхо
a.send(JSON.stringify(["atmo", { dp: "night", w: "rain" }]));
const gotB = await waitFor(b, "atmo");
const gotA = await waitFor(a, "atmo");
console.log("B got:", JSON.stringify(gotB[1]), "->", gotB[1].dp === "night" && gotB[1].w === "rain");
console.log("A echo:", JSON.stringify(gotA[1]), "->", gotA[1].dp === "night" && gotA[1].w === "rain");

// 2) смена только времени суток при той же погоде
b.inbox.length = 0;
a.inbox.length = 0;
a.send(JSON.stringify(["atmo", { dp: "evening", w: "rain" }]));
const ev = await waitFor(b, "atmo");
console.log("B evening:", JSON.stringify(ev[1]), "->", ev[1].dp === "evening" && ev[1].w === "rain");

// 3) мусорные значения игнорируются: ничего не приходит
b.inbox.length = 0;
a.inbox.length = 0;
a.send(JSON.stringify(["atmo", { dp: "storm", w: "meteor" }]));
await sleep(250);
console.log("garbage ignored:", !b.inbox.some((m) => m[0] === "atmo") && !a.inbox.some((m) => m[0] === "atmo"));

// 4) новичок получает атмосферу в снапшоте field
const c = await client("C");
const fieldC = await waitFor(c, "field");
console.log("C field.atmo:", JSON.stringify(fieldC[1].atmo), "->", fieldC[1].atmo && fieldC[1].atmo.dp === "evening" && fieldC[1].atmo.w === "rain");

// 5) новичок тоже может сменить атмосферу — все получают
a.inbox.length = 0;
b.inbox.length = 0;
c.inbox.length = 0;
c.send(JSON.stringify(["atmo", { dp: "morning", w: "cloud" }]));
const all = await Promise.all([waitFor(a, "atmo"), waitFor(b, "atmo"), waitFor(c, "atmo")]);
console.log(
  "C changed for all:",
  all.every((m) => m[1].dp === "morning" && m[1].w === "cloud"),
);

a.close();
b.close();
c.close();
process.exit(0);
