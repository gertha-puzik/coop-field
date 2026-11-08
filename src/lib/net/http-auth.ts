/**
 * HTTP-флоу аккаунта Элизии (P3, спек §3): только /auth/*.
 * /auth/register|login|logout и GET /auth/me — fetch + HttpOnly-cookie.
 * База — httpOrigin(): same-origin для Элизии (кука ездит сама), для
 * dev/legacy — origin сокета.
 *
 * Контракты сервера (server/auth.js handleAuthHttp):
 *   POST /auth/register {login,pass,name?} → 200 {ok, accountId…} | 400 {ok:false,reason} | 429 rate
 *   POST /auth/login    {login,pass} → 200 {ok, accountId…} | 401 {ok:false,reason:'bad'} | 429 rate
 *   POST /auth/logout           → 200 {ok:true, role:'guest'} + Set-Cookie deleted
 *   GET  /auth/me               → 200 {ok:true, role:'guest'} | 200 {ok, accountId…}
 * Ответ тела совместим с CoopWhoami (whoami-кадр того же сервера).
 *
 * Профили живут в ./http-profiles, админ-конфиг — в ./http-cfg (изоляция
 * сборки: модуль-донор графа симулятора не должен тянуть серверные
 * маршруты Elyria в public-бандл гротов — спека §10.4).
 * Здесь же общие низкоуровневые хелперы (apiFetch/asText/asId/ApiRow),
 * которыми пользуются оба соседних модуля.
 */
import { httpOrigin } from "./coop";
import { isCoopWhoami, type CoopWhoami } from "./protocol";

/**
 * W2 2026-11-08: снимок /auth/me кэшируется на вкладку («one fetch per tab»,
 * прецедент cfg-live.ts): все потребители страницы (AuthGate, каталог,
 * админ-панель, шапки «Мой профиль») делят один и тот же промис. Смена
 * сессии (успешный register|login|logout) сбрасывает кэш и рассылает
 * ME_EVENT — шапки обновляются без перезагрузки. ME_EVENT — браузерный
 * CustomEvent клиента, НЕ WS-имя протокола (литералы EV.* не трогаем).
 */

/** Браузерное событие «сессия изменилась, вот свежий кадр» (detail: CoopWhoami). */
export const ME_EVENT = "coop:me";

let meMemo: Promise<CoopWhoami> | null = null;

function emitMe(row: CoopWhoami): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ME_EVENT, { detail: row }));
}

async function post(path: string, body: Record<string, unknown>): Promise<CoopWhoami> {
  const res = await fetch(`${httpOrigin()}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const row = (await res.json().catch(() => null)) as unknown;
  const out = isCoopWhoami(row) ? row : { ok: false, reason: "error" };
  if (out.ok) {
    // register|login|logout сменили куку — закэшированный снимок протух.
    meMemo = null;
    emitMe(out);
  }
  return out;
}

/** Имя на поле отправляем ТОЛЬКО заданным и непустым: без поля сервер зовёт
 *  игрока логином (register v2, контракт {login, pass, name?}). */
export async function httpRegister(login: string, pass: string, name?: string): Promise<CoopWhoami> {
  const display = (name ?? "").trim();
  return post("/auth/register", display ? { login, pass, name: display } : { login, pass });
}

export async function httpLogin(login: string, pass: string): Promise<CoopWhoami> {
  return post("/auth/login", { login, pass });
}

export async function httpLogout(): Promise<CoopWhoami> {
  return post("/auth/logout", {});
}

/** Сырой ходок GET /auth/me (использован только httpMe-кэшем). */
async function meRequest(): Promise<CoopWhoami> {
  try {
    const res = await fetch(`${httpOrigin()}/auth/me`, { credentials: "include" });
    const row = (await res.json().catch(() => null)) as unknown;
    return isCoopWhoami(row) ? row : { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/**
 * Снимок сессии (восстановление после перезагрузки страницы). Кэш на вкладку:
 * повторные вызовы (AuthGate + шапки «Мой профиль» + каталог/админка одной
 * страницы) получают один и тот же промис — второй запрос не отправляется.
 */
export function httpMe(): Promise<CoopWhoami> {
  meMemo ??= meRequest();
  return meMemo;
}

/** Говорящий синоним httpMe() для шапок: подчёркивает общий кэш вкладки. */
export function meCached(): Promise<CoopWhoami> {
  return httpMe();
}

/* ===== Общие низкоуровневые хелперы (этот модуль в графе обоих сайтов) ===== */

/** Серверный JSON — слабая типизация: доверяем только прочитанным полям. */
export type ApiRow = Record<string, unknown>;

/** Общий низкоуровневый ходок: статус + разобранное тело (или null). */
export async function apiFetch(
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

/** Строка поля DTO с фолбэком (для parse-функций соседних модулей). */
export const asText = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
/** Идентификатор поля DTO: непустая строка или null. */
export const asId = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
