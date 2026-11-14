/**
 * Новости главной доски («Что нового?»): публичное чтение для обоих сайтов,
 * запись только admin. Хранилище DATA_DIR/home-news.json (атомарная запись).
 *
 * Роуты:
 *   GET  /cfg/news | /news     — {ok, items[]} (public/elyria/local);
 *   PUT  /admin/news — {items:[{title,body}]} admin-only.
 *
 * /cfg/news — обходной путь: на проде nginx уже шлёт /cfg* в Node.
 * host-гейт public прячет /admin*, поэтому PUT на public → 404 not_found.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, readJson } from "./runtime-config.js";
import { writeFileAtomic } from "./atomic-file.js";

const NEWS_FILE = path.join(DATA_DIR, "home-news.json");
const TITLE_MAX = 80;
const BODY_MAX = 500;
const ITEMS_MAX = 12;

const ROUTES = {
  PUBLIC: "/news",
  CFG: "/cfg/news",
  ADMIN: "/admin/news",
};

/** Дефолт, если файла нет или он битый — обе главные показывают одно и то же. */
const DEFAULT_ITEMS = [
  {
    id: "seed-1",
    title: "Добро пожаловать",
    body: "На доске появляются короткие новости о поле и меню. Заглядывай, когда вернёшься домой.",
  },
  {
    id: "seed-2",
    title: "Следы лап",
    body: "Проведи курсором по ночному полю — останутся лапки.",
  },
];

let store = loadStore();

function emptyStore() {
  return { v: 1, updatedAt: 0, items: DEFAULT_ITEMS.map((x) => ({ ...x })) };
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(NEWS_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return emptyStore();
    const items = sanitizeItems(raw.items);
    if (!items) return emptyStore();
    return {
      v: 1,
      updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
      items,
    };
  } catch {
    return emptyStore();
  }
}

function newId() {
  return `n-${randomBytes(4).toString("hex")}`;
}

/** Чистый текст без HTML; обрезает по codepoints. */
function cleanText(v, max) {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return [...t].slice(0, max).join("");
}

function sanitizeItems(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const row of raw.slice(0, ITEMS_MAX)) {
    if (!row || typeof row !== "object") continue;
    const title = cleanText(row.title, TITLE_MAX);
    const body = cleanText(row.body, BODY_MAX);
    if (!title || !body) continue;
    const id =
      typeof row.id === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(row.id)
        ? row.id
        : newId();
    out.push({ id, title, body });
  }
  return out.length ? out : null;
}

function persist() {
  writeFileAtomic(NEWS_FILE, JSON.stringify(store, null, 2) + "\n");
}

function publicPayload() {
  return {
    ok: true,
    updatedAt: store.updatedAt || 0,
    items: store.items.map((it) => ({
      id: it.id,
      title: it.title,
      body: it.body,
    })),
  };
}

function adminGate(req, res) {
  const session = sessionFromRequest(req);
  if (!session?.account) {
    json(res, 401, { ok: false, reason: "auth_required" });
    return null;
  }
  if (session.account.role !== "admin") {
    json(res, 403, { ok: false, reason: "forbidden" });
    return null;
  }
  return session;
}

/**
 * HTTP-стык. true — ответ уже отправлен; false — не наш путь.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
export async function handleHomeNewsHttp(req, res) {
  const url = new URL(req.url || "/", "http://local");
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method || "GET";

  if ((p === ROUTES.PUBLIC || p === ROUTES.CFG) && (method === "GET" || method === "HEAD")) {
    json(res, 200, publicPayload());
    return true;
  }

  if (p === ROUTES.ADMIN && method === "PUT") {
    // Запись только /admin/news: на public host-гейт прячет /admin* целиком.
    if (!adminGate(req, res)) return true;
    let body;
    try {
      body = await readJson(req);
    } catch {
      json(res, 400, { ok: false, reason: "json" });
      return true;
    }
    const items = sanitizeItems(body?.items);
    if (!items) {
      json(res, 400, {
        ok: false,
        reason: "invalid_items",
        message: `Нужен непустой список записей (до ${ITEMS_MAX}): у каждой title и body.`,
      });
      return true;
    }
    store = { v: 1, updatedAt: Date.now(), items };
    try {
      persist();
    } catch {
      json(res, 500, { ok: false, reason: "write_failed" });
      return true;
    }
    json(res, 200, publicPayload());
    return true;
  }

  return false;
}

/** Для тестов: сброс к дефолту в памяти (файл не трогаем, пока не PUT). */
export function resetHomeNewsForTests() {
  store = emptyStore();
}
