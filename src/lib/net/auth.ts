/**
 * Browser session for the room server: opaque token in sessionStorage,
 * attached to the WebSocket URL as ?t=. The server session table is the
 * source of truth; this key only lets the tab reconnect.
 */
import { EV, type CoopWhoami } from "./protocol.ts";

export const AUTH_STORAGE_KEY = "coop-field-session";

export function readAuthToken(): string {
  if (typeof window === "undefined") return "";
  try {
    return String(sessionStorage.getItem(AUTH_STORAGE_KEY) || "");
  } catch {
    return "";
  }
}

export function writeAuthToken(token: string) {
  if (typeof window === "undefined") return;
  try {
    if (token) sessionStorage.setItem(AUTH_STORAGE_KEY, token);
    else sessionStorage.removeItem(AUTH_STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

export function withAuthToken(wsUrl: string, token = readAuthToken()): string {
  if (!token) return wsUrl;
  try {
    const u = new URL(wsUrl);
    u.searchParams.set("t", token);
    return u.toString();
  } catch {
    return wsUrl;
  }
}

export function applyWhoami(row: CoopWhoami): CoopWhoami {
  if (row.ok && row.token) writeAuthToken(row.token);
  else if (row.ok && row.role === "guest") writeAuthToken("");
  return row;
}

export function authPayload(
  action: "hello" | "register" | "login" | "logout",
  fields: { login?: string; pass?: string; token?: string } = {},
) {
  return { action, ...fields, ...(action === "hello" ? { token: fields.token || readAuthToken() } : {}) };
}

export { EV };
