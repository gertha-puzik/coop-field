/**
 * Тест персистентности «теста» (фикс «АФК-кота перебросило на спавн» и
 * «после деплоя карта слетела на старую»):
 *
 *  1. кот заходит в комнату «тест», уходит freemove в дальнюю точку — позиция
 *     попадает в книгу data/test-cats.json;
 *  2. сервер убивается (SIGTERM) и поднимается заново — повторный join с тем же
 *     логином получает прежнюю freemove-точку (fx/fy), а не клетку спавна;
 *  3. setmap сохраняет карту: data/test-map.json перезаписан атомарно, бэкап
 *     прошлой версии лежит в data/backups/;
 *  4. данные позиции и карты живут в отдельных файлах, каталог data не в git.
 *
 * Запуск: node scripts/test-position-persist.mjs (сам спавнит свои server.js).
 * Пароля редактора нет: setmap пароль не читает, карту сохраняет только
 * сессия с ролью admin (server/testmap.js).
 */
import { spawn, execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { sendJoin } from "./ws-auth.mjs";
import fs from "node:fs";
import path from "node:path";

// Аккаунт-редактор: мутации карт (кадр setmap) за админ-гейтом (server/testmap.js),
// загрузчик карты «map-setter» — админ; аккаунт создаётся в data/ ДО старта
// сервера через scripts/make-admin.mjs (лестница S1, см. test-admin-reset).
const ADMIN_LOGIN = "map-setter";
const ADMIN_ACCOUNT_PASS = "password1";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = path.join(ROOT, "data");
const PORT = 3893 + Math.floor(Math.random() * 50);
const WS_ADDR = `ws://127.0.0.1:${PORT}`;
const LOGIN = `persist-cat-${Math.floor(Math.random() * 1e6)}`;

// data/ может отсутствовать в свежем worktree — тест пишет туда базовую карту
// и аккаунт-админа до старта сервера.
fs.mkdirSync(DATA, { recursive: true });
execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), ADMIN_LOGIN, ADMIN_ACCOUNT_PASS], {
  env: { ...process.env, DATA_DIR: DATA },
  encoding: "utf8",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const srv = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    // Карта живёт в ROOT/data.
    env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.on("data", () => {});
  srv.stderr.on("data", (d) => process.stderr.write(d));
  return srv;
}

function client(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_ADDR);
    ws.inbox = [];
    ws.on("open", () => sendJoin(ws, { room: "test", login: name }));
    ws.on("message", (raw) => ws.inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.once("open", () => resolve(ws));
  });
}

const waitFor = (ws, pred, ms = 4000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ws.inbox.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout; inbox=${JSON.stringify(ws.inbox.slice(-6))}`));
      setTimeout(tick, 15);
    };
    tick();
  });

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
};

// Отдельный data-каталог не трогаем: тест работает на тех же файлах, но свои
// логины/карту не смешивает с боевыми данными (карта после теста восстанавливается).

// Чистый клон стартует с пустым data/: подсеваем базовую раскладку, чтобы шаг 3
// (перезапись карты setmap-ом) имел что бэкапить — бэкапы ведутся только при
// замене существующего файла (backupTestMap молчит, если файла ещё не было).
if (!fs.existsSync(path.join(DATA, "test-map.json"))) {
  fs.writeFileSync(
    path.join(DATA, "test-map.json"),
    JSON.stringify(
      {
        v: 2,
        cols: 19,
        rows: 7,
        margin: 0.5,
        seed: "test",
        zones: [
          { id: "z1", name: "Лужайка", kind: "green", c0: 0, r0: 0, c1: 9, r1: 6 },
          { id: "z2", name: "Полигон", kind: "cells", c0: 10, r0: 1, c1: 15, r1: 5 },
          { id: "z3", name: "Заросли", kind: "green", c0: 16, r0: 0, c1: 18, r1: 6 },
        ],
        objects: [],
      },
      null,
      2,
    ),
  );
}

const mapBackup = fs.existsSync(path.join(DATA, "test-map.json"))
  ? fs.readFileSync(path.join(DATA, "test-map.json"), "utf8")
  : null;

const srv = startServer();
await sleep(700);

let failures0 = failures;
try {
  // 1. Свободный заход и уход в дальнюю точку
  const ws = await client(LOGIN);
  await waitFor(ws, ([ev]) => ev === "field");
  ws.send(JSON.stringify(["freemove", { x: 8.4, y: 5.7, stop: true }]));
  await waitFor(ws, ([ev, p]) => ev === "info" || (ev === "freemove" && p.stop), 500).catch(() => {});
  // Ждём слива книги позиций (троттлинг 3 с) + стоп-пакет уходит сразу
  await sleep(3400);
  const catsFile = path.join(DATA, "test-cats.json");
  check(fs.existsSync(catsFile), "книга позиций записана на диск");
  const book = JSON.parse(fs.readFileSync(catsFile, "utf8"));
  const rec = book.cats[LOGIN.toLowerCase()];
  check(!!rec && rec.fm === 1 && Math.abs(rec.fx - 8.4) < 0.01 && Math.abs(rec.fy - 5.7) < 0.01,
    `позиция в книге: ${JSON.stringify(rec)}`);
  ws.close();

  // 2. Рестарт сервера — кот возвращается на свою точку
  srv.kill("SIGTERM");
  await sleep(500);
  const srv2 = startServer();
  await sleep(700);
  const ws2 = await client(LOGIN);
  const field2 = await waitFor(ws2, ([ev, p]) => ev === "field" && p.format === "test");
  const me = (field2[1].cats || []).find((c) => c.login === LOGIN);
  check(!!me && me.fm === 1 && Math.abs(me.fx - 8.4) < 0.02 && Math.abs(me.fy - 5.7) < 0.02,
    `после рестарта кот на своей точке: ${JSON.stringify({ fm: me?.fm, fx: me?.fx, fy: me?.fy })}`);
  check(!(me && me.fx === 0 && me.fy === 0), "не на спавне (0,0)");
  ws2.close();

  // 3. setmap пишет карту атомарно и оставляет бэкап. Загрузчик — админ:
  // мутации карт за админ-гейтом (server/testmap.js), аккаунт-редактор
  // подготовлен выше через scripts/make-admin.mjs.
  const ws3 = await client(ADMIN_LOGIN);
  await waitFor(ws3, ([ev]) => ev === "field");
  const smallMap = {
    v: 2,
    cols: 12,
    rows: 6,
    seed: "persist-test",
    zones: [
      { id: "z1", name: "Лужайка", kind: "green", c0: 0, r0: 0, c1: 6, r1: 5 },
      { id: "z2", name: "Полигон", kind: "cells", c0: 7, r0: 1, c1: 10, r1: 4 },
    ],
    objects: [],
  };
  ws3.send(JSON.stringify(["setmap", { map: smallMap }]));
  const mapAck = await waitFor(ws3, ([ev, p]) => ev === "map" && p?.seed === "persist-test");
  check(!!mapAck, "setmap принят и разослан");
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, "test-map.json"), "utf8"));
  check(saved.seed === "persist-test", "карта сохранена в test-map.json");
  const bdir = path.join(DATA, "backups");
  const backs = fs.existsSync(bdir) ? fs.readdirSync(bdir).filter((f) => f.startsWith("test-map-")) : [];
  check(backs.length > 0, `бэкапы карты ведутся: ${backs.length} шт.`);
  ws3.close();

  // 4. Главная регрессия «слетевшей карты»: sanitizeTestMap раньше падал на
  // константах спрайтов (TDZ) — пустой catch подменял сохранённую карту дефолтом
  // при каждом старте. После рестарта карта обязана остаться сохранённой.
  srv2.kill("SIGTERM");
  await sleep(500);
  const srv3 = startServer();
  await sleep(700);
  const ws4 = await client("map-checker");
  const field3 = await waitFor(ws4, ([ev, p]) => ev === "field" && p.format === "test");
  check(field3[1].map?.seed === "persist-test",
    `карта пережила рестарт (seed=${JSON.stringify(field3[1].map?.seed)})`);
  ws4.close();
  srv3.kill("SIGTERM");
  await sleep(400);
} catch (e) {
  failures += 1;
  console.log("FAIL  исключение теста:", e.message);
}

// Восстанавливаем прежнюю карту и подчищаем тестовые данные
try {
  if (mapBackup !== null) fs.writeFileSync(path.join(DATA, "test-map.json"), mapBackup);
  const catsPath = path.join(DATA, "test-cats.json");
  if (fs.existsSync(catsPath)) {
    const book = JSON.parse(fs.readFileSync(catsPath, "utf8"));
    delete book.cats[LOGIN.toLowerCase()];
    delete book.cats["map-setter"];
    fs.writeFileSync(catsPath, JSON.stringify(book, null, 2));
  }
  const bdir = path.join(DATA, "backups");
  if (fs.existsSync(bdir)) {
    for (const f of fs.readdirSync(bdir)) {
      if (f.startsWith("test-map-")) fs.unlinkSync(path.join(bdir, f));
    }
  }
} catch {}

console.log(failures === 0 ? "\nВсе проверки прошли" : `\nПровалов: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
