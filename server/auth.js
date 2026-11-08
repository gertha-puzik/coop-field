/**
 * Sessions, password actions, HTTP /auth/* and WS `auth` frames.
 * Token is an opaque hex string stored in DATA_DIR/sessions.json; the server
 * is the source of truth. A socket identity lives on ws.account (or null = guest).
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { EV } from "./protocol.js";
import { DATA_DIR, originAllowedHere, csrfDecision, siteClassOfRequest } from "./config.js";
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

// Темп-лимиты auth-действий. Дефолты — прод-поведение; env-тюнинг нужен
// тестам (детерминированные пороги без sleep-магии) и владельцу для подстройки
// через systemd-юнит. Имена env: AUTH_REGISTER_GAP_MS, AUTH_REGISTER_HOURLY_MAX,
// AUTH_LOGIN_GAP_MS, AUTH_LOGIN_FAIL_MAX, AUTH_LOGIN_FAIL_WINDOW_MS.
const envMs = (name, def) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : def;
};
const REGISTER_GAP_MS = envMs("AUTH_REGISTER_GAP_MS", 60_000);
const REGISTER_HOUR_MAX = Math.max(1, Math.round(Number(process.env.AUTH_REGISTER_HOURLY_MAX) || 5));
const LOGIN_GAP_MS = envMs("AUTH_LOGIN_GAP_MS", 6_000);
// Подбор пароля к ОДНОМУ логину (дополнение к per-IP bucket): счёт ведётся по
// логину, поэтому ротация адресов не обходит, а владельца враг может лишь
// на время окна притормозить вход его имени — навсегда логин не закрывается;
// успешный вход сбрасывает счётчик.
const LOGIN_FAIL_MAX = Math.max(1, Math.round(Number(process.env.AUTH_LOGIN_FAIL_MAX) || 20));
const LOGIN_FAIL_WINDOW_MS = envMs("AUTH_LOGIN_FAIL_WINDOW_MS", 15 * 60_000);

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

/**
 * P5-редизайн каталога (read-only вью): аккаунт → время свежайшей ЖИВОЙ
 * сессии (createdAt последней сессии в пределах TTL). Единственный честный
 * источник «последний вход» без записи новых полей в аккаунты: сессии уже
 * пишутся при каждом входе, честнее просто смотреть на них. Просроченные
 * записи не учитываются (после 14 дней неактивности значение исчезает —
 * это честное «неизвестно», а не выдуманная дата). Ничего не мутирует.
 */
function lastSeenByAccount() {
  const out = new Map();
  const now = Date.now();
  for (const rec of Object.values(sessions)) {
    if (!rec || typeof rec !== "object") continue;
    if (now > Number(rec.expiresAt)) continue;
    const t = Number(rec.createdAt) || 0;
    if (!t) continue;
    const id = String(rec.accountId || "");
    if (!id) continue;
    if (t > (out.get(id) || 0)) out.set(id, t);
  }
  return out;
}

/**
 * Клиентский IP для темп-лимитов. X-Forwarded-For доверяем в ОДНОМ случае:
 * TCP-сокет пришёл с loopback (127.0.0.1/::1) — т.е. соединение терминировал
 * наш собственный nginx — и тогда берём ПОСЛЕДНЮЮ запись XFF: её дописал сам
 * nginx, клиент подделать её не может (свои поддельные хопы он дописал раньше,
 * они остаются НЕпоследними). Прямой коннект (не с loopback) — адрес сокета:
 * заголовок XFF от постороннего клиента — просто данные, не источник правды.
 * Обычно nginx /ws не передаёт XFF вовсе — до деплоя x-forwarded-for фрагмента
 * proxy-коннекты остаются loopback.
 */
function clientIp(reqOrWs) {
  const fwd = String(reqOrWs?.headers?.["x-forwarded-for"] || "");
  const sock = reqOrWs?.socket || reqOrWs?._socket;
  const remote = String(reqOrWs?.ip || sock?.remoteAddress || "0").split(",")[0].trim();
  if (fwd && isLoopback(remote)) {
    const last = fwd.split(",").pop().trim();
    if (last) return last;
  }
  return remote;
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * Троттлер на IP+действие: bucket хранит времена последних попыток за час.
 * loopback-исключение — это только ПРЯМОЙ локальный коннект (без XFF): локальная
 * разработка и скриптовые тесты не упираются в лимиты. Прод-трафик приходит
 * через nginx с XFF — тогда clientIp уже отдал реальный адрес, и лимиты
 * работают; без XFF-фрагмента nginx proxy-трафик тоже loopback (известный
 * остаточный риск до деплоя фрагмента).
 */
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

/* ---------- per-LOGIN замок неудачных входов ----------
 * Дополняет per-IP rate: брутфорс одного аккаунта с РОТАЦИЕЙ адресов per-IP
 * не ловит (gap 6 с на адрес — сотни попыток в час с одного IP и безлимит с роты).
 * Счёт ведём по логину: AUTH_LOGIN_FAIL_MAX неудач за AUTH_LOGIN_FAIL_WINDOW_MS
 * → дальнейшие попытки ПО ЛЮБОМУ адресу получают 'rate' до конца окна; успех
 * сбрасывает счётчик. Навсегда логин не закрывается — злой игрок может лишь
 * на время окна затормозить чей-то вход, DoS-лока имени нет. */

const loginFails = new Map();
/** Потолок карты, чтобы флуд несуществующими логинами не раздувал память. */
const LOGIN_FAIL_MAP_MAX = 4096;

function failKey(rawLogin) {
  return String(rawLogin || "").trim().toLowerCase();
}

/** Отдельная неудача: +1 в окно логина (по пути вычищаем просроченные записи). */
function noteLoginFail(rawLogin) {
  const key = failKey(rawLogin);
  if (!key) return;
  const now = Date.now();
  if (loginFails.size >= LOGIN_FAIL_MAP_MAX) {
    for (const [k, arr] of loginFails) {
      const keep = arr.filter((t) => now - t < LOGIN_FAIL_WINDOW_MS);
      if (keep.length) loginFails.set(k, keep);
      else loginFails.delete(k);
    }
  }
  const arr = (loginFails.get(key) || []).filter((t) => now - t < LOGIN_FAIL_WINDOW_MS);
  arr.push(now);
  loginFails.set(key, arr);
}

/** Замокнут ли логин (порог неудач в окне). Прежние неудачи по выходу
 *  из окна перестают считаться — лимит поствременный. */
function loginLocked(rawLogin) {
  const key = failKey(rawLogin);
  const now = Date.now();
  const arr = (loginFails.get(key) || []).filter((t) => now - t < LOGIN_FAIL_WINDOW_MS);
  if (arr.length) loginFails.set(key, arr);
  else loginFails.delete(key);
  return arr.length >= LOGIN_FAIL_MAX;
}

/** Успешный вход: счётчик неудач имени гасим. */
function clearLoginFails(rawLogin) {
  loginFails.delete(failKey(rawLogin));
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
  // Матрица токенов P1. Класс local — прежнее поведение (?t= работает, токен
  // в телах и whoami — на нём стоят тесты). Класс elyria уходит от токенов в
  // URL: принимает только cookie; AUTH_LEGACY_TOKEN=1 возвращает приём ?t=
  // на переходный период. Класс public ?t= пока принимает (гейт net.js всё
  // равно закрывает его HTTP-зоны; старые клиенты снимают ?t= в соседней фазе).
  if (siteClassOfRequest(req) === "elyria" && process.env.AUTH_LEGACY_TOKEN !== "1") {
    return cookieToken(req);
  }
  return queryToken(req) || cookieToken(req);
}

/** Сессия запроса (cookie/заголовки) — HTTP-потребителям профилей и др. */
function sessionFromRequest(req) {
  return readSession(tokenFromRequest(req));
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
  if (code === "full") return "Регистрация закрыта: на сервере больше нет свободных мест для аккаунтов.";
  if (code === "rate") return "Слишком часто. Подождите немного.";
  return "Не получилось войти.";
}

function cookieHeader(token, secure) {
  const maxAge = Math.floor(TTL_MS / 1000);
  // B1: host-only cookie — атрибута Domain намеренно НЕТ: кука привязана к
  // точному хосту и не расползается на соседние поддомены miew.ru.
  const parts = [`${COOKIE}=${token}`, "HttpOnly", "Path=/", `Max-Age=${maxAge}`];
  // P1: https-кука — Secure + SameSite=Lax (браузерный ход Элизии был
  // same-origin, None туда не нужен). COOKIE_LOOSE=1 возвращает легаси None
  // для переходного периода старых кросс-доменных клиентов.
  if (secure) {
    const samesite = process.env.COOKIE_LOOSE === "1" ? "SameSite=None" : "SameSite=Lax";
    parts.push("Secure", samesite);
  } else parts.push("SameSite=Lax");
  return parts.join("; ");
}

/** B1: CORS решается парой (Origin, класс destination-хоста): Access-Control-
 *  Allow-Origin — только точный origin и только если он «свой» для класса
 *  destination. Никогда wildcard, чужой origin не отражается; куки по нему
 *  браузер не прочитает (ACAO не выдан), даже если запрос дойдёт. */
function setCors(req, res) {
  const origin = String(req.headers.origin || "");
  const destClass = siteClassOfRequest(req);
  res.setHeader("Vary", "Origin");
  if (origin && originAllowedHere(origin, destClass)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
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
  // Хост-гейт P1: на public-хосте регистрации и входа нет вовсе — спокойный
  // отказ без деталей (ни «нет такой комнаты», ни подсказок о причине). Гость
  // в гротах по-прежнему получает hello/logout как обычно, а аккаунт на
  // elyria/local — прежний вход (см. матрицу токенов в tokenFromRequest).
  if ((action === "register" || action === "login") && ws.hostClass === "public") {
    sendWhoami(ws, { ok: false, reason: "error" });
    return;
  }
  // B1: register/login — «cookie-аутентифицированные» WS-операции (кадры
  // создают/поднимают сессию): на public/elyria они требуют Origin, точный
  // для destination-класса (upgrade-гейт в net.js отказывает чужому Origin
  // ПРИ подключении; здесь — отказ кадрам без Origin). Гость-геймплей,
  // hello/logout и прочие кадры работают, как раньше; на local классе
  // прежнее пермиссивное поведение (легаси-тесты и originless-скрипты).
  if ((action === "register" || action === "login") && ws.hostClass !== "local" && !ws.originOk) {
    sendWhoami(ws, { ok: false, reason: "error" });
    return;
  }
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
    if (loginLocked(payload.login)) {
      sendWhoami(ws, { ok: false, reason: "rate" });
      send(ws, EV.INFO, "Много неудачных попыток входа с этим именем. Подождите немного.");
      return;
    }
    if (!rate(ip, "login", LOGIN_GAP_MS, 0)) {
      sendWhoami(ws, { ok: false, reason: "rate" });
      send(ws, EV.INFO, reasonText("rate"));
      return;
    }
    const out = await loginAccount(payload.login, payload.pass);
    if (out.error) {
      noteLoginFail(payload.login);
      sendWhoami(ws, { ok: false, reason: "bad" });
      send(ws, EV.INFO, reasonText("bad"));
      return;
    }
    clearLoginFails(payload.login);
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
  // Класс САЙТА запроса (B1: Host-классификация + доверенная метка прокси) —
  // матрица тел-токенов (cookie-only на elyria).
  const siteClass = siteClassOfRequest(req);
  // CSRF fail-closed (B1): unsafe-методы с cookie-аутентификацией на
  // public/elyria обязаны нести Origin, точный для destination-класса:
  // пустой Origin → 403 csrf_origin_required, чужой → 403 csrf_origin_mismatch.
  // Класс local — прежнее пермиссивное поведение (AUTH_CSRF_STRICT='0'/'1'
  // форсирует режим для всех классов — контроль тестовых стендов).
  const csrfBad = csrfDecision({
    method: req.method,
    origin: req.headers.origin,
    destClass: siteClass,
    hasAuth: Boolean(cookieToken(req) || queryToken(req)),
  });
  if (csrfBad) {
    json(res, csrfBad.status, { ok: false, reason: csrfBad.reason });
    return true;
  }
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
      // Элизия — cookie-only: токен в теле HTTP-ответа не выдаётся (кука та же).
      // local — прежнее поведение, тесты и dev завязаны на токен в теле.
      const resp = { ok: true, ...publicAccount(out.account) };
      if (siteClass !== "elyria") resp.token = token;
      json(res, 200, resp, { "Set-Cookie": cookieHeader(token, secure) });
      return true;
    }
    if (url.pathname === "/auth/login" && req.method === "POST") {
      const body = await readJson(req);
      if (loginLocked(body.login)) {
        json(res, 429, { ok: false, reason: "rate" });
        return true;
      }
      if (!rate(ip, "login", LOGIN_GAP_MS, 0)) {
        json(res, 429, { ok: false, reason: "rate" });
        return true;
      }
      const out = await loginAccount(body.login, body.pass);
      if (out.error) {
        noteLoginFail(body.login);
        json(res, 401, { ok: false, reason: "bad" });
        return true;
      }
      clearLoginFails(body.login);
      const token = createSession(out.account.id);
      // Матрица тел-токенов P1: elyria — cookie-only, local — токен в теле.
      const resp = { ok: true, ...publicAccount(out.account) };
      if (siteClass !== "elyria") resp.token = token;
      json(res, 200, resp, { "Set-Cookie": cookieHeader(token, secure) });
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
  // Класс САЙТА хендшейка (B1: siteClassOfRequest — Host + доверенная метка
  // прокси): WS-кадры auth гейтятся по нему в handleAuthFrame — register/login
  // не работают на public-хосте, а на elyria требуют Origin своего класса.
  ws.hostClass = siteClassOfRequest(req);
  ws.clientOrigin = String(req?.headers?.origin || "");
  // B1: origin сокета — ПАРА (origin, destination-класс): чужой origin на
  // upgrade уже отклонён в net.js; сюда попадают «свои» и пустые (гость).
  ws.originOk = Boolean(ws.clientOrigin) && originAllowedHere(ws.clientOrigin, ws.hostClass);
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
  sessionFromRequest,
  lastSeenByAccount,
  flushAuth,
  COOKIE,
  TTL_MS,
};
