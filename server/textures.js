/**
 * Админ-замена текстур редактора локации (деревья/камни/растения/настилы/пол).
 * Builtin PNG остаются в статике /tex/<id>.png; замены лежат в DATA_DIR/tex/
 * и отдаются как /tex/file/<id>.png?v=<ts>. Каталог id фиксирован — новые
 * виды через этот API не добавляются, только байты существующих.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DATA_DIR } from "./config.js";
import { writeFileAtomic } from "./atomic-file.js";
import { sessionFromRequest } from "./auth.js";
import { json, setCors } from "./runtime-config.js";
import { PNG_MAGIC, readBody, parseMultipart } from "./sprites.js";

const require = createRequire(import.meta.url);
const PLANT_SPRITES = require("./plant-sprites.json");

const DIR = path.join(DATA_DIR, "tex");
const MANIFEST_FILE = path.join(DIR, "manifest.json");
const MAX_UPLOAD = 2 * 1024 * 1024;
const ID_RE = /^[a-z0-9-]{1,48}$/;

const TREE_ITEMS = [
  { id: "tree-1", label: "Дерево 1", category: "trees" },
  { id: "tree-2", label: "Дерево 2", category: "trees" },
  { id: "tree-3", label: "Дерево 3", category: "trees" },
];
const ROCK_ITEMS = [
  { id: "rock-1", label: "Валун", category: "rocks" },
  { id: "rock-2", label: "Булышка", category: "rocks" },
  { id: "rock-3", label: "Маленький", category: "rocks" },
  { id: "rock-4", label: "Малый", category: "rocks" },
  { id: "rock-5", label: "Малый 2", category: "rocks" },
  { id: "rock-6", label: "Средний", category: "rocks" },
  { id: "rock-7", label: "Крупный", category: "rocks" },
  { id: "rock-8", label: "Ступень", category: "rocks" },
  { id: "rock-9", label: "Ступень 2", category: "rocks" },
  { id: "rock-10", label: "Ступени", category: "rocks" },
];
const COVER_ITEMS = [
  { id: "grass-1", label: "Трава 1", category: "covers" },
  { id: "grass-2", label: "Трава 2", category: "covers" },
  { id: "flower-1", label: "Цветы 1", category: "covers" },
  { id: "flower-2", label: "Цветы 2", category: "covers" },
  { id: "flower-3", label: "Цветы 3", category: "covers" },
  { id: "flower-4", label: "Цветы 4", category: "covers" },
  { id: "slab-1", label: "Плитка 1", category: "covers" },
  { id: "slab-2", label: "Плитка 2", category: "covers" },
  { id: "slab-3", label: "Плитка 3", category: "covers" },
  { id: "slab-4", label: "Плитка 4", category: "covers" },
  { id: "floor-1", label: "Пол 1", category: "covers" },
  { id: "floor-2", label: "Пол 2", category: "covers" },
  { id: "floor-3", label: "Пол 3", category: "covers" },
];
const SURFACE_ITEMS = [
  { id: "grass-ground", label: "Трава (бесшовный пол)", category: "surfaces" },
  { id: "stone-floor", label: "Каменный пол", category: "surfaces" },
];
const PLANT_ITEMS = PLANT_SPRITES.map((p) => ({
  id: p.id,
  label: p.label,
  category: "plants",
  group: p.group,
}));

export const TEX_CATALOG = Object.freeze([
  ...TREE_ITEMS,
  ...ROCK_ITEMS,
  ...PLANT_ITEMS,
  ...COVER_ITEMS,
  ...SURFACE_ITEMS,
]);
const BY_ID = new Map(TEX_CATALOG.map((row) => [row.id, row]));

/** overrides: { [id]: { replacedAt, bytes, w, h } } */
let overrides = Object.create(null);

function fileOf(id) {
  return path.join(DIR, `${id}.png`);
}

function loadManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
    const next = Object.create(null);
    if (raw && typeof raw === "object" && raw.overrides && typeof raw.overrides === "object") {
      for (const [id, row] of Object.entries(raw.overrides)) {
        if (!BY_ID.has(id) || !row || typeof row !== "object") continue;
        const replacedAt = Number(row.replacedAt) || 0;
        const bytes = Number(row.bytes) || 0;
        const w = Number(row.w) || 0;
        const h = Number(row.h) || 0;
        if (!fs.existsSync(fileOf(id))) continue;
        next[id] = { replacedAt, bytes, w, h };
      }
    }
    overrides = next;
  } catch {
    overrides = Object.create(null);
  }
}

function persistManifest() {
  fs.mkdirSync(DIR, { recursive: true });
  writeFileAtomic(MANIFEST_FILE, JSON.stringify({ v: 1, overrides }, null, 2));
}

loadManifest();

function pngSize(buf) {
  if (!buf || buf.length < 24 || Buffer.compare(buf.subarray(0, 8), PNG_MAGIC) !== 0) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function srcOf(id) {
  const ov = overrides[id];
  if (ov) return `/tex/file/${id}.png?v=${ov.replacedAt || 0}`;
  return `/tex/${id}.png`;
}

function publicItem(meta) {
  const ov = overrides[meta.id];
  return {
    id: meta.id,
    label: meta.label,
    category: meta.category,
    group: meta.group || null,
    src: srcOf(meta.id),
    replaced: Boolean(ov),
    replacedAt: ov?.replacedAt || 0,
    w: ov?.w || 0,
    h: ov?.h || 0,
    bytes: ov?.bytes || 0,
  };
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

function isTexPath(p) {
  return p === "/tex/catalog" || p === "/tex/file" || p.startsWith("/tex/file/");
}

export function handleTexturesHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const adminMatch = p === "/admin/tex" ? ["", ""] : /^\/admin\/tex\/([^/]+)$/.exec(p);
  if (!isTexPath(p) && !adminMatch) return false;

  if (!adminMatch) {
    if (p === "/tex/catalog" && req.method === "GET") {
      json(res, 200, { ok: true, items: TEX_CATALOG.map(publicItem) });
      return true;
    }
    if (p.startsWith("/tex/file/") && req.method === "GET") {
      const idMatch = /^\/tex\/file\/([a-z0-9-]{1,48})\.png$/.exec(p);
      const id = idMatch?.[1];
      if (!id || !overrides[id]) {
        json(res, 404, { ok: false, reason: "not_found" });
        return true;
      }
      try {
        const data = fs.readFileSync(fileOf(id));
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(data.length),
          "cache-control": "public, max-age=60",
        });
        res.end(data);
      } catch {
        json(res, 404, { ok: false, reason: "not_found" });
      }
      return true;
    }
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, reason: "method_not_allowed" }));
    return true;
  }

  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (!adminGate(req, res)) return true;

  const id = decodeURIComponent(adminMatch[1] || "");
  if (req.method === "GET" && !id) {
    json(res, 200, {
      ok: true,
      items: TEX_CATALOG.map(publicItem),
      categories: [
        { id: "trees", label: "Деревья" },
        { id: "rocks", label: "Камни" },
        { id: "plants", label: "Растения" },
        { id: "covers", label: "Покрытия" },
        { id: "surfaces", label: "Поверхности" },
      ],
    });
    return true;
  }

  if (req.method === "POST" && id) {
    return Promise.resolve(handleReplace(req, res, id));
  }
  if (req.method === "DELETE" && id) {
    return handleRestore(res, id);
  }
  res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, reason: "method_not_allowed" }));
  return true;
}

async function handleReplace(req, res, id) {
  if (!ID_RE.test(id) || !BY_ID.has(id)) {
    json(res, 404, { ok: false, reason: "unknown_texture", message: "Такой текстуры в каталоге редактора нет." });
    return true;
  }
  const contentType = String(req.headers["content-type"] || "");
  if (!/^multipart\/form-data/i.test(contentType)) {
    json(res, 400, { ok: false, reason: "bad_content_type", message: "Ожидается multipart/form-data." });
    return true;
  }
  let buf;
  try {
    buf = await readBody(req, MAX_UPLOAD);
  } catch (e) {
    if (e && e.code === "too_large") {
      json(res, 413, { ok: false, reason: "too_large", message: `Файл больше ${MAX_UPLOAD} байт не принимается.` });
      return true;
    }
    json(res, 400, { ok: false, reason: "invalid", message: "Тело запроса не читается." });
    return true;
  }
  const parts = parseMultipart(buf, contentType);
  if (!parts?.file?.data?.length) {
    json(res, 400, { ok: false, reason: "no_file", message: "Файл PNG не приложен." });
    return true;
  }
  const data = parts.file.data;
  const size = pngSize(data);
  if (!size || size.w < 1 || size.h < 1 || size.w > 4096 || size.h > 4096) {
    json(res, 400, { ok: false, reason: "invalid_png", message: "Файл не похож на PNG (нужен IHDR 1–4096 px)." });
    return true;
  }
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = path.join(DIR, `.${id}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, fileOf(id));
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    json(res, 500, { ok: false, reason: "storage", message: "Не удалось сохранить файл текстуры." });
    return true;
  }
  overrides[id] = { replacedAt: Date.now(), bytes: data.length, w: size.w, h: size.h };
  try {
    persistManifest();
  } catch {
    json(res, 500, { ok: false, reason: "storage", message: "Файл записан, но манифест не сохранился." });
    return true;
  }
  json(res, 200, { ok: true, item: publicItem(BY_ID.get(id)) });
  return true;
}

function handleRestore(res, id) {
  if (!ID_RE.test(id) || !BY_ID.has(id)) {
    json(res, 404, { ok: false, reason: "unknown_texture", message: "Такой текстуры в каталоге редактора нет." });
    return true;
  }
  if (!overrides[id]) {
    json(res, 200, { ok: true, id, restored: false, item: publicItem(BY_ID.get(id)) });
    return true;
  }
  try { fs.unlinkSync(fileOf(id)); } catch { /* already gone */ }
  delete overrides[id];
  try {
    persistManifest();
  } catch {
    json(res, 500, { ok: false, reason: "storage", message: "Не удалось обновить манифест." });
    return true;
  }
  json(res, 200, { ok: true, id, restored: true, item: publicItem(BY_ID.get(id)) });
  return true;
}
