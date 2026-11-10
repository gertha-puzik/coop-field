/**
 * P4 профили: HTTP-контракт рабочих профилей + вариантная изоляция страниц.
 *
 *  1. гость: GET /profiles/me → 401 auth_required; GET /profiles — рабочий
 *     каталог (items/total/nextCursor; limit default 24); легаси-строка
 *     без profile в нём не показывается;
 *  2. регистрация+cookie (HTTP): GET /profiles/me — 200 DTO без login/role/pass,
 *     с пустыми слотами bio/avatarCharacterId;
 *  3. PATCH /profiles/me: bio+displayName пишутся и читаются обратно
 *     (и в ответе PATCH, и в свежем GET — флаш стора настоящий);
 *  4. PATCH-валидация: avatarCharacterId только из своих characters либо null;
 *     чужой id и перелив длин → 400 invalid; идентификационные ключи тела
 *     (login, accountId) → 400 unknown_keys; пустое тело → empty_patch;
 *     битый JSON → invalid_body; чужой Origin → 403 csrf;
 *  4.5. birthday (день рождения): валидная «ГГГГ-ММ-ДД» пишется в стор и
 *     читается целиком из /profiles/me и ответа PATCH; чужая карточка и
 *     каталог отдают только «ММ-ДД» (года в теле нет) и не несут
 *     lastSeenRoom; lastSeenAt на карточке остаётся числом; вложенная profile.birthday — тот же
 *     валидатор; невалиды («dfg34», «30123-45-678», «2026-13-01»,
 *     «2026-02-30», «1899-12-31», будущая дата) → 400 invalid без изменения
 *     профиля; null/пустая строка → сброс в null;
 *  5. GET /profiles/:id — публичный DTO по своему id; несуществующий id
 *     и скрытый аккаунт (строка без profile) → 404 unknown;
 *  6. GET /profiles — карточки: обе регистрированные записи, total согласован,
 *     приватных полей нет ни в одной карточке, порядок стабилен, легаси
 *     отсутствует;
 *  7. поиск и пагинация каталога (B3): q — подстрока displayName с
 *     нормализацией (регистр, NFC, trim; длиннее 64 код-поинтов — обрезка
 *     префиксом, НЕ 400); пустой/пробельный q = без фильтра; несуществующий
 *     q → items пуст и nextCursor null; скрытый легаси через поиск не
 *     течёт; limit — мусор → 400 invalid_limit, выше 48 — клэмп без 400;
 *     cursor — base64 «createdAt:accountId», мусор → 400 invalid_cursor,
 *     несуществующая позиция (удалённый элемент) — продолжение с ближайшей
 *     следующей БЕЗ ошибки; страницы стыкуются без дублей и без приватных
 *     полей на каждой; карточка по :id не зависит от limit/cursor/q;
 *  8. вариантная изоляция: www-grotto (после build:variants) не содержит
 *     players/, admin/, игровое поле game/ и стаб elision/; нет корня сборки
 *     → SKIP (как юнит-раннер).
 *
 * Запуск: node scripts/test-profiles.mjs (npm run test:profiles). Свои порт и
 * DATA_DIR (песочница), как test-auth.mjs; сервер убивается в finally; каталог
 * DATA чистится при выходе.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
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
      !("lastSeenRoom" in it) &&
      (it.birthday == null || /^\d{2}-\d{2}$/.test(it.birthday)) &&
      typeof it.lastSeenAt === "number" &&
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
    body: { login: "puzik_q", pass: "password1", name: "Пузик" },
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

  /* ---------- 5.5. день рождения: birthday (PATCH + валидация) ---------- */
  const bd = "2001-07-24";
  const bd1 = await probe({ method: "PATCH", path: "/profiles/me", cookie, body: { birthday: bd } });
  check(
    bd1.status === 200 && bd1.json?.ok === true && bd1.json?.birthday === bd,
    "birthday: валидная дата пишется и возвращается в ответе PATCH",
  );
  const bdMe = await probe({ path: "/profiles/me", cookie });
  check(bdMe.status === 200 && bdMe.json?.birthday === bd, "birthday: свежий GET /profiles/me несёт ту же строку");
  const bdCard = await probe({ path: `/profiles/${myAccount}` });
  const bdCardText = bdCard.text || "";
  check(
    bdCard.status === 200 &&
      bdCard.json?.birthday === "07-24" &&
      !bdCardText.includes(bd) &&
      !bdCardText.includes("lastSeenRoom"),
    "birthday: чужая карточка — день и месяц без года и без lastSeenRoom",
  );
  check(
    typeof bdCard.json?.lastSeenAt === "number" && bdCard.json.lastSeenAt > 0 && bdCard.json.lastSeenAt <= Date.now(),
    "lastSeenAt: чужая карточка по-прежнему несёт время последнего появления",
  );
  const bdList = await probe({ path: "/profiles" });
  const bdItem = (bdList.json?.items || []).find((it) => it.accountId === myAccount);
  const bdListText = bdList.text || "";
  check(
    bdItem &&
      bdItem.birthday === "07-24" &&
      !bdListText.includes(bd) &&
      !bdListText.includes("lastSeenRoom") &&
      typeof bdItem.lastSeenAt === "number" &&
      bdItem.lastSeenAt > 0,
    "birthday: каталог — ММ-ДД, без года и без lastSeenRoom, lastSeenAt на месте",
  );
  const disk = JSON.parse(readFileSync(path.join(DATA, "accounts.json"), "utf8"));
  check(
    disk.accounts?.[myAccount]?.profile?.birthday === bd,
    "birthday: в accounts.json у владельца остаётся полная ГГГГ-ММ-ДД",
  );
  // вложенная форма profile.birthday — тот же валидатор sanitizePatch
  const bdNested = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie,
    body: { profile: { birthday: "1990-01-01" } },
  });
  check(
    bdNested.status === 200 && bdNested.json?.birthday === "1990-01-01",
    "birthday: вложенная форма profile.birthday тоже работает",
  );
  const bdNestedCard = await probe({ path: `/profiles/${myAccount}` });
  check(
    bdNestedCard.json?.birthday === "01-01" && !(bdNestedCard.text || "").includes("1990-01-01"),
    "birthday: после вложенной правки чужая карточка снова без года",
  );
  // (c') невалиды: маска, реальность календаря и диапазон 01.01.1900 — сегодня
  const dayAfter = new Date(Date.now() + 30 * 86_400_000);
  const futureDate = `${dayAfter.getUTCFullYear()}-${String(dayAfter.getUTCMonth() + 1).padStart(2, "0")}-${String(dayAfter.getUTCDate()).padStart(2, "0")}`;
  const badBirthday = ["dfg34", "30123-45-678", "2026-13-01", "2026-02-30", "1899-12-31", futureDate];
  const birthdayRejects = [];
  for (const bad of badBirthday) {
    const r = await probe({ method: "PATCH", path: "/profiles/me", cookie, body: { birthday: bad } });
    if (!(
      r.status === 400 && r.json?.reason === "invalid" &&
      Array.isArray(r.json?.invalid) && r.json.invalid.some((i) => i.key === "birthday")
    )) {
      birthdayRejects.push(bad);
    }
  }
  check(birthdayRejects.length === 0, `birthday: невалиды (${badBirthday.join(", ")}) → 400 invalid`);
  const bdUnchanged = await probe({ path: "/profiles/me", cookie });
  check(
    bdUnchanged.status === 200 && bdUnchanged.json?.birthday === "1990-01-01",
    "birthday: после отклонённых правок профиль не изменился",
  );
  // (b) сброс: null и пустая строка → birthday null
  const bdNull = await probe({ method: "PATCH", path: "/profiles/me", cookie, body: { birthday: null } });
  check(bdNull.status === 200 && bdNull.json?.birthday === null, "birthday: PATCH null → 200 и birthday null");
  const bdEmpty = await probe({ method: "PATCH", path: "/profiles/me", cookie, body: { birthday: "" } });
  check(bdEmpty.status === 200 && bdEmpty.json?.birthday === null, "birthday: пустая строка → сброс (null)");
  const bdAfterReset = await probe({ path: `/profiles/${myAccount}` });
  check(bdAfterReset.json?.birthday === null, "birthday: сброс виден и в публичной карточке");

  /* ---------- 6. каталог ---------- */
  const reg2 = await probe({
    method: "POST",
    path: "/auth/register",
    body: { login: "gertha_q", pass: "password1", name: "Герта" },
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

  /* ---------- 7. поиск и пагинация каталога (B3) ---------- */
  // Пул для многостраничного каталога: 5 аккаунтов поверх Пузика и Герты
  // → 7 карточек; limit=3 даёт 3 страницы (3+3+1). rate-limiter не мешает:
  // прямые loopback-коннекты теста исключены из троттлинга (auth.js rate()).
  const extras = [];
  // register v2: логины пула — строго латиницей, видимые имена (name) — прежние
  // кириллические: поисковые пробы ниже бьют по displayName карточек.
  for (const [name, regLogin] of [["Ольга", "olga_q"], ["Тара", "tara_q"], ["Марго", "margo_q"], ["Кира", "kira_q"], ["Нова", "nova_q"]]) {
    const r = await probe({ method: "POST", path: "/auth/register", body: { login: regLogin, pass: "password1", name } });
    if (r.status === 200 && r.json?.ok === true && r.json?.accountId) {
      extras.push({ name, id: r.json.accountId, cookie: sessionCookie(r.setCookie) });
    }
  }
  check(extras.length === 5, "page: пул из 5 аккаунтов зарегистрирован (всего 7 карточек)");

  // 7a. поиск по подстроке имени (q=«мяу» → только «Пузик Мяу»)
  const subQ = await probe({ path: `/profiles?q=${encodeURIComponent("мяу")}` });
  check(
    subQ.status === 200 &&
      subQ.json?.ok === true &&
      subQ.json?.items?.length === 1 &&
      subQ.json.items[0].accountId === myAccount &&
      subQ.json?.total === 1 &&
      subQ.json?.nextCursor === null,
    "search: подстрока имени (q=«мяу» → карточка Пузика, следующей страницы нет)",
  );

  // 7b. регистронезависимость: заглавные/строчные/смешанные
  const upperQ = await probe({ path: `/profiles?q=${encodeURIComponent("МЯУ")}` });
  check(
    upperQ.json?.items?.length === 1 && upperQ.json.items[0].accountId === myAccount,
    "search: регистронезависимость (q=«МЯУ»)",
  );
  const mixedQ = await probe({ path: `/profiles?q=${encodeURIComponent("пУзИк МяУ")}` });
  check(
    mixedQ.json?.items?.length === 1 && mixedQ.json.items[0].accountId === myAccount,
    "search: смешанный регистр всей строки",
  );

  // 7c. trim по краям запроса
  const trimQ = await probe({ path: `/profiles?q=${encodeURIComponent("  МЯУ  ")}` });
  check(
    trimQ.json?.items?.length === 1 && trimQ.json.items[0].accountId === myAccount,
    "search: q тримится по краям",
  );

  // 7d. NFC: decomposed-имя ищется precomposed-запросом и наоборот.
  // Нове ставим имя «Cafe\u0301» (e + combining acute, НЕ U+00E9).
  const nova = extras[4];
  const nfcPatch = await probe({
    method: "PATCH",
    path: "/profiles/me",
    cookie: nova.cookie,
    body: { displayName: "Cafe\u0301" },
  });
  check(nfcPatch.status === 200 && nfcPatch.json?.displayName === "Cafe\u0301", "setup: Нове поставили decomposed-имя (Cafe+U+0301)");
  const nfcComposed = await probe({ path: `/profiles?q=${encodeURIComponent("caf\u00e9")}` });
  check(
    nfcComposed.json?.items?.length === 1 && nfcComposed.json.items[0].accountId === nova.id,
    "search: NFC — precomposed-запрос («caf\u00e9») находит decomposed-имя",
  );
  const nfcDecomposed = await probe({ path: `/profiles?q=${encodeURIComponent("CAFE\u0301")}` });
  check(
    nfcDecomposed.json?.items?.length === 1 && nfcDecomposed.json.items[0].accountId === nova.id,
    "search: NFC — decomposed-запрос нормализуется и находит то же имя",
  );

  // 7e. длинный q — обрезка префиксом, НЕ ошибка (имена ≤ 24 символов,
  // сверхдлинная подстрока никого не находит, но ответ — 200, не 400)
  const longQ = await probe({ path: `/profiles?q=${encodeURIComponent(`МЯУ${"х".repeat(100)}`)}` });
  check(
    longQ.status === 200 && longQ.json?.ok === true && longQ.json?.items?.length === 0 && longQ.json?.nextCursor === null,
    "search: q длиннее 64 код-поинтов — обрезка, не 400; результата нет",
  );

  // 7f. пустой и пробельный q — без фильтра
  const emptyQ = await probe({ path: "/profiles?q=" });
  const spaceQ = await probe({ path: `/profiles?q=${encodeURIComponent("   ")}` });
  check(
    emptyQ.status === 200 &&
      emptyQ.json?.items?.length === 7 &&
      spaceQ.json?.items?.length === 7 &&
      JSON.stringify(emptyQ.json?.items) === JSON.stringify(spaceQ.json?.items),
    "search: пустой и пробельный q = каталог без фильтра",
  );

  // 7g. несуществующее имя; скрытый легаси через поиск не течёт
  const noneQ = await probe({ path: `/profiles?q=${encodeURIComponent("зондызюжик")}` });
  check(
    noneQ.status === 200 && noneQ.json?.items?.length === 0 && noneQ.json?.total === 0 && noneQ.json?.nextCursor === null,
    "search: несуществующее имя → items пуст, nextCursor null",
  );
  const legacyQ = await probe({ path: `/profiles?q=${encodeURIComponent("легаси")}` });
  check(
    legacyQ.status === 200 && legacyQ.json?.items?.length === 0,
    "search: скрытый аккаунт (легаси) по логину не находится",
  );

  // 7h. пагинация: limit=3 на 7 карточках → 3 страницы
  const p1 = await probe({ path: "/profiles?limit=3" });
  const p1items = p1.json?.items || [];
  check(
    p1.status === 200 && p1items.length === 3 && typeof p1.json?.nextCursor === "string" && !!p1.json.nextCursor,
    "page1: limit=3 → 3 карточки + nextCursor",
  );
  check(p1items[0].accountId === myAccount, "page1: старейший аккаунт первым (createdAt asc)");
  check(cardsArePublic(p1items), "page1: приватных полей в items нет");
  check(p1.json?.total === 7, "page1: total — весь отфильтрованный набор (7), не страница");
  const cur1 = p1.json?.nextCursor;
  const last1 = p1items[p1items.length - 1];
  check(
    Buffer.from(cur1, "base64").toString("utf8") === `${last1.createdAt}:${last1.accountId}`,
    "page1: nextCursor = base64 «createdAt:accountId» последнего элемента страницы",
  );

  const p2 = await probe({ path: `/profiles?limit=3&cursor=${encodeURIComponent(cur1)}` });
  const p2items = p2.json?.items || [];
  check(
    p2.status === 200 && p2items.length === 3 && typeof p2.json?.nextCursor === "string" && !!p2.json.nextCursor,
    "page2: следующая тройка + свой nextCursor",
  );
  check(
    p2items.every(
      (it) => it.createdAt > last1.createdAt || (it.createdAt === last1.createdAt && it.accountId > last1.accountId),
    ),
    "page2: все элементы строго после позиции курсора",
  );
  check(cardsArePublic(p2items), "page2: приватных полей в items нет");

  const p3 = await probe({ path: `/profiles?limit=3&cursor=${encodeURIComponent(p2.json?.nextCursor)}` });
  const p3items = p3.json?.items || [];
  check(
    p3.status === 200 && p3items.length === 1 && p3.json?.nextCursor === null,
    "page3: последний batch → nextCursor null",
  );
  check(cardsArePublic(p3items), "page3: приватных полей в items нет");

  const allPages = [...p1items, ...p2items, ...p3items];
  check(new Set(allPages.map((it) => it.accountId)).size === 7 && allPages.length === 7, "pages: три страницы покрывают все 7 карточек без дублей");

  // 7i. limit по контракту: клэмп сверху, дефолт, мусор → 400
  const overLimit = await probe({ path: "/profiles?limit=100" });
  check(
    overLimit.status === 200 && overLimit.json?.ok === true && overLimit.json?.items?.length === 7 && overLimit.json?.nextCursor === null,
    "limit: 100 → 200 (клэмп до 48, не 400), весь набор на одной странице",
  );
  const lim1 = await probe({ path: "/profiles?limit=1" });
  check(
    lim1.status === 200 && lim1.json?.items?.length === 1 && !!lim1.json?.nextCursor,
    "limit: 1 → одна карточка + курсор",
  );
  const badLimits = [];
  for (const bad of ["0", "abc", "2.5"]) {
    const r = await probe({ path: `/profiles?limit=${encodeURIComponent(bad)}` });
    if (!(r.status === 400 && r.json?.ok === false && r.json?.reason === "invalid_limit")) badLimits.push(bad);
  }
  check(badLimits.length === 0, "limit: мусор (0/abc/2.5) → 400 invalid_limit");

  // 7j. invalid cursor → 400, а не молчаливая первая страница
  const b64Junk = await probe({ path: `/profiles?cursor=${encodeURIComponent("bm90LWN1cnNvcg==")}` });
  check(
    b64Junk.status === 400 && b64Junk.json?.ok === false && b64Junk.json?.reason === "invalid_cursor",
    "cursor: годный b64 не-курсор («not-cursor») → 400 invalid_cursor",
  );
  const rawJunk = await probe({ path: `/profiles?cursor=${encodeURIComponent("!!!garbage!!!")}` });
  check(
    rawJunk.status === 400 && rawJunk.json?.reason === "invalid_cursor",
    "cursor: b64-мусор → 400 invalid_cursor",
  );

  // 7k. несуществующий курсор (элемент удалён) — продолжение, не ошибка:
  // позиция старее всех карточек даёт ту же первую страницу.
  const ancientCursor = Buffer.from("999:zzz", "utf8").toString("base64");
  const ancient = await probe({ path: `/profiles?limit=3&cursor=${encodeURIComponent(ancientCursor)}` });
  check(
    ancient.status === 200 && JSON.stringify(ancient.json?.items) === JSON.stringify(p1items),
    "cursor: несуществующая позиция — 200, продолжение с ближайшей следующей (первая страница)",
  );
  // позиция «удалённого» элемента в середине списка: продолжение без него
  const BIG_ID = "zzzzzzzzzzzzzzzzzzzz";
  const midGone = await probe({
    path: `/profiles?limit=3&cursor=${encodeURIComponent(
      Buffer.from(`${last1.createdAt}:${BIG_ID}`, "utf8").toString("base64"),
    )}`,
  });
  check(
    midGone.status === 200 &&
      midGone.json?.items?.length === 3 &&
      midGone.json.items.every(
        (it) => it.createdAt > last1.createdAt || (it.createdAt === last1.createdAt && it.accountId > BIG_ID),
      ) &&
      !midGone.json.items.some((it) => p1items.some((x) => x.accountId === it.accountId)),
    "cursor: позиция удалённого элемента — продолжение без него и без 400",
  );

  // 7l. карточка по :id не зависит от limit/cursor/q в URL
  const kira = extras[3];
  const byIdWithParams = await probe({
    path: `/profiles/${kira.id}?limit=${encodeURIComponent("0")}&cursor=${encodeURIComponent("junk")}&q=${encodeURIComponent("миу")}`,
  });
  check(
    byIdWithParams.status === 200 &&
      byIdWithParams.json?.ok === true &&
      byIdWithParams.json?.accountId === kira.id &&
      !("login" in (byIdWithParams.json || {})) &&
      !("role" in (byIdWithParams.json || {})),
    "byId: карточка по id не зависит от limit/cursor/q (маршрут их не парсит)",
  );

  // 7m. поиск + пагинация вместе: q=«а» → 5 имён (Герта/Ольга/Тара/Марго/
  // Кира), limit=2 → страницы 2+2+1, объединение = весь результат
  const qaAll = await probe({ path: `/profiles?q=${encodeURIComponent("а")}` });
  check(
    qaAll.status === 200 && qaAll.json?.items?.length === 5 && qaAll.json?.total === 5 && qaAll.json?.nextCursor === null,
    "search: q=«а» без пагинации — все 5 карточек на одной странице",
  );
  const qa1 = await probe({ path: `/profiles?q=${encodeURIComponent("а")}&limit=2` });
  check(
    qa1.json?.items?.length === 2 && !!qa1.json?.nextCursor && qa1.json?.total === 5,
    "search+page1: 2 из 5 найденных, курсор есть, total прежний",
  );
  const qa2 = await probe({ path: `/profiles?q=${encodeURIComponent("а")}&limit=2&cursor=${encodeURIComponent(qa1.json?.nextCursor)}` });
  check(
    qa2.json?.items?.length === 2 &&
      !!qa2.json?.nextCursor &&
      qa2.json.items.every(
        (it) => it.createdAt > qa1.json.items[qa1.json.items.length - 1].createdAt ||
          (it.createdAt === qa1.json.items[qa1.json.items.length - 1].createdAt &&
            it.accountId > qa1.json.items[qa1.json.items.length - 1].accountId),
      ),
    "search+page2: продолжение строго после курсора",
  );
  const qa3 = await probe({ path: `/profiles?q=${encodeURIComponent("а")}&limit=2&cursor=${encodeURIComponent(qa2.json?.nextCursor)}` });
  check(
    qa3.json?.items?.length === 1 && qa3.json?.nextCursor === null,
    "search+page3: хвост запроса → nextCursor null",
  );
  const qaUnion = new Set([...(qa1.json?.items || []), ...(qa2.json?.items || []), ...(qa3.json?.items || [])].map((it) => it.accountId));
  check(
    qaUnion.size === 5 && (qaAll.json?.items || []).every((it) => qaUnion.has(it.accountId)),
    "search+pages: объединение страниц = весь результат запроса",
  );
} catch (e) {
  failures += 1;
  console.error("FAIL exception", e);
} finally {
  server.kill("SIGTERM");
}

/* ---------- 8. вариантная изоляция страниц (пост-сборочная) ----------
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
  check(!dirs.includes("game"), "isolation: в www-grotto нет game/ (поле elyria, P3 не регрессирует)");
  check(!dirs.includes("elision"), "isolation: в www-grotto нет elision/-стаба (P3 не регрессирует)");
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
