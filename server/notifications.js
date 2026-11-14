/**
 * Личные уведомления аккаунта (колокольчик в шапке).
 * Хранилище DATA_DIR/notifications.json — журнал по accountId.
 *
 * Типы волны:
 *   friend_request — заявка в друзья (payload: {fromId, fromName})
 *   announcement   — админ-анонс (payload: {announcementId})
 *
 * Роуты:
 *   GET  /notifications/me          — {ok, items[], unread}
 *   POST /notifications/me/read     — {ids?:string[], all?:bool} → mark read
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR, csrfDecision, siteClassOfRequest } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, setCors, readJson } from "./runtime-config.js";
import { writeFileAtomic } from "./atomic-file.js";

const FILE = path.join(DATA_DIR, "notifications.json");
const MAX_PER_ACCOUNT = 100;
const TITLE_MAX = 80;
const BODY_MAX = 400;

/** @type {{ v:number, byAccount: Record<string, Array<object>> }} */
let store = loadStore();

function emptyStore() {
  return { v: 1, byAccount: {} };
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!raw || typeof raw !== "object") return emptyStore();
    const byAccount = raw.byAccount && typeof raw.byAccount === "object" ? raw.byAccount : {};
    return { v: 1, byAccount };
  } catch {
    return emptyStore();
  }
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(FILE, JSON.stringify(store, null, 2));
}

function newId() {
  return `nt-${randomBytes(5).toString("hex")}`;
}

function listOf(accountId) {
  const id = String(accountId || "");
  if (!id) return [];
  if (!Array.isArray(store.byAccount[id])) store.byAccount[id] = [];
  return store.byAccount[id];
}

function trimList(list) {
  if (list.length > MAX_PER_ACCOUNT) list.splice(0, list.length - MAX_PER_ACCOUNT);
}

/**
 * Создать уведомление. Возвращает запись или null.
 * @param {string} accountId
 * @param {{ type:string, title:string, body?:string, payload?:object }} spec
 */
export function pushNotification(accountId, spec) {
  const id = String(accountId || "");
  if (!id || !spec || typeof spec !== "object") return null;
  const type = String(spec.type || "").slice(0, 32);
  const title = String(spec.title || "").trim().slice(0, TITLE_MAX);
  if (!type || !title) return null;
  const body = String(spec.body || "").trim().slice(0, BODY_MAX);
  const row = {
    id: newId(),
    type,
    title,
    body,
    payload: spec.payload && typeof spec.payload === "object" ? spec.payload : {},
    read: false,
    createdAt: Date.now(),
  };
  const list = listOf(id);
  list.push(row);
  trimList(list);
  persist();
  return row;
}

/** Фанаут одного анонса всем аккаунтам из списка id. */
export function fanoutAnnouncement(accountIds, { title, body, announcementId }) {
  const ids = Array.isArray(accountIds) ? accountIds : [];
  let n = 0;
  for (const accountId of ids) {
    const row = pushNotification(accountId, {
      type: "announcement",
      title,
      body: body || "",
      payload: { announcementId: String(announcementId || "") },
    });
    if (row) n += 1;
  }
  return n;
}

function publicItem(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body || "",
    payload: row.payload || {},
    read: !!row.read,
    createdAt: Number(row.createdAt) || 0,
  };
}

function isNotifPath(p) {
  return p === "/notifications/me" || p.startsWith("/notifications/");
}

export async function handleNotificationsHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  if (!isNotifPath(p)) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const session = sessionFromRequest(req);
  if (!session) {
    json(res, 401, { ok: false, reason: "auth_required" });
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const csrfBad = csrfDecision({
      method: req.method,
      origin: req.headers.origin,
      destClass: siteClassOfRequest(req),
      hasAuth: true,
    });
    if (csrfBad) {
      json(res, csrfBad.status, { ok: false, reason: csrfBad.reason });
      return true;
    }
  }

  const accountId = String(session.account?.id || "");

  if (req.method === "GET" && p === "/notifications/me") {
    const items = listOf(accountId).map(publicItem).reverse();
    const unread = items.reduce((n, it) => n + (it.read ? 0 : 1), 0);
    json(res, 200, { ok: true, items, unread });
    return true;
  }

  if (req.method === "POST" && p === "/notifications/me/read") {
    const body = await readJson(req, 16 * 1024);
    const list = listOf(accountId);
    let changed = 0;
    if (body && body.all === true) {
      for (const row of list) {
        if (!row.read) {
          row.read = true;
          changed += 1;
        }
      }
    } else {
      const ids = Array.isArray(body?.ids)
        ? body.ids.map((x) => String(x || "")).filter(Boolean)
        : [];
      const want = new Set(ids);
      for (const row of list) {
        if (want.has(row.id) && !row.read) {
          row.read = true;
          changed += 1;
        }
      }
    }
    if (changed) persist();
    const unread = list.reduce((n, it) => n + (it.read ? 0 : 1), 0);
    json(res, 200, { ok: true, changed, unread });
    return true;
  }

  json(res, 405, { ok: false, reason: "method_not_allowed" });
  return true;
}

export function unreadCount(accountId) {
  return listOf(accountId).reduce((n, it) => n + (it.read ? 0 : 1), 0);
}
