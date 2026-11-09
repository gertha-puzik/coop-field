/**
 * Cat position book (W4 carve, behavior-preserving): data/test-cats.json —
 * last known position of every «test»-room cat, restored on join after a
 * server restart. Throttled atomic flush (2 s ticker + on leave/shutdown),
 * 30-day TTL. Also owns the restore rules: a peace point must be inside the
 * current ground mask and outside obstacle bodies; a battle cell must be
 * walkable and free.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DATA_DIR,
} from "./config.js";
import { TEST_OBST_BODIES } from "./testmap.js";
import { nearestTestCell, testPointInIsland, testWalkable } from "./world.js";
import { occupied } from "./room.js";
import { writeFileAtomic } from "./testmap.js";

/* ---------- позиции котов между запусками сервера.
   Рестарт (деплой) раньше выбрасывал всех на спавн — включая АФК-котов, которые
   честно стояли на месте. Теперь последняя позиция каждого кота «теста» живёт
   в data/test-cats.json и возвращается хозяину при join. ---------- */
const CATS_FILE = path.join(DATA_DIR, "test-cats.json");
const CATS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // записи старше месяца не восстанавливаем
const CATS_SAVE_GAP_MS = 3000; // писать на диск не чаще раза в 3 с

let catBook = loadCatBook();
let catBookDirty = false;
let catBookLastSave = 0;

function loadCatBook() {
  try {
    const raw = JSON.parse(fs.readFileSync(CATS_FILE, "utf8"));
    if (raw && typeof raw === "object" && raw.cats && typeof raw.cats === "object") {
      return raw.cats;
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("cats file read failed:", e?.message || e);
  }
  return {};
}

/** Слив книги позиций на диск: грязный флаг + троттлинг, force — при выходе кота
 *  и на остановке сервера. Атомарно и с обрезкой устаревших записей. */
function flushCatBook(force = false) {
  const now = Date.now();
  if (!catBookDirty) return;
  if (!force && now - catBookLastSave < CATS_SAVE_GAP_MS) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const key of Object.keys(catBook)) {
      if (now - (catBook[key]?.ts || 0) > CATS_TTL_MS) delete catBook[key];
    }
    writeFileAtomic(CATS_FILE, JSON.stringify({ v: 1, savedAt: now, cats: catBook }, null, 2));
    catBookDirty = false;
    catBookLastSave = now;
  } catch (e) {
    console.warn("cats save failed:", e?.message || e);
  }
}

/** Кот стоит на новом месте — помечаем книгу грязной (пишется общим сливом). */
function rememberCat(cat) {
  if (!cat || !cat.login) return;
  catBook[String(cat.login).toLowerCase()] = {
    login: cat.login,
    fm: cat.fm ? 1 : 0,
    fx: Number.isFinite(cat.fx) ? cat.fx : undefined,
    fy: Number.isFinite(cat.fy) ? cat.fy : undefined,
    x: cat.x,
    y: cat.y,
    ts: Date.now(),
  };
  catBookDirty = true;
}

/**
 * P5-редизайн каталога (read-only вью): время последней записи позиции кота
 * по логину персонажа, 0 — записи нет/устарела (TTL 30 дней). Честный источник
 * «когда кота последний раз видели на поле» и комнаты-«дома» (книга ведётся
 * только для комнаты «тест»/Элизия). Ключ — логин кота, т.е. ИМЯ персонажа
 * (не логин аккаунта): одноимённые персонажи неразличимы — известное
 * ограничение источника, см. карточку в profiles.js. Ничего не мутирует.
 */
function catSeenAt(login) {
  const rec = catBook[String(login || "").toLowerCase()];
  if (!rec || typeof rec !== "object") return 0;
  return Number(rec.ts) || 0;
}

/** Мирная точка не внутри тела препятствия (эллипс с поворотом, чуть проще
 *  клиентского — на граничных точках лучше вернуть кота, чем оставить на спавне).
 *  Камень пропускается: он — платформа уровня 1, мирный кот стоит НА клетке
 *  камня (зеркало testPeaceObjectDepth клиента). */
function peacePointFreeOfObjects(fx, fy) {
  const px = fx * 100;
  const py = fy * 150;
  for (const b of TEST_OBST_BODIES) {
    if (b.o && b.o.kind === 'stone') continue;
    if (!(b.hw > 0) || !(b.h > 0)) continue;
    const cos = Math.cos(-b.rot);
    const sin = Math.sin(-b.rot);
    const dx = px - b.x * 100;
    const dy = py - b.y * 150;
    const ux = dx * cos - dy * sin;
    const uy = dx * sin + dy * cos;
    if ((ux * ux) / (b.hw * b.hw) + (uy * uy) / (b.h * b.h) <= 1) return false;
  }
  return true;
}

/** Возврат кота на прежнее место после рестарта сервера. Книга — только
 *  комната «тест»: клетка Элизии на поле 10×6 грота оказывается за кадром,
 *  и игрок пропадает. Мирная точка — только внутри локации и вне тел
 *  препятствий, боевая — на свободной проходимой клетке; иначе кот остаётся
 *  на обычном спавне. */
function restoreCatPosition(room, cat) {
  if (!room || room.fmt !== "test") return;
  const rec = catBook[String(cat.login || "").toLowerCase()];
  if (!rec || Date.now() - (rec.ts || 0) > CATS_TTL_MS) return;
  if (rec.fm === 1 && Number.isFinite(rec.fx) && Number.isFinite(rec.fy)) {
    const fx = Math.round(rec.fx * 100) / 100;
    const fy = Math.round(rec.fy * 100) / 100;
    const inside =
      testPointInIsland(fx, fy) || testPointInIsland(fx + 0.45, fy + 0.45);
    if (inside && peacePointFreeOfObjects(fx, fy)) {
      cat.fm = 1;
      cat.fx = fx;
      cat.fy = fy;
      const cell = nearestTestCell(fx, fy);
      if (cell) {
        cat.x = cell.x;
        cat.y = cell.y;
      }
      return;
    }
  }
  if (
    rec.fm === 0 &&
    Number.isInteger(rec.x) &&
    Number.isInteger(rec.y) &&
    testWalkable(rec.x, rec.y) &&
    !occupied(room, rec.x, rec.y, cat.id)
  ) {
    cat.fm = 0;
    cat.x = rec.x;
    cat.y = rec.y;
  }
}

/**
 * Стык с книгой точек: убрать персистную запись кота (админ-сброс положения,
 * POST /admin/players/reset). После стирания повторный join не вернёт прежнюю
 * точку — восстановление пройдёт по свежей клетке спавна; новая ходьба честно
 * запишется сама. true — запись была и удалена, false — записи и так не было.
 */
function forgetCat(rawLogin) {
  const key = String(rawLogin || "").toLowerCase();
  if (!key || !Object.prototype.hasOwnProperty.call(catBook, key)) return false;
  delete catBook[key];
  catBookDirty = true;
  return true;
}

export { flushCatBook, rememberCat, restoreCatPosition, forgetCat, catSeenAt };
