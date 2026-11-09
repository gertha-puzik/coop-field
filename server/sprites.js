/**
 * Менеджер спрайтов — единый источник каталога скинов (владелица: «загрузка
 * и удаление скинов/персонажей с категориями»). Домен живёт в DATA_DIR/sprites/:
 *   manifest.json — массив записей {id, name, category, builtin, addedAt}
 *                   (идёт в Git НЕ с ним: это runtime-данные, как accounts.json);
 *   <id>.png      — файлы ЗАГРУЖЕННЫХ спрайтов (builtin-файлы НЕ копируются:
 *                   их отдаёт статика www/sprites/<id>.png, src builtin = тот же
 *                   путь, как было до менеджера).
 * Сид: при загрузке модуля manifest.json отсутствует → записываем 32 базовых
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
 *   PATCH  /admin/sprites/:id      — переименование/смена категории/скрытие
 *                                    (hidden — #83: строка уходит из каталога
 *                                    и whitelist'а, файл остаётся на месте);
 *   DELETE /admin/sprites/:id      — только НЕ-builtin и только не одетый
 *                                    (отказ с wornBy: логин+имя персонажа);
 *                                    builtin — всегда отказ (это деплойная
 *                                    статика).
 *   Зона личных окрасов игроков (#83) — POST/GET/DELETE /sprites/mine* —
 *   живёт в my-sprites.js (спрут этого файла не раздуваем): там только
 *   HTTP-ручки и валидации игрока, а манифест — КАНОН ЗДЕСЬ. My-sprites.js
 *   импортирует переиспользуемые примитивы (readBody, parseMultipart,
 *   PNG_MAGIC, validName, srcOf) и мутирует манифест ТОЛЬКО через
 *   mutateSprites(ops) — одна очередь сериализации на все мутации (админские
 *   + личные), коммиты атомарны и идут контрактным порядком (png → память →
 *   manifest.json → syncWhitelist). Строки #83: ownerAccountId (null =
 *   админский/builtin-сид), sha256 (дедуп даблклика), w/h/bytes (габариты
 *   PNG при заливке — все поля опциональны, старые манифесты читать можно),
 *   hidden (тоггл админа).
 */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, SPRITES } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { json, readJson, setCors } from "./runtime-config.js";
import { spriteWearers, findById as findAccountById } from "./accounts.js";

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
  test1: "test1",
  "test1-png": "test1 PNG 600",
};

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function manifestRowOk(row) {
  if (
    !(row && typeof row === "object") ||
    !(typeof row.id === "string" && /^[a-z0-9-]{1,64}$/.test(row.id)) ||
    !(typeof row.name === "string" && Array.from(row.name).length >= NAME_MIN) ||
    !(typeof row.category === "string" && row.category.trim() &&
      Array.from(row.category).length <= CATEGORY_MAX) ||
    typeof row.builtin !== "boolean"
  ) return false;
  // #83: необязательные поля строк манифеста — их отсутствие легитимно
  // (старые манифесты/админские строки без них валидны), но типы строги:
  // мусор в новых полях роняет строку при загрузке, а не живёт в каталоге.
  if (row.ownerAccountId !== undefined && row.ownerAccountId !== null &&
    typeof row.ownerAccountId !== "string") return false;
  if (row.sha256 !== undefined && row.sha256 !== null &&
    !(typeof row.sha256 === "string" && /^[0-9a-f]{64}$/.test(row.sha256))) return false;
  if (row.hidden !== undefined && typeof row.hidden !== "boolean") return false;
  for (const key of ["w", "h", "bytes"]) {
    if (row[key] !== undefined && !Number.isInteger(row[key])) return false;
  }
  return true;
}

/** Чтение манифеста: отсутствующий файл → сид базовых (и запись на диск —
 *  контракт «при старте сид записывается»), битые строки выбрасываем.
 *  #83: нечитаемый/не-массивный манифест не затираем молча — откладываем
 *  уликой в manifest.corrupt-<ts>.json с громким логом, каталог живёт из сида. */
function stashCorruptManifest(reason) {
  const ts = Date.now().toString(36);
  const corruptPath = path.join(DIR, `manifest.corrupt-${ts}.json`);
  try {
    fs.renameSync(MANIFEST_FILE, corruptPath);
    console.warn(`sprites manifest CORRUPT: отложен как ${corruptPath} (${reason}); каталог пересеивается базой.`);
  } catch (e2) {
    console.warn(`sprites manifest CORRUPT: отложить не удалось (${e2?.message || e2}); каталог пересеивается базой.`);
  }
}

function loadManifest() {
  fs.mkdirSync(DIR, { recursive: true });
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  } catch (e) {
    if (e && e.code === "ENOENT") raw = null;
    else {
      stashCorruptManifest(e?.message || String(e));
      raw = null;
    }
  }
  if (raw !== null && !Array.isArray(raw)) {
    stashCorruptManifest("корень манифеста — не массив");
    raw = null;
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
    // #83: парсящийся, но без единой builtin-строки — «урезанный» манифест:
    // не затираем молча, улика + пересев базой.
    stashCorruptManifest("массив без единой builtin-строки");
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

/* ---------- #83: очередь сериализации манифеста ----------
 * Один async-мьютекс на ВСЕ мутации каталога (админские POST/PATCH/DELETE
 * и личные /sprites/mine*): валидация тяжёлых тел (readBody) идёт ДО входа
 * в очередь, а сама критическая секция синхронна — очередь лишь ставит
 * конкурирующие мутации в FIFO, внутри секции interleaving-а нет.
 * Контракт: подсчёт личного лимита и вставка — в ОДНОЙ критической секции. */
let manifestQueue = Promise.resolve();

/** Прогон fn строго после предыдущей мутации; очередь не рвётся на отказе fn. */
export function serializeManifestWork(fn) {
  const run = manifestQueue.then(fn);
  manifestQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * Операции над манифестом для мутатора (my-sprites.js и админские ручки).
 * Все коммиты держат контрактный порядок и ОТКАТЫВАЮТСЯ при ошибке диска:
 * вставка — png (tmp+rename) → память → manifest.json (tmp+rename) →
 * syncWhitelist; удаление — память → manifest.json → unlink(png) (осиротевший
 * файл безвреден, строка без файла ломает каталог); поля (name/category/
 * hidden) — память → manifest.json → syncWhitelist.
 * ВАЖНО: manifest мутируется только IN PLACE (push/splice) — ссылку держат
 * ops.rows и все читатели, переприсваивать переменную нельзя.
 */
export function mutateSprites(fn) {
  return serializeManifestWork(() => {
    const ops = {
      rows: manifest,
      rowById: findById,
      freeSlugFor,
      /** Вставка новой строки + PNG. {io:true} при ошибке диска (откат). */
      commitAppend(row, png) {
        try {
          writeFileAtomic(fileOf(row.id), png);
        } catch (e) {
          return { io: true, error: e };
        }
        manifest.push(row);
        try {
          writeFileAtomic(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
        } catch (e) {
          manifest.splice(manifest.findIndex((r) => r.id === row.id), 1);
          try { fs.unlinkSync(fileOf(row.id)); } catch { /* осиротевший tmp/png — мусор, не критично */ }
          return { io: true, error: e };
        }
        syncWhitelist();
        return { ok: true, row };
      },
      /** Удаление строки (+PNG). Откат строки при ошибке записи манифеста. */
      commitRemove(row) {
        const idx = manifest.findIndex((r) => r.id === row.id);
        if (idx === -1) return { missing: true };
        manifest.splice(idx, 1);
        try {
          writeFileAtomic(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
        } catch (e) {
          manifest.splice(idx, 0, row);
          return { io: true, error: e };
        }
        try { fs.unlinkSync(fileOf(row.id)); } catch (e) {
          if (e && e.code !== "ENOENT") console.warn("sprite file unlink failed:", e?.message || e);
        }
        syncWhitelist();
        return { ok: true };
      },
      /** Точечные поля строки (name/category/hidden) с откатом. Строка могла
       *  уйти из каталога, пока запрос шёл до очереди (гонка с DELETE) —
       *  отвечаем missing, а не падаем на undefined. */
      commitFields(row, fields) {
        if (!row) return { missing: true };
        const before = {};
        for (const key of Object.keys(fields)) before[key] = row[key];
        Object.assign(row, fields);
        try {
          writeFileAtomic(MANIFEST_FILE, JSON.stringify(manifest, null, 2));
        } catch (e) {
          Object.assign(row, before);
          return { io: true, error: e };
        }
        syncWhitelist();
        return { ok: true };
      },
    };
    return fn(ops);
  });
}

/** src каталога: builtin — статика www/sprites (как до менеджера), загруженный —
 *  API-отдача файла из DATA_DIR. Экспорт — my-sprites.js строит свой DTO тем
 *  же правилом (#83), чтобы личные окрасы не расходились с админскими. */
export function srcOf(row) {
  return row.builtin ? `/sprites/${row.id}.png${row.id === "test1" ? "?v=original-300x200" : ""}` : `/sprites/file/${row.id}.png`;
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
  const catalogIds = new Set(manifest.filter((r) => !r.hidden).map((r) => r.id));
  for (let i = SPRITES.length - 1; i >= 0; i -= 1) {
    const id = SPRITES[i];
    if (!BUILTIN_IDS.has(id) && !catalogIds.has(id)) SPRITES.splice(i, 1);
  }
  for (const row of manifest) {
    // #83: скрытый админом окрас в вайтлист не возвращается — pickSprite/
    // setSprite его больше не производят; новая отмена скрытия вернёт.
    if (row.hidden) continue;
    if (SPRITES.includes(row.id)) continue;
    SPRITES.push(row.id);
  }
}

syncWhitelist();

/** Живой валидатор id (accounts.js attachSprite, задачи п.5/#83; память, без fs).
 *  Скрытые админом строки валидатору недоступны: надеть их нельзя (как и WS). */
export function spriteIdAllowed(id) {
  return manifest.some((r) => r.id === id && !r.hidden);
}

/** Все строки каталога (живой массив) для читателей вне модуля (#83:
 *  my-sprites.js фильтрует свои окрасы по ownerAccountId). Мутации — только
 *  через mutateSprites; читатель мутировать не должен. */
export function allSpriteRows() {
  return manifest;
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

/** name 2–24 кодпоинтов после трима; category 1–32, не пустая.
 *  Экспорт — my-sprites.js надстраивает над валидатором свою чистку NFC
 *  (#83), не дублируя базовые правила. */
export function validName(raw) {
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

/** Подпись PNG — ровно 8 байт: 89 50 4E 47 0D 0A 1A 0A (\x89PNG\r\n\x1a\n).
 *  Экспорт: my-sprites.js проверяет ту же магию у личных окрасов (#83). */
export const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Чтение тела с потолком: лимит проверяется по факту прочитанных байтов
 *  (не только по Content-Length — его вообще могло не быть), копейки
 *  заголовка multipart в лимит НЕ входят. Экспорт — my-sprites.js читает
 *  тело своим потолком 1 МБ (админский MAX_UPLOAD 3 МБ не трогаем, #83). */
export function readBody(req, limit) {
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
 *  Возвращает {file?:{filename,data}, fields:{name,category}}.
 *  Экспорт — my-sprites.js разбирает форму личной загрузки тем же парсером. */
export function parseMultipart(buf, contentType) {
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
        // #83: скрытые админом строки из публичного каталога уходят — их
        // не видит ни карусель входа, ни профиль.
        items: manifest
          .filter((r) => !r.hidden)
          .map((r) => ({ id: r.id, name: r.name, category: r.category, src: srcOf(r) })),
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
        // #83: владелец личного окраса — по ownerAccountId; null = админский
        // (или builtin-сид). Логин мог быть удалён вместе с аккаунтом —
        // тогда честно показываем id.
        const owner = r.ownerAccountId
          ? (findAccountById(r.ownerAccountId)?.login || r.ownerAccountId)
          : null;
        return {
          id: r.id,
          name: r.name,
          category: r.category,
          builtin: r.builtin,
          src: srcOf(r),
          addedAt: Number(r.addedAt) || 0,
          wornBy,
          wornCount: wornBy.length,
          owner,
          hidden: r.hidden === true,
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
  // Коммит — ЕДИНСТВЕННАЯ критическая секция (подбор slug + вставка строки)
  // #83: очередь serializeManifestWork общая с личными окрасами, поэтому
  // подбор id и вставка идут в одном блоке: png → память → манифест →
  // вайтлист; при ошибке диска ops откатывает строку сама.
  const commit = await mutateSprites((ops) => {
    const row = {
      id: ops.freeSlugFor(name),
      name,
      category,
      builtin: false,
      addedAt: Date.now(),
    };
    return ops.commitAppend(row, form.file.data);
  });
  if (commit.io) {
    json(res, 500, { ok: false, reason: "storage", message: "Не удалось сохранить файл спрайта." });
    console.warn("sprite upload failed:", commit.error?.message || commit.error);
    return true;
  }
  const { id, addedAt } = commit.row;
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
  const extra = Object.keys(body).filter((k) => k !== "name" && k !== "category" && k !== "hidden");
  if (extra.length) {
    json(res, 400, { ok: false, reason: "unexpected_fields", unexpected: extra, expected: ["name", "category", "hidden"] });
    return true;
  }
  let nextName = null;
  let nextCategory = null;
  let nextHidden = null;
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
  // #83: скрытие — РЫЧАГ МОДЕРАЦИИ против «одетого» абузного окраса (обычный
  // DELETE против одетого бессилен): строка уходит из каталога и вайтлиста,
  // PNG остаётся на диске (улика). Тоггл — только админ (этот роут).
  if (body.hidden !== undefined) {
    if (typeof body.hidden !== "boolean") {
      json(res, 400, { ok: false, reason: "invalid_hidden", message: "hidden — только true или false." });
      return true;
    }
    nextHidden = body.hidden;
  }
  if (nextName === null && nextCategory === null && nextHidden === null) {
    json(res, 400, { ok: false, reason: "empty_patch", message: "Укажите name, category и/или hidden." });
    return true;
  }
  // Поля — через общую очередь мутаций (#83): память → манифест → вайтлист
  // (syncWhitelist внутри важен именно для hidden), с откатом при ошибке диска.
  const commit = await mutateSprites((ops) => {
    const fields = {};
    if (nextName !== null) fields.name = nextName;
    if (nextCategory !== null) fields.category = nextCategory;
    if (nextHidden !== null) fields.hidden = nextHidden;
    const target = ops.rowById(row.id);
    if (!target) return { missing: true };
    return ops.commitFields(target, fields);
  });
  if (commit.missing) {
    json(res, 404, { ok: false, reason: "unknown_sprite", message: "Спрайта с таким id уже нет." });
    return true;
  }
  if (commit.io) {
    json(res, 500, { ok: false, reason: "storage", message: "Не удалось сохранить изменение." });
    console.warn("sprite patch failed:", commit.error?.message || commit.error);
    return true;
  }
  json(res, 200, { ok: true, item: { id: row.id, name: row.name, category: row.category, builtin: row.builtin, src: srcOf(row), hidden: row.hidden === true } });
  return true;
}

async function handleDelete(res, id) {
  // Чтение и все проверки — внутри критической секции: между ними и удалением
  // никто не может вставить/удалить строку (одна очередь на все мутации, #83).
  const verdict = await mutateSprites((ops) => {
    const row = ops.rowById(id);
    if (!row) return { code: 404, reason: "unknown_sprite", message: "Спрайта с таким id нет." };
    if (row.builtin) {
      return {
        code: 400,
        reason: "builtin_immutable",
        message: "Базовые спрайты раздаются статикой деплоя — удалить их нельзя.",
      };
    }
    const wornBy = spriteWearers(row.id);
    if (wornBy.length) {
      const names = wornBy.map((w) => `${w.login} (${w.character})`).join(", ");
      return {
        code: 400,
        wornBy,
        reason: "in_use",
        message: `Спрайт одет у персонажей: ${names}. Сначала поменяйте им скин.`,
      };
    }
    const commit = ops.commitRemove(row);
    if (commit.io) return { code: 500, reason: "storage", message: "Не удалось сохранить изменение." };
    return { code: 200, id: row.id };
  });
  if (verdict.code === 200) {
    json(res, 200, { ok: true, id: verdict.id });
    return true;
  }
  if (verdict.code === 500) console.warn("sprite delete failed (io)");
  json(res, verdict.code, verdict.wornBy
    ? { ok: false, reason: verdict.reason, message: verdict.message, wornBy: verdict.wornBy }
    : { ok: false, reason: verdict.reason, message: verdict.message });
  return true;
}
