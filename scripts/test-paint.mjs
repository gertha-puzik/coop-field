// Пиксельная отрисовка локации: setmap принимает рисунок (PNG base64) и боевые
// клетки на закрашенных местах, отказывает боевой клетке на некрашеном месте,
// free-ходьба ходит только по закрашенному, спавн новичка — на закрашенной земле.
// Запуск: node scripts/test-paint.mjs — из чистого клона, сам поднимает свой
// server.js на случайном порту с временным DATA_DIR. Внешний сервер:
// WS_URL=ws://… node scripts/test-paint.mjs.
// Вторая setmap-правка уходит с НОВОГО сокета: сервер троттлит любые setmap-кадры
// раз в 10 с НА СОКЕТ. Пароль редактора по умолчанию — 1946 (совпадает с серверным
// legacy-дефолтом); переопределение — env MAP_PASS (спавненному серверу передаётся
// ADMIN_PASS с тем же значением).
import { WebSocket } from "ws";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// пароль редактора по умолчанию (совпадает с серверным legacy-дефолтом; переопределение — env MAP_PASS)
const PASS = process.env.MAP_PASS || "1946";

const PORT = 3993 + Math.floor(Math.random() * 40);
const url = process.env.WS_URL || `ws://127.0.0.1:${PORT}`;
const room = "test";
const rnd = Date.now().toString(36);
let fails = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) fails++;
};

// Свой server.js, если внешний адрес не задан; пароль уходит в spawn-окружение
// тем же значением, что и в кадрах setmap («читает env КАК сервер»).
const srv = process.env.WS_URL
  ? null
  : spawn(process.execPath, ["server.js"], {
      cwd: path.resolve(new URL("..", import.meta.url).pathname),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        DATA_DIR: mkdtempSync(path.join(tmpdir(), "coop-paint-")),
        ADMIN_PASS: PASS,
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

/* ---------- минимальный PNG-энкодер (RGBA, фильтр 0) ---------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // фильтр None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

/** Рисунок мира 12×8 (1200×1200): закрашена область клеток (0..8)×(0..5) минус
 *  дырка 2×2 клетки (2..3, 2..3) — сквозь неё нельзя идти (обе точки freeMove
 *  попадают в пустоту); боевая клетка (7,1) закрашена целиком; клетка (9,4)
 *  закрашена наполовину — боевая клетка там не ставится. */
function makePaint() {
  const w = 12 * 100;
  const h = 8 * 150;
  const rgba = Buffer.alloc(w * h * 4);
  const set = (x, y, on) => {
    const i = (y * w + x) * 4;
    rgba[i] = on ? 66 : 0;
    rgba[i + 1] = on ? 100 : 0;
    rgba[i + 2] = on ? 44 : 0;
    rgba[i + 3] = on ? 255 : 0;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = Math.floor(x / 100);
      const r = Math.floor(y / 150);
      const on = c <= 8 && r <= 5 && !(c >= 2 && c <= 3 && r >= 2 && r <= 3) && !(c === 9 && r === 4 && y % 2 === 0);
      set(x, y, on);
    }
  }
  return encodePng(w, h, rgba);
}

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

const paint = makePaint();
const zones = [{ id: "z1", name: "Лужайка", kind: "green", c0: 0, r0: 0, c1: 9, r1: 5 }];
const baseMap = {
  v: 2,
  cols: 12,
  rows: 8,
  margin: 0.5,
  seed: "test",
  zones,
  objects: [
    { id: "o1", kind: "battle", c: 7, r: 1, pos: "center" },
    { id: "o2", kind: "entry", c: 6, r: 1, pos: "center", dir: "right" },
  ],
  spawns: [{ c: 1, r: 1 }],
  paint,
};

// --- валидный setmap: рисунок + боевые клетки на закрашенных местах ---
const a = await client(`А-${rnd}`);
await waitFor(a, "you");
await waitFor(a, "field");
clear(a);
a.send(JSON.stringify(["setmap", { pass: PASS, map: baseMap }]));
await new Promise((r) => setTimeout(r, 600));
const mapEv = a.inbox.find((m) => m[0] === "map");
ok(!!mapEv, "setmap с рисунком принят, map разослан");
ok(mapEv?.[1]?.paint === paint, "рисунок возвращается в конфиге без изменений");
ok(
  (mapEv?.[1]?.objects ?? []).some((o) => o.kind === "battle" && o.c === 7 && o.r === 1),
  "боевая клетка (7,1) на закрашенном месте сохранена",
);
ok(
  !(mapEv?.[1]?.objects ?? []).some((o) => o.kind === "dirt" || o.kind === "ground"),
  "проталины/покрытия с рисунком не нужны (и их не было)",
);

// --- боевая клетка на наполовину закрашенном месте — отказ ---
// setmap уходит с НОВОГО сокета: предыдущий кадр прогнан меньше секунды назад,
// а сервер троттлит любые setmap-кадры раз в 10 с на сокет.
const admin2 = await client(`Админ2-${rnd}`);
await waitFor(admin2, "you");
await waitFor(admin2, "field");
clear(admin2);
const badMap = JSON.parse(JSON.stringify(baseMap));
badMap.objects.push({ id: "o9", kind: "battle", c: 9, r: 4, pos: "center" });
admin2.send(JSON.stringify(["setmap", { pass: PASS, map: badMap }]));
await new Promise((r) => setTimeout(r, 500));
const info = admin2.inbox.find((m) => m[0] === "info");
ok(
  !!info && /не целиком/.test(info[1]),
  `боевая клетка на некрашеном месте отказана: ${info?.[1] ?? "нет ответа"}`,
);
admin2.close();

// --- мирная ходьба только по закрашенному ---
const b = await client(`В-${rnd}`);
await waitFor(b, "you");
const fieldB = await waitFor(b, "field");
ok(fieldB[1]?.atmo, "новичок получает снапшот с якорем атмосферы");
clear(b);
a.send(JSON.stringify(["freemove", { x: 1.5, y: 1.5 }])); // закрашено
await new Promise((r) => setTimeout(r, 400));
const fmEcho = b.inbox.find((m) => m[0] === "freemove");
ok(!!fmEcho, "freemove по закрашенному принят и разослан");
clear(b);
a.send(JSON.stringify(["freemove", { x: 2.5, y: 2.5 }])); // дырка 2×2 (2..3, 2..3)
await new Promise((r) => setTimeout(r, 400));
ok(!b.inbox.some((m) => m[0] === "freemove"), "freemove в стёртую дырку отвергнут сервером");

// --- спавн новичка на закрашенной земле (зелёных зон с боем нет — только painted) ---
const meB = fieldB[1]?.cats?.find((c) => c.login === `В-${rnd}`);
const [bx, by] = [meB?.fx, meB?.fy];
ok(
  typeof bx === "number" && bx >= 0 && by >= 0 && bx < 9 && by < 6,
  `спавн новичка на закрашенной земле (${bx}, ${by})`,
);

a.close();
b.close();
console.log(fails === 0 ? "\nВСЕ ПРОВЕРКИ ПРОЙДЕНЫ" : `\nПРОВАЛОВ: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
