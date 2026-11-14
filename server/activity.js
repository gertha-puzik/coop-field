/**
 * Лента «Последние действия» профиля — публичный журнал событий аккаунта.
 * Хранилище DATA_DIR/activity.json: { v:1, byAccount: { [accountId]: Item[] } },
 * Item = { id, type, at, data }, новые в начале, не больше MAX_PER_ACCOUNT.
 * Решение владелицы 2026-11-14: ленту видят все, включая названия локаций.
 *
 * Типы: joined_site (не хранится — синтез из createdAt при отдаче),
 * entered_game {label}, moved {locationId,label}, friend_added {friendId},
 * avatar_changed, banner_changed.
 *
 * Схлопывание: то же событие (moved — с тем же locationId) моложе
 * COLLAPSE_MS → обновляем его `at`; entered_game — не чаще ENTER_GAP_MS.
 *
 * Роут (публичный в зоне Элизий, только GET):
 *   GET /activity/:accountId      — { ok, items }
 *   GET /cfg/activity/:accountId  — обход прод-nginx (как /cfg/friends)
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.js";
import { json, setCors } from "./runtime-config.js";
import { writeFileAtomic } from "./atomic-file.js";
import { findById } from "./accounts.js";

const FILE = path.join(DATA_DIR, "activity.json");
export const MAX_PER_ACCOUNT = 20;
const COLLAPSE_MS = 2 * 60_000;
const ENTER_GAP_MS = 10 * 60_000;
const TYPES = new Set(["entered_game", "moved", "friend_added", "avatar_changed", "banner_changed"]);
const SOMEONE = "кто-то";

/** @type {{ v:number, byAccount: Record<string, Array<{id:string,type:string,at:number,data:object}>> }} */
let store = loadStore();

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { v: 1, byAccount: {} };
    const src = raw.byAccount && typeof raw.byAccount === "object" && !Array.isArray(raw.byAccount) ? raw.byAccount : {};
    const byAccount = {};
    for (const [id, list] of Object.entries(src)) byAccount[id] = cleanList(list);
    return { v: 1, byAccount };
  } catch {
    return { v: 1, byAccount: {} };
  }
}

/** Только целые записи: объект, известный тип, конечное время (чужой/порченый журнал). */
function cleanList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((it) => it && typeof it === "object" && (TYPES.has(it.type) || it.type === "joined_site") && Number.isFinite(it.at))
    .map((it) => ({
      id: String(it.id || ""),
      type: it.type,
      at: it.at,
      data: it.data && typeof it.data === "object" && !Array.isArray(it.data) ? it.data : {},
    }))
    .slice(0, MAX_PER_ACCOUNT);
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(FILE, JSON.stringify(store));
  } catch (e) {
    console.warn("activity persist failed:", e?.message || e);
  }
}

function listOf(accountId) {
  return cleanList(store.byAccount[accountId]);
}

/** Записать событие в ленту аккаунта (единственный писатель). Никогда не
 *  бросает: лента — украшение, она не должна ронять heartbeat/переход/дружбу. */
export function pushActivity(accountId, type, data = {}) {
  try {
    writeActivity(accountId, type, data);
  } catch (e) {
    console.warn("activity push failed:", e?.message || e);
  }
}

/** Одинаковые записи подряд схлопываются; друзья и переходы — по своему ключу. */
function sameKey(a, type, payload) {
  if (type === "moved") return a.data?.locationId === payload.locationId;
  if (type === "friend_added") return a.data?.friendId === payload.friendId;
  return true;
}

function writeActivity(accountId, type, data) {
  const id = String(accountId || "");
  if (!id || !TYPES.has(type)) return;
  const now = Date.now();
  const payload = data && typeof data === "object" ? { ...data } : {};
  const list = listOf(id).slice();
  const same = list.find((it) => it.type === type);
  if (same) {
    if (type === "entered_game" && now - same.at < ENTER_GAP_MS) return;
    if (type !== "entered_game" && sameKey(same, type, payload) && now - same.at < COLLAPSE_MS) {
      list.splice(list.indexOf(same), 1);
      list.unshift({ ...same, at: now, data: payload });
      store.byAccount[id] = list;
      persist();
      return;
    }
  }
  list.unshift({ id: `ac-${randomBytes(5).toString("hex")}`, type, at: now, data: payload });
  if (list.length > MAX_PER_ACCOUNT) list.length = MAX_PER_ACCOUNT;
  store.byAccount[id] = list;
  persist();
}

/** Сырые хранимые события (новые сверху) — для тестов и отдачи. */
export function activityOf(accountId) {
  return listOf(String(accountId || "")).map((it) => ({ ...it, data: { ...it.data } }));
}

/** Стереть журнал аккаунта (удаление аккаунта). */
export function forgetActivity(accountId) {
  const id = String(accountId || "");
  if (!id || !(id in store.byAccount)) return;
  delete store.byAccount[id];
  persist();
}

/** Убрать friend_added этой пары у обеих сторон (уход из друзей). */
export function dropFriendActivity(aId, bId) {
  const a = String(aId || "");
  const b = String(bId || "");
  let changed = false;
  for (const [self, other] of [[a, b], [b, a]]) {
    const list = listOf(self);
    const next = list.filter((it) => !(it.type === "friend_added" && it.data?.friendId === other));
    if (next.length !== list.length) {
      store.byAccount[self] = next;
      changed = true;
    }
  }
  if (changed) persist();
}

function liveAccount(id) {
  const acc = findById(id);
  const p = acc?.profile;
  return acc && !(p && typeof p === "object" && p.deletedAt) ? acc : null;
}

function nameOf(acc) {
  return String(acc?.profile?.displayName || acc?.login || SOMEONE);
}

function publicItems(acc) {
  const items = activityOf(acc.id).map((it) => {
    if (it.type !== "friend_added") return it;
    const friend = liveAccount(it.data?.friendId);
    return { ...it, data: { ...it.data, friendName: friend ? nameOf(friend) : SOMEONE } };
  });
  if (!items.some((it) => it.type === "joined_site")) {
    items.push({ id: "joined", type: "joined_site", at: Number(acc.createdAt) || 0, data: {} });
  }
  return items;
}

function canonPath(p) {
  return p.startsWith("/cfg/activity/") ? "/activity/" + p.slice("/cfg/activity/".length) : p;
}

export async function handleActivityHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const raw = url.pathname;
  if (!(raw === "/activity" || raw.startsWith("/activity/") || raw === "/cfg/activity" || raw.startsWith("/cfg/activity/"))) {
    return false;
  }
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  const m = /^\/activity\/([A-Za-z0-9_-]{1,64})$/.exec(canonPath(raw));
  if (!m) {
    json(res, 404, { ok: false, reason: "not_found" });
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    json(res, 405, { ok: false, reason: "method_not_allowed" });
    return true;
  }
  const acc = liveAccount(m[1]);
  if (!acc) {
    json(res, 404, { ok: false, reason: "not_found" });
    return true;
  }
  json(res, 200, { ok: true, items: publicItems(acc) });
  return true;
}
