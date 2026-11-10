/**
 * Профили игроков (P4 + follow-up B3: серверная пагинация и поиск).
 * Вынесены из http-auth.ts, чтобы модуль-граф симулятора не тянул
 * /profiles-маршруты в public-бандл гротов (изоляция сайтов, §10.4).
 *
 * Контракты сервера (server/profiles.js):
 *   GET   /profiles/me   → 200 {ok, ...publicProfile} | гость 401 auth_required
 *   PATCH /profiles/me   → 200 {ok, ...publicProfile} | 400 unknown_keys/invalid/
 *                          empty_patch/invalid_body | 401 | 403 csrf
 *   GET   /profiles      → 200 {ok, items:[карточки], nextCursor, total(legacy)} —
 *                          каталог с серверной пагинацией (?limit, ?cursor) и
 *                          поиском (?q); nextCursor:null — страница последняя;
 *                          total — legacy-поле, НЕ контракт: не полагаться;
 *                          мусорный limit/cursor → 400 invalid_limit/invalid_cursor
 *   GET   /profiles/:id  → 200 {ok, accountId, ...publicProfile} | 404 unknown
 */
import { apiFetch, asId, asText, type ApiRow } from "./http-auth";

/** Вариант сборки (как http-auth.ts): литералы закрытых маршрутов
 *  вырезаются env-DCE в грот-бандле (канон P3, прецедент authRoute). */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === "elyria";

/** Маршрут профилей с env-DCE: в грот-сборке мёртвая ветка удаляется
 *  минификатором — литералов закрытой зоны в публичном бандле нет вовсе,
 *  живой вызов невозможен ('/dev/null' не несёт намёка). */
function profilesRoute(kind: "me"): string;
function profilesRoute(kind: "card", id: string): string;
function profilesRoute(kind: "me" | "card", id?: string): string {
  if (!IS_ELYRIA) return "/dev/null";
  if (kind === "me") return "/profiles/me";
  return `/profiles/${encodeURIComponent(id ?? "")}`;
}

/** Каталог профилей (страница /players/ — только Элизия): лимит/курсор
 *  строго валидируются сервером (см. server/profiles.js). В грот-сборке
 *  литерал вырезается той же env-DCE-веткой. */
function profilesCatalogRoute(qs: string): string {
  if (!IS_ELYRIA) return "/dev/null";
  return qs ? `/profiles?${qs}` : "/profiles";
}

export type ProfileCharacter = { id: string; name: string; sprite: string; size: number };

/** Публичный DTO (accounts.publicProfile): без login, role и пароля.
 *  lastSeenAt — время последнего появления (максимум свежайшей сессии и
 *  последней записи кота; 0 = неизвестно, честное «неизвестно» вместо
 *  выдумки). Комнаты последней записи в DTO нет. Сервер может не прислать
 *  lastSeenAt (свой /profiles/me его не несёт) — поэтому поле необязательное. */
export type PublicProfile = {
  displayName: string;
  bio: string;
  /** День рождения. Свой /profiles/me — полная «ГГГГ-ММ-ДД» (чтобы править).
   *  Чужая карточка и каталог — «ММ-ДД» без года. null — владелец не указал
   *  дату; карточка не выдумывает её. */
  birthday: string | null;
  /** Своя загруженная картинка: URL файла аватара или null — портрет
   *  карточки рисует её вместо спрайта персонажа. */
  avatar: string | null;
  avatarCharacterId: string | null;
  characters: ProfileCharacter[];
  activeCharacterId: string | null;
  createdAt: number;
  lastSeenAt?: number;
};

/** Карточка каталога: DTO + accountId (для deep-link /players?id=). */
export type ProfileCard = PublicProfile & { accountId: string };

/** СП профиля (скрытые параметры): сервер хранит их у записи и отдаёт
 *  ТОЛЬКО владельцу (/profiles/me) — в карточки каталога и чужие профили
 *  sp не входит. Все поля необязательны: partial-сохранение (PATCH без
 *  поля не трогает сохранённое) — частичный объект это честный ответ. */
export type ProfileSp = {
  periodSec?: number;
  damageLevel?: number;
  armorLevel?: number;
};

/** Свой профиль (/profiles/me): публичный DTO + приватные СП. */
export type ProfileMe = PublicProfile & { sp?: ProfileSp };

export type ProfilePatch = {
  displayName?: string;
  bio?: string;
  /** День рождения: строка ГГГГ-ММ-ДД или null (сброс) — уезжает в PATCH
   *  обычной строкой (не датой-объектом); partial: шлём только при отличии. */
  birthday?: string | null;
  avatarCharacterId?: string | null;
  /** Скин активного персонажа — id из каталога спрайтов (GET /sprites/catalog);
   *  сервер валидирует по live-whitelist и отвечает 400 при чужом id. */
  sprite?: string;
  /** Рост модельки, % (60–100): сервер зажимает и округляет, как room-join. */
  scale?: number;
  sp?: ProfileSp;
};

export type ProfileResult = { ok: boolean; reason?: string; details?: string; profile?: ProfileMe };

/** Маски дня рождения: полная «ГГГГ-ММ-ДД» (свой /profiles/me) и публичная
 *  «ММ-ДД» без года. Прочий мусор DTO сворачивается в null. */
const BIRTHDAY_FULL_RE = /^\d{4}-\d{2}-\d{2}$/;
const BIRTHDAY_MONTH_DAY_RE = /^\d{2}-\d{2}$/;

/** День рождения DTO: полная дата или месяц-день остаются строкой, мусор → null. */
function asBirthday(v: unknown): string | null {
  return typeof v === "string" && (BIRTHDAY_FULL_RE.test(v) || BIRTHDAY_MONTH_DAY_RE.test(v)) ? v : null;
}

function parseCharacters(raw: unknown): ProfileCharacter[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => !!c && typeof c === "object")
    .map((c) => {
      const row = c as Record<string, unknown>;
      return {
        id: asText(row.id),
        name: asText(row.name),
        sprite: asText(row.sprite),
        size: Number.isFinite(Number(row.size)) ? Number(row.size) : 100,
      };
    })
    .filter((c) => c.id);
}

/** Разбор приватных СП из ответа /profiles/me: мусор молча отбрасывается,
 *  пустой объект → sp нет вовсе (владелец их ещё не сохранял). */
function parseSp(raw: unknown): ProfileSp | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const sp: ProfileSp = {};
  if (typeof row.periodSec === "number" && Number.isFinite(row.periodSec)) {
    sp.periodSec = Math.round(row.periodSec * 10) / 10;
  }
  for (const key of ["damageLevel", "armorLevel"] as const) {
    const n = row[key];
    if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 9) sp[key] = n;
  }
  return Object.keys(sp).length ? sp : undefined;
}

function parseProfile(row: ApiRow): ProfileMe {
  return {
    displayName: asText(row.displayName),
    bio: asText(row.bio),
    birthday: asBirthday(row.birthday),
    avatar: asId(row.avatar),
    avatarCharacterId: asId(row.avatarCharacterId),
    characters: parseCharacters(row.characters),
    activeCharacterId: asId(row.activeCharacterId),
    createdAt: Number.isFinite(Number(row.createdAt)) ? Number(row.createdAt) : 0,
    // P5: только конечные числа и строки/NULL — мусор схлопывается в
    // «неизвестно» (0/null), чтобы UI не рисовал выдуманное время.
    lastSeenAt: Number.isFinite(Number(row.lastSeenAt)) ? Number(row.lastSeenAt) : 0,
    // СП — только из ответа своего /profiles/me (владелец).
    sp: parseSp(row.sp),
  };
}

/** Сведение ответа профиля: ok-строка → {ok:true, profile}, ошибки → reason+details. */
function toProfileResult(status: number, row: ApiRow | null, text: string): ProfileResult {
  if (status === 200 && row?.ok === true) return { ok: true, profile: parseProfile(row) };
  const reason =
    row?.reason === "auth_required" || row?.reason === "unknown" || row?.reason === "not_found"
      ? String(row.reason)
      : status === 0
        ? "offline"
        : "error";
  return { ok: false, reason, details: text || JSON.stringify(row) || "" };
}

/** Параметры страницы каталога: все опциональны. Без них — первая страница с
 *  серверным дефолтом limit=24 (обратная совместимость старых вызовов). */
export type ProfileCatalogPage = {
  limit?: number;
  cursor?: string;
  q?: string;
};

/** Каталог публичных карточек: {ok, items, nextCursor} | ошибка.
 *  nextCursor — курсор следующей страницы (null — страница последняя);
 *  серверный invalid_limit/invalid_cursor проходит в reason для человеко-
 *  читаемого показа. total — legacy-поле ответа, НЕ контракт: не полагаться. */
export async function httpProfileCatalog(
  page: ProfileCatalogPage = {},
): Promise<
  | { ok: true; items: ProfileCard[]; nextCursor: string | null; total?: number }
  | { ok: false; reason: string; details?: string }
> {
  const params = new URLSearchParams();
  if (typeof page.limit === "number" && Number.isFinite(page.limit) && page.limit > 0) {
    params.set("limit", String(Math.floor(page.limit)));
  }
  if (typeof page.cursor === "string" && page.cursor) params.set("cursor", page.cursor);
  if (typeof page.q === "string" && page.q.trim()) params.set("q", page.q);
  const qs = params.toString();
  const { status, row, text } = await apiFetch(profilesCatalogRoute(qs));
  if (status === 200 && row?.ok === true && Array.isArray(row.items)) {
    const items = (row.items as unknown[])
      .filter((it): it is ApiRow => !!it && typeof it === "object")
      .map((it) => ({ accountId: asText(it.accountId), ...parseProfile(it) }));
    return {
      ok: true,
      items,
      nextCursor: typeof row.nextCursor === "string" && row.nextCursor ? row.nextCursor : null,
      total: Number.isFinite(Number(row.total)) ? Number(row.total) : undefined,
    };
  }
  return { ok: false, reason: catalogErrorReason(status, row), details: text || undefined };
}

/** Причина сбоя каталога: сеть → offline; серверные reason (в т.ч. 400-е
 *  invalid_cursor/invalid_limit) проходят насквозь для человекочитаемого
 *  показа в UI; прочее — общий error. */
function catalogErrorReason(status: number, row: ApiRow | null): string {
  if (status === 0) return "offline";
  if (typeof row?.reason === "string" && row.reason) return row.reason;
  return "error";
}

/** Карточка по accountId (deep-link): DTO или 404/ошибка. */
export async function httpProfileById(accountId: string): Promise<ProfileResult & { card?: ProfileCard }> {
  const id = encodeURIComponent(accountId);
  const { status, row, text } = await apiFetch(profilesRoute("card", id));
  const base = toProfileResult(status, row, text);
  if (base.ok) return { ...base, card: { accountId: asText(row?.accountId), ...base.profile! } };
  return base;
}

/** Свой профиль по cookie-сессии; гость → {ok:false, reason:'auth_required'}. */
export async function httpMyProfile(): Promise<ProfileResult> {
  const { status, row, text } = await apiFetch(profilesRoute("me"));
  return toProfileResult(status, row, text);
}

/**
 * Правка своего профиля: displayName/bio/avatarCharacterId и sp (скрытые
 * параметры; partial — отсутствие поля не трогает сохранённое). Серверную
 * ошибку (unknown_keys/invalid/…) отдаём целиком в details — панель её показывает.
 */
export async function httpPatchProfile(patch: ProfilePatch): Promise<ProfileResult> {
  const { status, row, text } = await apiFetch(profilesRoute("me"), { method: "PATCH", body: patch });
  return toProfileResult(status, row, text);
}
