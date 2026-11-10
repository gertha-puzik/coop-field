#!/usr/bin/env node
import { randomFillSync } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import http from "node:http";
/**
 * Живой тест аватарок профиля (server/avatars.js, /avatars/mine + /avatars/file).
 * Песочница как у test-my-sprites.mjs: mkdtemp-DATA_DIR (data репо не трогаем),
 * свободный порт, спавн server.js, AUTH_CSRF_STRICT=1 (отрицание unsafe без
 * Origin без второго стенда).
 *
 * Сценарии (порядок уважает rate-окно «1 загрузка / 10 с на аккаунт» —
 * неудачные попытки окно не занимают, поэтому все негативы идут до первого
 * успешного аплоада своего аккаунта, а позитивы растянуты по трём аккаунтам):
 *   1. (f) POST без сессии → 401 auth_required; с cookie без Origin →
 *      403 csrf_origin_required; с чужим Origin → 403 csrf_origin_mismatch;
 *   2. не-multipart → 400 bad_content_type; битый multipart → 400
 *      bad_multipart; multipart без файла → 400 no_file;
 *   3. (e) мусорный файл без магии (≥100 байт) → 400 bad_magic;
 *   4. габариты: PNG 32×32 и JPEG SOF 20×20 → 400 bad_dims (обе ветки
 *      размерного парсера);
 *   5. (a) загрузка настоящего PNG 64×64 → 200 {ok:true, avatar:
 *      «/avatars/file/<id>.png?v=<ms>»}, файл на диске — имя = id аккаунта;
 *   6. (b) GET файла → 200, байты равны отправленным, content-type image/png;
 *   7. (h) avatar появился в GET /profiles/me и в публичной карточке по id
 *      (DTO accounts.publicProfile);
 *   8. (c) DELETE /avatars/mine → 200 {ok:true, avatar:null};
 *   9. (d) GET файла после удаления → 404; на диске файла нет; (h) avatar
 *      в /profiles/me — null;
 *  10. (g) JPEG по магии (SOI+APP0+SOF0+EOI, честные w/h из SOF) → 200,
 *      avatar «…jpg?v=…»; GET файла → 200 байт-в-байт, image/jpeg;
 *  11. (i) rate: две загрузки подряд одним аккаунтом → вторая 429 rate
 *      (окно 10 с ещё не прошло);
 *  12. host-гейт: /avatars/mine на Host-классе public (гроты) → 404 not_found,
 *      а публичный GET /avatars/file/<id>.jpg на том же хосте → 200 (файл
 *      читается обоим сайтам, как /sprites/file);
 *  13. мусорный ид маршрута файла (не-charset, чужое расширение) → 404;
 *      не-GET на файловый префикс → 405.
 *
 * Запуск: node scripts/test-avatars.mjs (npm run test:avatars).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-avatars-"));
const PORT = 4520 + Math.floor(Math.random() * 60);
const HOST = "127.0.0.1";
const HTTP = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;
const ORIGIN = `http://${HOST}:${PORT}`; // цикличный origin: классу local разрешён
const MAIN = "zhuchka_q";   // владелец основной аватарки (PNG-флоу)
const JPGER = "vesna_q";    // JPEG-загрузка (отдельный аккаунт — rate-окна)
const RATER = "tachka_q";   // rate-проба (две загрузки подряд)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
};

/* ---------- честный PNG-конструктор (как test-my-sprites.mjs) ---------- */

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

/** Валидный PNG заданных габаритов (RGBA, шум) — сервис парсит IHDR честно. */
function buildPng(w, h) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  const rowLen = 1 + w * 4;
  const raw = Buffer.alloc(h * rowLen);
  const px = Buffer.alloc(w * h * 4);
  randomFillSync(px);
  for (let y = 0; y < h; y += 1) {
    raw[y * rowLen] = 0; // filter: none
    px.copy(raw, y * rowLen + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Минимальный «JPEG» для серверных проверок: SOI + APP0-заглушка (магия
 *  FF D8 FF) + SOF0 с честными w/h (первый SOF-кадр парсится по BE-полям)
 *  + заполнитель + EOI (хвостовая магия FF D9). */
function buildJpeg(w, h) {
  const sof0 = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, // SOF0, длина сегмента 17
    0x08,                   // точность
    (h >> 8) & 0xff, h & 0xff,
    (w >> 8) & 0xff, w & 0xff,
    0x03,                   // 3 компонента
    0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  const app0len = 16;
  const len = Buffer.alloc(2);
  len.writeUInt16BE(app0len, 0);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]), // SOI + APP0
    len,
    Buffer.alloc(app0len - 2, 0x01),
    sof0,
    Buffer.alloc(120, 0x5a),              // тело до честного веса файла
    Buffer.from([0xff, 0xd9]),            // EOI
  ]);
}

/* ---------- multipart-конструктор и HTTP-хелперы (как #83) ---------- */

function multipart(fields, file) {
  const boundary = `----coopavatar${Math.random().toString(36).slice(2)}`;
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
const httpUpload = async (pathname, { body, contentType, token, origin, rawBody, rawType }) => {
  const headers = { "content-type": String(contentType || rawType || "") };
  if (token) headers.cookie = `coop_session=${token}`;
  if (origin) headers.origin = origin;
  const res = await fetch(`${HTTP}${pathname}`, {
    method: "POST",
    headers,
    body: rawBody === undefined ? body : rawBody,
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, json };
};

/** Резервированный заголовок Host (гейт классов сайта) — сырым http.request. */
function probeWithHost(pathname, { host, token, method = "GET" }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST,
      port: PORT,
      path: pathname,
      method,
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
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

let server = null;
function startServer() {
  server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST,
      DATA_DIR: DATA,
      AUTH_CSRF_STRICT: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(d));
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

try {
  startServer();
  await waitReady();

  /* ---------- сессия владельца ---------- */
  const reg = await httpJson("/auth/register", {
    method: "POST",
    body: { login: MAIN, pass: "password1", name: "Жучка" },
  });
  const token = reg.json?.token;
  const mainId = reg.json?.accountId;
  check(!!token && !!mainId, "регистрация владельца аватарки (+accountId сессии)");

  /* ---------- 1. гейты входа (f + CSRF-контракта #83) ---------- */
  const noSession = await httpUpload("/avatars/mine", {
    ...multipart({}, { filename: "a.png", data: buildPng(64, 64) }),
    origin: ORIGIN,
  });
  check(noSession.status === 401 && noSession.json?.reason === "auth_required",
    "1(f) POST /avatars/mine без сессии → 401 auth_required");
  const noOrigin = await httpUpload("/avatars/mine", {
    ...multipart({}, { filename: "a.png", data: buildPng(64, 64) }),
    token,
  });
  check(noOrigin.status === 403 && noOrigin.json?.reason === "csrf_origin_required",
    "1: upload с cookie без Origin → 403 csrf_origin_required");
  const foreignOrigin = await httpUpload("/avatars/mine", {
    ...multipart({}, { filename: "a.png", data: buildPng(64, 64) }),
    token,
    origin: "https://evil.example",
  });
  check(foreignOrigin.status === 403 && String(foreignOrigin.json?.reason || "").startsWith("csrf"),
    "1: upload с чужим Origin → 403 csrf*");

  /* ---------- 2. негейты формы и 3. магии (e) ---------- */
  const wrongCt = await httpUpload("/avatars/mine", { rawBody: JSON.stringify({}), rawType: "application/json", token, origin: ORIGIN });
  check(wrongCt.status === 400 && wrongCt.json?.reason === "bad_content_type",
    "2: не-multipart → 400 bad_content_type");
  const badMultipart = await httpUpload("/avatars/mine", {
    rawBody: "определённо не мультипарт",
    rawType: "multipart/form-data; boundary=x",
    token,
    origin: ORIGIN,
  });
  check(badMultipart.status === 400 && badMultipart.json?.reason === "bad_multipart",
    "2: битый multipart → 400 bad_multipart");
  const noFile = await httpUpload("/avatars/mine", { ...multipart({ note: "x" }), token, origin: ORIGIN });
  check(noFile.status === 400 && noFile.json?.reason === "no_file",
    "2: multipart без файла → 400 no_file");
  const badMagic = await httpUpload("/avatars/mine", {
    ...multipart({}, { filename: "x.png", data: Buffer.concat([Buffer.from("GIF89a — точно не картинка"), Buffer.alloc(120, 1)]) }),
    token,
    origin: ORIGIN,
  });
  check(badMagic.status === 400 && badMagic.json?.reason === "bad_magic",
    "3(e) мусорный файл без магии → 400 bad_magic");

  /* ---------- 4. габариты обеих веток парсера ---------- */
  const tinyPng = await httpUpload("/avatars/mine", {
    ...multipart({}, { filename: "tiny.png", data: buildPng(32, 32) }),
    token,
    origin: ORIGIN,
  });
  check(tinyPng.status === 400 && tinyPng.json?.reason === "bad_dims",
    "4: PNG 32×32 (сторона < 64) → 400 bad_dims");
  const tinyJpeg = await httpUpload("/avatars/mine", {
    ...multipart({}, { filename: "tiny.jpg", data: buildJpeg(20, 20) }),
    token,
    origin: ORIGIN,
  });
  check(tinyJpeg.status === 400 && tinyJpeg.json?.reason === "bad_dims",
    "4: JPEG SOF 20×20 → 400 bad_dims (JPEG-ветка парсера работает)");

  /* ---------- 5.(a) загрузка PNG ---------- */
  const png64 = buildPng(64, 64);
  const up = await httpUpload("/avatars/mine", {
    ...multipart({}, { filename: "me.png", data: png64 }),
    token,
    origin: ORIGIN,
  });
  const avatarUrl = up.json?.avatar;
  check(
    up.status === 200 && up.json?.ok === true && typeof avatarUrl === "string" &&
      new RegExp(`^/avatars/file/${mainId}\\.png\\?v=\\d+$`).test(avatarUrl),
    `5(a) upload PNG 64×64 → 200 {ok, avatar} с v-параметром (${avatarUrl})`,
  );
  check(existsSync(path.join(DATA, "avatars", `${mainId}.png`)),
    "5: файл лежит в data/avatars под именем-идом аккаунта");
  const storeRow = JSON.parse(readFileSync(path.join(DATA, "accounts.json"), "utf8")).accounts[mainId];
  check(
    storeRow?.profile?.avatarExt === "png" && typeof storeRow.profile.avatarAt === "number" && storeRow.profile.avatarAt > 0,
    "5: стор несёт profile.avatarExt='png' и profile.avatarAt>0",
  );

  /* ---------- 6.(b) публичная отдача файла ---------- */
  const file1 = await fetch(`${HTTP}${avatarUrl}`);
  const fileBody = Buffer.from(await file1.arrayBuffer());
  check(
    file1.status === 200 && fileBody.compare(png64) === 0 &&
      file1.headers.get("content-type") === "image/png",
    "6(b) GET /avatars/file/<id>.png → 200, байты равны отправленным",
  );

  /* ---------- 7.(h) DTO профиля несёт avatar ---------- */
  const meAfterUp = await httpJson("/profiles/me", { token });
  check(meAfterUp.status === 200 && meAfterUp.json?.avatar === avatarUrl,
    "7(h) GET /profiles/me: avatar равен строке из ответа загрузки");
  const cardAfterUp = await httpJson(`/profiles/${mainId}`);
  check(cardAfterUp.status === 200 && cardAfterUp.json?.avatar === avatarUrl,
    "7(h) публичная карточка по id несёт тот же avatar");

  /* ---------- 8.(c) DELETE ---------- */
  const del = await httpJson("/avatars/mine", { method: "DELETE", token, origin: ORIGIN });
  check(del.status === 200 && del.json?.ok === true && del.json?.avatar === null,
    "8(c) DELETE /avatars/mine → 200 {ok:true, avatar:null}");
  const storeAfterDel = JSON.parse(readFileSync(path.join(DATA, "accounts.json"), "utf8")).accounts[mainId];
  check(
    storeAfterDel?.profile?.avatarExt === null && storeAfterDel.profile.avatarAt === 0,
    "8: стор после удаления: avatarExt=null, avatarAt=0",
  );

  /* ---------- 9.(d)+(h) файл и DTO после удаления ---------- */
  const fileGone = await fetch(`${HTTP}${avatarUrl}`);
  check(fileGone.status === 404, "9(d) GET файла после удаления → 404");
  check(!existsSync(path.join(DATA, "avatars", `${mainId}.png`)), "9: файла нет на диске");
  const meAfterDel = await httpJson("/profiles/me", { token });
  check(meAfterDel.status === 200 && meAfterDel.json?.avatar === null,
    "9(h) GET /profiles/me после удаления: avatar null");

  /* ---------- 10.(g) JPEG-магия принимается ---------- */
  const jreg = await httpJson("/auth/register", {
    method: "POST",
    body: { login: JPGER, pass: "password1", name: "Весна" },
  });
  const jtok = jreg.json?.token;
  const jid = jreg.json?.accountId;
  check(!!jtok && !!jid, "регистрация JPEG-аккаунта (свежее rate-окно)");
  const jpegBuf = buildJpeg(64, 64);
  const jup = await httpUpload("/avatars/mine", {
    ...multipart({}, { filename: "me.jpg", data: jpegBuf }),
    token: jtok,
    origin: ORIGIN,
  });
  const jUrl = jup.json?.avatar;
  check(
    jup.status === 200 && jup.json?.ok === true &&
      new RegExp(`^/avatars/file/${jid}\\.jpg\\?v=\\d+$`).test(String(jUrl || "")),
    `10(g) JPEG (SOI+APP0+SOF0+EOI) принимается → avatar «…jpg?v=…» (${jUrl})`,
  );
  const file2 = await fetch(`${HTTP}${jUrl}`);
  const bytes2 = Buffer.from(await file2.arrayBuffer());
  check(
    file2.status === 200 && bytes2.compare(jpegBuf) === 0 &&
      file2.headers.get("content-type") === "image/jpeg",
    "10: GET JPEG-файла → 200 байт-в-байт, content-type image/jpeg",
  );
  const jme = await httpJson("/profiles/me", { token: jtok });
  check(jme.json?.avatar === jUrl, "10: JPEG-avatar в DTO /profiles/me");

  /* ---------- 11.(i) rate: раз в 10 секунд ---------- */
  const rreg = await httpJson("/auth/register", {
    method: "POST",
    body: { login: RATER, pass: "password1", name: "Тачка" },
  });
  const rtok = rreg.json?.token;
  check(!!rtok, "регистрация rate-аккаунта");
  const pngA = buildPng(64, 64);
  const r1 = await httpUpload("/avatars/mine", {
    ...multipart({}, { filename: "r1.png", data: pngA }),
    token: rtok,
    origin: ORIGIN,
  });
  const r2 = await httpUpload("/avatars/mine", {
    ...multipart({}, { filename: "r2.png", data: buildPng(70, 70) }),
    token: rtok,
    origin: ORIGIN,
  });
  check(
    r1.status === 200 && r2.status === 429 && r2.json?.reason === "rate",
    `11(i) две загрузки подряд: первая 200, вторая 429 rate (${r1.status}/${r2.status})`,
  );

  /* ---------- 12. host-гейт: гроты не знают /avatars/mine, файл публичен ---------- */
  const grottoMine = await probeWithHost("/avatars/mine", { host: "abnocw.phainonsmilk.ru", token: rtok });
  check(grottoMine.status === 404 && grottoMine.json?.reason === "not_found",
    "12: GET /avatars/mine на Host-классе public (гроты) → 404 not_found");
  const grottoFile = await probeWithHost(jUrl.split("?")[0], { host: "abnocw.phainonsmilk.ru" });
  check(grottoFile.status === 200,
    "12: публичный GET /avatars/file/<id>.jpg на гротто-хосте → 200 (файл обоим сайтам)");

  /* ---------- 13. мусорные ид/расширения файлового маршрута ---------- */
  const badId = await httpJson("/avatars/file/$neakier.png");
  check(badId.status === 404 && badId.json?.reason === "not_found",
    "13: мусорный ид файла → 404 (набор [A-Za-z0-9_-])");
  const badExt = await httpJson(`/avatars/file/${mainId}.gif`);
  check(badExt.status === 404, "13: не-png/jpg расширение → 404");
  const noSuchFile = await httpJson("/avatars/file/a00000000000000000000000000bee.png");
  check(noSuchFile.status === 404, "13: несуществующий файл → 404");
  const postToFile = await httpJson("/avatars/file/a00000000000000000000000000bee.png", {
    method: "POST",
    token,
    origin: ORIGIN,
    body: {},
  });
  check(postToFile.status === 405, "13: POST на файловый префикс → 405 method_not_allowed");

  await stopServer();
} catch (e) {
  failures += 1;
  console.log("FAIL  исключение теста:", e.message);
  await stopServer();
} finally {
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* уже нет */ }
}

if (failures) {
  console.log(`avatars: ${failures} FAIL`);
  process.exit(1);
}
console.log("avatars: OK");
