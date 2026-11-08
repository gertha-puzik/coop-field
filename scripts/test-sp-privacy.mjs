#!/usr/bin/env node
/**
 * Wave C regression: приватность СП профиля (W1 sp + P4/P5 профили).
 *
 * СП (скрытые параметры: sp.periodSec/damageLevel/armorLevel) — приватные
 * настройки владельца (server/profiles.js, контракт W1). Сценарии:
 *
 *  1. гость: GET /profiles/me → 401 auth_required (как в test:profiles);
 *  2. sp виден ТОЛЬКО владельцу: GET/PATCH /profiles/me отдаёт sp,
 *     каталог GET /profiles и чужая карточка GET /profiles/:id — НИКОГДА
 *     (даже своя карточка по :id — sp живёт только в /profiles/me);
 *  3. raw-тело каталога не содержит ключа "sp" вовсе;
 *  4. partial-PATCH: sp.periodSec отдельно НЕ теряет damageLevel/armorLevel
 *     (merge в profile.sp на сервере, отсутствие поля не трогает сохранённое);
 *  5. невалидный sp-патч (periodSec вне 1,8–5) и неизвестный sp-ключ — 400,
 *     сохранённое значение не затирается отказом;
 *  6. матрица не течёт мимо профиля: /auth/me не несёт sp (DTO publicAccount
 *     строит профиль только с displayName);
 *  7. диск: DATA_DIR/accounts.json хранит sp внутри profile, пароли — только
 *     scrypt-хэш (algo/salt/hash), plaintext-паролей в файле нет;
 *     sessions.json — только {accountId, createdAt, expiresAt}.
 *
 * Запуск: node scripts/test-sp-privacy.mjs (предложение npm-гейта:
 * "test:sp-privacy": "node scripts/test-sp-privacy.mjs" — патч в отчёте волны C).
 * Свои порт и DATA_DIR (песочница), как test-profiles.mjs; сервер убивается
 * в finally, песочница удаляется.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-sp-privacy-"));
const PORT = 4240 + Math.floor(Math.random() * 60);
const HOST = "127.0.0.1";
const WS = `ws://${HOST}:${PORT}`;
const HTTP = `http://${HOST}:${PORT}`;

process.env.DATA_DIR = DATA;

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ждём, пока сервер начнёт принимать сокеты (прогрев после spawn). */
async function waitReady(wsUrl) {
  for (let i = 0; i < 80; i += 1) {
    const ok = await new Promise((resolve) => {
      const probe = new WebSocket(wsUrl);
      probe.once("open", () => {
        probe.terminate();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (ok) return;
    await sleep(80);
  }
  throw new Error(`server not ready: ${wsUrl}`);
}

/** HTTP-проба: JSON-тело опционально, cookie и Origin прокидываются руками. */
async function probe({ method = "GET", path: p = "/", body, cookie }) {
  const res = await fetch(`${HTTP}${p}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* не-JSON ответ — держим текст */
  }
  return { status: res.status, json, text, setCookie };
}

const sessionCookie = (setCookie) => {
  const m = String(setCookie).match(/coop_session=([0-9a-f]+)/);
  return m ? `coop_session=${m[1]}` : "";
};

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST, DATA_DIR: DATA },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));

try {
  await waitReady(WS);

  /* ---- 1. гость ---- */
  const guestMe = await probe({ path: "/profiles/me" });
  check(guestMe.status === 401 && guestMe.json?.reason === "auth_required", "гость: GET /profiles/me → 401 auth_required");

  /* ---- регистрация двух аккаунтов (local-класс: без rate-лимитов) ---- */
  const regA = await probe({ method: "POST", path: "/auth/register", body: { login: "alice_sp", pass: "alice-pass-123", name: "Алиса" } });
  const regB = await probe({ method: "POST", path: "/auth/register", body: { login: "bob_view", pass: "bob-pass-1234", name: "Боб" } });
  check(regA.status === 200 && regA.json?.ok === true, "alice зарегистрирована (HTTP register v2)");
  check(regB.status === 200 && regB.json?.ok === true, "bob зарегистрирован");
  const aliceId = regA.json?.accountId;
  const aliceToken = regA.json?.token;
  const bobToken = regB.json?.token;
  check(!!aliceToken && !!bobToken, "local-класс отдал токены в телах (матрица B1, песочница)");
  const aliceCookie2 = sessionCookie(regA.setCookie);
  const bobCookie2 = sessionCookie(regB.setCookie);
  check(!!aliceCookie2 && !!bobCookie2, "Set-Cookie из register даёт сессионные куки");

  /* ---- 2. sp виден только владельцу ---- */
  const meBefore = await probe({ path: "/profiles/me", cookie: aliceCookie2 });
  check(meBefore.status === 200 && meBefore.json?.sp === undefined, "свой /profiles/me без сохранённых СП: ключа sp нет вовсе");

  const fullPatch = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie: aliceCookie2,
    body: { sp: { periodSec: 2.5, damageLevel: 3, armorLevel: 4 } },
  });
  check(
    fullPatch.status === 200 &&
      JSON.stringify(fullPatch.json?.sp) === JSON.stringify({ periodSec: 2.5, damageLevel: 3, armorLevel: 4 }),
    "PATCH полного sp → 200, ответ несёт sp владельцу",
  );

  const meAfter = await probe({ path: "/profiles/me", cookie: aliceCookie2 });
  check(
    JSON.stringify(meAfter.json?.sp) === JSON.stringify({ periodSec: 2.5, damageLevel: 3, armorLevel: 4 }),
    "GET /profiles/me: sp читается владельцем",
  );

  const catalog = await probe({ path: "/profiles" });
  const aliceCard = (catalog.json?.items || []).find((it) => it.accountId === aliceId);
  check(catalog.status === 200 && !!aliceCard, "каталог: карточка Алисы присутствует");
  check(!aliceCard || !("sp" in aliceCard), "каталог: в карточке НЕТ sp (публичный DTO не расширяется)");
  check(
    !catalog.text.includes('"sp"'),
    'raw-тело каталога не содержит ключа "sp" вообще',
  );

  const cardById = await probe({ path: `/profiles/${aliceId}`, cookie: bobCookie2 });
  check(cardById.status === 200 && !("sp" in cardById.json), "чужая карточка /profiles/:id — БЕЗ sp (даже с сессией)");
  check(!cardById.text.includes('"sp"'), "raw-тело чужой карточки не содержит sp");

  const ownCardById = await probe({ path: `/profiles/${aliceId}`, cookie: aliceCookie2 });
  check(ownCardById.status === 200 && !("sp" in ownCardById.json), "своя карточка по :id — тоже БЕЗ sp (sp живёт только в /profiles/me)");

  /* ---- 3. частичный PATCH sp не теряет соседние поля ---- */
  const partial1 = await probe({ method: "PATCH", path: "/profiles/me", cookie: aliceCookie2, body: { sp: { periodSec: 4 } } });
  check(
    partial1.status === 200 &&
      JSON.stringify(partial1.json?.sp) === JSON.stringify({ periodSec: 4, damageLevel: 3, armorLevel: 4 }),
    "PATCH sp.periodSec: damageLevel/armorLevel НЕ потеряны (partial-merge)",
  );

  const partial2 = await probe({ method: "PATCH", path: "/profiles/me", cookie: aliceCookie2, body: { sp: { damageLevel: 7 } } });
  check(
    partial2.status === 200 &&
      JSON.stringify(partial2.json?.sp) === JSON.stringify({ periodSec: 4, damageLevel: 7, armorLevel: 4 }),
    "PATCH sp.damageLevel поверх частичного: период и броня на месте",
  );

  const reread = await probe({ path: "/profiles/me", cookie: aliceCookie2 });
  check(
    JSON.stringify(reread.json?.sp) === JSON.stringify({ periodSec: 4, damageLevel: 7, armorLevel: 4 }),
    "свежий GET /profiles/me подтверждает merge (флаш стора настоящий)",
  );

  /* ---- 4. невалидный/неизвестный sp-патч не затирает сохранённое ---- */
  const badPatch = await probe({ method: "PATCH", path: "/profiles/me", cookie: aliceCookie2, body: { sp: { periodSec: 9 } } });
  check(badPatch.status === 400 && badPatch.json?.reason === "invalid", "sp.periodSec вне 1,8–5,0 → 400 invalid (не молчаливый зажим)");

  const unknownSub = await probe({ method: "PATCH", path: "/profiles/me", cookie: aliceCookie2, body: { sp: { magic: 1 } } });
  check(
    unknownSub.status === 400 && unknownSub.json?.reason === "unknown_keys" && unknownSub.json?.unknown?.includes("sp.magic"),
    "неизвестный ключ внутри sp → 400 unknown_keys с именем sp.magic",
  );

  const afterBad = await probe({ path: "/profiles/me", cookie: aliceCookie2 });
  check(
    JSON.stringify(afterBad.json?.sp) === JSON.stringify({ periodSec: 4, damageLevel: 7, armorLevel: 4 }),
    "после отказов sp не затёрт (отказ ничего не меняет)",
  );

  /* ---- 5. матрица: /auth/me не несёт sp ---- */
  const authMe = await probe({ path: `/auth/me?t=${aliceToken}` });
  check(authMe.status === 200 && !("sp" in authMe.json), "GET /auth/me не несёт sp (DTO publicAccount — только displayName профиля)");

  /* ---- 6. диск: хранение сп в profile, пароли — scrypt-хэш ---- */
  const rawAccounts = readFileSync(path.join(DATA, "accounts.json"), "utf8");
  const storeJson = JSON.parse(rawAccounts);
  const aliceRow = Object.values(storeJson.accounts || {}).find((a) => a.login === "alice_sp");
  check(
    !!aliceRow?.profile?.sp && JSON.stringify(aliceRow.profile.sp) === JSON.stringify({ periodSec: 4, damageLevel: 7, armorLevel: 4 }),
    "accounts.json: profile.sp хранит частично смерженный сп (персист)",
  );
  check(
    Object.values(storeJson.accounts || {}).every(
      (a) => a.pass && a.pass.algo === "scrypt" && typeof a.pass.hash === "string" && typeof a.pass.salt === "string",
    ),
    "accounts.json: у каждой записи пароль — только scrypt-хэш (algo+salt+hash), plaintext-полей нет",
  );
  check(!rawAccounts.includes("alice-pass-123") && !rawAccounts.includes("bob-pass-1234"), "accounts.json не содержит plaintext-паролей");
  const rawSessions = readFileSync(path.join(DATA, "sessions.json"), "utf8");
  const sessionsJson = JSON.parse(rawSessions);
  const someSession = Object.values(sessionsJson.sessions || {})[0];
  check(
    !!someSession &&
      !("pass" in someSession) &&
      !("login" in someSession) &&
      typeof someSession.accountId === "string" &&
      typeof someSession.expiresAt === "number",
    "sessions.json: только {accountId, createdAt, expiresAt}, без логинов и паролей",
  );

  server.kill("SIGTERM");
} catch (e) {
  failures += 1;
  console.error("sp-privacy: неподобный сбой песочницы:", e);
} finally {
  server.kill("SIGTERM");
  // Песочница удаляется ТОЛЬКО после фактического выхода сервера: его
  // shutdown-флаш (flushAuth → saveSessions) не должен писать в удалённый
  // каталог и пугать stderr ломаной ENOENT-строкой.
  server.once("exit", () => {
    try {
      rmSync(DATA, { recursive: true, force: true });
    } catch {
      /* best-effort очистка песочницы */
    }
  });
}

if (failures) {
  console.error(`sp-privacy: провалено проверок: ${failures}`);
  process.exit(1);
}
console.log("sp-privacy: СП видны только владельцу, partial-PATCH не теряет поля, на диске только хэши — ok");
