// Атмосфера: якорь времени суток не ломается при перезаходе на другого персонажа.
// Проверяем: (1) повторный join тем же сокетом (смена персонажа) сохраняет якорь;
// (2) новый сокет видит тот же якорь; (3) фаза суток якоря совпадает с часами;
// (4) после перезахода «atmo»-рассылки продолжают приходить.
// Запуск: PORT=3783 WS_PORT=3783 DATA_DIR=$(mktemp -d) node server.js
//         WS_URL=ws://127.0.0.1:3783 node scripts/test-atmo-rejoin.mjs
import { WebSocket } from "ws";

const url = process.env.WS_URL || "ws://127.0.0.1:3783";
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
const clear = (ws) => {
  ws.inbox.length = 0;
};

const a = await client(`А-${rnd}`);
const youA = await waitFor(a, "you");
const fieldA = await waitFor(a, "field");
const atmo1 = fieldA[1].atmo;
ok(!!atmo1, "field несёт якорь атмосферы");
ok(Number.isFinite(atmo1.cs) && atmo1.pl > 0, `якорь валиден (pl=${atmo1.pl})`);
const idxOf = (dp) => ["morning", "day", "evening", "night"].indexOf(dp);
const phaseOf = (cs, pl, now) => Math.floor(((now - cs) / pl % 4) + 4) % 4;
ok(
  phaseOf(atmo1.cs, atmo1.pl, atmo1.t) === idxOf(atmo1.dp),
  `dp якоря совпадает с часами (${atmo1.dp})`,
);

// --- перезаход тем же сокетом на другого персонажа (кнопка смены комнаты) ---
clear(a);
await new Promise((r) => setTimeout(r, 1100)); // больше JOIN_COOLDOWN_MS (1 с)
a.send(JSON.stringify(["join", { room, login: `Б-${rnd}` }]));
const youA2 = await waitFor(a, "you");
ok(youA2[1].id !== youA[1].id, "повторный join завёл нового кота");
const fieldA2 = await waitFor(a, "field");
const atmo2 = fieldA2[1].atmo;
ok(!!atmo2, "field после перезахода несёт якорь");
ok(atmo2.cs === atmo1.cs && atmo2.pl === atmo1.pl, "якорь цикла не сбросился (cs,pl те же)");
ok(
  phaseOf(atmo2.cs, atmo2.pl, atmo2.t) === idxOf(atmo2.dp),
  `dp после перезахода совпадает с часами (${atmo2.dp})`,
);

// --- независимый сокет видит тот же якорь ---
const b = await client(`В-${rnd}`);
await waitFor(b, "you");
const fieldB = await waitFor(b, "field");
const atmo3 = fieldB[1].atmo;
ok(atmo3.cs === atmo1.cs && atmo3.w === atmo2.w, "новичок видит тот же якорь, что и старожил");

// --- после перезахода atmo-рассылки продолжают приходить ---
clear(a);
a.send(JSON.stringify(["atmo", { dp: "night", w: "rain" }]));
const echo = await waitFor(a, "atmo");
ok(echo[1].dp === "night" && echo[1].w === "rain", "эхо перемотки после перезахода пришло");
const bAtmo = await waitFor(b, "atmo");
ok(bAtmo[1].dp === "night" && bAtmo[1].w === "rain", "рассылка перемотки дошла до соседа");

// --- якорь не прыгает назад во времени: cs движется только перемоткой ---
clear(b);
await new Promise((r) => setTimeout(r, 1200));
const fieldB2hit = b.inbox.find((m) => m[0] === "field");
ok(!fieldB2hit, "спонтанных field-снапшотов (сброс якоря) нет");

console.log(fails === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `\nПРОВАЛОВ: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
