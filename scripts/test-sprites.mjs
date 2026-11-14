#!/usr/bin/env node
import { createHash } from "node:crypto";
/**
 * Живой тест менеджера спрайтов (server/sprites.js, /sprites/* + /admin/sprites*).
 * Песочница как у test-admin-reset.mjs: mkdtemp-DATA_DIR (записей в data репо
 * нет), свободный порт, спавн server.js, AUTH_CSRF_STRICT=1 (отрицание
 * «unsafe без Origin» без второго стенда), лестница S1 для админа.
 *
 * Позитив:
 *   1. при старте каталог сеидится: публичный GET /sprites/catalog без сессии
 *      отдаёт 34 базовых (config.SPRITES), все category «Базовые»;
 *   2. admin-список — те же 34 строкой c builtin:true, addedAt:0, wornBy:[],
 *      имена из словаря владельца (puhlyashik — «Пухляшик», ryzhiy — «Сырь»);
 *   3. upload валидного PNG (мини 1×1) с именем «Тестовый Кот» и категорией
 *      «Праздничные» → id testovyy-kot, файл в DATA_DIR/sprites/, строка
 *      в публичном каталоге (33), файл отдаётся GET /sprites/file/<id>.png;
 *   4. повторное имя → суффикс id testovyy-kot-2;
 *   5. PATCH переименовывает/меняет категорию (манифест то же отражает);
 *   6. WS-путь: аккаунтный join c sprite=<загруженный id> проживает attachSprite
 *      (accounts.spriteIdAllowed) И pickSprite (config.SPRITES-зеркало) — кадр
 *      you приходит с новым скином, admin-список видит владельца;
 *   7. DELETE свободного: 200, из каталогов исчезает, PNG с диска удалён,
 *      повторный GET файла — 404, id больше НЕ валиден для setSprite.
 *
 * Негатив:
 *   - GET /admin/sprites без сессии → 401 auth_required;
 *   - GET /admin/sprites не-админом → 403 forbidden;
 *   - POST upload с cookie, но без Origin → 403 csrf_origin_required;
 *   - upload не-PNG (подпись не совпала) → 400 invalid_png;
 *   - upload >3 МБ → 413 too_large;
 *   - upload без файла / пустое имя / пустая категория → 400;
 *   - PATCH с лишним полем → 400 unexpected_fields; PATCH пустой → 400 empty_patch;
 *   - DELETE builtin → 400 builtin_immutable;
 *   - DELETE одетого → 400 in_use с wornBy (логин владельца в ответе);
 *   - GET /sprites/file/<builtin id>.png → 404 (builtin отдаёт статика деплоя,
 *     из файлового API — никогда);
 *   - /sprites/file/<неизвестный id>.png → 404.
 *
 * Освобождение занятого скина: PATCH /profiles/me {sprite} переодевает
 * персонажа. Повторный join со старым id окрас не снимает — надетый спрайт
 * профиля важнее payload. После PATCH DELETE проходит.
 *
 * Запуск: node scripts/test-sprites.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { SPRITES as BASE_SPRITE_IDS } from "../server/config.js";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-sprites-"));
const PORT = 4360 + Math.floor(Math.random() * 60);
const HOST = "127.0.0.1";
const HTTP = `http://${HOST}:${PORT}`;
const WS = `ws://${HOST}:${PORT}`;
const ORIGIN = `http://${HOST}:${PORT}`; // цикличный origin: классу local разрешён
// qa-логины приведены к строгому формату создания (register v2, мандат 2026-11-08:
// кириллица в логине регистрации больше не проходит; видимые имена остаются
// кириллическими через поле name персонажа, регистрируемого тестом).
const ADMIN = "lastochka_q";
const USER = "kopeechka_q";
/** Базовых в сида: сколько id в config.SPRITES (34 — источник истины счёта). */
const BASE_COUNT = BASE_SPRITE_IDS.length;
const originalTest1 = readFileSync(path.join(ROOT, 'public/sprites/test1.png'));
if (createHash('sha256').update(originalTest1).digest('hex') !== '19b074917c3fcb1bdba606ffe0a61b73fa2add2bdace5a5a1a427d0bf95926d7') {
  throw new Error('test1 must retain the supplied original PNG bytes and thin outline');
}

for(const [file,hash] of [
  ['test1-png.png','d80317349686449d4e8be899aea5225e311331d08c91a247844c865ff67a2672'],
  ['test1-walk.gif','e0945a10b755f13b7b02c94148f6b18e0d0a7e14328dd407fa15a58d23ba45b3'],
]) {
  if(createHash('sha256').update(readFileSync(path.join(ROOT,'public/sprites',file))).digest('hex')!==hash)throw new Error(`${file}: original asset bytes changed`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "OK  " : "FAIL"}  ${label}`);
  if (!cond) failures += 1;
};

/** Мини-валидный PNG 1×1 (полная подпись+чанки IHDR/IDAT/IEND). */
const MINI_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

/** Конструирование multipart/form-data вручную (fetch сам границу не ставит
 *  для Buffer-тела — собираем как браузер: --boundary, поля, файл, --). */
function multipart(fields, file) {
  const boundary = `----coopspritetest${Math.random().toString(36).slice(2)}`;
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

/** HTTP-хелперы: JSON-запрос (apiZone) и сырой upload по типу контента. */
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

/** WS-аккаунтный join в «тест» c заданным спрайтом: register-танец sendJoin,
 *  но join несёт sprite/size — проживает attachSprite (validAccounts) и
 *  pickSprite (room-зеркало config.SPRITES). */
function wsJoinWithSprite(login, sprite) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS);
    ws.inbox = [];
    ws.on("message", (raw) => ws.inbox.push(JSON.parse(String(raw))));
    ws.on("error", reject);
    ws.once("open", () => {
      let joined = false;
      const onMsg = (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg[0] !== "whoami") return;
        if (msg[1]?.accountId && !joined) {
          joined = true;
          ws.off("message", onMsg);
          ws.send(JSON.stringify(["join", { room: "test", login, sprite, size: 90 }]));
        } else if (msg[1]?.reason === "taken") {
          ws.send(JSON.stringify(["auth", { action: "login", login, pass: "password1" }]));
        }
      };
      ws.on("message", onMsg);
      ws.send(JSON.stringify(["auth", { action: "register", login, pass: "password1" }]));
      resolve(ws);
    });
  });
}
const waitFor = (ws, pred, ms = 5000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ws.inbox.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout; inbox=${JSON.stringify(ws.inbox.slice(-8))}`));
      setTimeout(tick, 15);
    };
    tick();
  });

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
const adminList = async (token) => httpJson("/admin/sprites", { token });

try {
  startServer();
  await waitReady();

  /* ---------- лестница S1: админ, обычный пользователь ---------- */

  const userReg = await httpJson("/auth/register", { method: "POST", body: { login: USER, pass: "password1" } });
  const userTok = userReg.json?.token;
  check(!!userTok, "регистрация не-админа");
  const adminReg = await httpJson("/auth/register", { method: "POST", body: { login: ADMIN, pass: "password1" } });
  check(!!adminReg.json?.token, "регистрация будущего админа");
  await stopServer();
  const cliOut = execFileSync(process.execPath, [path.join(ROOT, "scripts", "make-admin.mjs"), ADMIN], {
    env: { ...process.env, DATA_DIR: DATA },
    encoding: "utf8",
  });
  check(/повышен|уже админ/.test(cliOut), "make-admin повышает аккаунт (лестница S1)");
  const manifestFile = path.join(DATA, "sprites", "manifest.json");
  const seeded = JSON.parse(readFileSync(manifestFile, "utf8"));
  seeded.push({id:"origami-cat",name:"Снятая модель",category:"Базовые",builtin:true,addedAt:0});
  writeFileSync(manifestFile, JSON.stringify(seeded.filter(row => row.id !== "test1")));
  const accountsFile = path.join(DATA, "accounts.json");
  const accounts = JSON.parse(readFileSync(accountsFile, "utf8"));
  const retiredAccount = Object.values(accounts.accounts).find((acc) => acc.login === USER);
  retiredAccount.characters[0].sprite = "origami-cat";
  writeFileSync(accountsFile, JSON.stringify(accounts));

  startServer();
  await waitReady();
  const adminLogin = await httpJson("/auth/login", { method: "POST", body: { login: ADMIN, pass: "password1" } });
  const adminTok = adminLogin.json?.token;
  check(!!adminTok, "вход админа");

  /* ---------- сид каталога при старте ---------- */

  const cat0 = await pubCatalog();
  check(cat0.status === 200 && cat0.json?.ok === true, "публичный GET /sprites/catalog доступен без сессии");
  const items0 = cat0.json?.items || [];
  check(items0.some(row => row.id === "test1" && row.name === "test1" && row.src === "/sprites/test1.png?v=original-300x200"),
    "новая builtin test1 добавляется в каталог из старого манифеста");
  check(items0.some(row=>row.id==='test1-png'&&row.src==='/sprites/test1-png.png'), 'PNG 600px comparison variant is selectable');
  check(!items0.some((row) => row.id === "origami-cat"), "снятый builtin не воскресает из манифеста");
  const relogin = await httpJson("/auth/login", {method:"POST",body:{login:USER,pass:"password1"}});
  const me = await httpJson("/auth/me", {token:relogin.json?.token});
  check(me.json?.character?.sprite === BASE_SPRITE_IDS[0], "снятый скин игрока получает рабочий fallback");
  const card = await httpJson(`/profiles/${retiredAccount.id}`);
  check(card.json?.characters?.[0]?.sprite === BASE_SPRITE_IDS[0], "публичный профиль не ссылается на снятую модель");

  check(Array.isArray(items0) && items0.length === BASE_COUNT,
    `сид каталога: ${items0.length} = ${BASE_COUNT} базовых (config.SPRITES)`);
  check(items0.every((r) => r.category === "Базовые" && /^[a-z0-9-]{1,64}$/.test(r.id)),
    "все сид-строки: категория «Базовые», id — slug");
  const dictProbe = items0.find((r) => r.id === "puhlyashik");
  const dictProbe2 = items0.find((r) => r.id === "ryzhiy");
  check(dictProbe?.name === "Пухляшик" && dictProbe2?.name === "Сырь",
    `имена из словаря владельца (puhlyashik→«Пухляшик», ryzhiy→«Сырь»): ${dictProbe?.name}/${dictProbe2?.name}`);

  /* ---------- гейты админ-списка ---------- */

  const anonList = await httpJson("/admin/sprites");
  check(anonList.status === 401 && anonList.json?.reason === "auth_required",
    "GET /admin/sprites без сессии → 401 auth_required");
  const userList = await adminList(userTok);
  check(userList.status === 403 && userList.json?.reason === "forbidden",
    "GET /admin/sprites не-админом → 403 forbidden");

  const adm0 = await adminList(adminTok);
  const adminItems0 = adm0.json?.items || [];
  check(adm0.status === 200 && adminItems0.length === BASE_COUNT &&
    adminItems0.every((r) => r.builtin === true && Number(r.addedAt) === 0 && Array.isArray(r.wornBy)),
    `admin-список: ${BASE_COUNT} базовых, builtin:true, addedAt:0, wornBy:[]`);

  /* ---------- upload: валидный PNG ---------- */

  const noOrigin = await httpUpload("/admin/sprites", {
    ...multipart({ name: "Тень", category: "Ночные" }, { filename: "a.png", data: MINI_PNG }),
    token: adminTok,
  });
  check(noOrigin.status === 403 && noOrigin.json?.reason === "csrf_origin_required",
    "upload без Origin (CSRF-щит apiZone) → 403 csrf_origin_required");

  const up = await httpUpload("/admin/sprites", {
    ...multipart({ name: "Тестовый Кот", category: "Праздничные" }, { filename: "cat.png", data: MINI_PNG }),
    token: adminTok,
    origin: ORIGIN,
  });
  const uploaded = up.json?.item;
  check(up.status === 200 && up.json?.ok === true && uploaded?.id === "testovyy-kot",
    `upload валидного PNG → id транслит-слаг «testovyy-kot»: ${JSON.stringify(uploaded)}`);
  check(uploaded?.builtin === false && uploaded?.src === "/sprites/file/testovyy-kot.png",
    "uploaded: builtin:false, src = /sprites/file/<id>.png");
  const pngOnDisk = path.join(DATA, "sprites", "testovyy-kot.png");
  check(existsSync(pngOnDisk) && MINI_PNG.compare(readFileSync(pngOnDisk)) === 0,
    "PNG лежит в DATA_DIR/sprites/<id>.png байт-в-байт");
  check(JSON.parse(readFileSync(path.join(DATA, "sprites", "manifest.json"), "utf8"))
    .some((r) => r.id === "testovyy-kot" && r.category === "Праздничные" && r.builtin === false),
    "манифест несёт новую строку {id, name, category, builtin:false, addedAt}");

  await stopServer();
  startServer();
  await waitReady();
  const cat1 = await pubCatalog();
  const newPublic = (cat1.json?.items || []).find((r) => r.id === "testovyy-kot");
  check((cat1.json?.items || []).length === BASE_COUNT + 1 &&
    newPublic?.name === "Тестовый Кот" && newPublic?.category === "Праздничные",
    "публичный каталог подхватил новый спрайт с именем и категорией");

  const file1 = await fetch(`${HTTP}/sprites/file/testovyy-kot.png`);
  const fileBody = Buffer.from(await file1.arrayBuffer());
  check(file1.status === 200 && file1.headers.get("content-type") === "image/png" &&
    MINI_PNG.compare(fileBody) === 0,
    "GET /sprites/file/testovyy-kot.png → 200 image/png, байты совпали");

  const fileBuiltin = await httpJson("/sprites/file/puhlyashik.png");
  check(fileBuiltin.status === 404,
    "GET /sprites/file/<builtin id>.png → 404 (builtin — только статика деплоя)");
  const fileGhost = await httpJson("/sprites/file/net-takogo.png");
  check(fileGhost.status === 404, "GET /sprites/file/<неизвестный id>.png → 404");

  /* ---------- upload: нетлинги и лимиты ---------- */

  const badMagic = await httpUpload("/admin/sprites", {
    ...multipart({ name: "Подделка", category: "Ночные" }, { filename: "x.png", data: Buffer.from("GIF89a — точно не PNG") }),
    token: adminTok,
    origin: ORIGIN,
  });
  check(badMagic.status === 400 && badMagic.json?.reason === "invalid_png",
    "upload не-PNG (подпись не совпала) → 400 invalid_png");

  const big = Buffer.concat([MINI_PNG, Buffer.alloc(3 * 1024 * 1024 + 16, 7)]);
  const tooBig = await httpUpload("/admin/sprites", {
    ...multipart({ name: "Гигант", category: "Ночные" }, { filename: "big.png", data: big }),
    token: adminTok,
    origin: ORIGIN,
  });
  check(tooBig.status === 413 && tooBig.json?.reason === "too_large",
    "upload >3 МБ → 413 too_large");

  const noFile = await httpUpload("/admin/sprites", {
    ...multipart({ name: "Без файла", category: "Ночные" }),
    token: adminTok,
    origin: ORIGIN,
  });
  check(noFile.status === 400 && noFile.json?.reason === "no_file", "upload без файла → 400 no_file");
  const badName = await httpUpload("/admin/sprites", {
    ...multipart({ name: "Ы", category: "Ночные" }, { filename: "y.png", data: MINI_PNG }),
    token: adminTok,
    origin: ORIGIN,
  });
  check(badName.status === 400 && badName.json?.reason === "invalid_name", "upload имя 1 символ → 400 invalid_name");
  const badCat = await httpUpload("/admin/sprites", {
    ...multipart({ name: "Без категории", category: "   " }, { filename: "y.png", data: MINI_PNG }),
    token: adminTok,
    origin: ORIGIN,
  });
  check(badCat.status === 400 && badCat.json?.reason === "invalid_category", "upload пустая категория → 400 invalid_category");

  /* ---------- коллизия имени → суффикс id ---------- */

  const dup = await httpUpload("/admin/sprites", {
    ...multipart({ name: "Тестовый Кот", category: "Праздничные" }, { filename: "cat2.png", data: MINI_PNG }),
    token: adminTok,
    origin: ORIGIN,
  });
  check(dup.status === 200 && dup.json?.item?.id === "testovyy-kot-2",
    "повторное имя → суффикс id -2 (testovyy-kot-2)");

  /* ---------- PATCH: переименование и категория ---------- */

  const patch = await httpJson("/admin/sprites/testovyy-kot", {
    method: "PATCH",
    body: { name: "Снежок", category: "Зимние" },
    token: adminTok,
    origin: ORIGIN,
  });
  check(patch.status === 200 && patch.json?.item?.name === "Снежок" && patch.json?.item?.category === "Зимние",
    "PATCH переименовывает и меняет категорию (id НЕ меняется)");
  const patchExtra = await httpJson("/admin/sprites/testovyy-kot", {
    method: "PATCH",
    body: { name: "Х", force: true },
    token: adminTok,
    origin: ORIGIN,
  });
  check(patchExtra.status === 400 && patchExtra.json?.reason === "unexpected_fields",
    "PATCH с лишним полем → 400 unexpected_fields");
  const patchEmpty = await httpJson("/admin/sprites/testovyy-kot", {
    method: "PATCH",
    body: {},
    token: adminTok,
    origin: ORIGIN,
  });
  check(patchEmpty.status === 400 && patchEmpty.json?.reason === "empty_patch",
    "PATCH без name и category → 400 empty_patch");

  /* ---------- DELETE: builtin всегда отказ ---------- */

  const delBuiltin = await httpJson("/admin/sprites/puhlyashik", {
    method: "DELETE",
    token: adminTok,
    origin: ORIGIN,
  });
  check(delBuiltin.status === 400 && delBuiltin.json?.reason === "builtin_immutable",
    "DELETE builtin → 400 builtin_immutable (это деплойная статика)");

  /* ---------- носители: WS join со спрайтом через attachSprite ---------- */

  const ws = await wsJoinWithSprite("snezhinka_q", "testovyy-kot");
  const you = await waitFor(ws, ([ev]) => ev === "you");
  check(you[1]?.sprite === "testovyy-kot",
    `WS join со спрайтом testovyy-kot: кадр you с этим скином (pickSprite принял)`);
  await sleep(150);
  const wornList = await adminList(adminTok);
  const wornRow = (wornList.json?.items || []).find((r) => r.id === "testovyy-kot");
  check(wornRow?.wornCount === 1 && wornRow.wornBy.some((w) => w.login === "snezhinka_q"),
    "admin-список видит владельца: wornBy содержит логин аккаунта (attachSprite прошёл)");

  const delWorn = await httpJson("/admin/sprites/testovyy-kot", {
    method: "DELETE",
    token: adminTok,
    origin: ORIGIN,
  });
  check(delWorn.status === 400 && delWorn.json?.reason === "in_use" &&
    Array.isArray(delWorn.json?.wornBy) && delWorn.json.wornBy.some((w) => w.login === "snezhinka_q"),
    "DELETE одетого → 400 in_use, wornBy с логином владельца в ответе");
  check(typeof delWorn.json?.message === "string" && delWorn.json.message.includes("snezhinka_q"),
    "отказ «одет» несёт человекочитаемое message с ником");

  /* Освобождение: профиль переодевает. Повторный join со старым id не
   * затирает надетый окрас (иначе карусель входа снимала личный PNG). */
  ws.close();
  await sleep(300);
  const relog = await httpJson("/auth/login", { method: "POST", body: { login: "snezhinka_q", pass: "password1" } });
  const unworn = await httpJson("/profiles/me", {
    method: "PATCH",
    body: { sprite: "chis" },
    token: relog.json?.token,
    origin: ORIGIN,
  });
  check(unworn.status === 200 && unworn.json?.ok === true, "переодеть через профиль, не повторным join");
  const ws2 = await wsJoinWithSprite("snezhinka_q", "testovyy-kot");
  const you2 = await waitFor(ws2, ([ev]) => ev === "you");
  check(you2[1]?.sprite === "chis", "повторный join со старым id не снимает окрас профиля");
  ws2.close();
  await sleep(300);

  const del2 = await httpJson("/admin/sprites/testovyy-kot", {
    method: "DELETE",
    token: adminTok,
    origin: ORIGIN,
  });
  check(del2.status === 200 && del2.json?.ok === true && del2.json?.id === "testovyy-kot",
    "DELETE освободившегося → 200 ok, id подтверждён");
  check(!existsSync(pngOnDisk), "PNG удалён с диска вместе со строкой");
  const cat2 = await pubCatalog();
  check(!(cat2.json?.items || []).some((r) => r.id === "testovyy-kot"),
    "публичный каталог больше не содержит удалённый id");
  const fileGone = await httpJson("/sprites/file/testovyy-kot.png");
  check(fileGone.status === 404, "файл удалённого спрайта больше не отдаётся (404)");

  /* Зеркало whitelist: удалённый id НЕ валиден для setSprite — молча игнор. */
  const ws3 = await wsJoinWithSprite("snezhinka_q", "chis");
  const you3 = await waitFor(ws3, ([ev]) => ev === "you");
  ws3.send(JSON.stringify(["sprite", { sprite: "testovyy-kot" }]));
  await sleep(250);
  check(!(ws3.inbox || []).some(([ev, p]) => ev === "update cat" && p?.sprite === "testovyy-kot"),
    "setSprite с удалённым id молча отброшен (зеркало config.SPRITES синхронно сузилось)");
  ws3.close();

  /* ---------- уборка второго загруженного: живой цикл закрыт ---------- */

  const del3 = await httpJson("/admin/sprites/testovyy-kot-2", {
    method: "DELETE",
    token: adminTok,
    origin: ORIGIN,
  });
  check(del3.status === 200, "второй загруженный (суффикс -2) тоже удаляется");
  const catFinal = await pubCatalog();
  check((catFinal.json?.items || []).length === BASE_COUNT,
    `каталог вернулся к ${BASE_COUNT} базовым — тестовая песочница чиста`);

  await stopServer();
} catch (e) {
  failures += 1;
  console.log("FAIL  исключение теста:", e.message);
  await stopServer();
} finally {
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* уже нет */ }
}

if (failures) {
  console.log(`sprites: ${failures} FAIL`);
  process.exit(1);
}
console.log("sprites: OK");
