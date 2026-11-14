/**
 * Новости главной доски («Что нового?»): публичное чтение для обоих сайтов,
 * запись только admin. Хранилище DATA_DIR/home-news.json (атомарная запись).
 *
 * Роуты:
 *   GET  /cfg/news | /news           — {ok, items[]} (public/elyria/local);
 *   POST /cfg/news | /admin/news     — {items:[{title,body,pinned?}]} admin-only.
 *
 * Порядок: массив = порядок показа; pinned=true всегда всплывают наверх
 * (относительный порядок внутри групп сохраняется). body — ограниченный HTML
 * (b/strong/i/em/u/br/span.news-size-*). Запись через POST /cfg/news — обход
 * nginx 405 на /admin без location.
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
const BODY_PLAIN_MAX = 500;
const BODY_HTML_MAX = 2500;
const ITEMS_MAX = 12;

const ROUTES = {
  PUBLIC: "/news",
  CFG: "/cfg/news",
  ADMIN: "/admin/news",
};

const SIZE_CLASS = new Set(["news-size-sm", "news-size-md", "news-size-lg"]);
const INLINE_TAGS = new Set(["b", "strong", "i", "em", "u"]);

/** Дефолт, если файла нет или он битый — обе главные показывают одно и то же. */
const DEFAULT_ITEMS = [
  {
    id: "seed-1",
    title: "Добро пожаловать",
    body: "На доске появляются короткие новости о поле и меню. Заглядывай, когда вернёшься домой.",
    pinned: false,
  },
  {
    id: "seed-2",
    title: "Следы лап",
    body: "Проведи курсором по ночному полю — останутся лапки.",
    pinned: false,
  },
];

let store = loadStore();

function emptyStore() {
  return { v: 2, updatedAt: 0, items: DEFAULT_ITEMS.map((x) => ({ ...x })) };
}

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(NEWS_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return emptyStore();
    const items = sanitizeItems(raw.items);
    if (!items) return emptyStore();
    return {
      v: 2,
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

function plainLength(html) {
  return [...html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ")].length;
}

/**
 * Ограниченный HTML для body: b/strong/i/em/u/br/span.news-size-*.
 * contentEditable-обёртки div/p схлопываются в <br>.
 */
export function sanitizeNewsBody(raw) {
  if (typeof raw !== "string") return null;
  let html = raw.replace(/\u0000/g, "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  html = html.replace(
    /<\/?(script|style|iframe|object|embed|link|meta|base|form|input|button|textarea|select|svg|math|video|audio|source|img|a|table|thead|tbody|tr|td|th)\b[^>]*>/gi,
    "",
  );
  html = html.replace(/<div><br\s*\/?><\/div>/gi, "<br>");
  html = html.replace(/<\/div>/gi, "");
  html = html.replace(/<div\b[^>]*>/gi, "<br>");
  html = html.replace(/<\/p>/gi, "<br>");
  html = html.replace(/<p\b[^>]*>/gi, "");
  html = html.replace(/<br\s*\/?>/gi, "<br>");
  html = html.replace(/(?:<br>\s*){3,}/gi, "<br><br>");
  html = html.replace(/&nbsp;/gi, " ");

  let out = "";
  const stack = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] !== "<") {
      const next = html.indexOf("<", i);
      const chunk = next < 0 ? html.slice(i) : html.slice(i, next);
      out += chunk
        .replace(/&(?!#\d+;|#x[\da-fA-F]+;|[a-zA-Z][a-zA-Z\d]+;)/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      i = next < 0 ? html.length : next;
      continue;
    }
    const end = html.indexOf(">", i + 1);
    if (end < 0) {
      out += "&lt;";
      i += 1;
      continue;
    }
    const rawTag = html.slice(i + 1, end).trim();
    i = end + 1;
    if (!rawTag) continue;
    const closing = rawTag[0] === "/";
    const body = closing ? rawTag.slice(1).trim() : rawTag;
    const sp = body.search(/\s/);
    const name = (sp < 0 ? body : body.slice(0, sp)).toLowerCase();
    const attrStr = sp < 0 ? "" : body.slice(sp + 1);
    if (name === "br") {
      if (!closing) out += "<br>";
      continue;
    }
    if (closing) {
      const idx = stack.lastIndexOf(name);
      if (idx < 0) continue;
      while (stack.length > idx) out += `</${stack.pop()}>`;
      continue;
    }
    if (/on\w+|javascript:|data:/i.test(attrStr)) continue;
    if (INLINE_TAGS.has(name)) {
      if (attrStr.trim()) continue;
      out += `<${name}>`;
      stack.push(name);
      continue;
    }
    if (name === "span") {
      const cm = attrStr.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i);
      const cls = ((cm && (cm[1] || cm[2] || cm[3])) || "").trim();
      if (!SIZE_CLASS.has(cls)) continue;
      out += `<span class="${cls}">`;
      stack.push("span");
    }
  }
  while (stack.length) out += `</${stack.pop()}>`;
  out = out.replace(/^(?:<br>|\s)+|(?:<br>|\s)+$/g, "").trim();
  if (!out) return null;
  if (plainLength(out) > BODY_PLAIN_MAX) return null;
  if (out.length > BODY_HTML_MAX) return null;
  return out;
}

/** pinned вверх, внутри групп — порядок массива (DnD / «новые сверху»). */
function orderItems(items) {
  const pinned = [];
  const rest = [];
  for (const it of items) (it.pinned ? pinned : rest).push(it);
  return [...pinned, ...rest];
}

function sanitizeItems(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const row of raw.slice(0, ITEMS_MAX)) {
    if (!row || typeof row !== "object") continue;
    const title = cleanText(row.title, TITLE_MAX);
    const body = sanitizeNewsBody(row.body);
    if (!title || !body) continue;
    const id =
      typeof row.id === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(row.id)
        ? row.id
        : newId();
    out.push({ id, title, body, pinned: row.pinned === true });
  }
  if (!out.length) return null;
  return orderItems(out);
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
      pinned: it.pinned === true,
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

  const isWrite =
    method === "POST" && (p === ROUTES.CFG || p === ROUTES.ADMIN);
  if (isWrite) {
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
        message: `Нужен непустой список записей (до ${ITEMS_MAX}): у каждой title и body (до ${BODY_PLAIN_MAX} знаков).`,
      });
      return true;
    }
    store = { v: 2, updatedAt: Date.now(), items };
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

/** Для тестов: сброс к дефолту в памяти (файл не трогаем, пока не POST). */
export function resetHomeNewsForTests() {
  store = emptyStore();
}
