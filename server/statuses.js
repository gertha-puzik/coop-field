/**
 * Статусы игроков на поле (Элизия): каталог подписей + присвоение аккаунту.
 * Хранилище DATA_DIR/statuses.json (каталог); statusId живёт в
 * accounts.json → profile.statusId. Дефолт «Тестер»; три crown-id получают
 * «Глав. Администратор» при старте (идемпотентно).
 *
 * HTTP (host-гейт /admin в net.js + CSRF apiZone + role admin здесь):
 *   GET    /admin/statuses           — каталог + назначения
 *   POST   /admin/statuses           — {label, id?} создать
 *   PATCH  /admin/statuses/:id       — {label} переименовать
 *   DELETE /admin/statuses/:id       — удалить (назначения → tester)
 *   POST   /admin/statuses/assign    — {accountId, statusId} выдать/снять
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { accountsStore, findById, flushAccounts, setStatusLabelResolver } from "./accounts.js";
import { json, readJson, setCors } from "./runtime-config.js";
import { writeFileAtomic } from "./atomic-file.js";

const STATUSES_FILE = path.join(DATA_DIR, "statuses.json");
const DEFAULT_ID = "tester";
const CHIEF_ID = "chief-admin";
const LABEL_MAX = 48;
const ID_RE = /^[a-z0-9-]{2,40}$/;
/** Аккаунты с «Глав. Администратор» (мандат владелицы, 2026-11-13). */
const CHIEF_ACCOUNT_IDS = Object.freeze(["a34d8da4", "a348fcd7", "ae960493"]);

const ROUTES = {
  ROOT: "/admin/statuses",
  ASSIGN: "/admin/statuses/assign",
};

let catalog = loadCatalog();
let booted = false;

/** Вызывать из startServer (net.js): после полного load accounts/room. */
export function bootStatuses() {
  if (booted) return;
  booted = true;
  setStatusLabelResolver(statusLabelOf);
  seedAssignments();
}

function emptyCatalog() {
  return {
    v: 1,
    /** false → при первом старте всем без crown выдать Тестер (мандат владелицы). */
    assignedDefault: false,
    statuses: [
      { id: DEFAULT_ID, label: "Тестер", sort: 0 },
      { id: CHIEF_ID, label: "Глав. Администратор", sort: 10 },
    ],
  };
}

function loadCatalog() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATUSES_FILE, "utf8"));
    if (raw && typeof raw === "object" && Array.isArray(raw.statuses)) {
      const rows = raw.statuses
        .filter((r) => r && ID_RE.test(String(r.id || "")) && String(r.label || "").trim())
        .map((r, i) => ({
          id: String(r.id),
          label: clipLabel(r.label),
          sort: Number.isFinite(Number(r.sort)) ? Number(r.sort) : i,
        }));
      const byId = new Map(rows.map((r) => [r.id, r]));
      if (!byId.has(DEFAULT_ID)) {
        rows.unshift({ id: DEFAULT_ID, label: "Тестер", sort: 0 });
      }
      if (!byId.has(CHIEF_ID)) {
        rows.push({ id: CHIEF_ID, label: "Глав. Администратор", sort: 10 });
      }
      return {
        v: 1,
        assignedDefault: raw.assignedDefault === true,
        statuses: rows,
      };
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("statuses file read failed:", e?.message || e);
  }
  return emptyCatalog();
}

function flushCatalog() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(STATUSES_FILE, JSON.stringify(catalog, null, 2));
  } catch (e) {
    console.warn("statuses save failed:", e?.message || e);
  }
}

function clipLabel(v) {
  return String(v || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, LABEL_MAX);
}

function slugify(label) {
  const map = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  const base = String(label || "")
    .toLowerCase()
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "status";
}

function freeId(label) {
  const base = slugify(label);
  if (!catalog.statuses.some((s) => s.id === base) && ID_RE.test(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const id = `${base}-${i}`.slice(0, 40);
    if (!catalog.statuses.some((s) => s.id === id)) return id;
  }
  return `status-${Date.now().toString(36)}`.slice(0, 40);
}

function sortedStatuses() {
  return [...catalog.statuses].sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label, "ru"));
}

/** Подпись статуса для поля / DTO; неизвестный id → дефолт. */
export function statusLabelOf(statusId) {
  const id = String(statusId || DEFAULT_ID);
  const row = catalog.statuses.find((s) => s.id === id);
  if (row) return row.label;
  const def = catalog.statuses.find((s) => s.id === DEFAULT_ID);
  return def ? def.label : "Тестер";
}

export function defaultStatusId() {
  return DEFAULT_ID;
}

export function knownStatusId(id) {
  return catalog.statuses.some((s) => s.id === String(id || ""));
}

/**
 * Идемпотентный сид: всем аккаунтам без statusId — tester; трём crown-id —
 * chief-admin. Вызывается при старте модуля и после loadStore.
 */
export function seedAssignments() {
  // Только модульный стор accounts.js: loadStore() вернул бы копию, а
  // flushAccounts пишет живой store — сид иначе не попадал на диск.
  const store = accountsStore();
  let dirty = false;
  /** Первый проход после появления statuses.json: всем текущим — Тестер. */
  const firstWave = catalog.assignedDefault !== true;
  for (const acc of Object.values(store.accounts || {})) {
    if (!acc || typeof acc !== "object") continue;
    if (!acc.profile || typeof acc.profile !== "object") acc.profile = {};
    const chief = CHIEF_ACCOUNT_IDS.includes(String(acc.id));
    const cur = typeof acc.profile.statusId === "string" ? acc.profile.statusId : "";
    if (chief) {
      if (cur !== CHIEF_ID) {
        acc.profile.statusId = CHIEF_ID;
        dirty = true;
      }
    } else if (firstWave || !cur || !knownStatusId(cur)) {
      if (cur !== DEFAULT_ID) {
        acc.profile.statusId = DEFAULT_ID;
        dirty = true;
      }
    }
  }
  if (dirty) flushAccounts(true);
  if (firstWave) catalog.assignedDefault = true;
  flushCatalog();
}

function adminGate(req, res) {
  const session = sessionFromRequest(req);
  if (!session) {
    json(res, 401, { ok: false, reason: "auth_required", message: "Нужен вход в аккаунт администратора." });
    return null;
  }
  if (session.account?.role !== "admin") {
    json(res, 403, { ok: false, reason: "forbidden", message: "Раздел открыт только администраторам." });
    return null;
  }
  return session;
}

function accountsSnapshot() {
  const store = accountsStore();
  const rows = [];
  for (const acc of Object.values(store.accounts || {})) {
    if (!acc?.id) continue;
    const statusId =
      typeof acc.profile?.statusId === "string" && knownStatusId(acc.profile.statusId)
        ? acc.profile.statusId
        : DEFAULT_ID;
    rows.push({
      accountId: String(acc.id),
      login: String(acc.login || ""),
      displayName: String(acc.profile?.displayName || acc.login || ""),
      statusId,
      statusLabel: statusLabelOf(statusId),
      role: acc.role === "admin" ? "admin" : "registered",
    });
  }
  rows.sort((a, b) => a.login.localeCompare(b.login, "ru"));
  return rows;
}

function assignStatus(accountId, statusId) {
  const acc = findById(accountId);
  if (!acc) return { error: "no_such_account", message: "Аккаунт не найден." };
  const id = String(statusId || DEFAULT_ID);
  if (!knownStatusId(id)) return { error: "unknown_status", message: "Такого статуса нет в каталоге." };
  if (!acc.profile || typeof acc.profile !== "object") acc.profile = {};
  acc.profile.statusId = id;
  flushAccounts(true);
  return { ok: true, accountId: acc.id, statusId: id, statusLabel: statusLabelOf(id) };
}

/** Live-обновление подписей на поле после смены статуса (не расширяет EV). */
function notifyStatusLive(accountId, statusLabel) {
  // Ленивый импорт: room ↔ statuses без циклов на старте.
  import("./room.js")
    .then((room) => {
      if (typeof room.broadcastAccountStatus === "function") {
        room.broadcastAccountStatus(accountId, statusLabel);
      }
    })
    .catch(() => {});
}

export async function handleStatusesHttp(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;
  if (p !== ROUTES.ROOT && p !== ROUTES.ASSIGN && !p.startsWith(ROUTES.ROOT + "/")) {
    return false;
  }
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (!adminGate(req, res)) return true;

  if (p === ROUTES.ROOT && req.method === "GET") {
    json(res, 200, { ok: true, statuses: sortedStatuses(), accounts: accountsSnapshot() });
    return true;
  }

  if (p === ROUTES.ROOT && req.method === "POST") {
    const body = await readJson(req);
    if (!body || typeof body !== "object") {
      json(res, 400, { ok: false, reason: "json", message: "Нужен JSON {label}." });
      return true;
    }
    const label = clipLabel(body.label);
    if (label.length < 1) {
      json(res, 400, { ok: false, reason: "invalid_label", message: "Укажите название статуса." });
      return true;
    }
    let id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
    if (id && !ID_RE.test(id)) {
      json(res, 400, { ok: false, reason: "invalid_id", message: "Id статуса: латиница, цифры, дефис, 2–40." });
      return true;
    }
    if (!id) id = freeId(label);
    if (catalog.statuses.some((s) => s.id === id)) {
      json(res, 409, { ok: false, reason: "taken", message: "Такой id статуса уже есть." });
      return true;
    }
    const sort = catalog.statuses.reduce((m, s) => Math.max(m, s.sort), 0) + 1;
    const row = { id, label, sort };
    catalog.statuses.push(row);
    flushCatalog();
    json(res, 200, { ok: true, status: row, statuses: sortedStatuses() });
    return true;
  }

  const patchMatch = /^\/admin\/statuses\/([a-z0-9-]{2,40})$/.exec(p);
  if (patchMatch && req.method === "PATCH") {
    const id = patchMatch[1];
    const row = catalog.statuses.find((s) => s.id === id);
    if (!row) {
      json(res, 404, { ok: false, reason: "not_found", message: "Статус не найден." });
      return true;
    }
    const body = await readJson(req);
    const label = clipLabel(body?.label);
    if (label.length < 1) {
      json(res, 400, { ok: false, reason: "invalid_label", message: "Укажите название статуса." });
      return true;
    }
    row.label = label;
    flushCatalog();
    // Переименование отражается на поле у всех с этим statusId.
    for (const acc of Object.values(accountsStore().accounts || {})) {
      if (acc?.profile?.statusId === id) notifyStatusLive(acc.id, label);
    }
    json(res, 200, { ok: true, status: row, statuses: sortedStatuses() });
    return true;
  }

  if (patchMatch && req.method === "DELETE") {
    const id = patchMatch[1];
    if (id === DEFAULT_ID) {
      json(res, 400, { ok: false, reason: "protected", message: "Статус «Тестер» удалить нельзя." });
      return true;
    }
    const idx = catalog.statuses.findIndex((s) => s.id === id);
    if (idx < 0) {
      json(res, 404, { ok: false, reason: "not_found", message: "Статус не найден." });
      return true;
    }
    catalog.statuses.splice(idx, 1);
    flushCatalog();
    let dirty = false;
    for (const acc of Object.values(accountsStore().accounts || {})) {
      if (acc?.profile?.statusId === id) {
        acc.profile.statusId = DEFAULT_ID;
        dirty = true;
        notifyStatusLive(acc.id, statusLabelOf(DEFAULT_ID));
      }
    }
    if (dirty) flushAccounts(true);
    json(res, 200, { ok: true, statuses: sortedStatuses(), accounts: accountsSnapshot() });
    return true;
  }

  if (p === ROUTES.ASSIGN && req.method === "POST") {
    const body = await readJson(req);
    const accountId = String(body?.accountId || "").trim();
    const statusId = String(body?.statusId || DEFAULT_ID).trim();
    if (!accountId) {
      json(res, 400, { ok: false, reason: "invalid_account", message: "Не указан аккаунт." });
      return true;
    }
    const result = assignStatus(accountId, statusId);
    if (result.error) {
      json(res, result.error === "no_such_account" ? 404 : 400, {
        ok: false,
        reason: result.error,
        message: result.message,
      });
      return true;
    }
    notifyStatusLive(accountId, result.statusLabel);
    json(res, 200, { ok: true, ...result, accounts: accountsSnapshot() });
    return true;
  }

  json(res, 405, { ok: false, reason: "method", message: "Метод не поддерживается." });
  return true;
}

export { DEFAULT_ID as STATUS_DEFAULT_ID, CHIEF_ID as STATUS_CHIEF_ID, CHIEF_ACCOUNT_IDS };
