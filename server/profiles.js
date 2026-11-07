/**
 * HTTP-профили игроков — P4: рабочий каталог и правка СВОЕГО профиля.
 *
 *   GET    /profiles/me    200 { ok, ...publicProfile } | гость → 401 auth_required
 *   PATCH  /profiles/me    200 { ok, ...publicProfile } — по cookie-сессии,
 *                          только своей записи; правятся profile.displayName,
 *                          profile.bio и avatarCharacterId; никакой
 *                          идентификации из body (id/логин/роль — unknown_keys)
 *   GET    /profiles       200 { ok:true, items:[карточки], total } — каталог
 *                          публичных карточек, стабильный порядок, без пагинации
 *   GET    /profiles/:id   200 { ok, accountId, ...publicProfile } | 404 unknown
 *   прочие суб-пути/методы 404 not_found — статике ничего не проваливается.
 *
 * Идентичность строго из серверной сессии (auth.sessionFromRequest): ни один
 * параметр тела запроса не выбирает чужую запись. Карточка — accounts.publicProfile,
 * единый источник DTO: без login, без role и без парольных полей.
 *
 * «Публичный профиль» — запись profile, которую создаёт платформенная
 * регистрация (accounts.createAccount). Строки стора БЕЗ profile (легаси/ручные
 * правки файла) в каталоге не показываются и по :id отвечают «не найден» —
 * владелец их не заполнял, публичной карточки у них нет; правка профиля
 * (PATCH) создаёт profile и публикует карточку.
 *
 * Домен-изоляция: на public-хосте весь /profiles/* закрыт гейтом net.js ещё
 * до этого обработчика; сюда класс public дотянуться не может.
 */
import { isAllowedOrigin } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { publicProfile, findById, loadStore, flushAccounts } from "./accounts.js";

const NAME_MIN = 1;
const NAME_MAX = 24;
const BIO_MAX = 280;
const ID_MAX = 128;
const BODY_LIMIT = 16 * 1024;

/** Тот же класс невидимых/bidi-символов, что в sanitize.js: без него «Сы\u200Bрь»
 * визуально неотличимо от «Сырь» и подменяет показное имя. */
const INVISIBLE_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Тот же CORS-набор, что у /auth и /cfg: белые Origin получают явное разрешение. */
function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,PATCH,OPTIONS");
}

/** Тела PATCH немного: общий парсер auth.readJson здесь недоступен без
 * расширения auth.js (заморожен), поэтому локальная копия той же схемы. */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > BODY_LIMIT) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("json"));
      }
    });
    req.on("error", reject);
  });
}

/** Чистка одного текстового поля: невидимые вырезаются, пробелы схлопываются,
 * края тримятся. Длина считается по код-поинтам (эмодзи-суррогаты не рвутся).
 * Возвращает текст И длину: длинные мы ОТКАЗЫВАЕМ (400), а не режем молча —
 * иначе молчаливое усечение прятало бы от игрока часть введённого. */
function cleanText(raw) {
  const text = String(raw ?? "")
    .replace(INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return { text, len: Array.from(text).length };
}

/** Карточка каталога/страницы: accountId + публичный DTO без login/role/пароля. */
function card(acc) {
  return { accountId: String(acc.id || ""), ...publicProfile(acc) };
}

/** Стабильный порядок каталога: старейшие аккаунты впереди, при равных
 * createdAt — по accountId. Порядок не зависит от порядка ключей в файле. */
function bySeniority(a, b) {
  const t = (a.createdAt || 0) - (b.createdAt || 0);
  if (t !== 0) return t;
  return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;
}

/** Публичная карточка есть только у строки с заполненным profile (см. шапку). */
function hasPublicProfile(row) {
  if (!row || typeof row !== "object") return false;
  const p = row.profile;
  return (
    !!p && typeof p === "object" && typeof p.displayName === "string" && p.displayName.trim().length > 0
  );
}

/* ------------------------- PATCH: валидация тела ------------------------- */

const PATCH_FLAT = ["displayName", "bio", "avatarCharacterId"];

/**
 * Разбор тела PATCH. Принимает плоские поля (displayName, bio,
 * avatarCharacterId) и вложенные profile.{displayName,bio} —ради той же
 * терминологии, что в /auth/me. Идентификационные ключи (id, accountId, login,
 * role, characters...) не входят в белый список и отбиваются unknown_keys —
 * «никакого идентификатора из body».
 * Возвращает { values, invalid, unknown, seen }.
 */
function sanitizePatch(body, account) {
  const values = {};
  const invalid = [];
  const unknown = [];
  let seen = 0;

  const charIds = new Set(
    (Array.isArray(account.characters) ? account.characters : [])
      .map((c) => (c && typeof c === "object" && typeof c.id === "string" ? c.id : null))
      .filter(Boolean),
  );

  const applyField = (key, raw) => {
    seen += 1;
    if (key === "displayName") {
      const { text, len } = cleanText(raw);
      if (len < NAME_MIN || len > NAME_MAX) {
        invalid.push({ key, error: "видимая длина от 1 до 24 символов" });
        return;
      }
      values.displayName = text;
      return;
    }
    if (key === "bio") {
      const { text, len } = cleanText(raw);
      if (len > BIO_MAX) {
        invalid.push({ key, error: "видимая длина до 280 символов" });
        return;
      }
      values.bio = text;
      return;
    }
    if (key === "avatarCharacterId") {
      if (raw === null || raw === undefined) {
        values.avatarCharacterId = null;
        return;
      }
      if (typeof raw !== "string" || !charIds.has(raw)) {
        invalid.push({ key, error: "неизвестный персонаж (null — без аватара)" });
        return;
      }
      values.avatarCharacterId = raw;
      return;
    }
    unknown.push(key);
  };

  for (const [key, raw] of Object.entries(body)) {
    if (key === "profile") continue; // разобран ниже, плоские ключи не дублируются
    if (PATCH_FLAT.includes(key)) applyField(key, raw);
    else unknown.push(key);
  }
  const nested = body.profile;
  if (nested === undefined || nested === null) return { values, invalid, unknown, seen };
  if (typeof nested !== "object" || Array.isArray(nested)) {
    invalid.push({ key: "profile", error: "должен быть объектом полей профиля" });
    return { values, invalid, unknown, seen };
  }
  for (const [key, raw] of Object.entries(nested)) {
    if (PATCH_FLAT.includes(key)) applyField(key, raw);
    else unknown.push(`profile.${key}`);
  }
  return { values, invalid, unknown, seen };
}

/* ------------------------------ диспетчер ------------------------------- */

export async function handleProfilesHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  if (p !== "/profiles" && !p.startsWith("/profiles/")) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (p === "/profiles/me") {
    if (req.method === "GET") {
      const session = sessionFromRequest(req);
      if (!session) {
        json(res, 401, { ok: false, reason: "auth_required" });
        return true;
      }
      json(res, 200, { ok: true, ...publicProfile(session.account) });
      return true;
    }
    if (req.method === "PATCH") {
      // Правка — только по сессии и только своей записи.
      const session = sessionFromRequest(req);
      if (!session) {
        json(res, 401, { ok: false, reason: "auth_required" });
        return true;
      }
      // CSRF-щит в стиле auth.js для пишущих методов: непустой чужой Origin →
      // 403 ещё до разбора тела (куки браузера уезжают и на злые сайты).
      const origin = String(req.headers.origin || "");
      if (origin && !isAllowedOrigin(origin)) {
        json(res, 403, { ok: false, reason: "csrf" });
        return true;
      }
      let body;
      try {
        body = await readJson(req);
      } catch {
        json(res, 400, { ok: false, reason: "invalid_body" });
        return true;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        json(res, 400, { ok: false, reason: "invalid_body" });
        return true;
      }
      const { values, invalid, unknown, seen } = sanitizePatch(body, session.account);
      if (unknown.length) {
        json(res, 400, { ok: false, reason: "unknown_keys", unknown, allowed: [...PATCH_FLAT] });
        return true;
      }
      if (invalid.length) {
        json(res, 400, { ok: false, reason: "invalid", invalid });
        return true;
      }
      if (!seen) {
        json(res, 400, { ok: false, reason: "empty_patch" });
        return true;
      }
      const acc = session.account;
      // Легаси-строка без profile получает профиль в момент правки — это и есть
      // акт «опубликовать карточку» (см. hasPublicProfile).
      if (!acc.profile || typeof acc.profile !== "object") {
        acc.profile = { displayName: String(acc.login || "") };
      }
      if (values.displayName !== undefined) acc.profile.displayName = values.displayName;
      if (values.bio !== undefined) acc.profile.bio = values.bio;
      if (values.avatarCharacterId !== undefined) acc.profile.avatarCharacterId = values.avatarCharacterId;
      flushAccounts(true); // форс-проход: markDirty внутри accounts не экспортирован
      json(res, 200, { ok: true, ...publicProfile(acc) });
      return true;
    }
  }

  if (p === "/profiles" && req.method === "GET") {
    // Каталог: перечисление без пагинации, стабильный порядок. store перечитывается
    // с диска (loadStore): все мутации аккаунтов пишут файл синхронно (markDirty →
    // flushAccounts), так что диск согласован с памятью; перечисление store
    // без расширения accounts.js недоступно.
    let rows = [];
    try {
      rows = Object.values(loadStore().accounts || {});
    } catch {
      rows = [];
    }
    const items = rows.filter(hasPublicProfile).map(card).sort(bySeniority);
    json(res, 200, { ok: true, items, total: items.length });
    return true;
  }

  if (req.method === "GET" && p.startsWith("/profiles/")) {
    const rest = p.slice("/profiles/".length);
    // Один сегмент-идентификатор; вложенные суб-пути — общий 404 ниже.
    if (rest && !rest.includes("/")) {
      if (rest.length > ID_MAX) {
        json(res, 404, { ok: false, reason: "unknown" });
        return true;
      }
      const acc = findById(rest);
      if (acc && hasPublicProfile(acc)) {
        json(res, 200, { ok: true, ...card(acc) });
        return true;
      }
      // Не найден ИЛИ без публичного профиля: единый ответ без раскрытия
      // существования скрытых аккаунтов.
      json(res, 404, { ok: false, reason: "unknown" });
      return true;
    }
  }

  json(res, 404, { ok: false, reason: "not_found" });
  return true;
}
