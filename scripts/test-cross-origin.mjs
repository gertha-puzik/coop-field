#!/usr/bin/env node
/**
 * B1: КРОСС-ДОМЕННАЯ ИЗОЛЯЦИЯ — живые пробы против sandbox-сервера (matrix ≥ 20).
 *
 * Модель воспроизводит превью-топологию: один сервер, оба класса хостов
 * (public=гроты, elyria=Элизия), ОДИН общий ALLOWED_ORIGINS с обоими сайтами
 * прошлой волны. Политика после B1 — ПАРА (Origin, класс destination):
 *
 *  A. CORS:   GET /auth/me и /profiles/me на elyria-хосте с Origin гротов
 *             НЕ получают Access-Control-Allow-Origin — браузер чужого сайта
 *             не прочтёт credentialed-ответ (a, a2); свой origin — работает (e).
 *  B. CSRF:   unsafe+cookie на public/elyria: пустой Origin → 403
 *             csrf_origin_required (d), чужой Origin (в т.ч. сиблинг-класс
 *             превью из общего env-списка) → 403 csrf_origin_mismatch (b, c);
 *             свой origin + cookie — работает (e1-e3).
 *  C. WS:     upgrade с чужим origin/классом — отказ (g1, g6); свой origin —
 *             соединение живо и register работает (g2); гость без Origin
 *             играет как раньше (g3, j1); register/login кадрами без Origin
 *             на public/elyria — отказ (g4).
 *  D. Прокси-метка класса: AUTH_TRUST_PROXY_HEADER применяется только с
 *             loopback-сокета (h1, h2, h-local), заголовок с non-loopback
 *             адреса игнорируется (h3); unknown-значение → Host-класс (h2).
 *  E. Cookie: host-only (без Domain), HttpOnly, SameSite=Lax, Secure на https (i1, i2).
 *  F. env-контроль: AUTH_CSRF_STRICT=0 возвращает легаси-щит на elyria (30-31),
 *             =1 форсирует strict даже на local (32-33).
 *
 * Запуск: node scripts/test-cross-origin.mjs (спавнит server.js в песочницах
 * DATA_DIR, порты 4270-4530,_SERVICE-изолировано от других тестов).
 */
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir, networkInterfaces } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = new URL("..", import.meta.url).pathname;
const LOOP = "127.0.0.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
let passed = 0;
const check = (cond, label) => {
  passed += 1;
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};

/** HTTP-проба с ЯВНЫМ Host/Origin/cookie/x-coop-site (node:http не правит их). */
function probe(port, { method = "GET", path = "/", host, origin, cookie, site, proto, xff, body, target }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { host: host || `${target || LOOP}:${port}` };
    if (payload) headers["content-type"] = "application/json";
    if (origin) headers.origin = origin;
    if (cookie) headers.cookie = cookie;
    if (site) headers["x-coop-site"] = site;
    if (proto) headers["x-forwarded-proto"] = proto;
    if (xff) headers["x-forwarded-for"] = xff;
    const req = http.request(
      { host: target || LOOP, port, method, path, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try { json = JSON.parse(text); } catch {}
          resolve({
            status: res.statusCode,
            acao: res.headers["access-control-allow-origin"] || null,
            acac: res.headers["access-control-allow-credentials"] || null,
            vary: res.headers.vary || null,
            setCookie: res.headers["set-cookie"] || [],
            json,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Ждём, пока сервер ответит на /health (спавн-прогрев). */
async function waitReady(port, target = LOOP) {
  for (let i = 0; i < 100; i += 1) {
    const ok = await new Promise((resolve) => {
      const req = http.request({ host: target, port, path: "/health", method: "GET" }, (r) => {
        r.resume();
        resolve(r.statusCode === 200);
      });
      req.on("error", () => resolve(false));
      req.end();
    });
    if (ok) return true;
    await sleep(80);
  }
  throw new Error(`server not ready on ${target}:${port}`);
}

function spawnServer(port, host, env) {
  const data = mkdtempSync(path.join(tmpdir(), "coop-cross-"));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: host, DATA_DIR: data, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(d));
  return { child, data };
}

const cookieOf = (res) =>
  `coop_session=${(String((res.setCookie || [])[0] || "").match(/coop_session=([0-9a-f]+)/) || [])[1] || ""}`;

/** WS-клиент с произвольными заголовками; resolve: {open, ws, err}. */
function wsClient(port, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${LOOP}:${port}`, { headers: headers || {} });
    const inbox = [];
    ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
    let settled = false;
    ws.once("open", () => { if (!settled) { settled = true; resolve({ open: true, ws, inbox }); } });
    ws.once("error", (e) => { if (!settled) { settled = true; resolve({ open: false, ws, inbox, err: e.message }); } });
    ws.inbox = inbox;
  });
}

const waitFor = (ws, pred, ms = 5000) =>
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

/* ════════════════ Sandbox A: превью-топология ( основной matrix ) ════════════════ */
const PORT_A = 4270 + Math.floor(Math.random() * 60);
const sandboxA = spawnServer(PORT_A, LOOP, {
  PUBLIC_HOSTS: "grot.example,pr-49.abnocw.phainonsmilk.ru",
  ELYRIA_HOSTS: "ely.example,pr-49.elysiae.phainonsmilk.ru",
  // «один общий список с обоими сайтами» — как пишут preview-скрипты.
  ALLOWED_ORIGINS:
    "https://grot.example,https://ely.example,https://pr-49.abnocw.phainonsmilk.ru,https://pr-49.elysiae.phainonsmilk.ru",
});

try {
  await waitReady(PORT_A);
  const ELY = "ely.example";
  const GROT = "grot.example";
  const originEly = "https://ely.example";
  const originGrot = "https://grot.example";

  // Жертва: регистрация на elyria-хосте originless-скриптом (легаси, без cookie
  // — старое поведение сохранено), кука сессии — материал для проб ниже.
  const reg = await probe(PORT_A, { method: "POST", path: "/auth/register", host: ELY,
    body: { login: "Victim", pass: "password1" } });
  check(reg.status === 200 && !!cookieOf(reg), "setup: originless-регистрация на elyria жива (без Origin и без cookie)");

  const cookieV = cookieOf(reg);

  // (a) Кросс-сайт ЧТЕНИЕ: грот-origin с кукой жертвы на elyria-хосте.
  // Ответ сервер придёт, но без ACAO — браузер страницы гротов его не прочтёт.
  const a = await probe(PORT_A, { method: "GET", path: "/auth/me", host: ELY, origin: originGrot, cookie: cookieV });
  check(
    a.status === 200 && a.json?.ok === true && a.json?.login === "Victim" && a.acao === null && a.acac === null,
    "(a) GET /auth/me elyria+Origin гротов+cookie: 200, но БЕЗ ACAO — credentialed-ответ нечитаем чужим сайтом",
  );
  const a2 = await probe(PORT_A, { method: "GET", path: "/profiles/me", host: ELY, origin: originGrot, cookie: cookieV });
  check(
    a2.status === 200 && a2.acao === null && a2.acac === null,
    "(a2) GET /profiles/me elyria+Origin гротов+cookie: 200, но БЕЗ ACAO (зона profiles под тем же надзором)",
  );

  // (b)/(c) Кросс-сайт ЗАПИСЬ: unsafe+cookie с чужим Origin → 403 mismatch.
  const b = await probe(PORT_A, { method: "POST", path: "/auth/logout", host: ELY, origin: originGrot, cookie: cookieV });
  check(
    b.status === 403 && b.json?.reason === "csrf_origin_mismatch",
    "(b) POST /auth/logout elyria+cookie+Origin гротов → 403 csrf_origin_mismatch",
  );
  const c2 = await probe(PORT_A, { method: "POST", path: "/auth/login", host: "pr-49.elysiae.phainonsmilk.ru",
    origin: "https://pr-49.abnocw.phainonsmilk.ru", cookie: cookieV,
    body: { login: "Victim", pass: "password1" } });
  check(
    c2.status === 403 && c2.json?.reason === "csrf_origin_mismatch",
    "(c2) POST /auth/login с Origin сиблинг-класса pr-49.abnocw (из общего env-списка!) на elisium → 403",
  );
  const c1 = await probe(PORT_A, { method: "PATCH", path: "/profiles/me", host: "pr-49.elysiae.phainonsmilk.ru",
    origin: "https://pr-48.elysiae.phainonsmilk.ru", cookie: cookieV, body: { displayName: "Hacked" } });
  check(
    c1.status === 403 && c1.json?.reason === "csrf_origin_mismatch",
    "(c1) PATCH /profiles/me с Origin чужого превью pr-48.elisium на pr-49.elisium → 403",
  );
  // Уже добавленный профиль не должен был измениться.
  const c1Verify = await probe(PORT_A, { method: "GET", path: "/profiles/me", host: "pr-49.elysiae.phainonsmilk.ru",
    origin: "https://pr-49.elysiae.phainonsmilk.ru", cookie: cookieV });
  check(
    c1Verify.status === 200 && c1Verify.json?.displayName !== "Hacked",
    "(c1b) профиль жертвы НЕ изменён после отказа 403 (запись не дошла)",
  );

  // Regression: a host approved by the shared policy need not be duplicated
  // in ALLOWED_ORIGINS. The old profile handler rejected it as plain `csrf`.
  const skinOrigin = "https://phainonsmilk.ru";
  const skinSave = await probe(PORT_A, { method: "PATCH", path: "/profiles/me",
    host: "phainonsmilk.ru", origin: skinOrigin, cookie: cookieV,
    body: { sprite: "puhlyashik", scale: 90 } });
  check(skinSave.status === 200 && skinSave.json?.ok === true,
    "profile skin: trusted same-site origin absent from ALLOWED_ORIGINS saves successfully");
  const skinResave = await probe(PORT_A, { method: "PATCH", path: "/profiles/me",
    host: "phainonsmilk.ru", origin: skinOrigin, cookie: cookieV,
    body: { sprite: "puzatik", scale: 95 } });
  check(skinResave.status === 200 && skinResave.json?.ok === true,
    "profile skin: a second save can replace the selected skin");
  const skinRead = await probe(PORT_A, { path: "/profiles/me", host: "phainonsmilk.ru",
    origin: skinOrigin, cookie: cookieV });
  check(skinRead.json?.characters?.some(c => c.id === skinRead.json.activeCharacterId && c.sprite === "puzatik" && c.size === 95),
    "profile skin: fresh GET preserves the replacement skin and scale");

  // (d) FAIL-CLOSED: unsafe+cookie БЕЗ Origin → 403 csrf_origin_required.
  const d = await probe(PORT_A, { method: "POST", path: "/auth/logout", host: ELY, cookie: cookieV });
  check(
    d.status === 403 && d.json?.reason === "csrf_origin_required",
    "(d) POST /auth/logout elyria+cookie БЕЗ Origin → 403 csrf_origin_required (empty-Origin больше не принят)",
  );
  const d2 = await probe(PORT_A, { method: "POST", path: "/cfg", host: ELY, cookie: cookieV, body: {} });
  check(
    d2.status === 403 && d2.json?.reason === "csrf_origin_required",
    "(d2) POST /cfg elyria+cookie БЕЗ Origin → 403 csrf_origin_required (cfg-зона)",
  );

  // (e) СВОЙ origin не ломает легитимные ходы сайта.
  const e1 = await probe(PORT_A, { method: "POST", path: "/auth/login", host: ELY, origin: originEly,
    body: { login: "Victim", pass: "password1" } });
  check(e1.status === 200 && e1.json?.ok === true, "(e1) POST /auth/login с правильным elyria-origin → 200 (не 403)");
  const e2 = await probe(PORT_A, { method: "PATCH", path: "/profiles/me", host: ELY, origin: originEly,
    cookie: cookieV, body: { displayName: "NewName" } });
  check(
    e2.status === 200 && e2.json?.displayName === "NewName",
    "(e2) PATCH /profiles/me с правильным elyria-origin+cookie → 200 (правка работает)",
  );
  const regBye = await probe(PORT_A, { method: "POST", path: "/auth/register", host: ELY,
    body: { login: "ByeCat", pass: "password1" } });
  const e3 = await probe(PORT_A, { method: "POST", path: "/auth/logout", host: ELY, origin: originEly,
    cookie: cookieOf(regBye) });
  check(e3.status === 200 && e3.json?.ok === true && e3.json?.role === "guest",
    "(e3) POST /auth/logout с правильным origin+cookie → 200 (свой сайт работает)");

  // (f) Префлайты — та же пара (Origin, класс destination).
  const f1 = await probe(PORT_A, { method: "OPTIONS", path: "/auth/me", host: ELY, origin: originEly });
  check(
    f1.status === 204 && f1.acao === originEly && f1.acac === "true" && /origin/i.test(f1.vary || ""),
    "(f1) OPTIONS /auth/me свой origin: точный ACAO (не wildcard!) + Allow-Credentials + Vary: Origin",
  );
  const f2 = await probe(PORT_A, { method: "OPTIONS", path: "/auth/me", host: ELY,
    origin: "https://random.example" });
  check(
    f2.status === 204 && f2.acao === null && f2.acac === null,
    "(f2) OPTIONS /auth/me произвольный Origin: без ACAO (произвольный origin не отражается)",
  );
  const f3 = await probe(PORT_A, { method: "OPTIONS", path: "/cfg", host: ELY, origin: originGrot });
  check(
    f3.status === 204 && f3.acao === null,
    "(f3) OPTIONS /cfg с Origin гротов на elyria-destination: префлайту отказано (нет ACAO)",
  );
  const f4 = await probe(PORT_A, { method: "OPTIONS", path: "/profiles", host: ELY, origin: originEly });
  check(
    f4.status === 204 && f4.acao === originEly && f4.acac === "true",
    "(f4) OPTIONS /profiles свой origin: ACAO выдан (префлайт валидируется per-destination)",
  );

  // (l) Positive control: свой origin на СВОЁМ классе — гроты читают свой же /cfg.
  const l = await probe(PORT_A, { method: "GET", path: "/cfg", host: GROT, origin: originGrot });
  check(
    l.status === 200 && l.acao === originGrot && l.acac === "true",
    "(l) GET /cfg на public-хосте с origin гротов: ACAO выдан (свой класс читает свои данные)",
  );

  // (i) Cookie-атрибуты: host-only (без Domain), HttpOnly, SameSite=Lax, Secure на https.
  const setHttp = String((reg.setCookie || [])[0] || "");
  check(
    /^coop_session=[0-9a-f]+; HttpOnly; Path=\/; Max-Age=\d+; SameSite=Lax$/.test(setHttp),
    "(i1) Set-Cookie: HttpOnly + Path + Max-Age + SameSite=Lax; атрибута Domain НЕТ (host-only)",
  );
  const regHttps = await probe(PORT_A, { method: "POST", path: "/auth/register", host: ELY, proto: "https",
    body: { login: "SecureCat", pass: "password1" } });
  const setHttps = String((regHttps.setCookie || [])[0] || "");
  check(
    setHttps.includes("Secure") && setHttps.includes("SameSite=Lax") && !/domain/i.test(setHttps) && setHttps.includes("HttpOnly"),
    "(i2) Set-Cookie на https (x-forwarded-proto): Secure + SameSite=Lax, БЕЗ Domain",
  );

  // (g) WS: upgrade — пара (origin, класс destination).
  const g1 = await wsClient(PORT_A, { host: ELY, origin: originGrot });
  check(g1.open === false, "(g1) WS upgrade на elyria-хост с origin гротов → отказ соединения");
  if (g1.ws) try { g1.ws.close(); } catch {}
  const g6 = await wsClient(PORT_A, { host: "pr-49.elysiae.phainonsmilk.ru", origin: "https://pr-48.elysiae.phainonsmilk.ru" });
  check(g6.open === false, "(g6) WS upgrade на pr-49.elisium с origin чужого превью pr-48 → отказ");
  if (g6.ws) try { g6.ws.close(); } catch {}

  const g2 = await wsClient(PORT_A, { host: ELY, origin: originEly });
  check(g2.open === true, "(g2) WS upgrade на elyria-хост с правильным origin → соединение живо");
  if (g2.open) {
    g2.ws.send(JSON.stringify(["auth", { action: "register", login: "WsElyCat", pass: "password1" }]));
    const who = await waitFor(g2.ws, (m) => m[0] === "whoami" && m[1]?.accountId);
    check(who[1]?.ok === true && who[1]?.login === "WsElyCat", "(g2b) register кадром на elyria с правильным origin работает");
    g2.ws.close();
  }

  const g3 = await wsClient(PORT_A, { host: ELY });
  check(g3.open === true, "(g3) WS upgrade на elyria-хост БЕЗ Origin → гость/скрипт подключается как раньше");
  if (g3.open) {
    g3.ws.send(JSON.stringify(["auth", { action: "register", login: "NoOriginCat", pass: "password1" }]));
    const refuse = await waitFor(g3.ws, (m) => m[0] === "whoami" && m[1]?.ok === false);
    check(refuse[1]?.reason === "error", "(g4) register кадром на elyria БЕЗ Origin → отказ (cookie-операции требуют Origin)");
    g3.ws.close();
  }

  // (j) Гость-геймплей на public-хосте гротов — как раньше.
  const j1 = await wsClient(PORT_A, { host: GROT });
  check(j1.open === true, "(j1) гость на public-хосте: WS без Origin подключается");
  if (j1.open) {
    await waitFor(j1.ws, (m) => m[0] === "whoami");
    j1.ws.send(JSON.stringify(["join", { room: "grot-1", login: "ГостьГрот" }]));
    const you = await waitFor(j1.ws, (m) => m[0] === "you");
    const field = await waitFor(j1.ws, (m) => m[0] === "field");
    check(you[1]?.id != null && field[1] != null, "(j1b) гость-геймплей: join grot-1 → you + field (как раньше)");
    j1.ws.send(JSON.stringify(["auth", { action: "register", login: "WsPub", pass: "password1" }]));
    const pubRefuse = await waitFor(j1.ws, (m) => m[0] === "whoami" && m[1]?.ok === false);
    check(pubRefuse[1]?.reason === "error", "(j2) register кадром на public-хосте — прежний спокойный отказ");
    j1.ws.close();
  }

  // (m) GET c cookie и Origin гротов на public-destination: чтение /cfg живо
  // (зона открытая), ACAO НЕ выдан чужому классу даже на чтении.
  const m1 = await probe(PORT_A, { method: "GET", path: "/cfg", host: ELY, origin: originGrot, cookie: cookieV });
  check(
    m1.status === 200 && m1.acao === null,
    "(m1) GET /cfg elyria+Origin гротов: читается сервером, но ACAO не выдан (крoss-читание закрыто)",
  );

  // ===== S3 (Z.AI 2026-11-08): легаси-шаблон *.vercel.app удалён из isAllowedOrigin =====
  // Verceil-хосты больше не «свои» ни в одном классе — ни в легаси-щите local,
  // ни в per-destination парах; явный env ALLOWED_ORIGINS — единственный запасной выход.
  const v1 = await probe(PORT_A, { method: "POST", path: "/auth/login",
    origin: "https://coop-field-evil.vercel.app", body: { login: "VercelCat", pass: "password1" } });
  check(
    v1.status === 403 && v1.json?.reason === "csrf",
    "(v1) S3: POST /auth/login (local, пермиссивный щит) с vercel-Origin → 403 csrf (прежде regex пропускал до логина)",
  );
  const v2 = await probe(PORT_A, { method: "POST", path: "/cfg", host: GROT,
    origin: "https://coop-field-evil.vercel.app", body: {} });
  check(
    v2.status === 404 && v2.json?.reason === "not_found",
    "(v2) S3: POST /cfg на public-dest с vercel-Origin → 404 not_found (host-гейт опережает CSRF; vercel не даёт ничего)",
  );
  const v3 = await wsClient(PORT_A, { origin: "https://coop-field-evil.vercel.app" });
  check(
    v3.open === false,
    "(v3) S3: WS upgrade на local-хост с vercel-Origin → отказ (regex-ветка isAllowedOrigin удалена)",
  );
  if (v3.ws) try { v3.ws.close(); } catch {}

  // ===== S4 (Z.AI 2026-11-08): /health экспонирует режим клиентского IP =====
  const h1 = await probe(PORT_A, { method: "GET", path: "/health" });
  check(
    h1.status === 200 && h1.json?.clientIpMode === "loopback",
    "(h1) S4: /health прямого loopback-коннекта → clientIpMode='loopback' (лимиты auth неактивны для этого трафика)",
  );
  const h2 = await probe(PORT_A, { method: "GET", path: "/health", xff: "203.0.113.7" });
  check(
    h2.status === 200 && h2.json?.clientIpMode === "xff",
    "(h2) S4: /health с X-Forwarded-For с loopback-сокета → clientIpMode='xff' (как за нашим nginx)",
  );
} catch (e) {
  failures += 1;
  console.error("FAIL exception (sandbox A)", e);
} finally {
  sandboxA.child.kill("SIGTERM");
}

/* ════════════════ Sandbox B: AUTH_TRUST_PROXY_HEADER с loopback ════════════════ */
const PORT_B = 4340 + Math.floor(Math.random() * 40);
const sandboxB = spawnServer(PORT_B, LOOP, {
  PUBLIC_HOSTS: "pub.example",
  ELYRIA_HOSTS: "ely.example",
  AUTH_TRUST_PROXY_HEADER: "X-Coop-Site",
});
try {
  await waitReady(PORT_B);
  const h1 = await probe(PORT_B, { method: "POST", path: "/auth/register", host: "ely.example",
    site: "public", body: { login: "Trusted", pass: "password1" } });
  check(
    h1.status === 404 && h1.json?.reason === "not_found",
    "(h1) X-Coop-Site: public с loopback при включённом env → применился (/auth скрыт)",
  );
  const h2 = await probe(PORT_B, { method: "POST", path: "/auth/register", host: "ely.example",
    site: "nonsense", body: { login: "Fallback", pass: "password1" } });
  check(
    h2.status === 200 && h2.json?.ok === true,
    "(h2) X-Coop-Site: неизвестное значение → fail-closed к Host-классификации (elyria жив)",
  );
  const hLocal = await probe(PORT_B, { method: "POST", path: "/auth/register", host: "pub.example",
    site: "local", body: { login: "LocalByHeader", pass: "password1" } });
  check(
    hLocal.status === 200 && hLocal.json?.ok === true,
    "(h-local) X-Coop-Site: local с loopback → гейт public снят по метке (легаси-режим local)",
  );
} catch (e) {
  failures += 1;
  console.error("FAIL exception (sandbox B)", e);
} finally {
  sandboxB.child.kill("SIGTERM");
}

/* ════════════ Sandbox C: метка с NON-loopback адреса игнорируется ════════════ */
// Свой IPv4 машины: коннект на него с этой же машины даёт сокет с адресом LAN,
// а не 127.0.0.1 — единственный способ честно воспроизвести «снаружи».
const lan = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === "IPv4" && !i.internal);
if (lan) {
  const PORT_C = 4390 + Math.floor(Math.random() * 40);
  const sandboxC = spawnServer(PORT_C, lan.address, {
    PUBLIC_HOSTS: "pub.example",
    ELYRIA_HOSTS: "ely.example",
    AUTH_TRUST_PROXY_HEADER: "X-Coop-Site",
  });
  try {
    await waitReady(PORT_C, lan.address);
    const h3 = await probe(PORT_C, { method: "POST", path: "/auth/register", host: "ely.example",
      site: "public", target: lan.address, body: { login: "Forged", pass: "password1" } });
    check(
      h3.status === 200 && h3.json?.ok === true,
      "(h3) X-Coop-Site подделка с non-loopback (через LAN-IP) → игнор: класс по Host (elyria жив, НЕ public)",
    );
    const h3b = await probe(PORT_C, { method: "POST", path: "/cfg", host: "pub.example",
      site: "elyria", target: lan.address, body: {} });
    check(
      h3b.status === 404 && h3b.json?.reason === "not_found",
      "(h3b) подделка метки на public-Host: игнор → гейт public по Host стоит (POST /cfg скрыт)",
    );
  } catch (e) {
    failures += 1;
    console.error("FAIL exception (sandbox C)", e);
  } finally {
    sandboxC.child.kill("SIGTERM");
  }
} else {
  console.log("skip (h3/h3b): нет непетлевого IPv4-интерфейса для честной пробы non-loopback");
}

/* ════════════ Sandbox D: AUTH_CSRF_STRICT=0 — permissive для всех ════════════ */
// Легаси-щит: originless+cookie на elyria проходит; чужой Origin (не из общего
// списка) — прежний 403 'csrf'.
const PORT_D = 4440 + Math.floor(Math.random() * 40);
const sandboxD = spawnServer(PORT_D, LOOP, {
  ELYRIA_HOSTS: "ely.example",
  AUTH_CSRF_STRICT: "0",
});
try {
  await waitReady(PORT_D);
  const regD = await probe(PORT_D, { method: "POST", path: "/auth/register", host: "ely.example",
    body: { login: "Strict0", pass: "password1" } });
  const out0 = await probe(PORT_D, { method: "POST", path: "/auth/logout", host: "ely.example",
    cookie: cookieOf(regD) });
  check(
    out0.status === 200 && out0.json?.ok === true,
    "(30) AUTH_CSRF_STRICT=0: отказ выключен форс-флагом — originless logout на elyria снова 200 (контроль стендов)",
  );
  const regD2 = await probe(PORT_D, { method: "POST", path: "/auth/register", host: "ely.example",
    body: { login: "Strict0b", pass: "password1" } });
  const evil = await probe(PORT_D, { method: "POST", path: "/auth/logout", host: "ely.example",
    origin: "https://evil.example", cookie: cookieOf(regD2) });
  check(
    evil.status === 403 && evil.json?.reason === "csrf",
    "(31) AUTH_CSRF_STRICT=0: чужой Origin всё равно 403 легаси-щитом (permissive ≠ дыра)",
  );
} catch (e) {
  failures += 1;
  console.error("FAIL exception (sandbox D)", e);
} finally {
  sandboxD.child.kill("SIGTERM");
}

/* ════════════ Sandbox E: AUTH_CSRF_STRICT=1 — strict даже на local ════════════ */
const PORT_E = 4480 + Math.floor(Math.random() * 40);
const sandboxE = spawnServer(PORT_E, LOOP, { AUTH_CSRF_STRICT: "1" });
try {
  await waitReady(PORT_E);
  const regE = await probe(PORT_E, { method: "POST", path: "/auth/register",
    body: { login: "Strict1", pass: "password1" } });
  check(
    regE.status === 200 && !!cookieOf(regE),
    "(32) AUTH_CSRF_STRICT=1: local+originless register БЕЗ cookie-реквизитов жив (strict не ломает guest/скрипты)",
  );
  const req1 = await probe(PORT_E, { method: "POST", path: "/auth/logout", cookie: cookieOf(regE) });
  check(
    req1.status === 403 && req1.json?.reason === "csrf_origin_required",
    "(33) AUTH_CSRF_STRICT=1: cookie+без Origin на local → 403 csrf_origin_required (strict форсирован)",
  );
  // S3 (Z.AI 2026-11-08): vercel-Origin под strict — двойной отказ (strict-щит
  // + удалённый isAllowedOrigin-regex); валидная кука не спасает, причина точная.
  const vS = await probe(PORT_E, { method: "POST", path: "/auth/logout",
    origin: "https://coop-field-pr-evil.vercel.app", cookie: cookieOf(regE) });
  check(
    vS.status === 403 && vS.json?.reason === "csrf_origin_mismatch",
    "(34) S3 strict: vercel-Origin на strict-local с валидной кукой → 403 csrf_origin_mismatch",
  );
} catch (e) {
  failures += 1;
  console.error("FAIL exception (sandbox E)", e);
} finally {
  sandboxE.child.kill("SIGTERM");
}

if (failures) {
  console.error(`cross-origin tests: FAIL (${failures} из ${passed})`);
  process.exit(1);
}
console.log(`cross-origin tests: зелёный (${passed} проверок)`);
