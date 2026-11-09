#!/usr/bin/env node
import { randomFillSync } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import http from "node:http";
/**
 * Живой тест личных окрасов игроков (#83, server/my-sprites.js, /sprites/mine*).
 * Песочница как у test-sprites.mjs: mkdtemp-DATA_DIR (data репо не трогаем),
 * свободный порт, спавн server.js, AUTH_CSRF_STRICT=1 (отрицание unsafe без
 * Origin без второго стенда), лестница S1 для админа.
 *
 * Позитив:
 *   1. сессия игрока (register v2) + upload валидного PNG 300×200 (шумовой
 *      RGBA, честный IHDR) → 201 {ok, sprite:{id,name,category,src,w,h,bytes}},
 *      id = транслит-слаг имени, категория — константа «Мои окрасы»;
 *   2. id появился в публичном GET /sprites/catalog (без сессии) с той же
 *      категорией; файл GET /sprites/file/<id>.png отдаёт байт-в-байт;
 *   3. PATCH /profiles/me {sprite:<id>} принимается — активный персонаж
 *      в новом окрасе (внешность применяется из профиля при входе в «Элизию»);
 *   4. GET /sprites/mine — свои с габаритами/счётчиком лимита 3;
 *   5. дедуп даблклика: то же тело от того же аккаунта → 200 dedup, id прежний;
 *      то же тело от ДРУГОГО аккаунта — новый окрас (дедуп свой Clare на своего);
 *   6. DELETE чужой сессией → 403 forbidden; DELETE одетого → 409 worn;
 *      после переодевания DELETE владельцем → 200 (каталог/файл чисты);
 *   7. рестарт сервера: свои окрасы читаются из манифеста с габаритами —
 *      канон каталога живёт на диске, а не только в памяти процесса;
 *   8. админ (лестница S1): GET /admin/sprites видит колонку владельца
 *      (owner = логин); PATCH {hidden:true} — строка уходит из каталога и
 *      валидаторов (PATCH /profiles/me {sprite} → 400), файл НЕ удалён,
 *      скрытый слот всё равно занимает лимит 3; отмена скрытия возвращает
 *      окрас; DELETE личного через /sprites/mine/:id админом → 200,
 *      DELETE builtin через mine-зону → 404;
 *   9. WS join с чужеродным id (удалённый окрас) не надевает его (живое
 *      зеркало вайтлиста config.SPRITES);
 *  10. аудит: DATA_DIR/sprites/sprites-audit.jsonl — append-only строки
 *      {ts, accountId, id, name, bytes} на каждую принятую заливку;
 *  11. rate: свежий аккаунт, окно 5/час — шестая обработанная загрузка →
 *      429 rate (удаления обработанные попытки не возвращают);
 *  12. host-гейт: /sprites/mine на Host-классе public (гроты) → 404 not_found
 *      (как профили и админ-зоны).
 *
 * Негатив (буквы контракта):
 *   - без сессии → 401 auth_required; с cookie без Origin → 403 csrf_origin_required;
 *   - не-PNG → 400 bad_magic; >1 МБ → 413 too_large; габариты вне диапазона
 *     (50×50; 1000×700 = 700 000 px; пустой холст <1,5 КБ) → 400 bad_dims;
 *     имя 1 символ → 400 bad_name; multipart без файла → 400 no_file;
 *   - 4-й спрайт на аккаунт → 409 limit («У вас уже 3 окраса — удалите один
 *     в профиле»).
 *
 * Запуск: node scripts/test-my-sprites.mjs (npm run test:my-sprites).
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { SPRITES as BASE_SPRITE_IDS } from "../server/config.js";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-my-sprites-"));
const PORT = 4460 + Math.floor(Math.random() * 60);
const HOST = "127.0.0.1";
const HTTP = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;
const ORIGIN = `http://${HOST}:${PORT}`; // цикличный origin: классу local разрешён
const MAIN = "hulimka_q";     // владелец личных окрасов
const OTHER = "snezhana_q";   // чужая сессия (DELETE → 403)
const ADMIN = "lastochka_q";  // будущий админ (лестница S1)
const RATE = "khronometr_q";  // скользящее окно rate
/** Базовых в сидe: сколько id в config.SPRITES (источник истины счёта). */
const BASE_COUNT = BASE_SPRITE_IDS.length;
/** Категория — серверная константа (#83): свободный ввод игроку закрыт. */
const MINE_CATEGORY = "Мои окрасы";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Ждём кадр по предикату в inbox сокета (как waitFor в test-sprites.mjs). */
const waitFor = (ws, pred, ms = 5000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = (ws.inbox || []).find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout; inbox=${JSON.stringify((ws.inbox || []).slice(-8))}`));
      setTimeout(tick, 15);
    };
    tick();
  });

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
};

/* ---------- честный PNG-конструктор (без зависимостей): IHDR + IDAT + IEND ---------- */

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

/** Валидный PNG заданных габаритов: RGBA, фильтр 0. solid=true — однотонный
 *  (пустой) холст: сжимается в копейки — для негативных проб габаритов. */
function buildPng(w, h, solid = false) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const rowLen = 1 + w * 4;
  const raw = Buffer.alloc(h * rowLen);
  if (!solid) {
    const px = Buffer.alloc(w * h * 4);
    randomFillSync(px);
    for (let y = 0; y < h; y += 1) {
      raw[y * rowLen] = 0; // filter: none
      px.copy(raw, y * rowLen + 1, y * w * 4, (y + 1) * w * 4);
    }
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Конструирование multipart/form-data вручную (как браузер). */
function multipart(fields, file) {
  const boundary = `----coopminesprite${Math.random().toString(36).slice(2)}`;
  const chunks = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`),
    );
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="${file.filename}"\r\ncontent-type: image/png\r\n\r\n`,
      ),
    );
    chunks.push(file.data);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** HTTP-хелперы: JSON и сырой multipart upload. host-параметр — только для
 *  зонда host-гейта: node-fetch запрещает переопределять Host, гейт пробиваем
 *  сырым http.request ниже. */
const httpJson = async (pathname, { method = "GET", body, token, origin } = {}) => {
  const headers = { "content-type": "application/json" };
  if (token) headers.cookie = `coop_session=${token}`;
  if (origin) headers.origin = origin;
  const res = await fetch(`${HTTP}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};
const httpUpload = async (pathname, { body, contentType, token, origin }) => {
  const headers = { "content-type": String(contentType) };
  if (token) headers.cookie = `coop_session=${token}`;
  if (origin) headers.origin = origin;
  const res = await fetch(`${HTTP}${pathname}`, { method: "POST", headers, body });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

/** Резервированный заголовок Host (гейт классов сайта) — сырым http.request. */
function probeWithHost(pathname, { host, token }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST,
      port: PORT,
      path: pathname,
      headers: {
        host,
        cookie: token ? `coop_session=${token}` : "",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let server = null;
let serverLog = "";
function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST,
      DATA_DIR: DATA,
      ADMIN_PASS: "1946",
      AUTH_CSRF_STRICT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => { serverLog += String(d); });
  server.stderr.on("data", (d) => { serverLog += String(d); process.stderr.write(d); });
}
async function stopServer() {
  if (!server || server.exitCode !== null || server.signalCode) return;
  server.kill("SIGTERM");
  await new Promise((resolve) => {
    if (server.exitCode !== null || server.signalCode) return resolve();
    server.once("exit", resolve);
  });
}
async function waitReady() {
  for (let i = 0; i < 100; i += 1) {
    const ok = await new Promise((resolve) => {
      const probe = new WebSocket(WS);
      probe.once("open", () => { probe.terminate(); resolve(true); });
      probe.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(80);
  }
  throw new Error(`server not ready: ${WS}`);
}

const pubCatalog = async () => httpJson("/sprites/catalog");

try {
  startServer();
  await waitReady();

  /* ---------- лестница S1: все три аккаунта регистрируются, админ — через CLI ---------- */

  const mainReg = await httpJson("/auth/register", { method: "POST", body: { login: MAIN, pass: "password1", name: "Хулимка" } });
  const mainTok = mainReg.json?.token;
  check(!!mainTok, "регистрация владельца личных окрасов");
  const otherReg = await httpJson("/auth/register", { method: "POST", body: { login: OTHER, pass: "password1", name: "Снежана" } });
  const otherTok = otherReg.json?.token;
  check(!!otherTok, "регистрация чужой сессии");
  const adminReg = await httpJson("/auth/register", { method: "POST", body: { login: ADMIN, pass: "password1" } });
  check(!!adminReg.json?.token, "регистрация будущего админа");
  await stopServer();
  const cliOut = execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), ADMIN], {
    env: { ...process.env, DATA_DIR: DATA },
    encoding: "utf8",
  });
  check(/повышен|уже админ/.test(cliOut), "make-admin повышает админа (лестница S1)");
  startServer();
  await waitReady();
  const adminLogin = await httpJson("/auth/login", { method: "POST", body: { login: ADMIN, pass: "password1" } });
  const adminTok = adminLogin.json?.token;
  check(!!adminTok, "вход админа");

  /* ---------- upload валидного PNG 300×200 и гейты входа ---------- */

  const noSession = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Ночной Луч" }, { filename: "a.png", data: buildPng(300, 200) }),
    origin: ORIGIN,
  });
  check(noSession.status === 401 && noSession.json?.reason === "auth_required",
    "POST /sprites/mine без сессии → 401 auth_required");

  // csrf: cookie есть, Origin нет — щит apiZone (AUTH_CSRF_STRICT=1)
  const noOrigin = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Ночной Луч" }, { filename: "a.png", data: buildPng(300, 200) }),
    token: mainTok,
  });
  check(noOrigin.status === 403 && noOrigin.json?.reason === "csrf_origin_required",
    "upload с cookie без Origin → 403 csrf_origin_required");

  const firstPng = buildPng(300, 200);
  const up1 = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Ночной Луч", category: "Взлом", id: "hacker-id" }, { filename: "cat.png", data: firstPng }),
    token: mainTok,
    origin: ORIGIN,
  });
  const up1sprite = up1.json?.sprite;
  check(up1.status === 201 && up1.json?.ok === true && typeof up1sprite?.id === "string",
    `upload 300×200 → 201 {ok, sprite}: ${JSON.stringify(up1sprite)}`);
  check(up1sprite?.id === "nochnoy-luch" && up1sprite?.name === "Ночной Луч",
    "id — транслит-слаг имени; поля category/id из запроса проигнорированы");
  check(up1sprite?.category === MINE_CATEGORY && up1sprite?.w === 300 && up1sprite?.h === 200 &&
    up1sprite?.bytes === firstPng.length && up1sprite?.src === `/sprites/file/nochnoy-luch.png`,
    `sprite DTO: категория «${MINE_CATEGORY}», габариты/вес/файловый src честные`);
  check(!Object.keys(up1.json || {}).includes("ownerAccountId") &&
    !Object.keys(up1sprite || {}).includes("ownerAccountId") &&
    !Object.keys(up1sprite || {}).includes("sha256"),
    "ownerAccountId/sha256 наружу не отдаются");
  const mainSpriteId = up1sprite?.id;

  /* ---------- каталог и файлы ---------- */

  const cat1 = await pubCatalog();
  const catRow = ((cat1.json?.items) || []).find((r) => r.id === mainSpriteId);
  check((cat1.json?.items || []).length === BASE_COUNT + 1 &&
    catRow?.name === "Ночной Луч" && catRow?.category === MINE_CATEGORY,
    `публичный каталог: ${BASE_COUNT}+1 строка, новая — с категорией «${MINE_CATEGORY}»`);
  const file1 = await fetch(`${HTTP}/sprites/file/${mainSpriteId}.png`);
  const fileBody = Buffer.from(await file1.arrayBuffer());
  check(file1.status === 200 && firstPng.compare(fileBody) === 0,
    "GET /sprites/file/<id>.png → 200, байты совпали с загруженными");

  /* ---------- надевание через профиль (существующий флоу) ---------- */

  const wear = await httpJson("/profiles/me", {
    method: "PATCH",
    body: { sprite: mainSpriteId },
    token: mainTok,
    origin: ORIGIN,
  });
  check(wear.status === 200 && wear.json?.ok === true,
    "PATCH /profiles/me {sprite:<новый id>} принимается (spriteIdAllowed живой)");
  const mineCard = await httpJson("/profiles/me", { token: mainTok });
  check((mineCard.json?.characters || []).some((c) => c.sprite === mainSpriteId),
    "активный персонаж аккаунта носит личный окрас (применится при входе)");

  /* ---------- GET /sprites/mine ---------- */

  const mineList = await httpJson("/sprites/mine", { token: mainTok });
  check(mineList.status === 200 && (mineList.json?.items || []).length === 1 &&
    mineList.json?.limit === 3 && mineList.json?.count === 1 &&
    mineList.json?.items?.[0]?.hidden === false,
    "GET /sprites/mine: свои окрасы с габаритами, limit 3, счётчик");
  const mineAnon = await httpJson("/sprites/mine");
  check(mineAnon.status === 401, "GET /sprites/mine без сессии → 401");

  /* ---------- негативы контракта ---------- */

  const badMagic = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Подделка" }, { filename: "x.png", data: Buffer.from("GIF89a — точно не PNG") }),
    token: mainTok,
    origin: ORIGIN,
  });
  check(badMagic.status === 400 && badMagic.json?.reason === "bad_magic",
    "не-PNG → 400 bad_magic");

  const huge = Buffer.concat([buildPng(300, 200), Buffer.alloc(1024 * 1024 + 16, 7)]);
  const tooBig = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Гигант" }, { filename: "big.png", data: huge }),
    token: mainTok,
    origin: ORIGIN,
  });
  check(tooBig.status === 413 && tooBig.json?.reason === "too_large",
    "тело >1 МБ → 413 too_large (контроль при чтении тела)");

  const tinyDims = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Мелочь" }, { filename: "tiny.png", data: buildPng(50, 50, true) }),
    token: mainTok,
    origin: ORIGIN,
  });
  check(tinyDims.status === 400 && tinyDims.json?.reason === "bad_dims",
    "габариты 50×50 (вне 100–1000) → 400 bad_dims");
  const hugeArea = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Панно" }, { filename: "wall.png", data: buildPng(1000, 700, true) }),
    token: mainTok,
    origin: ORIGIN,
  });
  check(hugeArea.status === 400 && hugeArea.json?.reason === "bad_dims",
    "1000×700 = 700 000 px > 600 000 → 400 bad_dims");
  const emptyCanvas = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Пустой Холст" }, { filename: "empty.png", data: buildPng(300, 200, true) }),
    token: mainTok,
    origin: ORIGIN,
  });
  check(emptyCanvas.status === 400 && emptyCanvas.json?.reason === "bad_dims",
    "пустой холст <1,5 КБ при валидных габаритах → 400 bad_dims");
  const badName = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Ы" }, { filename: "y.png", data: buildPng(300, 200) }),
    token: mainTok,
    origin: ORIGIN,
  });
  check(badName.status === 400 && badName.json?.reason === "bad_name",
    "имя 1 символ → 400 bad_name");
  const noFile = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Без файла" }),
    token: mainTok,
    origin: ORIGIN,
  });
  check(noFile.status === 400 && noFile.json?.reason === "no_file",
    "multipart без файла → 400 no_file");

  /* ---------- лимит 3/аккаунт и дедуп даблклика ---------- */

  const up2 = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Утренний Бриз" }, { filename: "b.png", data: buildPng(300, 200) }),
    token: mainTok,
    origin: ORIGIN,
  });
  const up3 = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Лунная Дорожка" }, { filename: "c.png", data: buildPng(300, 200) }),
    token: mainTok,
    origin: ORIGIN,
  });
  check(up2.status === 201 && up3.status === 201, "2-й и 3-й окрасы загружены (201)");
  const fourth = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Четвёртый" }, { filename: "d.png", data: buildPng(300, 200) }),
    token: mainTok,
    origin: ORIGIN,
  });
  check(fourth.status === 409 && fourth.json?.reason === "limit" &&
    String(fourth.json?.message || "").includes("3 окраса"),
    `4-й спрайт → 409 limit («${fourth.json?.message}»)`);

  const dedup = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Другое Имя" }, { filename: "again.png", data: firstPng }),
    token: mainTok,
    origin: ORIGIN,
  });
  check(dedup.status === 200 && dedup.json?.ok === true && dedup.json?.dedup === true &&
    dedup.json?.sprite?.id === mainSpriteId,
    "дубликат тела → 200 существующий sprite (слот не тратится)");
  const mineAfterDedup = await httpJson("/sprites/mine", { token: mainTok });
  check(mineAfterDedup.json?.count === 3 &&
    (mineAfterDedup.json?.items || []).every((it) => it.category === MINE_CATEGORY),
    "после дедупа счётчик прежний (3 из 3), категория — константа");
  const otherDup = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Чужой Клон" }, { filename: "clone.png", data: firstPng }),
    token: otherTok,
    origin: ORIGIN,
  });
  check(otherDup.status === 201 && otherDup.json?.sprite?.id !== mainSpriteId,
    "то же тело от ДРУГОГО аккаунта — новый окрас (дедуп только свой)");

  /* ---------- DELETE: чужой / одетый / владелец ---------- */

  const delForeign = await httpJson(`/sprites/mine/${mainSpriteId}`, {
    method: "DELETE",
    token: otherTok,
    origin: ORIGIN,
  });
  check(delForeign.status === 403 && delForeign.json?.reason === "forbidden",
    "DELETE чужой сессией → 403 forbidden");
  const delWorn = await httpJson(`/sprites/mine/${mainSpriteId}`, {
    method: "DELETE",
    token: mainTok,
    origin: ORIGIN,
  });
  check(delWorn.status === 409 && delWorn.json?.reason === "worn" &&
    Array.isArray(delWorn.json?.wornBy),
    "DELETE одетого владельцем → 409 worn (сначала переоденьте кота)");
  const unwear = await httpJson("/profiles/me", {
    method: "PATCH",
    body: { sprite: "chis" },
    token: mainTok,
    origin: ORIGIN,
  });
  check(unwear.status === 200, "переодели персонажа в базовый скин (PATCH /profiles/me)");
  const delOwn = await httpJson(`/sprites/mine/${mainSpriteId}`, {
    method: "DELETE",
    token: mainTok,
    origin: ORIGIN,
  });
  check(delOwn.status === 200 && delOwn.json?.ok === true && delOwn.json?.id === mainSpriteId,
    "DELETE владельцем после переодевания → 200");
  const catAfterDel = await pubCatalog();
  // осталось: Бриз (main) + Дорожка (main) + Чужой Клон (other) поверх базовых
  check(!(catAfterDel.json?.items || []).some((r) => r.id === mainSpriteId) &&
    (catAfterDel.json?.items || []).length === BASE_COUNT + 3,
    `удалённый окрас ушёл из каталога (${BASE_COUNT}+3 строк: 2 своих + 1 чужой клон)`);
  const mineAfterDel = await httpJson("/sprites/mine", { token: mainTok });
  check(mineAfterDel.json?.count === 2, "счётчик владельца освободился (2 из 3)");

  /* ---------- рестарт: канон манифеста читается с диска ---------- */

  await stopServer();
  startServer();
  await waitReady();
  const relogin = await httpJson("/auth/login", { method: "POST", body: { login: MAIN, pass: "password1" } });
  const reTok = relogin.json?.token;
  check(!!reTok, "повторный вход владельца после рестарта (сессии перезагружены)");
  const mineAfterRestart = await httpJson("/sprites/mine", { token: reTok });
  check(mineAfterRestart.status === 200 && mineAfterRestart.json?.count === 2 &&
    (mineAfterRestart.json?.items || []).every((it) => it.w === 300 && it.h === 200 && it.bytes > 0),
    "после рестарта свои окрасы читаются из манифеста с габаритами");

  /* ---------- админ: владелец, скрытие, удаление через mine ---------- */

  const adminLogin2 = await httpJson("/auth/login", { method: "POST", body: { login: ADMIN, pass: "password1" } });
  const adminTok2 = adminLogin2.json?.token;
  const adminSprites = await httpJson("/admin/sprites", { token: adminTok2 });
  const mineRows = (adminSprites.json?.items || []).filter((r) => r.owner === MAIN);
  check(adminSprites.status === 200 && mineRows.length === 2,
    "GET /admin/sprites видит колонку владельца: 2 строки с owner = логин владельца");
  check((adminSprites.json?.items || []).every((r) => r.hidden === false) &&
    (adminSprites.json?.items || []).filter((r) => r.builtin).every((r) => r.owner === null),
    "все строки открыты, у builtin владельца нет (null)");

  const brezId = mineRows.find((r) => r.name === "Утренний Бриз")?.id;
  const lunarId = mineRows.find((r) => r.name === "Лунная Дорожка")?.id;
  check(!!brezId && !!lunarId, "id личных в админ-списке найдены по именам");

  const hideRes = await httpJson(`/admin/sprites/${brezId}`, {
    method: "PATCH",
    body: { hidden: true },
    token: adminTok2,
    origin: ORIGIN,
  });
  check(hideRes.status === 200 && hideRes.json?.item?.hidden === true,
    "PATCH {hidden:true} — админ скрывает личный окрас");
  const catHidden = await pubCatalog();
  check(!(catHidden.json?.items || []).some((r) => r.id === brezId),
    "скрытый окрас исчез из публичного каталога");
  check(existsSync(path.join(DATA, "sprites", `${brezId}.png`)),
    "файл скрытого окраса НЕ удалён с диска (улика)");
  const fileHidden = await httpJson(`/sprites/file/${brezId}.png`);
  check(fileHidden.status === 200,
    "файл скрытого окраса по-прежнему отдаётся (кэш и старые портреты не ломаются)");
  const wearHidden = await httpJson("/profiles/me", {
    method: "PATCH",
    body: { sprite: brezId },
    token: reTok,
    origin: ORIGIN,
  });
  check(wearHidden.status === 400 && Array.isArray(wearHidden.json?.invalid),
    "надеть скрытый окрас через профиль нельзя (spriteIdAllowed уважает hidden)");
  const mineHidden = await httpJson("/sprites/mine", { token: reTok });
  const hiddenItem = (mineHidden.json?.items || []).find((it) => it.id === brezId);
  check(hiddenItem?.hidden === true && mineHidden.json?.count === 2,
    "владелец видит скрытый окрас с меткой hidden — и слот его всё равно держит");
  /* Скрытый слот держит лимит даже у соседа: свежий аккаунт, 3 окраса,
   * один скрываем — четвёртый заливаемый падает в limit. */
  const zayReg = await httpJson("/auth/register", { method: "POST", body: { login: "zayats_q", pass: "password1" } });
  const zayTok = zayReg.json?.token;
  check(!!zayTok, "регистрация свежего аккаунта для пробы «скрытый держит слот»");
  const zayIds = [];
  for (const nm of ["Зеркальный", "Бархатный", "Медовый"]) {
    const r = await httpUpload("/sprites/mine", {
      ...multipart({ name: nm }, { filename: "z.png", data: buildPng(300, 200) }),
      token: zayTok,
      origin: ORIGIN,
    });
    if (r.status === 201) zayIds.push(r.json?.sprite?.id);
  }
  check(zayIds.length === 3, "три окраса свежего аккаунта залиты (201×3)");
  const hideZay = await httpJson(`/admin/sprites/${zayIds[0]}`, {
    method: "PATCH",
    body: { hidden: true },
    token: adminTok2,
    origin: ORIGIN,
  });
  check(hideZay.status === 200 && hideZay.json?.item?.hidden === true,
    "админ скрыл один из трёх окрасов свежего аккаунта");
  const fourthZay = await httpUpload("/sprites/mine", {
    ...multipart({ name: "Запасной" }, { filename: "spare.png", data: buildPng(300, 200) }),
    token: zayTok,
    origin: ORIGIN,
  });
  check(fourthZay.status === 409 && fourthZay.json?.reason === "limit",
    "скрытый слот занимает лимит: 4-й заливаемый при одном скрытом → 409 limit");
  const unhide = await httpJson(`/admin/sprites/${brezId}`, {
    method: "PATCH",
    body: { hidden: false },
    token: adminTok2,
    origin: ORIGIN,
  });
  const catUnhidden = await pubCatalog();
  check(unhide.status === 200 && (catUnhidden.json?.items || []).some((r) => r.id === brezId),
    "отмена скрытия возвращает окрас в каталог");

  const adminDeleteMine = await httpJson(`/sprites/mine/${lunarId}`, {
    method: "DELETE",
    token: adminTok2,
    origin: ORIGIN,
  });
  check(adminDeleteMine.status === 200 && adminDeleteMine.json?.id === lunarId,
    "DELETE личного окраса админом через /sprites/mine/:id → 200");
  const delBuiltinMine = await httpJson("/sprites/mine/puhlyashik", {
    method: "DELETE",
    token: adminTok2,
    origin: ORIGIN,
  });
  check(delBuiltinMine.status === 404,
    "DELETE builtin через /sprites/mine/:id → 404 (зона только личных)");

  /* ---------- WS: удалённый id не надевается (живое зеркало вайтлиста) ---------- */

  const ws1 = await new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.inbox = [];
    ws.on("message", (raw) => ws.inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.once("open", () => {
      ws.send(JSON.stringify(["auth", { action: "register", login: "tennor_q", pass: "password1" }]));
      resolve(ws);
    });
  });
  // ждём whoami с accountId (регистрация прошла), потом join с чужеродным id
  await waitFor(ws1, ([ev, p]) => ev === "whoami" && p?.accountId);
  ws1.send(JSON.stringify(["join", { room: "test", login: "tennor_q", sprite: lunarId, size: 90 }]));
  const youFrame = await waitFor(ws1, ([ev]) => ev === "you");
  check(youFrame && youFrame[1]?.sprite !== lunarId,
    "WS join с id удалённого окраса: валидатор его отбросил, персонаж без скина");
  ws1.close();
  await sleep(150);

  /* ---------- rate: скользящее окно 5/час ---------- */

  const rateReg = await httpJson("/auth/register", { method: "POST", body: { login: RATE, pass: "password1" } });
  const rateTok = rateReg.json?.token;
  check(!!rateTok, "регистрация rate-счётчика (свежие окна)");
  const statuses = [];
  // 5 обработанных загрузок: первые два слота освобождаем удалением НЕ надевая
  // (delete rate-попытки не возвращает), шестой POST встречает 429 rate —
  // гейт стоит ДО чтения тела и ДО лимита.
  const deletedIds = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await httpUpload("/sprites/mine", {
      ...multipart({ name: `Окрас Номер ${i + 1}` }, { filename: `r${i}.png`, data: buildPng(300, 200) }),
      token: rateTok,
      origin: ORIGIN,
    });
    statuses.push(res.status);
    if (res.status === 201 && (i === 0 || i === 1)) {
      const id = res.json?.sprite?.id;
      const del = await httpJson(`/sprites/mine/${id}`, { method: "DELETE", token: rateTok, origin: ORIGIN });
      if (del.status === 200) deletedIds.push(id);
    }
  }
  check(deletedIds.length === 2 && statuses.slice(0, 5).every((s) => s === 201) &&
    statuses[5] === 429 && await (async () => {
      const again = await httpUpload("/sprites/mine", {
        ...multipart({ name: "Седьмой Пробный" }, { filename: "r6.png", data: buildPng(300, 200) }),
        token: rateTok,
        origin: ORIGIN,
      });
      return again.status === 429 && again.json?.reason === "rate";
    })(),
    `rate 5/час: шестая и седьмая обработанная загрузка → 429 rate (${statuses.join(",")},${deletedIds.length} del)`);

  /* ---------- аудит: по строке на каждую принятую заливку ---------- */

  const auditPath = path.join(DATA, "sprites", "sprites-audit.jsonl");
  check(existsSync(auditPath), "файл аудита sprites-audit.jsonl создан рядом с манифестом");
  const auditLines = readFileSync(auditPath, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
  // Зафиксированные заливки: Ночной Луч, Утренний Бриз, Лунная Дорожка (владелец),
  // Чужой Клон (другая сессия) + 3 окраса zay (Зеркальный, Бархатный, Медовый)
  // + 5 окрасов rate-аккаунта = 12 записей.
  check(auditLines.length === 12,
    `аудит: по строке на каждую принятую заливку /sprites/mine (${auditLines.length} = 12)`);
  check(auditLines.every((row) => typeof row.ts === "number" && typeof row.accountId === "string" &&
    typeof row.id === "string" && typeof row.name === "string" && Number.isInteger(row.bytes)),
    "строки аудита: {ts, accountId, id, name, bytes} — append-only");
  check(auditLines.some((row) => row.name === "Ночной Луч" && row.bytes === firstPng.length),
    "первая заливка в аудите с честным весом файла");

  /* ---------- манифест на диске: личные поля существуют, наружу не текут ---------- */

  const manifestRows = JSON.parse(readFileSync(path.join(DATA, "sprites", "manifest.json"), "utf8"));
  const aRow = manifestRows.find((r) => r.ownerAccountId && r.sha256);
  check(!!aRow && typeof aRow.ownerAccountId === "string" && /^[0-9a-f]{64}$/.test(aRow.sha256) &&
    aRow.category === MINE_CATEGORY && !aRow.builtin && aRow.bytes > 0 && aRow.w === 300 && aRow.h === 200,
    "манифест несёт ownerAccountId/sha256/w/h/bytes личной строки");
  const catFinal = await pubCatalog();
  const catString = JSON.stringify(catFinal.json);
  check(!catString.includes("ownerAccountId") && !catString.includes("sha256") && !catString.includes("hidden"),
    "публичный каталог не отдаёт приватные поля строк");

  /* ---------- host-гейт: гротов не знают про личную зону ---------- */

  const grottoProbe = await probeWithHost("/sprites/mine", { host: "abnocw.phainonsmilk.ru", token: reTok });
  check(grottoProbe.status === 404 && grottoProbe.json?.reason === "not_found",
    "GET /sprites/mine на Host-классе public (гроты) → 404 not_found");

  /* ---------- битый манифест: улика, а не молчаливый пересев ---------- */

  const manifestFile = path.join(DATA, "sprites", "manifest.json");
  await stopServer();
  writeFileSync(manifestFile, "{ эт точно не json", "utf8");
  startServer();
  await waitReady();
  const catCorrupt = await pubCatalog();
  check((catCorrupt.json?.items || []).length === BASE_COUNT,
    "битый манифест: каталог пересеян базой (строки базовые, не пустой)");
  const spritesDirEntries = readdirSync(path.join(DATA, "sprites"));
  const stashName = spritesDirEntries.find((f) => /^manifest\.corrupt-.*\.json$/.test(f));
  check(!!stashName,
    `битый манифест отложен уликой manifest.corrupt-<ts>.json (${stashName || "нет"})`);
  check(readFileSync(path.join(DATA, "sprites", stashName || "x"), "utf8") === "{ эт точно не json",
    "улика хранит исходные битые байты (не перезаписана сидом)");
  check(spritesDirEntries.includes("manifest.json") &&
    (catCorrupt.json?.items || []).length === BASE_COUNT,
    "после пересева на диске снова валидный manifest.json");

  await stopServer();
} catch (e) {
  failures += 1;
  console.log("FAIL  исключение теста:", e.message);
  await stopServer();
} finally {
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* уже нет */ }
}

if (failures) {
  console.log(`my-sprites: ${failures} FAIL`);
  process.exit(1);
}
console.log("my-sprites: OK");
