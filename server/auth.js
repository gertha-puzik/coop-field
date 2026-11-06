/**
 * Sessions, password actions, HTTP /auth/* and WS `auth` frames.
 * Token is an opaque hex string stored in DATA_DIR/sessions.json; the server
 * is the source of truth. A socket identity lives on ws.account (or null = guest).
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { EV } from "./protocol.js";
import { DATA_DIR, isAllowedOrigin } from "./config.js";
import { send } from "./room.js";
import {
  PASS_MIN,
  createAccount,
  loginAccount,
  findById,
  publicAccount,
  flushAccounts,
} from "./accounts.js";

const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const COOKIE = "coop_session";
const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const REGISTER_GAP_MS = 60_000;
const REGISTER_HOUR_MAX = 5;
const LOGIN_GAP_MS = 6_000;

let sessions = loadSessions();
const hits = new Map();

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    if (raw && typeof raw === "object" && raw.sessions && typeof raw.sessions === "object") {
      return raw.sessions;
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("sessions file read failed:", e?.message || e);
  }
  return {};
}

function saveSessions() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const now = Date.now();
    for (const [id, row] of Object.entries(sessions)) {
      if (!row || now > Number(row.expiresAt)) delete sessions[id];
    }
    writeFileAtomic(SESSIONS_FILE, JSON.stringify({ v: 1, sessions }, null, 2));
  } catch (e) {
    console.warn("sessions save failed:", e?.message || e);
  }
}

function newToken() {
  return randomBytes(32).toString("hex");
}

function createSession(accountId) {
  const token = newToken();
  sessions[token] = { accountId, createdAt: Date.now(), expiresAt: Date.now() + TTL_MS };
  saveSessions();
  return token;
}

function readSession(token) {
  const rec = token ? sessions[token] : null;
  if (!rec) return null;
  if (Date.now() > Number(rec.expiresAt)) {
    delete sessions[token];
    saveSessions();
    return null;
  }
  const acc = findById(rec.accountId);
  return acc ? { token, account: acc } : null;
}

function destroySession(token) {
  if (token && sessions[token]) {
    delete sessions[token];
    saveSessions();
  }
}

function clientIp(reqOrWs) {
  const fwd = reqOrWs?.headers?.["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  const sock = reqOrWs?.socket || reqOrWs?._socket;
  return String(reqOrWs?.ip || sock?.remoteAddress || "0").split(",")[0].trim();
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function rate(ip, key, gapMs, hourMax) {
  if (isLoopback(ip)) return true;
  const now = Date.now();
  const bucket = hits.get(ip) || {};
  const arr = (bucket[key] || []).filter((t) => now - t < 60 * 60_000);
  if (arr.length && now - arr[arr.length - 1] < gapMs) {
    hits.set(ip, { ...bucket, [key]: arr });
    return false;
  }
  if (hourMax && arr.length >= hourMax) {
    hits.set(ip, { ...bucket, [key]: arr });
    return false;
  }
  arr.push(now);
  hits.set(ip, { ...bucket, [key]: arr });
  return true;
}

function cookieToken(req) {
  const raw = String(req?.headers?.cookie || "");
  const m = raw.match(/(?:^|;\s*)coop_session=([0-9a-f]+)/i);
  return m ? m[1] : "";
}

function queryToken(req) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    return String(url.searchParams.get("t") || "");
  } catch {
    return "";
  }
}

function tokenFromRequest(req) {
  return queryToken(req) || cookieToken(req);
}

function bindAccount(ws, account, token) {
  ws.account = account || null;
  ws.sessionToken = token || "";
}

function bindToken(ws, token) {
  const hit = readSession(token);
  if (!hit) {
    bindAccount(ws, null, "");
    return null;
  }
  bindAccount(ws, hit.account, hit.token);
  return hit.account;
}

function whoamiBody(ws, extra = {}) {
  const acc = ws.account;
  if (!acc) return { ok: true, role: "guest", ...extra };
  return { ok: true, ...publicAccount(acc), token: extra.token || ws.sessionToken || undefined, ...extra };
}

function reasonText(code) {
  if (code === "taken") return "Это имя уже занято.";
  if (code === "weak") return `Пароль слишком короткий (минимум ${PASS_MIN}).`;
  if (code === "short") return "Имя слишком короткое.";
  if (code === "bad") return "Неверный логин или пароль.";
  if (code === "rate") return "Слишком часто. Подождите немного.";
  return "Не получилось войти.";
}

function cookieHeader(token, secure) {
  const maxAge = Math.floor(TTL_MS / 1000);
  const parts = [`${COOKIE}=${token}`, "HttpOnly", "Path=/", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure", "SameSite=None");
  else parts.push("SameSite=Lax");
  return parts.join("; ");
}

function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function readJson(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("json"));
      }
    });
    req.on("error", reject);
  });
}

function sendWhoami(ws, body) {
  send(ws, EV.WHOAMI, body);
}

async function handleAuthFrame(ws, payload = {}, ip = "0") {
  const action = String(payload.action || "").trim();
  if (action === "hello") {
    const token = String(payload.token || ws.sessionToken || "");
    if (token) bindToken(ws, token);
    sendWhoami(ws, whoamiBody(ws));
    return;
  }
  if (action === "logout") {
    destroySession(ws.sessionToken);
    bindAccount(ws, null, "");
    sendWhoami(ws, { ok: true, role: "guest" });
    return;
  }
  if (action === "register") {
    if (!rate(ip, "register", REGISTER_GAP_MS, REGISTER_HOUR_MAX)) {
      sendWhoami(ws, { ok: false, reason: "rate" });
      send(ws, EV.INFO, reasonText("rate"));
      return;
    }
    const out = await createAccount(payload.login, payload.pass);
    if (out.error) {
      sendWhoami(ws, { ok: false, reason: out.error });
      send(ws, EV.INFO, reasonText(out.error));
      return;
    }
    const token = createSession(out.account.id);
    bindAccount(ws, out.account, token);
    sendWhoami(ws, whoamiBody(ws, { token }));
    return;
  }
  if (action === "login") {
    if (!rate(ip, "login", LOGIN_GAP_MS, 0)) {
      sendWhoami(ws, { ok: false, reason: "rate" });
      send(ws, EV.INFO, reasonText("rate"));
      return;
    }
    const out = await loginAccount(payload.login, payload.pass);
    if (out.error) {
      sendWhoami(ws, { ok: false, reason: "bad" });
      send(ws, EV.INFO, reasonText("bad"));
      return;
    }
    const token = createSession(out.account.id);
    bindAccount(ws, out.account, token);
    sendWhoami(ws, whoamiBody(ws, { token }));
    return;
  }
  sendWhoami(ws, { ok: false, reason: "error" });
}

function json(res, status, body, extraHeaders) {
  const headers = { "content-type": "application/json; charset=utf-8", ...extraHeaders };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

async function handleAuthHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/auth" && !url.pathname.startsWith("/auth/")) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  const ip = clientIp(req);
  const secure = req.headers["x-forwarded-proto"] === "https" || url.protocol === "https:";
  try {
    if (url.pathname === "/auth/me" && req.method === "GET") {
      const hit = readSession(tokenFromRequest(req));
      if (!hit) {
        json(res, 200, { ok: true, role: "guest" });
        return true;
      }
      json(res, 200, { ok: true, ...publicAccount(hit.account) });
      return true;
    }
    if (url.pathname === "/auth/logout" && req.method === "POST") {
      destroySession(tokenFromRequest(req));
      json(res, 200, { ok: true, role: "guest" }, { "Set-Cookie": cookieHeader("deleted", secure) + "; Max-Age=0" });
      return true;
    }
    if (url.pathname === "/auth/register" && req.method === "POST") {
      if (!rate(ip, "register", REGISTER_GAP_MS, REGISTER_HOUR_MAX)) {
        json(res, 429, { ok: false, reason: "rate" });
        return true;
      }
      const body = await readJson(req);
      const out = await createAccount(body.login, body.pass);
      if (out.error) {
        json(res, 400, { ok: false, reason: out.error });
        return true;
      }
      const token = createSession(out.account.id);
      json(res, 200, { ok: true, token, ...publicAccount(out.account) }, { "Set-Cookie": cookieHeader(token, secure) });
      return true;
    }
    if (url.pathname === "/auth/login" && req.method === "POST") {
      if (!rate(ip, "login", LOGIN_GAP_MS, 0)) {
        json(res, 429, { ok: false, reason: "rate" });
        return true;
      }
      const body = await readJson(req);
      const out = await loginAccount(body.login, body.pass);
      if (out.error) {
        json(res, 401, { ok: false, reason: "bad" });
        return true;
      }
      const token = createSession(out.account.id);
      json(res, 200, { ok: true, token, ...publicAccount(out.account) }, { "Set-Cookie": cookieHeader(token, secure) });
      return true;
    }
  } catch {
    json(res, 400, { ok: false, reason: "error" });
    return true;
  }
  json(res, 404, { ok: false, reason: "error" });
  return true;
}

function handshake(ws, req) {
  const token = tokenFromRequest(req);
  if (token) bindToken(ws, token);
  ws.clientIp = clientIp(req);
  sendWhoami(ws, whoamiBody(ws));
}

function flushAuth() {
  flushAccounts();
  saveSessions();
}

export {
  handleAuthHttp,
  handleAuthFrame,
  handshake,
  bindToken,
  whoamiBody,
  tokenFromRequest,
  flushAuth,
  COOKIE,
  TTL_MS,
};
