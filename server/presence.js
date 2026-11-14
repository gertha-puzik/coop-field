/**
 * Присутствие на сайте / в игровой + накопление playtimeMs.
 *
 * Клиент шлёт POST /presence/heartbeat { where:'site'|'game', active?:bool }
 * каждые ~20 с с открытых вкладок; active=true (или любой input) снимает AFK.
 *
 * Статусы (presence):
 *   traveling — свежий heartbeat where=game
 *   online    — свежий site, игровой нет
 *   away      — вкладка жива, но бездействие > AWAY_MS (10 мин)
 *   resting   — нет свежих heartbeat (вкладки закрыты / TTL истёк)
 *
 * Playtime: пока where=game и heartbeat живой, копим мс в profile.playtimeMs
 * (персист через flushAccounts). Учёт с момента деплоя фичи — старые = 0.
 *
 * AFK на поле: isAfk(accountId) → room.publicCat несёт afk:true; смена
 * статуса дергает зарегистрированный onAfkChange.
 */
import { csrfDecision, siteClassOfRequest } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, setCors, readJson } from "./runtime-config.js";
import { findById, flushAccounts } from "./accounts.js";
import { lastLocationFor } from "./persist.js";
import { pushActivity } from "./activity.js";

const HEARTBEAT_TTL_MS = 45_000;
const AWAY_MS = 10 * 60_000;
const PLAYTIME_FLUSH_GAP_MS = 30_000;

/** @typedef {'online'|'traveling'|'away'|'resting'} PresenceTone */

/** @type {Map<string, { siteUntil:number, gameUntil:number, lastActivityAt:number, lastGameTick:number, dirtyPlay:boolean }>} */
const live = new Map();

/** @type {((accountId:string, afk:boolean) => void) | null} */
let afkListener = null;

/** @type {(() => Map<any, any> | Iterable<any>) | null} */
let roomsProvider = null;

/** Резолвер имени локации (биндится из net.js → location-world, без цикла import). */
/** @type {(id:number) => {name:string, zoneName:string}} */
let placeResolver = (id) => {
  const n = Math.max(1, Number(id) || 1);
  const name = n === 1 ? "Долина" : n === 2 ? "Редколесье" : `Локация ${n}`;
  return { name, zoneName: "Средиземье" };
};

export function onAfkChange(fn) {
  afkListener = typeof fn === "function" ? fn : null;
}

/** Room-слой регистрирует доступ к живым комнатам (избегаем цикличного import). */
export function bindPresenceRooms(provider) {
  roomsProvider = typeof provider === "function" ? provider : null;
}

export function bindPlaceResolver(fn) {
  if (typeof fn === "function") placeResolver = fn;
}

function rowOf(accountId) {
  const id = String(accountId || "");
  if (!id) return null;
  let row = live.get(id);
  if (!row) {
    const now = Date.now();
    row = {
      siteUntil: 0,
      gameUntil: 0,
      lastActivityAt: now,
      lastGameTick: 0,
      dirtyPlay: false,
    };
    live.set(id, row);
  }
  return row;
}

function placeById(id) {
  return placeResolver(Number(id) || 1);
}

/** Живая локация аккаунта (если кот сейчас в комнате). */
function liveLocationId(accountId) {
  const id = String(accountId || "");
  if (!id || !roomsProvider) return 0;
  try {
    const rooms = roomsProvider();
    if (!rooms) return 0;
    for (const room of rooms.values ? rooms.values() : rooms) {
      if (!room || !room.sockets) continue;
      for (const [ws, cat] of room.sockets.entries()) {
        if (!ws?.account || String(ws.account.id) !== id) continue;
        const loc = Number(cat?.locationId) || 0;
        if (loc > 0) return loc;
      }
    }
  } catch {
    return 0;
  }
  return 0;
}

function characterLogin(acc) {
  const chars = Array.isArray(acc?.characters) ? acc.characters : [];
  const active = chars.find((c) => c && c.id === acc.activeCharacterId) || chars[0];
  return active && typeof active.name === "string" ? active.name : "";
}

/**
 * Подпись локации для карточки: живой кот → текущая; иначе последняя
 * из книги позиций (lastLocationFor). Пусто → null (клиент «—»).
 */
export function locationLabelOf(acc) {
  if (!acc) return null;
  const liveId = liveLocationId(acc.id);
  if (liveId > 0) {
    const p = placeById(liveId);
    return p.zoneName ? `${p.zoneName} · ${p.name}` : p.name;
  }
  const login = characterLogin(acc);
  if (!login) return null;
  const lastId = lastLocationFor(login);
  if (!lastId) return null;
  const p = placeById(lastId);
  return p.zoneName ? `${p.zoneName} · ${p.name}` : p.name;
}

function hasLiveTab(row, now) {
  return row.siteUntil > now || row.gameUntil > now;
}

/**
 * @returns {PresenceTone}
 */
export function presenceOf(accountId, now = Date.now()) {
  const row = live.get(String(accountId || ""));
  if (!row || !hasLiveTab(row, now)) return "resting";
  if (now - row.lastActivityAt >= AWAY_MS) return "away";
  if (row.gameUntil > now) return "traveling";
  return "online";
}

export function isAfk(accountId, now = Date.now()) {
  return presenceOf(accountId, now) === "away";
}

function emitAfk(accountId, wasAfk, now) {
  const nowAfk = isAfk(accountId, now);
  if (wasAfk === nowAfk) return;
  if (afkListener) {
    try {
      afkListener(accountId, nowAfk);
    } catch (e) {
      console.warn("afk listener failed:", e?.message || e);
    }
  }
}

/** Начислить playtime за интервал игрового heartbeat. */
function accruePlaytime(acc, row, now) {
  if (!acc?.profile || typeof acc.profile !== "object") {
    if (acc) acc.profile = {};
  }
  if (!acc) return;
  if (row.lastGameTick > 0 && row.gameUntil >= now - HEARTBEAT_TTL_MS) {
    const delta = Math.min(Math.max(0, now - row.lastGameTick), HEARTBEAT_TTL_MS * 2);
    if (delta > 0) {
      acc.profile.playtimeMs = Math.max(0, Math.floor(Number(acc.profile.playtimeMs) || 0)) + delta;
      row.dirtyPlay = true;
    }
  }
  row.lastGameTick = now;
}

function maybeFlushPlaytime(acc, row, force = false) {
  if (!row.dirtyPlay || !acc) return;
  const now = Date.now();
  if (!force && now - (row._lastFlush || 0) < PLAYTIME_FLUSH_GAP_MS) return;
  flushAccounts(true);
  row.dirtyPlay = false;
  row._lastFlush = now;
}

/**
 * Публичный срез присутствия для card()/catalog.
 */
export function presenceSlice(acc, now = Date.now()) {
  const id = String(acc?.id || "");
  return {
    presence: presenceOf(id, now),
    playtimeMs: Math.max(0, Math.floor(Number(acc?.profile?.playtimeMs) || 0)),
    locationLabel: locationLabelOf(acc),
  };
}

/** Любая активность на сайте/в игре снимает AFK. */
export function touchActivity(accountId) {
  const id = String(accountId || "");
  if (!id) return;
  const row = rowOf(id);
  if (!row) return;
  const now = Date.now();
  const was = isAfk(id, now);
  row.lastActivityAt = now;
  emitAfk(id, was, now);
}

/** Канон /presence/*; обходной /cfg/presence/* — прод nginx уже шлёт /cfg в Node. */
function isPresencePath(p) {
  return (
    p === "/presence/heartbeat" || p.startsWith("/presence/") ||
    p === "/cfg/presence/heartbeat" || p.startsWith("/cfg/presence/")
  );
}

function canonPresencePath(p) {
  if (p === "/cfg/presence/heartbeat") return "/presence/heartbeat";
  if (p.startsWith("/cfg/presence/")) return "/presence/" + p.slice("/cfg/presence/".length);
  return p;
}

export async function handlePresenceHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const raw = url.pathname;
  if (!isPresencePath(raw)) return false;
  const p = canonPresencePath(raw);
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

  if (req.method === "POST" && p === "/presence/heartbeat") {
    const body = await readJson(req, 4 * 1024);
    const where = body && typeof body.where === "string" ? body.where : "";
    if (where !== "site" && where !== "game") {
      json(res, 400, { ok: false, reason: "invalid_where" });
      return true;
    }
    const active = body?.active !== false; // по умолчанию heartbeat = активность
    const acc = session.account;
    const id = String(acc?.id || "");
    const row = rowOf(id);
    const now = Date.now();
    const wasAfk = isAfk(id, now);

    if (where === "game") {
      // Лента: вход в игру — когда свежего game-heartbeat до этого не было.
      if (row.gameUntil <= now) pushActivity(id, "entered_game", { label: locationLabelOf(acc) || "" });
      accruePlaytime(acc, row, now);
      row.gameUntil = now + HEARTBEAT_TTL_MS;
      maybeFlushPlaytime(acc, row, false);
    } else {
      row.siteUntil = now + HEARTBEAT_TTL_MS;
    }
    if (active) row.lastActivityAt = now;
    emitAfk(id, wasAfk, now);

    json(res, 200, {
      ok: true,
      presence: presenceOf(id, now),
      playtimeMs: Math.max(0, Math.floor(Number(acc?.profile?.playtimeMs) || 0)),
    });
    return true;
  }

  json(res, 405, { ok: false, reason: "method_not_allowed" });
  return true;
}

/** Периодический слив playtime и очистка мёртвых строк. */
export function tickPresence() {
  const now = Date.now();
  for (const [id, row] of live.entries()) {
    if (!hasLiveTab(row, now) && now - row.lastActivityAt > AWAY_MS * 3) {
      if (row.dirtyPlay) {
        const acc = findById(id);
        maybeFlushPlaytime(acc, row, true);
      }
      live.delete(id);
      continue;
    }
    if (row.dirtyPlay) {
      const acc = findById(id);
      maybeFlushPlaytime(acc, row, false);
    }
  }
}

setInterval(tickPresence, 20_000).unref?.();
