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

export type ProfileCharacter = { id: string; name: string; sprite: string; size: number };

/** Публичный DTO (accounts.publicProfile): без login, role и пароля.
 *  P5-редизайн (аддитивно): lastSeenAt — время последнего появления
 *  (максимум свежайшей сессии и последней записи кота; 0 = неизвестно,
 *  честное «неизвестно» вместо выдумки), lastSeenRoom — комната последней
 *  записи кота ("test" = Элизия; null = кота в поле не видели). Сервер
 *  может не прислать поля (старый бэкенд) — поэтому необязательные. */
export type PublicProfile = {
  displayName: string;
  bio: string;
  avatarCharacterId: string | null;
  characters: ProfileCharacter[];
  activeCharacterId: string | null;
  createdAt: number;
  lastSeenAt?: number;
  lastSeenRoom?: string | null;
};

/** Карточка каталога: DTO + accountId (для deep-link /players?id=). */
export type ProfileCard = PublicProfile & { accountId: string };

export type ProfilePatch = {
  displayName?: string;
  bio?: string;
  avatarCharacterId?: string | null;
};

export type ProfileResult = { ok: boolean; reason?: string; details?: string; profile?: PublicProfile };

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

function parseProfile(row: ApiRow): PublicProfile {
  return {
    displayName: asText(row.displayName),
    bio: asText(row.bio),
    avatarCharacterId: asId(row.avatarCharacterId),
    characters: parseCharacters(row.characters),
    activeCharacterId: asId(row.activeCharacterId),
    createdAt: Number.isFinite(Number(row.createdAt)) ? Number(row.createdAt) : 0,
    // P5: только конечные числа и строки/NULL — мусор схлопывается в
    // «неизвестно» (0/null), чтобы UI не рисовал выдуманное время.
    lastSeenAt: Number.isFinite(Number(row.lastSeenAt)) ? Number(row.lastSeenAt) : 0,
    lastSeenRoom: typeof row.lastSeenRoom === "string" && row.lastSeenRoom ? row.lastSeenRoom : null,
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
  const { status, row, text } = await apiFetch(qs ? `/profiles?${qs}` : "/profiles");
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
  const { status, row, text } = await apiFetch(`/profiles/${id}`);
  const base = toProfileResult(status, row, text);
  if (base.ok) return { ...base, card: { accountId: asText(row?.accountId), ...base.profile! } };
  return base;
}

/** Свой профиль по cookie-сессии; гость → {ok:false, reason:'auth_required'}. */
export async function httpMyProfile(): Promise<ProfileResult> {
  const { status, row, text } = await apiFetch("/profiles/me");
  return toProfileResult(status, row, text);
}

/**
 * Правка своего профиля: displayName/bio/avatarCharacterId. Серверную ошибку
 * (unknown_keys/invalid/…) отдаём целиком в details — панель её показывает.
 */
export async function httpPatchProfile(patch: ProfilePatch): Promise<ProfileResult> {
  const { status, row, text } = await apiFetch("/profiles/me", { method: "PATCH", body: patch });
  return toProfileResult(status, row, text);
}
