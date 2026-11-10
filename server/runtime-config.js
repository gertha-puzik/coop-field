/**
 * Runtime-конфиг v2 (P2, спек §6): в DATA_DIR/runtime-config.json лежат ТОЛЬКО
 * значения { v: 1, atmo, universes, combat } — whitelist-модель: что можно
 * менять, определяет реестр server/cfg-registry.js (ключи atmo.phaseMin,
 * atmo.weatherMin, universes.strikeDamage, universes.armor,
 * universes.arrowSpeed, combat.armorCurve — мандат владелицы 2026-11-08).
 * Протокольные константы, события авторизации и лимиты сюда НЕ входят и сюда
 * не пишутся.
 *
 * Файл остаётся схемы v:1 — обратная совместимость на чтение: старый файл
 * (только atmo) поднимается, universes и combat добираются дефолтами реестра
 * (кривая брони — канон W3), файл НЕ перезаписывается до первого
 * admin-POST. Запись — атомарная (writeFileAtomic) с вращением бэкапов
 * (BACKUP_KEEP штук), механика без изменений.
 *
 * HTTP (роли проверяет adminFromReq по сессии; на public-хосте POST /cfg и
 * admin-маршруты прячет host-гейт в net.js; пишущие POST идут через CSRF
 * Origin-щит там же):
 *   GET  /cfg           — публичный: v, atmo, universes, combat (кривая
 *                         брони видна игрокам — HUD прогноз урона), apply-hint
 *                         (БЕЗ истории).
 *   GET  /cfg/admin     — admin: значения + история + метаданные реестра.
 *   POST /cfg           — admin: патч по ключам реестра; reset: true — дефолты.
 *   POST /cfg/restore   — admin: восстановить бэкап по имени ИЗ listHistory.
 *   GET  /cfg/export    — admin: текущие значения одним JSON (incl. combat).
 *   POST /cfg/import    — admin: принять экспорт (через sanitizeValues, всё или ничего).
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, isAllowedOrigin } from "./config.js";
import { writeFileAtomic } from "./atomic-file.js";
import {
  REGISTRY, KEYS, defaultsFor, sanitizeValues, universesForPublic, mutationsForAdmin,
  armorCurveFor,
} from "./cfg-registry.js";
import { findById } from "./accounts.js";

const FILE = path.join(DATA_DIR, "runtime-config.json");
const BACKUP_DIR = path.join(DATA_DIR, "cfg-backups");
const BACKUP_KEEP = 8;

/** Дефолты — из реестра (единственный источник). Легаси-алиас для смоука. */
const defaults = defaultsFor;

/**
 * Легаси-валидатор atmo для модульного смоука (test-server-modules): толерантен
 * к мусору (NaN→дефолт), универс значения дописывает дефолтами. HTTP-роуты
 * используют строгий sanitizeValues из реестра — здесь только совместимость.
 */
function sanitizeConfig(raw) {
  if (!raw || typeof raw !== "object") return { error: "конфиг не распознан" };
  const sec = raw.atmo && typeof raw.atmo === "object" ? raw.atmo : raw;
  const pick = (k) => {
    const n = Number(sec[k]);
    return Number.isFinite(n) ? n : undefined;
  };
  const out = sanitizeValues(
    { atmo: { phaseMin: pick("phaseMin"), weatherMin: pick("weatherMin") } },
    defaults(),
  );
  return { config: out.values };
}

/**
 * Чтение файла с read-time миграцией: старый atmo-only файл читается, universes
 * добираются дефолтами, файл на диске не трогается до первого admin-POST.
 * Мусор внутри (не наша писанина) → дефолты с предупреждением.
 */
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const out = sanitizeValues(raw, defaults());
    if (!out.values) {
      console.warn("runtime-config: файл не прошёл реестр — дефолты:", JSON.stringify(out.error));
      return defaults();
    }
    return out.values;
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("runtime-config read failed:", e?.message || e);
    return defaults();
  }
}

let current = loadConfig();

/** Apply-политики как данные: по каждому ключу реестра. */
function applyMap() {
  const out = {
    hint: "Длительности суток и погоды — стартовые значения новых комнат (живую комнату крутит atmoset). Уровни урона и брони действуют на следующие события; список периодов стрелы игрок увидит в новой сессии.",
  };
  for (const def of Object.values(REGISTRY)) out[def.key] = def.applyPolicy;
  return out;
}

/** Публичный блок: v, atmo, universes (только списки+дефолты), apply-hint.
 *  F2 (мандат 2026-11-08): combat.armorCurve — публичная кривая брони — игроки
 *  видят её прогноз урона на HUD, поэтому она НЕ admin-only и приходит ОБЕИМ
 *  вариантам сайтов. Читается через fail-safe armorCurveFor (битое — канон). */
function publicConfig() {
  return {
    v: current.v,
    atmo: { ...current.atmo },
    universes: universesForPublic(current),
    combat: { armorCurve: armorCurveFor(current) },
    apply: applyMap(),
  };
}

/** Админ-блок: значения + история бэкапов + метаданные реестра. F2 §4:
 *  админ видит ПОЛНЫЙ кураторский список (playerView: false) — выключение
 *  выбора игроков не стирает allowedValues, повторное включение возвращает
 *  список (а не весь движковый юниверс). Кривая брони — в values.combat. */
function adminConfig() {
  return {
    ok: true,
    v: current.v,
    values: {
      atmo: { ...current.atmo },
      universes: universesForPublic(current, { playerView: false }),
      combat: { armorCurve: armorCurveFor(current) },
    },
    registry: mutationsForAdmin(),
    apply: applyMap(),
    history: listHistory(),
    historyKeep: BACKUP_KEEP,
  };
}

/** Живая кривая брони для combat.js (on-next-event): значение реестра через
 *  armorCurveFor из cfg-registry (любой мусор → канон W3, не фантазия).
 *  Прецедент — combatCaps: читается на каждом событии. */
function armorCurve() {
  return armorCurveFor(current);
}

/** Кэпсы боя для combat.js (читаются на каждом событии — on-next-event).
 *  F2 §4: капы считаются по списку, ВИДИМОМУ игроку: playerSelectable=false →
 *  [defaultValue] — сервер продолжает отвергать выбор вне видимого списка
 *  даже для самодельных клиентов (клиент не авторитетен), поведение старого
 *  {default}-only-списка сохранено дословно. */
function combatCaps() {
  const u = current.universes;
  const visible = (field, kind) => (u[field].playerSelectable === false ? [u[field].default] : u[field][kind]);
  return { maxDamageLevel: Math.max(...visible("strikeDamage", "levels")), armorTenths: visible("armor", "tenths") };
}

function atmoLengths() {
  return {
    pl: current.atmo.phaseMin * 60_000,
    wl: current.atmo.weatherMin * 60_000,
  };
}

/**
 * Live-значение глобального master-гейта atmo.playerControl (мандат
 * владелицы 2026-11-08): читается ГЕЙТОМ atmoset/atmo на каждом кадре —
 * тот же live-паттерн, что combatCaps в combat.js. Отсутствие ключа в
 * старом файле (до 7-го ключа) трактуется как true — геймплей не меняется.
 */
function playerAtmoControl() {
  return current.atmo.playerControl !== false;
}

function rotateBackup(cfgJson) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(path.join(BACKUP_DIR, `${stamp}.json`), cfgJson);
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

/**
 * Сохранение: сначала вращение бэкапов (снимок текущего файла), потом
 * атомарная запись. next обязан уже пройти реестр (sanitizeValues).
 */
function saveConfig(next) {
  const payload = JSON.stringify(next, null, 2);
  try {
    if (fs.existsSync(FILE)) rotateBackup(fs.readFileSync(FILE, "utf8"));
  } catch {
    /* first write */
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(FILE, payload);
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

/** Администратор или спокойный 403 (матрица ответа POST /cfg прежняя). */
function requireAdmin(req, res) {
  if (adminFromReq(req)) return true;
  json(res, 403, { ok: false, reason: "auth_required" });
  return false;
}

async function handleCfgHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  if (p !== "/cfg" && !p.startsWith("/cfg/")) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  // Публичный: только значения (v, atmo, universes, apply-hint) — без истории.
  if (p === "/cfg" && req.method === "GET") {
    json(res, 200, { ok: true, ...publicConfig() });
    return true;
  }
  // Администратор: текущие значения + история + метаданные реестра.
  if (p === "/cfg/admin" && req.method === "GET") {
    if (!requireAdmin(req, res)) return true;
    json(res, 200, adminConfig());
    return true;
  }
  // Администратор: экспорт текущих значений одним JSON (для переноса).
  //  F2 §4: экспорт несёт полный кураторский список + явные флаги — перенос
  //  честен в обе стороны (импорт/re-валидация на приёмнике).
  if (p === "/cfg/export" && req.method === "GET") {
    if (!requireAdmin(req, res)) return true;
    json(res, 200, {
      ok: true,
      v: current.v,
      atmo: { ...current.atmo },
      universes: universesForPublic(current, { playerView: false }),
      combat: { armorCurve: armorCurveFor(current) },
    });
    return true;
  }
  if (p === "/cfg" && req.method === "POST") {
    if (!requireAdmin(req, res)) return true;
    try {
      const body = await readJson(req);
      if (body && body.reset === true) {
        saveConfig(defaults());
        json(res, 200, { ok: true, ...publicConfig() });
        return true;
      }
      const out = sanitizeValues(body, current);
      if (out.error) {
        json(res, 400, { ok: false, ...out.error });
        return true;
      }
      saveConfig(out.values);
      json(res, 200, { ok: true, ...publicConfig() });
    } catch {
      json(res, 400, { ok: false, reason: "error" });
    }
    return true;
  }
  // Восстановление бэкапа: только по имени из listHistory (path-guard — имя
  // обязано быть в свежем списке бэкапов, никаких путей наружу каталога).
  if (p === "/cfg/restore" && req.method === "POST") {
    if (!requireAdmin(req, res)) return true;
    try {
      const body = await readJson(req);
      const name = body?.name;
      const history = listHistory();
      if (typeof name !== "string" || !history.includes(name)) {
        json(res, 404, { ok: false, reason: "unknown_backup", allowed: history });
        return true;
      }
      const raw = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, name), "utf8"));
      const out = sanitizeValues(raw, defaults());
      if (out.error) {
        json(res, 400, { ok: false, ...out.error });
        return true;
      }
      saveConfig(out.values);
      json(res, 200, { ok: true, restored: name, ...publicConfig() });
    } catch {
      json(res, 400, { ok: false, reason: "error" });
    }
    return true;
  }
  // Импорт экспортного JSON: только секции реестра, всё или ничего.
  if (p === "/cfg/import" && req.method === "POST") {
    if (!requireAdmin(req, res)) return true;
    try {
      const body = await readJson(req);
      const patch = { atmo: body?.atmo ?? {}, universes: body?.universes ?? {}, combat: body?.combat ?? {} };
      const out = sanitizeValues(patch, defaults());
      if (out.error) {
        json(res, 400, { ok: false, ...out.error });
        return true;
      }
      saveConfig(out.values);
      json(res, 200, { ok: true, ...publicConfig() });
    } catch {
      json(res, 400, { ok: false, reason: "error" });
    }
    return true;
  }
  json(res, 404, { ok: false, reason: "error" });
  return true;
}

export {
  FILE,
  BACKUP_DIR,
  sanitizeConfig,
  publicConfig,
  adminConfig,
  combatCaps,
  armorCurve,
  atmoLengths,
  playerAtmoControl,
  saveConfig,
  loadConfig,
  defaults,
  handleCfgHttp,
  listHistory,
  // F2: ре-экспорт хелперов для per-room-модуля (server/room-config.js) — те же
  // механика ответа, лимит тела и гейт admin-роли, что у /cfg-роутов; сами
  // хелперы и формат существующих ответов НЕ изменены.
  adminFromReq,
  requireAdmin,
  readJson,
  json,
  setCors,
};
