/**
 * Админ-операции «Игроки на поле» (/admin/players*) — клиент вкладки дашборда
 * /admin «Игроки на поле». Отдельный модуль вместо расширения http-cfg.ts:
 * домен свой (живые комнаты, не реестр конфига), а граф импортов держим
 * изоляцией сайтов (§10.4) — модуль циклится только в бандле страницы /admin.
 *
 * Контракты (server/admin-ops.js):
 *   GET  /admin/players          — живые комнаты и коты: координаты прямо из
 *                                  комнатного состояния; поля login/id/x/y/
 *                                  sprite/fm/fx/fy + accountLogin/accountRole
 *                                  (null у гостя без сессии);
 *   POST /admin/players/reset    — {room, login} сброс кота на свежую клетку
 *                                  спавна → 200 {ok, room, login, x, y, sprite};
 *   POST /admin/players/promote  — {login} логин АККАУНТА → роль admin
 *                                  (idempotent already).
 * Инвайты (регистрация закрытого сайта — только по кодам от админов, код
 * канона XXXX-XXXX живёт 24 часа):
 *   GET  /admin/invites          — все записи с вычисляемым статусом;
 *   POST /admin/invites/generate — {count 1..10, note?} → новые коды;
 *   POST /admin/invites/revoke   — {code} отзыв действующего кода.
 * Отказы 4xx: {ok:false, reason, message} — message от сервера уже
 * человекочитаемый. Гейты: сессия (401), роль admin (403), CSRF-щит apiZone.
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";

/** Строка кота в списке занятости (координаты живые, из комнаты). */
export type AdminFieldCat = {
  login: string;
  id: number;
  x: number;
  y: number;
  sprite: string;
  /** 1 — кот в мирной freemove-точке «теста» (fx/fy — сама точка), 0 — клетка. */
  fm: number;
  fx: number | null;
  fy: number | null;
  /** Логин аккаунта сокета; null — гость без сессии (грот). */
  accountLogin: string | null;
  /** Роль аккаунта; null — гость. */
  accountRole: "admin" | "registered" | null;
};

/** Комната в списке занятости: живые коты, пустые комнаты не отдаются. */
export type AdminFieldRoom = {
  room: string;
  title: string;
  fmt: string;
  count: number;
  cats: AdminFieldCat[];
};

/** Отказ операции зоны: ok=false, reason + человекочитаемый message сервера. */
export type AdminFieldError = { ok: false; reason: string; message?: string; details?: string };

/** Ответ списка занятости (GET /admin/players). */
export type AdminPlayersAction =
  | { ok: true; rooms: AdminFieldRoom[] }
  | AdminFieldError;

/** Ответ сброса кота на спавн (POST /admin/players/reset). */
export type AdminResetAction =
  | { ok: true; login: string; x: number; y: number; sprite: string }
  | AdminFieldError;

/** Ответ выдачи роли admin (POST /admin/players/promote). */
export type AdminPromoteAction =
  | { ok: true; login: string; id: string; already: boolean; message: string }
  | AdminFieldError;

const asNum = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const asNumOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function parseRole(v: unknown): "admin" | "registered" | null {
  if (v === "admin") return "admin";
  if (v === "registered") return "registered";
  return null;
}

/** Разбор строки кота: доверяем только прочитанным полям DTO. */
function parseCat(row: ApiRow): AdminFieldCat {
  const accountLogin = asText(row.accountLogin);
  return {
    login: asText(row.login),
    id: asNum(row.id, 0),
    x: asNum(row.x, 0),
    y: asNum(row.y, 0),
    sprite: asText(row.sprite),
    fm: row.fm === 1 ? 1 : 0,
    fx: asNumOrNull(row.fx),
    fy: asNumOrNull(row.fy),
    accountLogin: accountLogin || null,
    accountRole: parseRole(row.accountRole),
  };
}

/** Разбор снимка занятости; битые строки выбрасываем, список не врёт. */
function parseRooms(row: ApiRow | null): AdminFieldRoom[] {
  if (!row || !Array.isArray(row.rooms)) return [];
  const out: AdminFieldRoom[] = [];
  for (const raw of row.rooms) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as ApiRow;
    const room = asText(item.room);
    if (!room) continue;
    out.push({
      room,
      title: asText(item.title, room),
      fmt: asText(item.fmt),
      count: asNum(item.count, 0),
      cats: Array.isArray(item.cats) ? (item.cats as ApiRow[]).map(parseCat) : [],
    });
  }
  return out;
}

/** Список занятости (GET /admin/players): комнаты и коты с координатами. */
export async function httpAdminPlayers(): Promise<AdminPlayersAction> {
  const { status, row } = await apiFetch("/admin/players");
  if (status === 200 && row?.ok === true) return { ok: true, rooms: parseRooms(row) };
  return {
    ok: false,
    reason: row?.reason === "auth_required" ? "auth_required" : row?.reason === "forbidden" ? "forbidden" : "error",
    message: asText(row?.message),
  };
}

/** Сброс кота на свежую клетку спавна (POST /admin/players/reset {room, login}). */
export async function httpAdminPlayerReset(room: string, login: string): Promise<AdminResetAction> {
  const { status, row, text } = await apiFetch("/admin/players/reset", {
    method: "POST",
    body: { room, login },
  });
  if (status === 200 && row?.ok === true) {
    return { ok: true, login: asText(row.login, login), x: asNum(row.x, 0), y: asNum(row.y, 0), sprite: asText(row.sprite) };
  }
  return {
    ok: false,
    reason: status === 401 ? "auth_required" : status === 0 ? "offline" : asText(row?.reason, "error"),
    message: asText(row?.message),
    details: text,
  };
}

/** Выдача роли admin (POST /admin/players/promote {login} — логин аккаунта). */
export async function httpAdminPlayerPromote(login: string): Promise<AdminPromoteAction> {
  const { status, row, text } = await apiFetch("/admin/players/promote", {
    method: "POST",
    body: { login },
  });
  if (status === 200 && row?.ok === true) {
    return {
      ok: true,
      login: asText(row.login, login),
      id: asText(row.id),
      already: row.already === true,
      message: asText(row.message, `«${login}» теперь администратор.`),
    };
  }
  return {
    ok: false,
    reason: status === 401 ? "auth_required" : status === 0 ? "offline" : asText(row?.reason, "error"),
    message: asText(row?.message),
    details: text,
  };
}

/* ===== Инвайты (коды приглашений для регистрации закрытого сайта) ===== */

/** Статус кода — вычисляется сервером (поле status DTO). */
export type AdminInviteStatus = "active" | "used" | "expired" | "revoked";

/** Запись кода приглашения (DTO /admin/invites): код канона XXXX-XXXX,
 *  живёт 24 часа; null-поля — «пока не применимо». */
export type AdminInviteRow = {
  /** Код канонического вида XXXX-XXXX. */
  code: string;
  /** Время создания (ISO-строка сервера). */
  createdAt: string;
  /** Срок жизни (ISO-строка): createdAt + 24 часа. */
  expiresAt: string;
  /** Заметка админа «кому/для чего» (до 80 симв.; null — не указана). */
  note: string | null;
  /** Логин зарегистрировавшегося по коду (null — код ещё не использован). */
  claimedByLogin: string | null;
  /** Момент использования (ISO-строка; null — не использован). */
  claimedAt: string | null;
  /** Момент отзыва (ISO-строка; null — код не отозван). */
  revokedAt: string | null;
  /** Жизненный статус: действует / использован / истёк / отозван. */
  status: AdminInviteStatus;
};

/** Ответ списка приглашений (GET /admin/invites). */
export type AdminInvitesAction =
  | { ok: true; invites: AdminInviteRow[] }
  | AdminFieldError;

/** Ответ генерации кодов (POST /admin/invites/generate): свежие записи. */
export type AdminInvitesGenerateAction =
  | { ok: true; invites: AdminInviteRow[] }
  | AdminFieldError;

/** Ответ отзыва кода (POST /admin/invites/revoke). */
export type AdminInviteRevokeAction =
  | { ok: true; code: string }
  | AdminFieldError;

/** Строка DTO или null (пустая строка тоже null — «не применимо»). */
const asTextOrNull = (v: unknown): string | null => {
  const s = asText(v);
  return s ? s : null;
};

function parseInviteStatus(v: unknown): AdminInviteStatus {
  return v === "used" || v === "expired" || v === "revoked" ? v : "active";
}

/** Разбор записи кода: доверяем только прочитанным полям DTO. */
function parseInvite(row: ApiRow): AdminInviteRow {
  return {
    code: asText(row.code),
    createdAt: asText(row.createdAt),
    expiresAt: asText(row.expiresAt),
    note: asTextOrNull(row.note),
    claimedByLogin: asTextOrNull(row.claimedByLogin),
    claimedAt: asTextOrNull(row.claimedAt),
    revokedAt: asTextOrNull(row.revokedAt),
    status: parseInviteStatus(row.status),
  };
}

/** Разбор массива invites из тела; битые строки выбрасываем. */
function parseInvites(row: ApiRow | null): AdminInviteRow[] {
  if (!row || !Array.isArray(row.invites)) return [];
  const out: AdminInviteRow[] = [];
  for (const raw of row.invites) {
    if (!raw || typeof raw !== "object") continue;
    const item = parseInvite(raw as ApiRow);
    if (item.code) out.push(item);
  }
  return out;
}

/** Список всех кодов приглашений (GET /admin/invites). */
export async function httpAdminInvites(): Promise<AdminInvitesAction> {
  const { status, row } = await apiFetch("/admin/invites");
  if (status === 200 && row?.ok === true) return { ok: true, invites: parseInvites(row) };
  return {
    ok: false,
    reason: row?.reason === "auth_required" ? "auth_required" : row?.reason === "forbidden" ? "forbidden" : "error",
    message: asText(row?.message),
  };
}

/** Генерация кодов (POST /admin/invites/generate {count 1..10, note?}). */
export async function httpAdminInvitesGenerate(count: number, note?: string): Promise<AdminInvitesGenerateAction> {
  const clean = note?.trim();
  const { status, row, text } = await apiFetch("/admin/invites/generate", {
    method: "POST",
    body: clean ? { count, note: clean } : { count },
  });
  if (status === 200 && row?.ok === true) return { ok: true, invites: parseInvites(row) };
  return {
    ok: false,
    reason: status === 401 ? "auth_required" : status === 0 ? "offline" : asText(row?.reason, "error"),
    message: asText(row?.message),
    details: text,
  };
}

/** Отзыв действующего кода (POST /admin/invites/revoke {code}). */
export async function httpAdminInviteRevoke(code: string): Promise<AdminInviteRevokeAction> {
  const { status, row, text } = await apiFetch("/admin/invites/revoke", {
    method: "POST",
    body: { code },
  });
  if (status === 200 && row?.ok === true) return { ok: true, code: asText(row.code, code) };
  return {
    ok: false,
    reason: status === 401 ? "auth_required" : status === 0 ? "offline" : asText(row?.reason, "error"),
    message: asText(row?.message),
    details: text,
  };
}

/* ========================= Статусы на поле (/admin/statuses*) ========================= */

/** Строка каталога статусов. */
export type AdminStatusRow = { id: string; label: string; sort: number };

/** Назначение статуса аккаунту. */
export type AdminStatusAccount = {
  accountId: string;
  login: string;
  displayName: string;
  statusId: string;
  statusLabel: string;
  role: "admin" | "registered";
};

export type AdminStatusesSnapshot =
  | { ok: true; statuses: AdminStatusRow[]; accounts: AdminStatusAccount[] }
  | AdminFieldError;

function parseStatus(row: ApiRow): AdminStatusRow | null {
  const id = asText(row.id);
  const label = asText(row.label);
  if (!id || !label) return null;
  return { id, label, sort: asNum(row.sort, 0) };
}

function parseStatusAccount(row: ApiRow): AdminStatusAccount | null {
  const accountId = asText(row.accountId);
  const login = asText(row.login);
  if (!accountId || !login) return null;
  return {
    accountId,
    login,
    displayName: asText(row.displayName, login),
    statusId: asText(row.statusId, "tester"),
    statusLabel: asText(row.statusLabel, "Тестер"),
    role: parseRole(row.role) === "admin" ? "admin" : "registered",
  };
}

/** GET /admin/statuses — каталог + назначения. */
export async function httpAdminStatuses(): Promise<AdminStatusesSnapshot> {
  const { status, row } = await apiFetch("/admin/statuses");
  if (status === 200 && row?.ok === true) {
    const statuses: AdminStatusRow[] = [];
    const accounts: AdminStatusAccount[] = [];
    if (Array.isArray(row.statuses)) {
      for (const raw of row.statuses) {
        if (!raw || typeof raw !== "object") continue;
        const s = parseStatus(raw as ApiRow);
        if (s) statuses.push(s);
      }
    }
    if (Array.isArray(row.accounts)) {
      for (const raw of row.accounts) {
        if (!raw || typeof raw !== "object") continue;
        const a = parseStatusAccount(raw as ApiRow);
        if (a) accounts.push(a);
      }
    }
    return { ok: true, statuses, accounts };
  }
  return {
    ok: false,
    reason: row?.reason === "auth_required" ? "auth_required" : row?.reason === "forbidden" ? "forbidden" : "error",
    message: asText(row?.message),
  };
}

/** POST /admin/statuses {label, id?} — создать статус. */
export async function httpAdminStatusCreate(label: string, id?: string): Promise<AdminStatusesSnapshot> {
  const body: { label: string; id?: string } = { label };
  if (id?.trim()) body.id = id.trim();
  const { status, row, text } = await apiFetch("/admin/statuses", { method: "POST", body });
  if (status === 200 && row?.ok === true) return httpAdminStatuses();
  return {
    ok: false,
    reason: status === 401 ? "auth_required" : status === 0 ? "offline" : asText(row?.reason, "error"),
    message: asText(row?.message),
    details: text,
  };
}

/** PATCH /admin/statuses/:id {label} — переименовать. */
export async function httpAdminStatusRename(id: string, label: string): Promise<AdminStatusesSnapshot> {
  const { status, row, text } = await apiFetch(`/admin/statuses/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { label },
  });
  if (status === 200 && row?.ok === true) return httpAdminStatuses();
  return {
    ok: false,
    reason: status === 401 ? "auth_required" : status === 0 ? "offline" : asText(row?.reason, "error"),
    message: asText(row?.message),
    details: text,
  };
}

/** DELETE /admin/statuses/:id — удалить (назначения → Тестер). */
export async function httpAdminStatusDelete(id: string): Promise<AdminStatusesSnapshot> {
  const { status, row, text } = await apiFetch(`/admin/statuses/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (status === 200 && row?.ok === true) return httpAdminStatuses();
  return {
    ok: false,
    reason: status === 401 ? "auth_required" : status === 0 ? "offline" : asText(row?.reason, "error"),
    message: asText(row?.message),
    details: text,
  };
}

/** POST /admin/statuses/assign {accountId, statusId} — выдать статус. */
export async function httpAdminStatusAssign(accountId: string, statusId: string): Promise<AdminStatusesSnapshot> {
  const { status, row, text } = await apiFetch("/admin/statuses/assign", {
    method: "POST",
    body: { accountId, statusId },
  });
  if (status === 200 && row?.ok === true) {
    if (Array.isArray(row.accounts) && Array.isArray(row.statuses)) {
      const statuses: AdminStatusRow[] = [];
      const accounts: AdminStatusAccount[] = [];
      for (const raw of row.statuses) {
        if (!raw || typeof raw !== "object") continue;
        const s = parseStatus(raw as ApiRow);
        if (s) statuses.push(s);
      }
      for (const raw of row.accounts) {
        if (!raw || typeof raw !== "object") continue;
        const a = parseStatusAccount(raw as ApiRow);
        if (a) accounts.push(a);
      }
      if (statuses.length) return { ok: true, statuses, accounts };
    }
    return httpAdminStatuses();
  }
  return {
    ok: false,
    reason: status === 401 ? "auth_required" : status === 0 ? "offline" : asText(row?.reason, "error"),
    message: asText(row?.message),
    details: text,
  };
}
