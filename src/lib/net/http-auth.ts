/**
 * HTTP-флоу аккаунта Элизии (P3, спек §3): /auth/register|login|logout и
 * GET /auth/me через fetch + HttpOnly-cookie. База — httpOrigin(): same-origin
 * для Элизии (кука ездит сама), для dev/legacy — origin сокета.
 *
 * Контракты сервера (server/auth.js handleAuthHttp):
 *   POST /auth/register {login,pass} → 200 {ok, accountId…} | 400 {ok:false,reason} | 429 rate
 *   POST /auth/login    {login,pass} → 200 {ok, accountId…} | 401 {ok:false,reason:'bad'} | 429 rate
 *   POST /auth/logout           → 200 {ok:true, role:'guest'} + Set-Cookie deleted
 *   GET  /auth/me               → 200 {ok:true, role:'guest'} | 200 {ok, accountId…}
 * Ответ тела совместим с CoopWhoami (whoami-кадр того же сервера).
 * На public-хосте гротов этих маршрутов нет (нет гейт net.js) — панель входа
 * там и не рендерится (site.ts изоляция).
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
