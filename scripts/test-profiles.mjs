/**
 * P4 профили: HTTP-контракт рабочих профилей + вариантная изоляция страниц.
 *
 *  1. гость: GET /profiles/me → 401 auth_required; GET /profiles — рабочий
 *     каталог (items/total, без пагинации); легаси-строка без profile
 *     в нём не показывается;
 *  2. регистрация+cookie (HTTP): GET /profiles/me — 200 DTO без login/role/pass,
 *     с пустыми слотами bio/avatarCharacterId;
 *  3. PATCH /profiles/me: bio+displayName пишутся и читаются обратно
 *     (и в ответе PATCH, и в свежем GET — флаш стора настоящий);
 *  4. PATCH-валидация: avatarCharacterId только из своих characters либо null;
 *     чужой id и перелив длин → 400 invalid; идентификационные ключи тела
 *     (login, accountId) → 400 unknown_keys; пустое тело → empty_patch;
 *     битый JSON → invalid_body; чужой Origin → 403 csrf;
 *  5. GET /profiles/:id — публичный DTO по своему id; несуществующий id
 *     и скрытый аккаунт (строка без profile) → 404 unknown;
 *  6. GET /profiles — карточки: обе регистрированные записи, total согласован,
 *     приватных полей нет ни в одной карточке, порядок стабилен, легаси
 *     отсутствует;
 *  7. вариантная изоляция: www-grotto (после build:variants) не содержит
 *     players/, admin/ и elision/; нет корня сборки → SKIP (как юнит-раннер).
 *
 * Запуск: node scripts/test-profiles.mjs (npm run test:profiles). Свои порт и
 * DATA_DIR (песочница), как test-auth.mjs; сервер убивается в finally; каталог
 * DATA чистится при выходе.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const ROOT = new URL("..", import.meta.url).pathname;
const DATA = mkdtempSync(path.join(tmpdir(), "coop-profiles-"));
const PORT = 4110 + Math.floor(Math.random() * 60);
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
async function probe({ method = "GET", path: p = "/", body, cookie, origin, rawBody }) {
  const res = await fetch(`${HTTP}${p}`, {
    method,
    headers: {
      ...(body === undefined && rawBody === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
      ...(origin ? { origin } : {}),
    },
    body: rawBody === undefined && body === undefined ? undefined : rawBody ?? JSON.stringify(body),
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

/** Каталог карточек без приватных полей: ни login/role/pass ни в ком. */
const cardsArePublic = (items) =>
  Array.isArray(items) &&
  items.every(
    (it) =>
      it &&
      typeof it === "object" &&
      !("login" in it) &&
      !("role" in it) &&
      !("pass" in it) &&
      !("password" in it) &&
      typeof it.accountId === "string" &&
      typeof it.displayName === "string" &&
      typeof it.bio === "string" &&
      (it.avatarCharacterId === null || typeof it.avatarCharacterId === "string"),
  );

// Легаси-аккаунт БЕЗ profile: существует в сторе, но публичной карточки у него
// нет — ни в каталоге, ни по :id. Пишем ДО старта сервера (v1 passthrough).
const LEGACY_ID = "a00000000000000000000000000dead";
writeFileSync(
  path.join(DATA, "accounts.json"),
  JSON.stringify(
    {
      v: 1,
      accounts: {
        [LEGACY_ID]: {
          id: LEGACY_ID,
          login: "Легаси",
          pass: { algo: "scrypt", N: 16384, r: 8, p: 1, keylen: 32, salt: "00", hash: "00" },
          role: "registered",
          createdAt: 1000,
          characters: [{ id: "c00000000000000000000000000bee", name: "Легаси", sprite: "", size: 100 }],
          activeCharacterId: "c00000000000000000000000000bee",
        },
      },
    },
    null,
    2,
  ),
);

const server = spawn(process.execPath, ["server.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), HOST, DATA_DIR: DATA },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));

try {
  await waitReady(WS);

  /* ---------- 1. гость ---------- */
  const guestMe = await probe({ path: "/profiles/me" });
  check(
    guestMe.status === 401 && guestMe.json?.ok === false && guestMe.json?.reason === "auth_required",
    "guest: GET /profiles/me → 401 auth_required",
  );
  const guestList = await probe({ path: "/profiles" });
  check(
    guestList.status === 200 &&
      guestList.json?.ok === true &&
      Array.isArray(guestList.json?.items) &&
      guestList.json.items.length === 0 &&
      guestList.json?.total === 0,
    "guest: GET /profiles — каталог пуст (легаси без profile не показывается)",
  );

  /* ---------- 2. регистрация + me ---------- */
  const reg = await probe({
    method: "POST",
    path: "/auth/register",
    body: { login: "Пузик", pass: "password1" },
  });
  const cookie = sessionCookie(reg.setCookie);
  const myAccount = reg.json?.accountId;
  check(reg.status === 200 && reg.json?.ok === true && !!cookie && !!myAccount, "register: аккаунт + cookie-сессия");
  const me = await probe({ path: "/profiles/me", cookie: myAccount ? cookie : "" });
  check(
    me.status === 200 &&
      me.json?.ok === true &&
      me.json?.displayName === "Пузик" &&
      me.json?.bio === "" &&
      me.json?.avatarCharacterId === null &&
      Array.isArray(me.json?.characters) &&
      !("login" in (me.json || {})) &&
      !("role" in (me.json || {})) &&
      !("pass" in (me.json || {})),
    "me: GET /profiles/me — публичный DTO без login/role/pass; слоты bio/avatar на месте",
  );
  const myCharacter = Array.isArray(me.json?.characters) ? me.json.characters[0] : null;
  check(!!myCharacter?.id, "me: у аккаунта есть персонаж (id для аватара)");

  /* ---------- 3. PATCH пишет и читается обратно ---------- */
  const patch1 = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie,
    body: { displayName: "Пузик Мяу", bio: "Люблю пивные гроты и шум листьев." },
  });
  check(
    patch1.status === 200 &&
      patch1.json?.ok === true &&
      patch1.json?.displayName === "Пузик Мяу" &&
      patch1.json?.bio === "Люблю пивные гроты и шум листьев.",
    "patch: bio+displayName применились (ответ несёт свежее DTO)",
  );
  const meAfter = await probe({ path: "/profiles/me", cookie });
  check(
    meAfter.status === 200 &&
      meAfter.json?.displayName === "Пузик Мяу" &&
      meAfter.json?.bio === "Люблю пивные гроты и шум листьев.",
    "patch: значение читаются обратно свежим GET /profiles/me",
  );

  /* ---------- 4. валидация PATCH ---------- */
  const patchAvatarOk = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie,
    body: { avatarCharacterId: myCharacter?.id },
  });
  check(
    patchAvatarOk.status === 200 && patchAvatarOk.json?.avatarCharacterId === myCharacter?.id,
    "patch: avatarCharacterId из своих characters — ок",
  );
  const patchAvatarNull = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie,
    body: { avatarCharacterId: null },
  });
  check(
    patchAvatarNull.status === 200 && patchAvatarNull.json?.avatarCharacterId === null,
    "patch: avatarCharacterId null — сброшен",
  );
  const patchAvatarBad = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie,
    body: { avatarCharacterId: "c123-hack" },
  });
  check(
    patchAvatarBad.status === 400 &&
      patchAvatarBad.json?.reason === "invalid" &&
      Array.isArray(patchAvatarBad.json?.invalid),
    "patch: чужой avatarCharacterId → 400 invalid",
  );
  const patchLongName = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie,
    body: { displayName: "о".repeat(25) },
  });
  check(patchLongName.status === 400 && patchLongName.json?.reason === "invalid", "patch: displayName 25 символов → 400 invalid");
  const patchLongBio = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie,
    body: { bio: "б".repeat(281) },
  });
  check(patchLongBio.status === 400 && patchLongBio.json?.reason === "invalid", "patch: bio 281 символ → 400 invalid");
  const patchUnknown = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie,
    body: { login: "ЧужойЛогин", accountId: "a-hack" },
  });
  check(
    patchUnknown.status === 400 &&
      patchUnknown.json?.reason === "unknown_keys" &&
      Array.isArray(patchUnknown.json?.unknown) &&
      patchUnknown.json?.unknown?.includes("login"),
    "patch: идентификация из body (login/accountId) → 400 unknown_keys",
  );
  const patchEmpty = await probe({ method: "PATCH", path: "/profiles/me", cookie, body: {} });
  check(patchEmpty.status === 400 && patchEmpty.json?.reason === "empty_patch", "patch: пустое тело → 400 empty_patch");
  const patchJunk = await probe({ method: "PATCH", path: "/profiles/me", cookie, rawBody: "{broken json" });
  check(patchJunk.status === 400 && patchJunk.json?.reason === "invalid_body", "patch: битый JSON → 400 invalid_body");
  const patchCsrf = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie,
    origin: "https://evil.example",
    body: { bio: "перезапись злым сайтом" },
  });
  check(patchCsrf.status === 403 && patchCsrf.json?.reason === "csrf", "patch: чужой Origin → 403 csrf");
  const patchNoSession = await probe({ method: "PATCH", path: "/profiles/me", body: { bio: "x" } });
  check(patchNoSession.status === 401 && patchNoSession.json?.reason === "auth_required", "patch: без сессии → 401 auth_required");

  /* ---------- 5. GET /profiles/:id ---------- */
  const byId = await probe({ path: `/profiles/${myAccount}` });
  check(
    byId.status === 200 &&
      byId.json?.ok === true &&
      byId.json?.accountId === myAccount &&
      byId.json?.displayName === "Пузик Мяу" &&
      byId.json?.bio === "Люблю пивные гроты и шум листьев." &&
      !("login" in (byId.json || {})) &&
      !("role" in (byId.json || {})),
    "byId: GET /profiles/:id — публичный DTO по accountId",
  );
  const byIdUnknown = await probe({ path: "/profiles/a1111-no-such-id" });
  check(
    byIdUnknown.status === 404 && byIdUnknown.json?.ok === false && byIdUnknown.json?.reason === "unknown",
    "byId: несуществующий id → 404 unknown (JSON)",
  );
  const byIdHidden = await probe({ path: `/profiles/${LEGACY_ID}` });
  check(
    byIdHidden.status === 404 && byIdHidden.json?.reason === "unknown",
    "byId: скрытый аккаунт без profile → 404 unknown (без раскрытия)",
  );

  /* ---------- 6. каталог ---------- */
  const reg2 = await probe({
    method: "POST",
    path: "/auth/register",
    body: { login: "Герта", pass: "password1" },
  });
  const cookie2 = sessionCookie(reg2.setCookie);
  await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie: cookie2,
    body: { bio: "Админ площадки." },
  });
  const list = await probe({ path: "/profiles" });
  const items = list.json?.items;
  check(
    list.status === 200 && list.json?.ok === true && Array.isArray(items) && items.length === 2 && list.json?.total === 2,
    "catalog: обе регистрированные карточки, total согласован (легаси скрыт)",
  );
  check(cardsArePublic(items), "catalog: ни в одной карточке нет login/role/pass");
  const list2 = await probe({ path: "/profiles" });
  check(JSON.stringify(list.json?.items) === JSON.stringify(list2.json?.items), "catalog: порядок стабилен между запросами");
  const orderOk =
    Array.isArray(items) &&
    items.length === 2 &&
    items[0].accountId === myAccount &&
    items.every((it, i) => i === 0 || items[i - 1].createdAt <= it.createdAt);
  check(orderOk, "catalog: старейший аккаунт первым (createdAt asc)");
  const legacyLeaked = Array.isArray(items) && items.some((it) => it.accountId === LEGACY_ID);
  check(!legacyLeaked, "catalog: легаси-строка без profile в каталог не попала");
} catch (e) {
  failures += 1;
  console.error("FAIL exception", e);
} finally {
  server.kill("SIGTERM");
}

/* ---------- 7. вариантная изоляция страниц (пост-сборочная) ----------
 * www-grotto лежит в корне только после build:variants; в CI без сборки
 * честно SKIP-им (как run-unit-tests), а на собранном дереве требуем
 * отсутствия вырезанных маршрутов. */
const GROTTO = path.join(ROOT, "www-grotto");
if (!existsSync(GROTTO)) {
  console.log("skip  вариантная изоляция: www-grotto не собран (build:variants не гонялся)");
} else {
  const dirs = existsSync(GROTTO) ? readdirSync(GROTTO).sort() : [];
  check(!dirs.includes("players"), "isolation: в www-grotto нет players/");
  check(!dirs.includes("admin"), "isolation: в www-grotto нет admin/");
  check(!dirs.includes("elision"), "isolation: в www-grotto нет elision/ (P3 не регрессирует)");
}

try {
  rmSync(DATA, { recursive: true, force: true });
} catch {
  /* песочница во временном каталоге — уберётся системой */
}

if (failures) {
  console.error(`profiles tests: FAIL (${failures})`);
  process.exit(1);
}
console.log("profiles tests: зелёный");
