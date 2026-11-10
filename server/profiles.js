/**
 * HTTP-профили игроков — P4: рабочий каталог и правка СВОЕГО профиля.
 *
 *   GET    /profiles/me    200 { ok, ...publicProfile, sp? } | гость → 401
 *   PATCH  /profiles/me    200 { ok, ...publicProfile, sp? } — по cookie-сессии,
 *                          только своей записи; правятся profile.displayName
 *                          (он же — «ник на поле», синхронизируется в имя
 *                          активного персонажа), profile.bio, avatarCharacterId,
 *                          profile.birthday (день рождения: строго дата
 *                          «ГГГГ-ММ-ДД» реального календаря, не раньше
 *                          01.01.1900 и не позже сегодня, либо null/пустая
 *                          строка — сброс), sprite/scale (скин и рост
 *                          активного персонажа —
 *                          канонический сеттер accounts.applyProfileAppearance)
 *                          и sp (скрытые параметры: periodSec/damageLevel/
 *                          armorLevel — partial, отсутствие поля не трогает
 *                          сохранённое); никакой идентификации из body
 *                          (id/логин/роль — unknown_keys)
 *   GET    /profiles       200 { ok:true, items, total, nextCursor } — каталог
 *                          публичных карточек с серверной пагинацией/поиском:
 *                          ?limit (default 24; выше 48 — клэмп, НЕ 400;
 *                          мусор/0 → 400 invalid_limit), ?cursor (base64[64]
 *                          «<createdAt>:<accountId>» последнего элемента
 *                          страницы; мусор → 400 invalid_cursor — НЕ молчаливая
 *                          первая страница; ссылка на удалённый элемент — не
 *                          ошибка: keyset-продолжение с ближайшей позиции),
 *                          ?q (поиск по displayName: NFC+trim+lowercase,
 *                          длиннее 64 код-поинтов — обрезка префиксом, не 400;
 *                          пустой после чистки — без фильтра); total — дёшево:
 *                          длина уже собранного отфильтрованного набора
 *                          (legacy, НЕ контрактное поле — не полагаться).
 *                          Карточка каталога несёт lastSeenAt (время
 *                          последнего появления: сессии auth.js + книга
 *                          позиций persist.js). lastSeenRoom не отдаётся:
 *                          на Элизии одна локация, комнату не выдумываем.
 *                          birthday чужим — «ММ-ДД» без года; полная
 *                          «ГГГГ-ММ-ДД» остаётся в сторе и в /profiles/me.
 *   GET    /profiles/:id   200 { ok, accountId, ...publicProfile,
 *                          birthday «ММ-ДД»|null, lastSeenAt } | 404 unknown
 *   прочие суб-пути/методы 404 not_found — статике ничего не проваливается.
 *
 * Идентичность строго из серверной сессии (auth.sessionFromRequest): ни один
 * параметр тела запроса не выбирает чужую запись. Карточка — accounts.publicProfile,
 * единый источник DTO: без login, без role и без парольных полей.
 *
 * СП профиля (sp: periodSec/damageLevel/armorLevel) — приватные настройки
 * владельца: они читаются ТОЛЬКО владельцу (GET/PATCH /profiles/me и ответ
 * PATCH). В каталог GET /profiles и в карточку /profiles/:id sp НЕ входит —
 * публичный DTO не расширяется.
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
import { originAllowedHere, csrfDecision, siteClassOfRequest } from "./config.js";
import { sessionFromRequest, lastSeenByAccount } from "./auth.js";
import {
  publicProfile,
  findById,
  loadStore,
  flushAccounts,
  activeCharacter,
  applyProfileAppearance,
} from "./accounts.js";
import { catSeenAt } from "./persist.js";
import { spriteIdAllowed } from "./sprites.js";

const NAME_MIN = 1;
const NAME_MAX = 24;
const BIO_MAX = 280;
const ID_MAX = 128;
const BODY_LIMIT = 16 * 1024;

/* ------------- СП профиля: контракт скрытых параметров игрока ------------- */
/* Хранение: profile.sp = { periodSec, damageLevel, armorLevel } (partial: PATCH
 * без поля не трогает сохранённое — как bio). Отдаются только владельцу.
 * Диапазоны — те же, что предлагает экран входа (клиент шлёт готовые пресеты):
 * период оборота стрелы 1,8–5,0 сек (округление до 0,1), урон/броня —
 * целые пресеты 0–9, на клиенте они подписаны как 0,0–0,9. */
const SP_PERIOD_MIN = 1.8;
const SP_PERIOD_MAX = 5;
const SP_LEVEL_MIN = 0;
const SP_LEVEL_MAX = 9;

/* ------------- B3: пагинация и поиск каталога GET /profiles ------------- */

const PAGE_DEFAULT = 24;
const PAGE_MAX = 48; // выше — клэмп (списку не вредит), НЕ 400
const QUERY_MAX = 64; // код-поинты: длиннее — обрезка префиксом, НЕ 400
const CURSOR_MAX = 256; // символов сырого курсора: длиннее — invalid_cursor

/** Тот же класс невидимых/bidi-символов, что в sanitize.js: без него «Сы\u200Bрь»
 * визуально неотличимо от «Сырь» и подменяет показное имя. */
const INVISIBLE_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Та же пара (Origin, класс сайта), что в общем HTTP-слое и /auth. */
function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin && originAllowedHere(origin, siteClassOfRequest(req))) {
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

/** День рождения для чужой карточки: «ММ-ДД», без года. Полная «ГГГГ-ММ-ДД»
 *  остаётся в accounts.json и в ответе владельцу (/profiles/me, PATCH).
 *  Мусор и пустота уже схлопнуты publicProfile в null — здесь не выдумываем дату. */
function publicBirthday(full) {
  return typeof full === "string" && /^\d{4}-\d{2}-\d{2}$/.test(full) ? full.slice(5) : null;
}

/** Карточка каталога/страницы: accountId + публичный DTO без login/role/пароля.
 *  lastSeenAt — время последнего появления (максимум из свежайшей живой
 *  сессии аккаунта и последней записи позиции кота в книге «теста»; 0 = данных
 *  нет — клиент рисует «неизвестно», а не выдумывает). Комнату последней
 *  записи (lastSeenRoom) не отдаём: на Элизии одна локация, поле бессмысленно,
 *  и пустоту не подменяем выдуманной комнатой. Источники только читаются:
 *  сессии (auth.js) и книга позиций (persist.js). Книга ключуется ИМЕНЕМ
 *  персонажа — одноимённые коты неразличимы, это честно отражает источник. */
function card(acc, sessionSeen) {
  const chars = Array.isArray(acc.characters) ? acc.characters : [];
  let catTs = 0;
  for (const ch of chars) {
    if (!ch || typeof ch !== "object") continue;
    const ts = catSeenAt(ch.name);
    if (ts > catTs) catTs = ts;
  }
  const seen = Math.max(catTs, sessionSeen.get(String(acc.id || "")) || 0);
  const pub = publicProfile(acc);
  return {
    accountId: String(acc.id || ""),
    ...pub,
    birthday: publicBirthday(pub && pub.birthday),
    lastSeenAt: seen,
  };
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

/* ------------- B3: разбор limit/cursor/q и keyset-навигация --------------- */

/** Нормализация поискового текста: NFC → вырезаны невидимые → пробелы
 *  схлопнуты, края тримиты → нижний регистр. Одна и та же функция для q и
 *  displayName — сравнение подстрокой по обеим нормализованным сторонам. */
function normText(raw) {
  return String(raw ?? "")
    .normalize("NFC")
    .replace(INVISIBLE_RE, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** LIMIT: default 24; выше 48 — клэмп. Мусор — не-цифры, 0, дроби —
 *  400 invalid_limit; «?limit=» (значение пусто) трактуется как дефолт.
 *  Порядок разбора параметров фиксирован: limit → cursor → q. */
function parseLimit(raw) {
  if (raw === null || raw === undefined || raw === "") return PAGE_DEFAULT;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new Error("invalid_limit");
  const n = Number(s);
  if (n < 1) throw new Error("invalid_limit");
  return Math.min(n, PAGE_MAX);
}

/** Курсор: base64(«<createdAt>:<accountId>») последнего элемента предыдущей
 *  страницы. Допускается base64url (- _ вместо + /) и пробел как не-закоди-
 *  рованный «+». Битое — 400 invalid_cursor: сломанная навигация должна быть
 *  видимой ошибкой, а не молчаливой первой страницей. Безопасно: длина
 *  ограничена, декодированный формат строго /^\d+:строка$/. */
function parseCursor(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  let s = String(raw);
  if (s.length > CURSOR_MAX) throw new Error("invalid_cursor");
  s = s.replace(/ /g, "+").replace(/-/g, "+").replace(/_/g, "/");
  const text = Buffer.from(s, "base64").toString("utf8");
  const m = text.match(/^(\d+):([\s\S]{1,128})$/);
  if (!m) throw new Error("invalid_cursor");
  return { createdAt: Number(m[1]), accountId: m[2] };
}

function encodeCursor(item) {
  return Buffer.from(`${item.createdAt}:${item.accountId}`, "utf8").toString("base64");
}

/** Позиция продолжения: индекс первого элемента СТРОГО после
 *  (createdAt, accountId) по порядку bySeniority — бинарный поиск по тому
 *  же правилу, которым список отсортирован. Элемент курсора может быть уже
 *  удалён — позиция всё равно осмысленна (keyset, не индекс: продолжение
 *  с ближайшей следующей позиции, без ошибки и без пропусков). */
function afterCursor(cards, cur) {
  let lo = 0;
  let hi = cards.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const c = cards[mid];
    if (c.createdAt < cur.createdAt || (c.createdAt === cur.createdAt && c.accountId <= cur.accountId)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Q: нормализуется; пустой после чистки → без фильтра. Длиннее QUERY_MAX
 *  код-поинтов — обрезка до префикса, НЕ 400 (зафиксировано тестом: длинный
 *  поисковый запрос всё ещё «ищется», а не отбивается). */
function parseQuery(raw) {
  const norm = normText(raw);
  if (!norm) return "";
  return Array.from(norm).slice(0, QUERY_MAX).join("");
}

/* ------------------------- PATCH: валидация тела ------------------------- */

/* Внешность из профиля: спрайт и размер персистятся в АКТИВНОМ персонаже
 * (accounts.applyProfileAppearance — канонический сеттер вне room-join).
 * Спрайт — только id из живого каталога (whitelist, как attachSprite);
 * размер — проценты роста 60–100, зажим и округление как в room-join. */
const PATCH_FLAT = ["displayName", "bio", "avatarCharacterId", "birthday", "sprite", "scale"];

/* Birthday: формат хранения — строка «ГГГГ-ММ-ДД» либо null (не заполнено).
 * Диапазон: от 01.01.1900 до сегодняшнего дня по UTC включительно. */
const BIRTHDAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BIRTHDAY_MIN_MS = Date.UTC(1900, 0, 1);

/** Полночь текущих UTC-суток: правая граница «до сегодня включительно». */
function todayUtcStartMs() {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Дата существует в реальном календаре и лежит в допустимом диапазоне:
 *  компоненты созданной UTC-даты обязаны совпасть с исходной строкой — так
 *  «2026-02-30» (V8 честно скатывает его в 2 марта) и «2026-13-01»
 *  (Invalid Date) отбиваются по фактическому мусору, а 29 февраля
 *  проходит ровно в високосные годы. */
function birthdayOk(raw) {
  const d = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  if (
    d.getUTCFullYear() !== Number(raw.slice(0, 4)) ||
    d.getUTCMonth() !== Number(raw.slice(5, 7)) - 1 ||
    d.getUTCDate() !== Number(raw.slice(8, 10))
  ) {
    return false;
  }
  return d.getTime() >= BIRTHDAY_MIN_MS && d.getTime() <= todayUtcStartMs();
}

/** СП профиля для владельца — читанье из стора (только честные значения:
 *  мусор молча прячется, битые поля не отдаются). None → ключа нет вовсе. */
function spView(acc) {
  const raw = acc?.profile?.sp;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out = {};
  if (typeof raw.periodSec === "number" && Number.isFinite(raw.periodSec)) {
    out.periodSec = Math.round(raw.periodSec * 10) / 10;
  }
  for (const key of ["damageLevel", "armorLevel"]) {
    const n = raw[key];
    if (Number.isInteger(n) && n >= SP_LEVEL_MIN && n <= SP_LEVEL_MAX) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Разбор тела PATCH. Принимает плоские поля (displayName, bio,
 * avatarCharacterId, birthday), вложенный объект sp {periodSec?, damageLevel?,
 * armorLevel?} (и то же под profile.sp — ради терминологии /auth/me) и
 * вложенные profile.{displayName,bio,avatarCharacterId}. Идентификационные
 * ключи (id, accountId, login, role, characters...) не входят в белый
 * список и отбиваются unknown_keys — «никакого идентификатора из body».
 * СП — только готовые числа: период 1,8–5,0 сек с округлением до 0,1, пресеты
 * урона/брони — целые 0–9; выход за диапазон = 400 invalid, НЕ молчаливый
 * зажим (сохраниться должно ровно то, что игрок выставил в профиле).
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

  /** Один вложенный объект СП: знакомые ключи валидируются по строгим
   *  диапазонам, незнакомые — unknown_keys (как profile.*). */
  const applySp = (raw) => {
    seen += 1;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      invalid.push({ key: "sp", error: "объект полей: periodSec, damageLevel, armorLevel" });
      return;
    }
    for (const [key, v] of Object.entries(raw)) {
      if (key === "periodSec") {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          invalid.push({ key: "sp.periodSec", error: "число от 1,8 до 5,0" });
          continue;
        }
        const p = Math.round(v * 10) / 10;
        if (p < SP_PERIOD_MIN || p > SP_PERIOD_MAX) {
          invalid.push({ key: "sp.periodSec", error: "число от 1,8 до 5,0" });
          continue;
        }
        values.sp = values.sp || {};
        values.sp.periodSec = p;
        continue;
      }
      if (key === "damageLevel" || key === "armorLevel") {
        if (typeof v !== "number" || !Number.isInteger(v) || v < SP_LEVEL_MIN || v > SP_LEVEL_MAX) {
          invalid.push({ key: `sp.${key}`, error: "пресет от 0 до 9" });
          continue;
        }
        values.sp = values.sp || {};
        values.sp[key] = v;
        continue;
      }
      unknown.push(`sp.${key}`);
    }
  };

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
    if (key === "birthday") {
      // Формат хранения: null/пустая строка — сброс, иначе строго «ГГГГ-ММ-ДД»
      // реального дня из диапазона 01.01.1900 — сегодня (см. birthdayOk):
      // выход за диапазон или ложная дата — видимая 400-ошибка, НЕ зажим.
      if (raw === null || raw === "") {
        values.birthday = null;
        return;
      }
      if (typeof raw === "string" && BIRTHDAY_RE.test(raw) && birthdayOk(raw)) {
        values.birthday = raw;
        return;
      }
      invalid.push({ key, error: "дата ГГГГ-ММ-ДД, не раньше 01.01.1900 и не позже сегодня" });
      return;
    }
    if (key === "sprite") {
      // Whitelist живого каталога (как attachSprite): сохранение чужого id —
      // видимая 400-ошибка, а не молчаливый старый спрайт.
      const want = typeof raw === "string" ? raw.trim() : "";
      if (!want || !spriteIdAllowed(want)) {
        invalid.push({ key, error: "неизвестный скин" });
        return;
      }
      values.sprite = want;
      return;
    }
    if (key === "scale") {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        invalid.push({ key, error: "число от 60 до 100" });
        return;
      }
      // Зажим в 60–100 и округление — как рост в room-join (room.js).
      values.scale = Math.min(100, Math.max(60, Math.round(raw)));
      return;
    }
    unknown.push(key);
  };

  for (const [key, raw] of Object.entries(body)) {
    if (key === "profile") continue; // разобран ниже, плоские ключи не дублируются
    if (key === "sp") {
      applySp(raw);
      continue;
    }
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
    if (key === "sp") {
      applySp(raw);
      continue;
    }
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
      // СП — только владельцу своей записи (см. spView и шапку модуля).
      json(res, 200, { ok: true, ...publicProfile(session.account), sp: spView(session.account) });
      return true;
    }
    if (req.method === "PATCH") {
      // Правка — только по сессии и только своей записи.
      const session = sessionFromRequest(req);
      if (!session) {
        json(res, 401, { ok: false, reason: "auth_required" });
        return true;
      }
      // Повторная проверка использует общую политику, а не старый список:
      // легитимный адрес сайта не обязан дублироваться в ALLOWED_ORIGINS.
      const csrfBad = csrfDecision({
        method: req.method, origin: req.headers.origin,
        destClass: siteClassOfRequest(req), hasAuth: true,
      });
      if (csrfBad) {
        json(res, csrfBad.status, { ok: false, reason: csrfBad.reason });
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
      // Birthday — partial-merge как у соседей: поля нет — сохранённое не
      // трогаем; null — сброс в null (пустая дата = дня рождения нет).
      if (values.birthday !== undefined) acc.profile.birthday = values.birthday;
      // СП — partial-merge: в PATCH нет поля → сохранённое не трогаем.
      if (values.sp) {
        const cur =
          acc.profile.sp && typeof acc.profile.sp === "object" && !Array.isArray(acc.profile.sp)
            ? acc.profile.sp
            : {};
        acc.profile.sp = { ...cur, ...values.sp };
      }
      // Внешность (скин/рост) и «ник на поле» — канонический сеттер активного
      // персонажа: displayName синхронизируется в его имя даже без смены скина.
      if (values.sprite !== undefined || values.scale !== undefined || values.displayName !== undefined) {
        if (!activeCharacter(acc)) {
          json(res, 400, { ok: false, reason: "invalid", invalid: [{ key: "sprite", error: "у аккаунта нет персонажа" }] });
          return true;
        }
        applyProfileAppearance(acc, { sprite: values.sprite, scale: values.scale, name: values.displayName });
      }
      flushAccounts(true); // форс-проход: markDirty внутри accounts не экспортирован
      json(res, 200, { ok: true, ...publicProfile(acc), sp: spView(acc) });
      return true;
    }
  }

  if (p === "/profiles" && req.method === "GET") {
    // Параметры каталога разбираются ДО перечисления: мусорный limit/cursor
    // отбивается 400 без чтения стора. Порядок разборов limit → cursor → q
    // фиксирован: при нескольких ошибках отвечает первая по порядку.
    let limit;
    let cursor;
    let q;
    try {
      limit = parseLimit(url.searchParams.get("limit"));
      cursor = parseCursor(url.searchParams.get("cursor"));
      q = parseQuery(url.searchParams.get("q"));
    } catch (e) {
      const reason = e && e.message === "invalid_limit" ? "invalid_limit" : "invalid_cursor";
      json(res, 400, { ok: false, reason });
      return true;
    }
    // Каталог: keyset-пагинация поверх стабильного порядка bySeniority.
    // store перечитывается с диска (loadStore): все мутации аккаунтов пишут
    // файл синхронно (markDirty → flushAccounts), так что диск согласован с
    // памятью; перечисление store без расширения accounts.js недоступно.
    // P5: карта «последний вход» считается один раз на запрос (read-only
    // сессии) и раздаётся карточкам.
    const seenMap = lastSeenByAccount();
    let rows = [];
    try {
      rows = Object.values(loadStore().accounts || {});
    } catch {
      rows = [];
    }
    let items = rows.filter(hasPublicProfile).map((acc) => card(acc, seenMap)).sort(bySeniority);
    if (q) {
      // Подстрока по нормализованным displayName: разница регистра,
      // декомпозиции и пробелов не влияет на результат (NFC+trim+lower —
      // одна и та же нормализация у q и у имени).
      items = items.filter((c) => normText(c.displayName).includes(q));
    }
    const start = cursor ? afterCursor(items, cursor) : 0;
    // total — дёшево (длина уже собранного набора), не контракт: клиент
    // страницы не запрашивает и на total не полагается; поле осталось
    // legacy-совместимости ради старых потребителей ответа.
    const page = items.slice(start, start + limit);
    const nextCursor = start + limit < items.length && page.length ? encodeCursor(page[page.length - 1]) : null;
    json(res, 200, { ok: true, items: page, total: items.length, nextCursor });
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
        json(res, 200, { ok: true, ...card(acc, lastSeenByAccount()) });
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
