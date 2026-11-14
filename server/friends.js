/**
 * Друзья: заявки и взаимные связи.
 * Хранилище DATA_DIR/friends.json — рёбра {id, fromId, toId, status, createdAt}.
 * status: pending | accepted.
 *
 * Роуты (сессия + CSRF apiZone):
 *   GET  /friends/me              — {ok, friends[], incoming[], outgoing[]}
 *   GET  /friends/:accountId      — {ok, friends[]} публичный список принятых
 *   POST /friends/request         — {accountId} исходящая заявка
 *   POST /friends/accept          — {accountId} принять входящую
 *   POST /friends/decline         — {accountId} отклонить входящую
 *   POST /friends/cancel          — {accountId} отменить исходящую
 *   POST /friends/remove          — {accountId} удалить из друзей
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR, csrfDecision, siteClassOfRequest } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, setCors, readJson } from "./runtime-config.js";
import { writeFileAtomic } from "./atomic-file.js";
import { findById, publicProfile } from "./accounts.js";
import { pushNotification } from "./notifications.js";
import { presenceOf } from "./presence.js";

const FILE = path.join(DATA_DIR, "friends.json");

/** @type {{ v:number, edges: Array<object> }} */
let store = loadStore();

function emptyStore() {
  return { v: 1, edges: [] };
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.edges)) return emptyStore();
    return { v: 1, edges: raw.edges.filter((e) => e && typeof e === "object") };
  } catch {
    return emptyStore();
  }
}

function persist() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(FILE, JSON.stringify(store, null, 2));
}

function newId() {
  return `fr-${randomBytes(5).toString("hex")}`;
}

function hasPublic(acc) {
  const p = acc?.profile;
  return !!(p && typeof p === "object" && !p.deletedAt && typeof p.displayName === "string");
}

function friendCard(acc) {
  if (!acc || !hasPublic(acc)) return null;
  const pub = publicProfile(acc);
  return {
    accountId: String(acc.id),
    displayName: pub.displayName,
    avatar: pub.avatar,
    presence: presenceOf(acc.id),
  };
}

function edgeBetween(a, b) {
  const x = String(a);
  const y = String(b);
  return store.edges.find(
    (e) =>
      (String(e.fromId) === x && String(e.toId) === y) ||
      (String(e.fromId) === y && String(e.toId) === x),
  );
}

function acceptedFriendsOf(accountId) {
  const id = String(accountId);
  const out = [];
  for (const e of store.edges) {
    if (e.status !== "accepted") continue;
    const other = String(e.fromId) === id ? e.toId : String(e.toId) === id ? e.fromId : null;
    if (!other) continue;
    const card = friendCard(findById(other));
    if (card) out.push(card);
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName, "ru"));
  return out;
}

/** Канон /friends/*; обходной /cfg/friends/* — прод nginx уже шлёт /cfg в Node. */
function isFriendsPath(p) {
  return (
    p === "/friends" || p.startsWith("/friends/") ||
    p === "/cfg/friends" || p.startsWith("/cfg/friends/")
  );
}

function canonFriendsPath(p) {
  if (p === "/cfg/friends") return "/friends";
  if (p.startsWith("/cfg/friends/")) return "/friends/" + p.slice("/cfg/friends/".length);
  return p;
}

async function requireSession(req, res) {
  const session = sessionFromRequest(req);
  if (!session) {
    json(res, 401, { ok: false, reason: "auth_required" });
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

export async function handleFriendsHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const raw = url.pathname;
  if (!isFriendsPath(raw)) return false;
  const p = canonFriendsPath(raw);
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  /* ---------- публичный список друзей чужого профиля ---------- */
  const pubMatch = /^\/friends\/([A-Za-z0-9_-]{1,64})$/.exec(p);
  if (pubMatch && pubMatch[1] !== "me" && pubMatch[1] !== "request" &&
      pubMatch[1] !== "accept" && pubMatch[1] !== "decline" &&
      pubMatch[1] !== "cancel" && pubMatch[1] !== "remove") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, reason: "method_not_allowed" });
      return true;
    }
    const acc = findById(pubMatch[1]);
    if (!acc || !hasPublic(acc)) {
      json(res, 404, { ok: false, reason: "unknown" });
      return true;
    }
    json(res, 200, { ok: true, friends: acceptedFriendsOf(acc.id) });
    return true;
  }

  const session = await requireSession(req, res);
  if (!session) return true;
  const me = session.account;
  const meId = String(me.id);

  if (req.method === "GET" && p === "/friends/me") {
    const friends = acceptedFriendsOf(meId);
    const incoming = [];
    const outgoing = [];
    for (const e of store.edges) {
      if (e.status !== "pending") continue;
      if (String(e.toId) === meId) {
        const card = friendCard(findById(e.fromId));
        if (card) incoming.push({ ...card, requestedAt: Number(e.createdAt) || 0 });
      } else if (String(e.fromId) === meId) {
        const card = friendCard(findById(e.toId));
        if (card) outgoing.push({ ...card, requestedAt: Number(e.createdAt) || 0 });
      }
    }
    json(res, 200, { ok: true, friends, incoming, outgoing });
    return true;
  }

  const mutateRoutes = {
    "/friends/request": "request",
    "/friends/accept": "accept",
    "/friends/decline": "decline",
    "/friends/cancel": "cancel",
    "/friends/remove": "remove",
  };
  const action = mutateRoutes[p];
  if (action && req.method === "POST") {
    const body = await readJson(req, 4 * 1024);
    const targetId = body && typeof body.accountId === "string" ? body.accountId.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(targetId)) {
      json(res, 400, { ok: false, reason: "invalid_id" });
      return true;
    }
    if (targetId === meId) {
      json(res, 400, { ok: false, reason: "self" });
      return true;
    }
    const other = findById(targetId);
    if (!other || !hasPublic(other)) {
      json(res, 404, { ok: false, reason: "unknown" });
      return true;
    }

    const existing = edgeBetween(meId, targetId);

    if (action === "request") {
      if (existing?.status === "accepted") {
        json(res, 200, { ok: true, already: "friends" });
        return true;
      }
      if (existing?.status === "pending") {
        if (String(existing.fromId) === meId) {
          json(res, 200, { ok: true, already: "outgoing" });
          return true;
        }
        // Встречная заявка → сразу друзья
        existing.status = "accepted";
        existing.acceptedAt = Date.now();
        persist();
        json(res, 200, { ok: true, status: "accepted" });
        return true;
      }
      store.edges.push({
        id: newId(),
        fromId: meId,
        toId: targetId,
        status: "pending",
        createdAt: Date.now(),
      });
      persist();
      const fromName = publicProfile(me)?.displayName || me.login;
      pushNotification(targetId, {
        type: "friend_request",
        title: "Заявка в друзья",
        body: `${fromName} хочет добавить вас в друзья`,
        payload: { fromId: meId, fromName },
      });
      json(res, 200, { ok: true, status: "pending" });
      return true;
    }

    if (action === "accept") {
      if (!existing || existing.status !== "pending" || String(existing.toId) !== meId) {
        json(res, 404, { ok: false, reason: "no_request" });
        return true;
      }
      existing.status = "accepted";
      existing.acceptedAt = Date.now();
      persist();
      json(res, 200, { ok: true, status: "accepted" });
      return true;
    }

    if (action === "decline") {
      if (!existing || existing.status !== "pending" || String(existing.toId) !== meId) {
        json(res, 404, { ok: false, reason: "no_request" });
        return true;
      }
      store.edges = store.edges.filter((e) => e !== existing);
      persist();
      json(res, 200, { ok: true, status: "declined" });
      return true;
    }

    if (action === "cancel") {
      if (!existing || existing.status !== "pending" || String(existing.fromId) !== meId) {
        json(res, 404, { ok: false, reason: "no_request" });
        return true;
      }
      store.edges = store.edges.filter((e) => e !== existing);
      persist();
      json(res, 200, { ok: true, status: "cancelled" });
      return true;
    }

    if (action === "remove") {
      if (!existing || existing.status !== "accepted") {
        json(res, 404, { ok: false, reason: "not_friends" });
        return true;
      }
      store.edges = store.edges.filter((e) => e !== existing);
      persist();
      json(res, 200, { ok: true, status: "removed" });
      return true;
    }
  }

  json(res, 405, { ok: false, reason: "method_not_allowed" });
  return true;
}

/** Срез для карточки профиля: друзья + relation к зрителю (если есть). */
export function friendsPreview(accountId, viewerId) {
  const friends = acceptedFriendsOf(accountId);
  let relation = "none";
  if (viewerId && String(viewerId) !== String(accountId)) {
    const e = edgeBetween(viewerId, accountId);
    if (e?.status === "accepted") relation = "friends";
    else if (e?.status === "pending" && String(e.fromId) === String(viewerId)) relation = "outgoing";
    else if (e?.status === "pending" && String(e.toId) === String(viewerId)) relation = "incoming";
  } else if (viewerId && String(viewerId) === String(accountId)) {
    relation = "self";
  }
  return { friends, relation, friendCount: friends.length };
}
