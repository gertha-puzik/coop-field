/**
 * Менеджер спрайтов — единый источник каталога скинов (владелица: «загрузка
 * и удаление скинов/персонажей с категориями»). Домен живёт в DATA_DIR/sprites/:
 *   manifest.json — массив записей {id, name, category, builtin, addedAt}
 *                   (идёт в Git НЕ с ним: это runtime-данные, как accounts.json);
 *   <id>.png      — файлы ЗАГРУЖЕННЫХ спрайтов (builtin-файлы НЕ копируются:
 *                   их отдаёт статика www/sprites/<id>.png, src builtin = тот же
 *                   путь, как было до менеджера).
 * Сид: при загрузке модуля manifest.json отсутствует → записываем 31 базовый
 * id (config.SPRITES; имя = клиентский словарь settings.ts SPRITES — зеркало
 * меняется одним PR, счёт одинаковый), category «Базовые», builtin true,
 * addedAt 0. Загруженные: builtin false, src = /sprites/file/<id>.png.
 *
 * Живой валидатор: config.js экспортирует массив SPRITES, и room.js
 * pickSprite/setSprite (ЗАЩИЩЁНЫ — не трогаем) проверяют скин через
 * SPRITES.includes. Каталог зеркалируется туда IN PLACE (push/splice
 * содержимого, сама константа не переприсваивается — биндинг не ломается):
 * базовые остаются списанными в config.js, загруженные добавляются/убираются
 * этим модулем. Так WS-валидация pickSprite/setSprite принимает новые id без
 * единой правки защищённых файлов. accounts.js attachSprite переключён на
 * явный spriteIdAllowed() (задача п.5), wearers-проход живёт в accounts.js
 * (spriteWearers — владелец стора).
 *
 * ВНИМАНИЕ на цикл импортов accounts.js ↔ sprites.js: оба вызывают функции
 * друг друга ТОЛЬКО внутри тел функций (ни одного top-level вызова) — ESM
 * live-биндинги это держат, порядок инициализации не задет.
 *
 * HTTP-маршруты (образец стека защиты — admin-ops.js: host-гейт net.js прячет
 * /admin/* на public-классе, apiZone-CSRF (unsafe+cookie ⇒ Origin), далее
 * сессия 401 + роль admin 403):
 *   GET    /sprites/catalog        — ПУБЛИЧНЫЙ каталог обоим сайтам:
 *                                    {ok:true, items:[{id,name,category,src}]};
 *   GET    /sprites/file/<id>.png  — PNG загруженного спрайта (только
 *                                    НЕ-builtin: builtin — статика www*; 404
 *                                    если id нет в манифесте/файла нет);
 *   GET    /admin/sprites          — админский список с метаданными и владельцами;
 *   POST   /admin/sprites          — multipart upload (file, name 2-24,
 *                                    category 1-32; лимит 3 МБ; магия PNG
 *                                    первых 8 байт; id = translit-slug имени,
 *                                    коллизия — суффикс -2/-3; id несменяем);
 *   PATCH  /admin/sprites/:id      — переименование/смена категории;
 *   DELETE /admin/sprites/:id      — только НЕ-builtin и только не одетый
 *                                    (отказ с wornBy: логин+имя персонажа);
 *                                    builtin — всегда отказ (это деплойная
 *                                    статика).
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SPRITES } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, readJson, setCors } from "./runtime-config.js";
import { spriteWearers } from "./accounts.js";

const DIR = path.join(DATA_DIR, "sprites");
const MANIFEST_FILE = path.join(DIR, "manifest.json");
/** Имя файла спрайта по id: id — это slug ^[a-z0-9-]{1,64}$, квалификатор
 *  расширения входит в проверку маршрута. */
const fileOf = (id) => path.join(DIR, `${id}.png`);

/** Лимит тела upload: 3 МБ (бытовые PNG пака 20–200 КБ; запас для больших
 *  артов оставлен, но не безразмерный — multipart-обёртка добавляет копейки). */
const MAX_UPLOAD = 3 * 1024 * 1024;
const NAME_MIN = 2;
const NAME_MAX = 24;
const CATEGORY_MAX = 32;
/** Базовая категория сида; свободные строки для загруженных (задача п.2). */
const BASE_CATEGORY = "Базовые";
const BASE_NAMES = {
  puhlyashik: "Пухляшик",
  puhlyashshshshshshshsh: "Пухляшшшшшшшш",
  blestyashka: "Блестяшка",
  puzatik: "Пузатик",
  razdora: "Пламя Раздора",
  pohititel: "Похититель Пламени",
  gromoryov: "Громорёв",
  gremuchnik: "Гремучник",
  syrstyashka: "Сырстяшка",
  ryzhiy: "Сырь",
  trehcvetny: "Негрик",
  negr: "Негрик 2",
  chis: "Чис",
  lera: "Лера",
  anya1: "Аня",
  anya2: "Аня 2",
  serebristyy: "ВП",
  evr: "Эвр",
  drel: "Дрель",
  maslina: "Маслина",
  buran: "Буран",
  sumrak: "Сумрак",
  izya: "Изя",
  kameshechek: "Камешечек",
  klubochek: "Клубочек",
  podushka: "Подушечка",
  plyushik: "Плюшик",
  rvanitse: "Рванитсе",
  "puhlyashik-kit": "Пухляшик (кит-версия)",
  "blestyashka-kit": "Блестяшка",
  "chistolapik-kit": "Чистолапик",
};

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function manifestRowOk(row) {
  return (
    row && typeof row === "object" &&
    typeof row.id === "string" && /^[a-z0-9-]{1,64}$/.test(row.id) &&
    typeof row.name === "string" && Array.from(row.name).length >= NAME_MIN &&
    typeof row.category === "string" && row.category.trim() &&
    Array.from(row.category).length <= CATEGORY_MAX &&
    typeof row.builtin === "boolean"
  );
}

/** Чтение манифеста: отсутствующий файл → сид базовых (и запись на диск —
 *  контракт «при старте сид записывается»), битые строки выбрасываем. */
function loadManifest() {
  fs.mkdirSync(DIR, { recursive: true });
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("sprites manifest read failed:", e?.message || e);
  }
  if (Array.isArray(raw)) {
    const rows = raw.filter((row) => manifestRowOk(row) && (!row.builtin || SPRITES.includes(row.id)));
    // Снятые из поставки builtin не возвращаются из сохранённого манифеста.
    // хотя бы одна builtin-строка — иначе файл считаем пустым (сид восстановит).
    if (rows.some((r) => r.builtin)) {
      // гарантируем базовые id: отсутствующий в манифесте builtin дописываем
      // (файл мог быть повреждён/урезан) — базовые не удаляются из каталога.
      const have = new Set(rows.map((r) => r.id));
      for (const b of seedRows()) if (!have.has(b.id)) rows.push(b);
      return rows;
    }
  }
  const rows = seedRows();
  try {
    writeFileAtomic(MANIFEST_FILE, JSON.stringify(rows, null, 2));
  } catch (e) {
    console.warn("sprites manifest seed write failed:", e?.message || e);
  }
  return rows;
}

function seedRows() {
  return SPRITES.map((id) => ({
    id,
    name: BASE_NAMES[id] || id,
    category: BASE_CATEGORY,
    builtin: true,
    addedAt: 0,
  }));
}

let manifest = loadManifest();

function flushManifest() {
  try {
    writeFileAtomic(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
  } catch (e) {
    console.warn("sprites manifest save failed:", e?.message || e);
  }
}

/** src каталога: builtin — статика www/sprites (как до менеджера), загруженный —
 *  API-отдача файла из DATA_DIR. */
function srcOf(row) {
  return row.builtin ? `/sprites/${row.id}.png` : `/sprites/file/${row.id}.png`;
}

/** Зеркалирование манифеста в config.SPRITES IN PLACE: room.js/dummy-rab.js
 *  (защищённые, без правок) читают массив на каждом вызове — их whitelist
 *  становится динамическим сам. Идём в ДВЕ стороны: новый загруженный id
 *  докидываем, удалённый из каталога — снимаем (иначе DELETE оставлял бы id
 *  легальным для pickSprite/setSprite). Базовые id (снапшот при загрузке
 *  модуля — до первой мутации) не снимаются никогда. Биндинг константы не
 *  переприсваиваем — только push/splice содержимого. */
const BUILTIN_IDS = new Set(SPRITES);

function syncWhitelist() {
  const catalogIds = new Set(manifest.map((r) => r.id));
  for (let i = SPRITES.length - 1; i >= 0; i -= 1) {
    const id = SPRITES[i];
    if (!BUILTIN_IDS.has(id) && !catalogIds.has(id)) SPRITES.splice(i, 1);
  }
  for (const row of manifest) {
    if (SPRITES.includes(row.id)) continue;
    SPRITES.push(row.id);
  }
}

syncWhitelist();

/** Живой валидатор id (accounts.js attachSprite, задача п.5; память, без fs). */
export function spriteIdAllowed(id) {
  return manifest.some((r) => r.id === id);
}

function findById(id) {
  return manifest.find((r) => r.id === id) || null;
}

/* ---------- slug имени: транслитерация ---------- */

const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
  с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
  ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** id = латиница a-z0-9- из имени простой транслитерацией (кириллица → лат,
 *  прочее — в дефис); слагается без подчёркиваний/точек, пустой результат —
 *  «sprite». Обрезаем 64, чтобы файл/путь были обозримыми. */
export function slugifyName(raw) {
  const text = String(raw || "").toLowerCase();
  let out = "";
  for (const ch of text) {
    if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += "-";
  }
  const slug = out.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
  return slug || "sprite";
}

function slugTaken(slug) {
  return manifest.some((r) => r.id === slug) || fs.existsSync(fileOf(slug));
}

/** Коллизия id → числовой суффикс (-2, -3, …). id НЕ сменяем после создания. */
function freeSlugFor(name) {
  const base = slugifyName(name);
  if (!slugTaken(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const cand = `${base}-${n}`;
    if (!slugTaken(cand) && cand.length <= 64) return cand;
  }
  return `sprite-${Date.now().toString(36)}`;
}

/* ---------- валидация полей ---------- */

function clipChars(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("");
}

/** name 2–24 кодпоинтов после трима; category 1–32, не пустая. */
function validName(raw) {
  const text = clipChars(String(raw ?? "").replace(/\s+/g, " ").trim(), NAME_MAX);
  if (Array.from(text).length < NAME_MIN) return null;
  return text;
}

function validCategory(raw) {
  const text = clipChars(String(raw ?? "").replace(/\s+/g, " ").trim(), CATEGORY_MAX);
  if (!text) return null;
  return text;
}

/* ---------- multipart/form-data (без зависимостей) ---------- */

/** Подпись PNG — ровно 8 байт: 89 50 4E 47 0D 0A 1A 0A (\x89PNG\r\n\x1a\n). */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      // отказ сразу (без буферизации): сокет НЕ рвём — клиент должен успеть
      // прочесть 413; тело дальше игнорируем (listener-а 'data' нет — поток
      // стоит, память не копится).
      reject(Object.assign(new Error("too large"), { code: "too_large" }));
      return;
    }
    const chunks = [];
    let n = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return;
      n += c.length;
      if (n > limit) {
        over = true;
        chunks.length = 0;
        reject(Object.assign(new Error("too large"), { code: "too_large" }));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {});
  });
}

/** Разбор multipart:_bin-safe (Buffer.indexOf), формат FormData браузера:
 *  --boundary\r\ncontent-disposition…\r\n\r\nbody\r\n--boundary--\r\n.
 *  Возвращает {file?:{filename,data}, fields:{name,category}}. */
function parseMultipart(buf, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(String(contentType || ""));
  const boundary = m ? m[1] || m[2] : "";
  if (!boundary) return null;
  const dash = Buffer.from(`--${boundary}`);
  const out = { file: null, fields: {} };
  let pos = buf.indexOf(dash);
  if (pos !== 0) return null;
  pos += dash.length;
  for (;;) {
    // после разделителя: либо «--» (конец), либо \r\n + очередная часть
    if (buf.slice(pos, pos + 2).toString("latin1") === "--") break;
    if (buf.slice(pos, pos + 2).toString("latin1") !== "\r\n") return null;
    pos += 2;
    const headEnd = buf.indexOf(Buffer.from("\r\n\r\n"), pos);
    if (headEnd === -1) return null;
    const head = buf.slice(pos, headEnd).toString("utf8");
    const next = buf.indexOf(Buffer.from(`\r\n--${boundary}`), headEnd);
    if (next === -1) return null;
    const data = buf.slice(headEnd + 4, next);
    const nameMatch = /name="([^"]*)"/i.exec(head);
    if (!nameMatch) return null;
    const fieldName = nameMatch[1];
    const fileMatch = /filename="([^"]*)"/i.exec(head);
    if (fileMatch) {
      if (fieldName === "file") out.file = { filename: fileMatch[1] || "", data };
    } else {
      out.fields[fieldName] = data.toString("utf8");
    }
    pos = next + Buffer.from(`\r\n--${boundary}`).length;
  }
  if (!out.file && !Object.keys(out.fields).length) return null;
  return out;
}

/* ---------- HTTP-стык (apiZone-паттерн admin-ops.js) ---------- */

/** Сессия → админ: null = нет сессии (401), false = не админ (403) —
 *  контракт тот же, что у admin-ops.js adminGate. */
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

function isSpritesPath(p) {
  return p === "/sprites/catalog" || p === "/sprites/file" || p.startsWith("/sprites/file/");
}

/** Разбор маршрута: true — наш (ответ отписан), false — чужой, дальше по цепи
 *  net.js (до статики: без этого хука /sprites/file уходил бы в файловый 404). */
export function handleSpritesHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const adminMatch = p === "/admin/sprites" ? ["", ""] : /^\/admin\/sprites\/([^/]+)$/.exec(p);
  if (!isSpritesPath(p) && !adminMatch) return false;
  const isAdmin = Boolean(adminMatch);
  if (isAdmin) setCors(req, res);
  if (req.method === "OPTIONS" && isAdmin) {
    res.writeHead(204);
    res.end();
    return true;
  }

  /* --- публичная часть: каталог и файлы (GET, без сессии) --- */
  if (!isAdmin) {
    if (p === "/sprites/catalog" && req.method === "GET") {
      json(res, 200, {
        ok: true,
        items: manifest.map((r) => ({ id: r.id, name: r.name, category: r.category, src: srcOf(r) })),
      });
      return true;
    }
    if (p.startsWith("/sprites/file/") && req.method === "GET") {
      const idMatch = /^\/sprites\/file\/([a-z0-9-]{1,64})\.png$/.exec(p);
      const row = idMatch ? findById(idMatch[1]) : null;
      // builtin — статика www/sprites (файл API не отдаёт: 404), загруженного
      // файла нет — тоже 404 (id мог быть удалён, а ссылка осталась в кэше).
      if (!row || row.builtin) {
        json(res, 404, { ok: false, reason: "not_found" });
        return true;
      }
      try {
        const data = fs.readFileSync(fileOf(row.id));
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(data.length),
          "cache-control": "public, max-age=300",
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

  /* --- админская часть (сессия + роль + apiZone-CSRF из net.js) --- */
  if (!adminGate(req, res)) return true;

  const id = decodeURIComponent(adminMatch[1] || "");
  if (req.method === "GET" && !id) {
    json(res, 200, {
      ok: true,
      items: manifest.map((r) => {
        // владельцы — для всех строк, включая builtin: таблица показывает
        // «одет у N» под каждым спрайтом (удаление это не разрешает, но
        // админу видна занятость базовых скинов тоже).
        const wornBy = spriteWearers(r.id);
        return {
          id: r.id,
          name: r.name,
          category: r.category,
          builtin: r.builtin,
          src: srcOf(r),
          addedAt: Number(r.addedAt) || 0,
          wornBy,
          wornCount: wornBy.length,
        };
      }),
    });
    return true;
  }

  if (req.method === "POST" && !id) {
    return Promise.resolve(handleUpload(req, res));
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

async function handleUpload(req, res) {
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
  const form = parseMultipart(buf, contentType);
  if (!form) {
    json(res, 400, { ok: false, reason: "invalid_multipart", message: "Форма не читается (multipart повреждён)." });
    return true;
  }
  const name = validName(form.fields.name);
  const category = validCategory(form.fields.category);
  if (!name) {
    json(res, 400, { ok: false, reason: "invalid_name", message: `Имя спрайта: ${NAME_MIN}–${NAME_MAX} символов.` });
    return true;
  }
  if (!category) {
    json(res, 400, { ok: false, reason: "invalid_category", message: `Категория: 1–${CATEGORY_MAX} символов, не пустая.` });
    return true;
  }
  if (!form.file || !form.file.data || !form.file.data.length) {
    json(res, 400, { ok: false, reason: "no_file", message: "Файл PNG не приложен." });
    return true;
  }
  if (PNG_MAGIC.compare(form.file.data, 0, 8) !== 0) {
    json(res, 400, { ok: false, reason: "invalid_png", message: "Файл не похож на PNG (подпись не совпала)." });
    return true;
  }
  const id = freeSlugFor(name);
  const addedAt = Date.now();
  manifest.push({ id, name, category, builtin: false, addedAt });
  try {
    fs.writeFileSync(fileOf(id), form.file.data);
    flushManifest();
    syncWhitelist();
  } catch (e) {
    manifest = manifest.filter((r) => r.id !== id);
    json(res, 500, { ok: false, reason: "storage", message: "Не удалось сохранить файл спрайта." });
    console.warn("sprite upload failed:", e?.message || e);
    return true;
  }
  json(res, 200, { ok: true, item: { id, name, category, builtin: false, src: srcOf({ id, builtin: false }), addedAt } });
  return true;
}

async function handlePatch(req, res, id) {
  const row = findById(id);
  if (!row) {
    json(res, 404, { ok: false, reason: "unknown_sprite", message: "Спрайта с таким id нет." });
    return true;
  }
  let body;
  try {
    body = await readJson(req);
  } catch {
    json(res, 400, { ok: false, reason: "json", message: "Тело запроса не читается как JSON." });
    return true;
  }
  const extra = Object.keys(body).filter((k) => k !== "name" && k !== "category");
  if (extra.length) {
    json(res, 400, { ok: false, reason: "unexpected_fields", unexpected: extra, expected: ["name", "category"] });
    return true;
  }
  let nextName = null;
  let nextCategory = null;
  if (body.name !== undefined) {
    nextName = validName(body.name);
    if (!nextName) {
      json(res, 400, { ok: false, reason: "invalid_name", message: `Имя спрайта: ${NAME_MIN}–${NAME_MAX} символов.` });
      return true;
    }
  }
  if (body.category !== undefined) {
    nextCategory = validCategory(body.category);
    if (!nextCategory) {
      json(res, 400, { ok: false, reason: "invalid_category", message: `Категория: 1–${CATEGORY_MAX} символов, не пустая.` });
      return true;
    }
  }
  if (nextName === null && nextCategory === null) {
    json(res, 400, { ok: false, reason: "empty_patch", message: "Укажите name и/или category." });
    return true;
  }
  if (nextName !== null) row.name = nextName;
  if (nextCategory !== null) row.category = nextCategory;
  flushManifest();
  json(res, 200, { ok: true, item: { id: row.id, name: row.name, category: row.category, builtin: row.builtin, src: srcOf(row) } });
  return true;
}

function handleDelete(res, id) {
  const row = findById(id);
  if (!row) {
    json(res, 404, { ok: false, reason: "unknown_sprite", message: "Спрайта с таким id нет." });
    return true;
  }
  if (row.builtin) {
    json(res, 400, {
      ok: false,
      reason: "builtin_immutable",
      message: "Базовые спрайты раздаются статикой деплоя — удалить их нельзя.",
    });
    return true;
  }
  const wornBy = spriteWearers(row.id);
  if (wornBy.length) {
    const names = wornBy.map((w) => `${w.login} (${w.character})`).join(", ");
    json(res, 400, {
      ok: false,
      reason: "in_use",
      message: `Спрайт одет у персонажей: ${names}. Сначала поменяйте им скин.`,
      wornBy,
    });
    return true;
  }
  manifest = manifest.filter((r) => r.id !== row.id);
  try {
    fs.unlinkSync(fileOf(row.id));
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("sprite file unlink failed:", e?.message || e);
  }
  flushManifest();
  syncWhitelist();
  json(res, 200, { ok: true, id: row.id });
  return true;
}
