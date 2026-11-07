/**
 * HTTP-флоу аккаунта Элизии (P3, спек §3) + профили и админ-конфиг (P4).
 * /auth/register|login|logout и GET /auth/me — fetch + HttpOnly-cookie.
 * База — httpOrigin(): same-origin для Элизии (кука ездит сама), для
 * dev/legacy — origin сокета.
 *
 * Контракты сервера (server/auth.js handleAuthHttp):
 *   POST /auth/register {login,pass} → 200 {ok, accountId…} | 400 {ok:false,reason} | 429 rate
 *   POST /auth/login    {login,pass} → 200 {ok, accountId…} | 401 {ok:false,reason:'bad'} | 429 rate
 *   POST /auth/logout           → 200 {ok:true, role:'guest'} + Set-Cookie deleted
 *   GET  /auth/me               → 200 {ok:true, role:'guest'} | 200 {ok, accountId…}
 * Ответ тела совместим с CoopWhoami (whoami-кадр того же сервера).
 *
 * Профили (server/profiles.js, P4):
 *   GET   /profiles/me   → 200 {ok, ...publicProfile} | гость 401 auth_required
 *   PATCH /profiles/me   → 200 {ok, ...publicProfile} | 400 unknown_keys/invalid/
 *                          empty_patch/invalid_body | 401 | 403 csrf
 *   GET   /profiles      → 200 {ok, items:[карточки], nextCursor, total(legacy)} —
 *                          каталог с серверной пагинацией (?limit, ?cursor) и
 *                          поиском (?q); nextCursor:null — страница последняя;
 *                          total — legacy-поле, НЕ контракт: не полагаться;
 *                          мусорный limit/cursor → 400 invalid_limit/invalid_cursor
 *   GET   /profiles/:id  → 200 {ok, accountId, ...publicProfile} | 404 unknown
 *
 * Конфиг (server/runtime-config.js): GET /cfg/admin, POST /cfg (PATCH/reset),
 * POST /cfg/restore {name}, GET /cfg/export, POST /cfg/import — все пишущие
 * под ролью admin; не-админ получает {ok:false, reason:'auth_required'}.
 *
 * На public-хосте гротов этих маршрутов нет (гейт net.js) — панели профилей
 * и админки там не рендерятся (site.ts изоляция).
 */
import { httpOrigin } from "./coop";
import { isCoopWhoami, type CoopWhoami } from "./protocol";

async function post(path: string, body: Record<string, unknown>): Promise<CoopWhoami> {
  const res = await fetch(`${httpOrigin()}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const row = (await res.json().catch(() => null)) as unknown;
  return isCoopWhoami(row) ? row : { ok: false, reason: "error" };
}

export async function httpRegister(login: string, pass: string): Promise<CoopWhoami> {
  return post("/auth/register", { login, pass });
}

export async function httpLogin(login: string, pass: string): Promise<CoopWhoami> {
  return post("/auth/login", { login, pass });
}

export async function httpLogout(): Promise<CoopWhoami> {
  return post("/auth/logout", {});
}

/** Снимок сессии (восстановление после перезагрузки страницы). */
export async function httpMe(): Promise<CoopWhoami> {
  try {
    const res = await fetch(`${httpOrigin()}/auth/me`, { credentials: "include" });
    const row = (await res.json().catch(() => null)) as unknown;
    return isCoopWhoami(row) ? row : { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/* ==================== P4: профили игроков (/profiles) ==================== */

/** Серверный JSON — слабая типизация: доверяем только прочитанным полям. */
export type ApiRow = Record<string, unknown>;

export type ProfileCharacter = { id: string; name: string; sprite: string; size: number };

/** Публичный DTO (accounts.publicProfile): без login, role и пароля. */
export type PublicProfile = {
  displayName: string;
  bio: string;
  avatarCharacterId: string | null;
  characters: ProfileCharacter[];
  activeCharacterId: string | null;
  createdAt: number;
};

/** Карточка каталога: DTO + accountId (для deep-link /players?id=). */
export type ProfileCard = PublicProfile & { accountId: string };

export type ProfilePatch = {
  displayName?: string;
  bio?: string;
  avatarCharacterId?: string | null;
};

export type ProfileResult = { ok: boolean; reason?: string; details?: string; profile?: PublicProfile };

const asText = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const asId = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

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
  };
}

/** Общий низкоуровневый ходок: статус + разобранное тело (или null). */
async function apiFetch(
  path: string,
  init: { method?: string; body?: string | Record<string, unknown> } = {},
): Promise<{ status: number; row: ApiRow | null; text: string }> {
  const hasBody = init.body !== undefined;
  const payload = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  try {
    const res = await fetch(`${httpOrigin()}${path}`, {
      method: init.method || "GET",
      credentials: "include",
      headers: hasBody ? { "content-type": "application/json" } : {},
      body: hasBody ? payload : undefined,
    });
    const text = await res.text();
    let row: ApiRow | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      row = parsed && typeof parsed === "object" ? (parsed as ApiRow) : null;
    } catch {
      row = null;
    }
    return { status: res.status, row, text };
  } catch {
    return { status: 0, row: null, text: "" };
  }
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

/* ==================== P4: админ-конфиг (/cfg) ==================== */

/** Мета ключа реестра (зеркало cfg-registry, сервер отдаёт всю подпись). */
export type CfgFieldMeta = {
  key: string;
  label: string;
  description: string;
  unit: string;
  kind: string;
  values: number[] | { min: number; max: number; step: number };
  default: number;
  applyPolicy: string;
  applyHint: string;
};

export type CfgUniversesValues = {
  levels?: number[];
  tenths?: number[];
  periods?: number[];
  default: number;
};

export type CfgAdminSnapshot = {
  v: number;
  values: { atmo: Record<string, number>; universes: Record<string, CfgUniversesValues> };
  registry: Record<string, CfgFieldMeta>;
  apply: Record<string, string>;
  history: string[];
  historyKeep: number;
};

export type CfgAction = { ok: boolean; reason?: string; details?: string; snapshot?: CfgAdminSnapshot };

const asStrMap = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
};

const metaOf = (raw: unknown): CfgFieldMeta | null => {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as ApiRow;
  const values = Array.isArray(row.values)
    ? (row.values as number[])
    : row.values && typeof row.values === "object"
      ? {
          min: Number((row.values as ApiRow).min),
          max: Number((row.values as ApiRow).max),
          step: Number((row.values as ApiRow).step || 1),
        }
      : null;
  const label = asText(row.label);
  const key = asText(row.key);
  if (!key || !label || values === null) return null;
  return {
    key,
    label,
    description: asText(row.description),
    unit: asText(row.unit),
    kind: asText(row.kind),
    values,
    default: Number(row.default),
    applyPolicy: asText(row.applyPolicy),
    applyHint: asText(row.applyHint),
  };
};

function parseAdminSnapshot(row: ApiRow): CfgAdminSnapshot | null {
  const values = row.values as { atmo?: unknown; universes?: unknown } | undefined;
  if (!values || typeof values !== "object") return null;
  const atmoNum: Record<string, number> = {};
  for (const [k, v] of Object.entries((values.atmo as Record<string, unknown>) || {})) {
    if (Number.isFinite(Number(v))) atmoNum[k] = Number(v);
  }
  const universes: Record<string, CfgUniversesValues> = {};
  const u = (values.universes as Record<string, unknown>) || {};
  for (const [name, raw] of Object.entries(u)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as ApiRow;
    const numList = (v: unknown): number[] | undefined =>
      Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : undefined;
    universes[name] = {
      levels: numList(row.levels),
      tenths: numList(row.tenths),
      periods: numList(row.periods),
      default: Number.isFinite(Number(row.default)) ? Number(row.default) : 0,
    };
  }
  const registry: Record<string, CfgFieldMeta> = {};
  for (const [k, raw] of Object.entries((row.registry as Record<string, unknown>) || {})) {
    const meta = metaOf(raw);
    if (meta) registry[k] = meta;
  }
  const history = Array.isArray(row.history) ? (row.history as unknown[]).filter((n): n is string => typeof n === "string") : [];
  return {
    v: Number(row.v) || 1,
    values: { atmo: atmoNum, universes },
    registry,
    apply: asStrMap(row.apply),
    history,
    historyKeep: Number(row.historyKeep) || 0,
  };
}

/** Дашборд-снимок /cfg/admin: значения + мета реестра + история бэкапов. */
export async function httpCfgAdmin(): Promise<CfgAction> {
  const { status, row, text } = await apiFetch("/cfg/admin");
  const snapshot = status === 200 && row?.ok === true ? parseAdminSnapshot(row) : null;
  if (snapshot) return { ok: true, snapshot };
  return { ok: false, reason: row?.reason === "auth_required" ? "auth_required" : "error", details: text };
}

/** Применение патча значений/дефолтов (POST /cfg). 400-я ошибка (unknown_keys/
 * invalid) отдаётся в details целиком — дашборд показывает её без обрезки. */
export async function httpCfgApply(patch: { atmo?: Record<string, number>; universes?: Record<string, CfgUniversesValues> }): Promise<CfgAction> {
  const { status, row, text } = await apiFetch("/cfg", { method: "POST", body: patch });
  if (status === 200 && row?.ok === true) return { ok: true };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Сброс на дефолты реестра (POST /cfg {reset:true}). */
export async function httpCfgReset(): Promise<CfgAction> {
  const { status, row, text } = await apiFetch("/cfg", { method: "POST", body: { reset: true } });
  if (status === 200 && row?.ok === true) return { ok: true };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Восстановление бэкапа по имени из свежей истории (POST /cfg/restore). */
export async function httpCfgRestore(name: string): Promise<CfgAction> {
  const { status, row, text } = await apiFetch("/cfg/restore", { method: "POST", body: { name } });
  if (status === 200 && row?.ok === true) return { ok: true };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Экспорт значений: сырой JSON-текст файла (GET /cfg/export). */
export async function httpCfgExportText(): Promise<{ ok: boolean; text: string; reason?: string }> {
  const res = await fetch(`${httpOrigin()}/cfg/export`, { credentials: "include" }).catch(() => null);
  if (!res) return { ok: false, text: "", reason: "offline" };
  const text = await res.text();
  if (res.ok && text.startsWith("{")) return { ok: true, text };
  let reason = "error";
  try {
    const row = JSON.parse(text) as ApiRow;
    if (row?.reason === "auth_required") reason = "auth_required";
  } catch {
    /* не JSON — общий error */
  }
  return { ok: false, text, reason };
}

/** Импорт экспортного JSON (POST /cfg/import, всё-или-ничего). */
export async function httpCfgImportText(text: string): Promise<CfgAction> {
  const { status, row, text: body } = await apiFetch("/cfg/import", { method: "POST", body: text });
  if (status === 200 && row?.ok === true) return { ok: true };
  return { ok: false, reason: cfgErrorReason(status, row), details: body };
}

function cfgErrorReason(status: number, row: ApiRow | null): string {
  if (status === 0) return "offline";
  if (typeof row?.reason === "string" && row.reason) return row.reason;
  if (status === 403) return "auth_required";
  return "error";
}
