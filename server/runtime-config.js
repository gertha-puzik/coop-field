/**
 * Safe room tunables stored in DATA_DIR/runtime-config.json.
 * Only atmoset-class lengths live here — protocol invariants stay in protocol.js.
 * Apply timing: new rooms pick the default; a live room already has its own atmo.
 * Admin HTTP POST /cfg (session role=admin). History: last 8 backups, like setmap.
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, isAllowedOrigin } from "./config.js";
import { ATMO_PHASE_MS_DEF, ATMO_WEATHER_MS_DEF } from "./protocol.js";
import { findById } from "./accounts.js";

const FILE = path.join(DATA_DIR, "runtime-config.json");
const BACKUP_DIR = path.join(DATA_DIR, "cfg-backups");
const BACKUP_KEEP = 8;
const PHASE_MIN_MIN = 1;
const PHASE_MIN_MAX = 120;
const WEATHER_MIN_MIN = 2;
const WEATHER_MIN_MAX = 240;

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function defaults() {
  return {
    v: 1,
    atmo: {
      phaseMin: Math.round(ATMO_PHASE_MS_DEF / 60_000),
      weatherMin: Math.round(ATMO_WEATHER_MS_DEF / 60_000),
    },
  };
}

function clampInt(raw, lo, hi, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function sanitizeConfig(raw) {
  const base = defaults();
  if (!raw || typeof raw !== "object") return { error: "конфиг не распознан" };
  const atmo = raw.atmo && typeof raw.atmo === "object" ? raw.atmo : raw;
  return {
    config: {
      v: 1,
      atmo: {
        phaseMin: clampInt(atmo.phaseMin, PHASE_MIN_MIN, PHASE_MIN_MAX, base.atmo.phaseMin),
        weatherMin: clampInt(atmo.weatherMin, WEATHER_MIN_MIN, WEATHER_MIN_MAX, base.atmo.weatherMin),
      },
    },
  };
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const out = sanitizeConfig(raw);
    return out.config || defaults();
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("runtime-config read failed:", e?.message || e);
    return defaults();
  }
}

let current = loadConfig();

function publicConfig() {
  return {
    ...current,
    apply: {
      atmo: "new-room",
      hint: "Длительности суток и погоды новых комнат. Уже открытая комната меняется событием atmoset сразу.",
    },
  };
}

function atmoLengths() {
  return {
    pl: current.atmo.phaseMin * 60_000,
    wl: current.atmo.weatherMin * 60_000,
  };
}

function rotateBackup(json) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(BACKUP_DIR, `${stamp}.json`), json);
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith(".json")).sort();
  while (files.length > BACKUP_KEEP) {
    const gone = files.shift();
    try {
      fs.unlinkSync(path.join(BACKUP_DIR, gone));
    } catch {
      /* ignore */
    }
  }
}

function listHistory() {
  try {
    return fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, BACKUP_KEEP);
  } catch {
    return [];
  }
}

function saveConfig(next) {
  const json = JSON.stringify(next, null, 2);
  try {
    if (fs.existsSync(FILE)) rotateBackup(fs.readFileSync(FILE, "utf8"));
  } catch {
    /* first write */
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(FILE, json);
  current = next;
}

function tokenFromReq(req) {
  try {
    const url = new URL(req.url || "/", "http://localhost");
    const q = String(url.searchParams.get("t") || "");
    if (q) return q;
  } catch {
    /* ignore */
  }
  const raw = String(req?.headers?.cookie || "");
  const m = raw.match(/(?:^|;\s*)coop_session=([0-9a-f]+)/i);
  return m ? m[1] : "";
}

function adminFromReq(req) {
  const token = tokenFromReq(req);
  if (!token) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "sessions.json"), "utf8"));
    const rec = raw?.sessions?.[token];
    if (!rec || Date.now() > Number(rec.expiresAt)) return null;
    const account = findById(rec.accountId);
    return account && account.role === "admin" ? account : null;
  } catch {
    return null;
  }
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

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
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

async function handleCfgHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/cfg" && !url.pathname.startsWith("/cfg/")) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (url.pathname === "/cfg" && req.method === "GET") {
    json(res, 200, { ok: true, ...publicConfig(), history: listHistory() });
    return true;
  }
  if (url.pathname === "/cfg" && req.method === "POST") {
    if (!adminFromReq(req)) {
      json(res, 403, { ok: false, reason: "auth_required" });
      return true;
    }
    try {
      const body = await readJson(req);
      if (body.reset) {
        saveConfig(defaults());
        json(res, 200, { ok: true, ...publicConfig(), history: listHistory() });
        return true;
      }
      const out = sanitizeConfig(body);
      if (out.error) {
        json(res, 400, { ok: false, reason: out.error });
        return true;
      }
      saveConfig(out.config);
      json(res, 200, { ok: true, ...publicConfig(), history: listHistory() });
      return true;
    } catch {
      json(res, 400, { ok: false, reason: "error" });
      return true;
    }
  }
  json(res, 404, { ok: false, reason: "error" });
  return true;
}

export {
  FILE,
  sanitizeConfig,
  publicConfig,
  atmoLengths,
  saveConfig,
  loadConfig,
  defaults,
  handleCfgHttp,
  listHistory,
};
