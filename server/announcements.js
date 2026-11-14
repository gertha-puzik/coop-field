/**
 * Админ-анонсы → фан-аут в личные уведомления всех живых аккаунтов.
 * Журнал DATA_DIR/announcements.json (для вкладки админки).
 *
 * Роуты:
 *   GET  /admin/announcements           — список (admin)
 *   POST /admin/announcements           — {title, body?} создать + fanout
 *   POST /admin/announcements/delete    — {id} удалить запись журнала
 *     (уже разосланные уведомления у получателей не трогаем)
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR, csrfDecision, siteClassOfRequest } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, setCors, readJson } from "./runtime-config.js";
import { writeFileAtomic } from "./atomic-file.js";
import { accountsStore } from "./accounts.js";
import { fanoutAnnouncement } from "./notifications.js";

const FILE = path.join(DATA_DIR, "announcements.json");
const TITLE_MAX = 80;
const BODY_MAX = 500;
const MAX_ITEMS = 100;

/** @type {{ v:number, items: Array<object> }} */
let store = loadStore();

function emptyStore() {
  return { v: 1, items: [] };
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) return emptyStore();
    return { v: 1, items: raw.items.filter((x) => x && typeof x === "object") };
  } catch {
    return emptyStore();
  }
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(FILE, JSON.stringify(store, null, 2));
}

function newId() {
  return `an-${randomBytes(5).toString("hex")}`;
}

function cleanText(v, max) {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return [...t].slice(0, max).join("");
}

/** Канон /admin/announcements*; обходной /cfg/announcements* — как /cfg/statuses. */
function isAnnPath(p) {
  return (
    p === "/admin/announcements" || p.startsWith("/admin/announcements/") ||
    p === "/cfg/announcements" || p.startsWith("/cfg/announcements/")
  );
}

function canonAnnPath(p) {
  if (p === "/cfg/announcements") return "/admin/announcements";
  if (p.startsWith("/cfg/announcements/")) {
    return "/admin/announcements/" + p.slice("/cfg/announcements/".length);
  }
  return p;
}

function requireAdmin(req, res) {
  const session = sessionFromRequest(req);
  if (!session) {
    json(res, 401, { ok: false, reason: "auth_required" });
    return null;
  }
  if (session.account?.role !== "admin") {
    json(res, 403, { ok: false, reason: "forbidden" });
    return null;
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
      return null;
    }
  }
  return session;
}

function liveAccountIds() {
  const out = [];
  for (const acc of Object.values(accountsStore().accounts || {})) {
    if (acc?.id && acc.profile && !acc.profile.deletedAt) out.push(String(acc.id));
  }
  return out;
}

export async function handleAnnouncementsHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const raw = url.pathname;
  if (!isAnnPath(raw)) return false;
  const p = canonAnnPath(raw);
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const session = requireAdmin(req, res);
  if (!session) return true;

  if (req.method === "GET" && p === "/admin/announcements") {
    const items = [...store.items].reverse().map((it) => ({
      id: it.id,
      title: it.title,
      body: it.body || "",
      createdAt: Number(it.createdAt) || 0,
      authorLogin: it.authorLogin || "",
      delivered: Number(it.delivered) || 0,
    }));
    json(res, 200, { ok: true, items });
    return true;
  }

  if (req.method === "POST" && p === "/admin/announcements") {
    const body = await readJson(req, 8 * 1024);
    const title = cleanText(body?.title, TITLE_MAX);
    const text = cleanText(body?.body ?? "", BODY_MAX) || "";
    if (!title) {
      json(res, 400, { ok: false, reason: "invalid_title" });
      return true;
    }
    const id = newId();
    const ids = liveAccountIds();
    const delivered = fanoutAnnouncement(ids, {
      title,
      body: text,
      announcementId: id,
    });
    const row = {
      id,
      title,
      body: text,
      createdAt: Date.now(),
      authorLogin: String(session.account?.login || ""),
      delivered,
    };
    store.items.push(row);
    if (store.items.length > MAX_ITEMS) store.items.splice(0, store.items.length - MAX_ITEMS);
    persist();
    json(res, 200, { ok: true, item: row });
    return true;
  }

  if (req.method === "POST" && p === "/admin/announcements/delete") {
    const body = await readJson(req, 4 * 1024);
    const id = typeof body?.id === "string" ? body.id : "";
    if (!id) {
      json(res, 400, { ok: false, reason: "invalid_id" });
      return true;
    }
    const before = store.items.length;
    store.items = store.items.filter((it) => it.id !== id);
    if (store.items.length === before) {
      json(res, 404, { ok: false, reason: "not_found" });
      return true;
    }
    persist();
    json(res, 200, { ok: true });
    return true;
  }

  json(res, 405, { ok: false, reason: "method_not_allowed" });
  return true;
}
