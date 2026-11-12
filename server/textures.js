/**
 * Каталог текстур редактора локации (деревья/камни/растения/настилы/пол).
 * Builtin PNG — статика /tex/<id>.png; замены и кастомные — DATA_DIR/tex/
 * (/tex/file/<id>.png?v=…). Админ: замена байтов, откат builtin, CRUD
 * кастомных (имя + категория-вкладка + опциональный group-тег).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DATA_DIR, OBJECT_DIMS } from "./config.js";
import { writeFileAtomic } from "./atomic-file.js";
import { sessionFromRequest } from "./auth.js";
import { json, readJson, setCors } from "./runtime-config.js";
import { PNG_MAGIC, readBody, parseMultipart, slugifyName } from "./sprites.js";

const require = createRequire(import.meta.url);
const PLANT_SPRITES = require("./plant-sprites.json");

const DIR = path.join(DATA_DIR, "tex");
const MANIFEST_FILE = path.join(DIR, "manifest.json");
const MAX_UPLOAD = 2 * 1024 * 1024;
const MAX_CUSTOMS = 80;
const ID_RE = /^[a-z0-9-]{1,48}$/;
const LABEL_MAX = 48;
const GROUP_MAX = 48;

export const TEX_CATEGORIES = Object.freeze([
  { id: "trees", label: "Деревья" },
  { id: "rocks", label: "Камни" },
  { id: "plants", label: "Растения" },
  { id: "covers", label: "Покрытия" },
  { id: "surfaces", label: "Поверхности" },
]);
const CAT_IDS = new Set(TEX_CATEGORIES.map((c) => c.id));
const KIND_CAT = Object.freeze({ tree: "trees", plant: "plants", stone: "rocks", rock: "rocks" });
const DEFAULT_DIMS = Object.freeze({
  trees: [80, 120],
  rocks: [24, 19],
  plants: [40, 40],
  covers: [48, 48],
  surfaces: [96, 96],
});

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

const BUILTIN = Object.freeze([
  ...TREE_ITEMS,
  ...ROCK_ITEMS,
  ...PLANT_ITEMS,
  ...COVER_ITEMS,
  ...SURFACE_ITEMS,
].map((row) => Object.freeze({ ...row, custom: false, group: row.group || null })));
const BUILTIN_BY_ID = new Map(BUILTIN.map((row) => [row.id, row]));

/** @type {Record<string, { replacedAt: number, bytes: number, w: number, h: number }>} */
let overrides = Object.create(null);
/** @type {Array<{ id: string, label: string, category: string, group: string|null, custom: true, createdAt: number, replacedAt: number, bytes: number, w: number, h: number }>} */
let customs = [];

function fileOf(id) {
  return path.join(DIR, `${id}.png`);
}

function clipLabel(raw) {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length <= LABEL_MAX ? text : chars.slice(0, LABEL_MAX).join("");
}

function clipGroup(raw) {
  if (raw == null || raw === "") return null;
  const text = String(raw).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const chars = Array.from(text);
  return chars.length <= GROUP_MAX ? text : chars.slice(0, GROUP_MAX).join("");
}

function itemById(id) {
  return BUILTIN_BY_ID.get(id) || customs.find((c) => c.id === id) || null;
}

function allItems() {
  return [...BUILTIN, ...customs];
}

function freeCustomId(label) {
  const base = `x-${slugifyName(label)}`.slice(0, 40).replace(/-+$/g, "") || "x-tex";
  if (!itemById(base) && !fs.existsSync(fileOf(base)) && ID_RE.test(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const cand = `${base}-${n}`.slice(0, 48);
    if (ID_RE.test(cand) && !itemById(cand) && !fs.existsSync(fileOf(cand))) return cand;
  }
  return `x-tex-${Date.now().toString(36)}`.slice(0, 48);
}

function loadManifest() {
  try {
    const raw = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
    const nextOv = Object.create(null);
    if (raw && typeof raw === "object" && raw.overrides && typeof raw.overrides === "object") {
      for (const [id, row] of Object.entries(raw.overrides)) {
        if (!BUILTIN_BY_ID.has(id) || !row || typeof row !== "object") continue;
        if (!fs.existsSync(fileOf(id))) continue;
        nextOv[id] = {
          replacedAt: Number(row.replacedAt) || 0,
          bytes: Number(row.bytes) || 0,
          w: Number(row.w) || 0,
          h: Number(row.h) || 0,
        };
      }
    }
    const nextCustoms = [];
    if (raw && typeof raw === "object" && Array.isArray(raw.customs)) {
      for (const row of raw.customs) {
        if (!row || typeof row !== "object") continue;
        const id = String(row.id || "");
        const label = clipLabel(row.label);
        const category = String(row.category || "");
        if (!ID_RE.test(id) || BUILTIN_BY_ID.has(id) || !label || !CAT_IDS.has(category)) continue;
        if (!fs.existsSync(fileOf(id))) continue;
        nextCustoms.push({
          id,
          label,
          category,
          group: clipGroup(row.group),
          custom: true,
          createdAt: Number(row.createdAt) || 0,
          replacedAt: Number(row.replacedAt) || Number(row.createdAt) || 0,
          bytes: Number(row.bytes) || 0,
          w: Number(row.w) || 0,
          h: Number(row.h) || 0,
        });
      }
    }
    overrides = nextOv;
    customs = nextCustoms;
  } catch {
    overrides = Object.create(null);
    customs = [];
  }
}

function persistManifest() {
  fs.mkdirSync(DIR, { recursive: true });
  writeFileAtomic(
    MANIFEST_FILE,
    JSON.stringify({ v: 2, overrides, customs }, null, 2),
  );
}

loadManifest();

function pngSize(buf) {
  if (!buf || buf.length < 24 || Buffer.compare(buf.subarray(0, 8), PNG_MAGIC) !== 0) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** Файлы замен/кастомных — под /cfg/tex-file (префикс /cfg уже проксирует nginx на проде).
 *  Старые /tex/file/* оставляем алиасом для localhost и будущих exact-location. */
function srcOf(meta) {
  if (meta.custom) return `/cfg/tex-file/${meta.id}.png?v=${meta.replacedAt || meta.createdAt || 0}`;
  const ov = overrides[meta.id];
  if (ov) return `/cfg/tex-file/${meta.id}.png?v=${ov.replacedAt || 0}`;
  return `/tex/${meta.id}.png`;
}

function publicItem(meta) {
  const ov = meta.custom ? null : overrides[meta.id];
  return {
    id: meta.id,
    label: meta.label,
    category: meta.category,
    group: meta.group || null,
    custom: Boolean(meta.custom),
    src: srcOf(meta),
    replaced: meta.custom ? true : Boolean(ov),
    replacedAt: meta.custom ? meta.replacedAt || 0 : ov?.replacedAt || 0,
    w: meta.custom ? meta.w || 0 : ov?.w || 0,
    h: meta.custom ? meta.h || 0 : ov?.h || 0,
    bytes: meta.custom ? meta.bytes || 0 : ov?.bytes || 0,
  };
}

/** Живой каталог (builtin + custom) — для /tex/catalog и админки. */
export function texCatalogItems() {
  return allItems().map(publicItem);
}

/** Разрешён ли spr для kind объекта карты (builtin whitelist ∪ custom той же вкладки). */
export function texSpriteOk(kind, spr) {
  const id = String(spr || "");
  if (!id) return false;
  const cat = KIND_CAT[kind];
  if (!cat) return false;
  const meta = itemById(id);
  return Boolean(meta && meta.category === cat);
}

/** Покрытие клетки / кисть: builtin covers ∪ custom covers|surfaces. */
export function texCoverOk(id) {
  const meta = itemById(String(id || ""));
  return Boolean(meta && (meta.category === "covers" || meta.category === "surfaces"));
}

/** Габариты спрайта: builtin OBJECT_DIMS, иначе PNG custom, иначе дефолт категории. */
export function texDimsOf(id) {
  if (OBJECT_DIMS[id]) return OBJECT_DIMS[id];
  const meta = itemById(id);
  if (meta?.custom && meta.w > 0 && meta.h > 0) return [meta.w, meta.h];
  if (meta) return DEFAULT_DIMS[meta.category] || [57, 42];
  return [57, 42];
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

/** Публичный каталог/файлы: /tex/* и обходной /cfg/tex-* (прод nginx уже шлёт весь /cfg в Node). */
function isPublicTexPath(p) {
  return (
    p === "/tex/catalog" ||
    p === "/cfg/tex-catalog" ||
    p === "/tex/file" ||
    p.startsWith("/tex/file/") ||
    p === "/cfg/tex-file" ||
    p.startsWith("/cfg/tex-file/")
  );
}

/** Админ CRUD: /admin/tex* и обходной /cfg/tex* (без пересечения с tex-catalog/tex-file). */
function adminTexMatch(p) {
  if (p === "/admin/tex" || p === "/cfg/tex") return { root: true, id: "" };
  const m = /^\/(?:admin|cfg)\/tex\/([^/]+)$/.exec(p);
  if (!m) return null;
  return { root: false, id: decodeURIComponent(m[1] || "") };
}

function serveTexFile(res, id) {
  const meta = id ? itemById(id) : null;
  const allowed = meta && (meta.custom || overrides[id]);
  if (!id || !allowed) {
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

export function handleTexturesHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const admin = adminTexMatch(p);
  if (!isPublicTexPath(p) && !admin) return false;

  if (!admin) {
    if ((p === "/tex/catalog" || p === "/cfg/tex-catalog") && req.method === "GET") {
      json(res, 200, { ok: true, items: texCatalogItems() });
      return true;
    }
    if (p.startsWith("/tex/file/") || p.startsWith("/cfg/tex-file/")) {
      if (req.method !== "GET") {
        res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, reason: "method_not_allowed" }));
        return true;
      }
      const idMatch = /^\/(?:tex\/file|cfg\/tex-file)\/([a-z0-9-]{1,48})\.png$/.exec(p);
      return serveTexFile(res, idMatch?.[1]);
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

  const id = admin.root ? "" : admin.id;

  if (req.method === "GET" && !id) {
    json(res, 200, {
      ok: true,
      items: texCatalogItems(),
      categories: TEX_CATEGORIES.map((c) => ({ ...c })),
    });
    return true;
  }

  if (req.method === "POST" && !id) {
    return Promise.resolve(handleCreate(req, res));
  }
  if (req.method === "POST" && id) {
    return Promise.resolve(handleReplace(req, res, id));
  }
  if (req.method === "PATCH" && id) {
    return Promise.resolve(handlePatch(req, res, id));
  }
  if (req.method === "DELETE" && id) {
    return handleDelete(res, id);
  }
  res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: false, reason: "method_not_allowed" }));
  return true;
}

async function readPngUpload(req, res) {
  const contentType = String(req.headers["content-type"] || "");
  if (!/^multipart\/form-data/i.test(contentType)) {
    json(res, 400, { ok: false, reason: "bad_content_type", message: "Ожидается multipart/form-data." });
    return null;
  }
  let buf;
  try {
    buf = await readBody(req, MAX_UPLOAD);
  } catch (e) {
    if (e && e.code === "too_large") {
      json(res, 413, { ok: false, reason: "too_large", message: `Файл больше ${MAX_UPLOAD} байт не принимается.` });
      return null;
    }
    json(res, 400, { ok: false, reason: "invalid", message: "Тело запроса не читается." });
    return null;
  }
  const parts = parseMultipart(buf, contentType);
  if (!parts) {
    json(res, 400, { ok: false, reason: "invalid_multipart", message: "Форма не читается (multipart повреждён)." });
    return null;
  }
  return parts;
}

function writePngFile(id, data) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = path.join(DIR, `.${id}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, fileOf(id));
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    return false;
  }
}

async function handleCreate(req, res) {
  if (customs.length >= MAX_CUSTOMS) {
    json(res, 409, { ok: false, reason: "limit", message: `Не больше ${MAX_CUSTOMS} своих текстур.` });
    return true;
  }
  const parts = await readPngUpload(req, res);
  if (!parts) return true;
  const label = clipLabel(parts.fields.label ?? parts.fields.name);
  const category = String(parts.fields.category || "").trim();
  const group = clipGroup(parts.fields.group);
  if (!label) {
    json(res, 400, { ok: false, reason: "invalid_label", message: `Название: 1–${LABEL_MAX} символов.` });
    return true;
  }
  if (!CAT_IDS.has(category)) {
    json(res, 400, { ok: false, reason: "invalid_category", message: "Категория должна совпадать с вкладкой редактора (trees/rocks/plants/covers/surfaces)." });
    return true;
  }
  if (!parts.file?.data?.length) {
    json(res, 400, { ok: false, reason: "no_file", message: "Файл PNG не приложен." });
    return true;
  }
  const data = parts.file.data;
  const size = pngSize(data);
  if (!size || size.w < 1 || size.h < 1 || size.w > 4096 || size.h > 4096) {
    json(res, 400, { ok: false, reason: "invalid_png", message: "Файл не похож на PNG (нужен IHDR 1–4096 px)." });
    return true;
  }
  const id = freeCustomId(label);
  if (!writePngFile(id, data)) {
    json(res, 500, { ok: false, reason: "storage", message: "Не удалось сохранить файл текстуры." });
    return true;
  }
  const now = Date.now();
  const row = {
    id,
    label,
    category,
    group,
    custom: true,
    createdAt: now,
    replacedAt: now,
    bytes: data.length,
    w: size.w,
    h: size.h,
  };
  customs.push(row);
  try {
    persistManifest();
  } catch {
    customs = customs.filter((c) => c.id !== id);
    try { fs.unlinkSync(fileOf(id)); } catch { /* ignore */ }
    json(res, 500, { ok: false, reason: "storage", message: "Файл записан, но манифест не сохранился." });
    return true;
  }
  json(res, 200, { ok: true, item: publicItem(row) });
  return true;
}

async function handleReplace(req, res, id) {
  if (!ID_RE.test(id) || !itemById(id)) {
    json(res, 404, { ok: false, reason: "unknown_texture", message: "Такой текстуры в каталоге редактора нет." });
    return true;
  }
  const parts = await readPngUpload(req, res);
  if (!parts) return true;
  if (!parts.file?.data?.length) {
    json(res, 400, { ok: false, reason: "no_file", message: "Файл PNG не приложен." });
    return true;
  }
  const data = parts.file.data;
  const size = pngSize(data);
  if (!size || size.w < 1 || size.h < 1 || size.w > 4096 || size.h > 4096) {
    json(res, 400, { ok: false, reason: "invalid_png", message: "Файл не похож на PNG (нужен IHDR 1–4096 px)." });
    return true;
  }
  if (!writePngFile(id, data)) {
    json(res, 500, { ok: false, reason: "storage", message: "Не удалось сохранить файл текстуры." });
    return true;
  }
  const meta = itemById(id);
  const now = Date.now();
  if (meta.custom) {
    meta.replacedAt = now;
    meta.bytes = data.length;
    meta.w = size.w;
    meta.h = size.h;
  } else {
    overrides[id] = { replacedAt: now, bytes: data.length, w: size.w, h: size.h };
  }
  try {
    persistManifest();
  } catch {
    json(res, 500, { ok: false, reason: "storage", message: "Файл записан, но манифест не сохранился." });
    return true;
  }
  json(res, 200, { ok: true, item: publicItem(meta) });
  return true;
}

async function handlePatch(req, res, id) {
  if (!ID_RE.test(id) || !itemById(id)) {
    json(res, 404, { ok: false, reason: "unknown_texture", message: "Такой текстуры в каталоге редактора нет." });
    return true;
  }
  let body = {};
  try {
    body = await readJson(req);
  } catch {
    json(res, 400, { ok: false, reason: "json", message: "Тело запроса не читается как JSON." });
    return true;
  }
  const extra = Object.keys(body).filter((k) => !["label", "category", "group"].includes(k));
  if (extra.length) {
    json(res, 400, { ok: false, reason: "unexpected_fields", unexpected: extra, expected: ["label", "category", "group"] });
    return true;
  }
  const meta = itemById(id);
  if ("label" in body) {
    const label = clipLabel(body.label);
    if (!label) {
      json(res, 400, { ok: false, reason: "invalid_label", message: `Название: 1–${LABEL_MAX} символов.` });
      return true;
    }
    if (meta.custom) meta.label = label;
    else {
      // builtin: храним override-метку в customs? проще — запретить смену id, но label для builtin
      // держим в отдельной map labels. Чтобы не усложнять манифест — разрешаем label/group/category
      // только для custom; для builtin только category запрещена, label через softLabels.
      json(res, 400, { ok: false, reason: "builtin_immutable", message: "У базовой текстуры можно только заменить PNG или откатить. Имя и вкладка — у своих текстур." });
      return true;
    }
  }
  if ("category" in body) {
    if (!meta.custom) {
      json(res, 400, { ok: false, reason: "builtin_immutable", message: "У базовой текстуры вкладку менять нельзя." });
      return true;
    }
    const category = String(body.category || "").trim();
    if (!CAT_IDS.has(category)) {
      json(res, 400, { ok: false, reason: "invalid_category", message: "Категория должна совпадать с вкладкой редактора." });
      return true;
    }
    meta.category = category;
  }
  if ("group" in body) {
    if (!meta.custom) {
      json(res, 400, { ok: false, reason: "builtin_immutable", message: "У базовой текстуры тег менять нельзя." });
      return true;
    }
    meta.group = body.group === null ? null : clipGroup(body.group);
  }
  try {
    persistManifest();
  } catch {
    json(res, 500, { ok: false, reason: "storage", message: "Не удалось обновить манифест." });
    return true;
  }
  json(res, 200, { ok: true, item: publicItem(meta) });
  return true;
}

function handleDelete(res, id) {
  if (!ID_RE.test(id) || !itemById(id)) {
    json(res, 404, { ok: false, reason: "unknown_texture", message: "Такой текстуры в каталоге редактора нет." });
    return true;
  }
  const meta = itemById(id);
  if (meta.custom) {
    try { fs.unlinkSync(fileOf(id)); } catch { /* already gone */ }
    customs = customs.filter((c) => c.id !== id);
    try {
      persistManifest();
    } catch {
      json(res, 500, { ok: false, reason: "storage", message: "Не удалось обновить манифест." });
      return true;
    }
    json(res, 200, { ok: true, id, deleted: true });
    return true;
  }
  if (!overrides[id]) {
    json(res, 200, { ok: true, id, restored: false, item: publicItem(meta) });
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
  json(res, 200, { ok: true, id, restored: true, item: publicItem(meta) });
  return true;
}

/** Совместимость: прежний экспорт фиксированного каталога (только builtin). */
export const TEX_CATALOG = BUILTIN;
