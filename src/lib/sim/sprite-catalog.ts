/**
 * Динамический каталог спрайтов поверх статичного settings.SPRITES —
 * обновляемый источник для каруселей (экрана входа и панели настроек) и
 * валидаций, НЕ трогая защищённые файлы (simulator.tsx, entry-screen.tsx,
 * settings-panel.tsx — все они читают импортированные массивы на каждом
 * рендере/вызове).
 *
 * Механизм: массивы settings.ts остаются ТОЙ ЖЕ ссылкой (константы не
 * переприсваиваются), содержимое обновляется IN PLACE (splice):
 *   - SPRITES — сам каталог карусели/валидаций (coop.spriteOf, use-network,
 *     elision-present и пр. читают его в рантайме);
 *   - FIELD_SPRITES — копия для предзагрузки картинок поля ходов
 *     (useSpriteCache; последний элемент — rab, его сохраняем);
 *   - SPRITE_GROUPS — колонки карусели «персонажи». Рукотворные базовые
 *     группы НЕ переопределяем (UX листания выверен владельцами), ХВОСТ
 *     массива после базовых групп замещаем группами по категориям
 *     загруженных спрайтов: категория «Праздничные» становится колонкой
 *     «Праздничные» — игрок видит категории на тех же экранах без правки
 *     защищённых файлов; MALYSHOCHKI_SET отдельным разделом не трогаем.
 *
 * Загрузка: при старте модуля — синхронно из localStorage-кэша (успевает до
 * первого useEffect-предзагрузки картинок), затем один HTTP-fetch
 * GET /sprites/catalog (каталог меняется редко, WS-push не заводим).
 * Сбой/пусто — остаётся статичный массив settings (вид как до менеджера).
 * Subscribe — для будущих UI-фильтров и админ-вкладки.
 */
import {
  SPRITES,
  SPRITE_GROUPS,
  FIELD_SPRITES,
  type SpriteGroup,
  type SpriteMeta,
} from "./settings";
import { SPRITE_CATALOG_CACHE_KEY } from "./engine-consts";
import { httpSpriteCatalog, type SpriteCatalogItem } from "@/lib/net/http-sprites";

/** Длина рукотворных групп (хвост после неё — категории каталога). */
const BASE_GROUPS_COUNT = SPRITE_GROUPS.length;
const BUILTIN_SOURCES = new Map(SPRITES.map(sp => [sp.id, sp.src]));

type Listener = () => void;
const listeners = new Set<Listener>();

export function subscribeSpriteCatalog(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const fn of listeners) fn();
}

/** Прочитать элементы каталога текущего состояния (валидации, UI). */
export function currentSpriteCatalog(): SpriteMeta[] {
  return SPRITES;
}

/** Уникальные категории текущего каталога (порядок сохранён). */
export function spriteCategories(): string[] {
  const seen: string[] = [];
  for (const sp of SPRITES) {
    if (sp.category && !seen.includes(sp.category)) seen.push(sp.category);
  }
  return seen;
}

const slugOf = (raw: string): string => {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  let out = "";
  const text = String(raw || "").toLowerCase();
  for (const ch of text) {
    if (map[ch] !== undefined) out += map[ch];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += "-";
  }
  return `cat-${out.replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "")}` || "cat";
};

/** Точка применения: каталог сервера (или кэша) → живые массивы settings.
 *  Ссылки массивов прежние (важно: поля закрытых файлов могли их закэшировать
 *  ссылочно — но чтение содержимого всегда свежее). */
export function applySpriteCatalog(items: SpriteCatalogItem[]): void {
  if (!Array.isArray(items) || !items.length) return;
  const rows: SpriteMeta[] = items.map((it) => ({
    id: it.id,
    name: it.name || it.id,
    src: BUILTIN_SOURCES.get(it.id) || it.src || `/sprites/${it.id}.png`,
    category: it.category,
  }));
  // каталог целиком: уходит и переименованный builtin (имена/категории
  // правятся админом), исчезнувшие загруженные из списка уходят.
  SPRITES.splice(0, SPRITES.length, ...rows);
  // предзагрузка поля: [каталог…, rab] — копия FIELD_SPRITES живёт своей
  // жизнью, чиним содержимое тем же in-place способом.
  const rab = FIELD_SPRITES[FIELD_SPRITES.length - 1];
  FIELD_SPRITES.splice(0, FIELD_SPRITES.length, ...rows, {
    id: rab?.id ?? "rab",
    name: rab?.name ?? "РАБ",
    src: rab?.src ?? "/sprites/rab.png",
  });
  // группы карусели: рукотворные НЕ трогаем, хвост = категории НЕ-builtin.
  const byCategory = new Map<string, string[]>();
  const builtinIds = new Set(rows.filter((r) => isBuiltinId(r.id)).map((r) => r.id));
  for (const r of rows) {
    if (builtinIds.has(r.id)) continue;
    const cat = r.category || "Без категории";
    byCategory.set(cat, [...(byCategory.get(cat) || []), r.id]);
  }
  const tail: SpriteGroup[] = [];
  for (const [category, ids] of byCategory) {
    tail.push({ id: slugOf(category), name: category, spriteIds: ids });
  }
  SPRITE_GROUPS.splice(BASE_GROUPS_COUNT, SPRITE_GROUPS.length - BASE_GROUPS_COUNT, ...tail);
  notify();
}

/** Базовые id из статичного набора (подсветка builtin в UI и разделитель
 *  «рукотворные группы/категории»): множество заполняется при загрузке модуля
 *  ДО первого apply — 32 элемента, O(1) поиск. */
const STATIC_BASE_IDS = new Set<string>();
const isBuiltinId = (id: string): boolean => STATIC_BASE_IDS.has(id);

// top-level init: собрать базовые id ДО первого apply — модуль грузится один
// раз на страницу, ровно тут же заказывается и boot-fetch ниже.
for (const sp of SPRITES) STATIC_BASE_IDS.add(sp.id);

/* ---------- кэш localStorage ---------- */

function readCache(): SpriteCatalogItem[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SPRITE_CATALOG_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return null;
    const items = parsed as SpriteCatalogItem[];
    const have = new Set(items.map(item => item.id));
    // Новый builtin должен быть виден до фонового fetch; загруженные скины
    // из старого кэша сохраняем вместе с их именами и категориями.
    return [...items, ...SPRITES.filter(sp => !have.has(sp.id)).map(sp => ({
      ...sp, category: sp.category ?? "Базовые",
    }))];
  } catch {
    return null;
  }
}

function writeCache(items: SpriteCatalogItem[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SPRITE_CATALOG_CACHE_KEY, JSON.stringify(items));
  } catch {
    /* переполнение/приватный режим — кэш не критичен */
  }
}

/* ---------- fetch ---------- */

let refreshPromise: Promise<void> | null = null;

/** Подтянуть каталог с сервера (идемпотентно: параллельные вызовы — один
 *  fetch). Сбой сети молча оставляет текущее состояние (статичный массив
 *  или прошлый кэш). */
export function refreshSpriteCatalog(): Promise<void> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const items = await httpSpriteCatalog();
      if (items) {
        applySpriteCatalog(items);
        writeCache(items);
      }
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

// Boot: сначала синхронный кэш (успевает до первой отрисовки и предзагрузки
// картинок), затем фоновый fetch поверх него. Вызывается import-ом этого
// модуля из графа страницы (src/lib/net/coop.ts) — на обеих вариантах сайта.
{
  const cached = readCache();
  if (cached) applySpriteCatalog(cached);
  if (typeof window !== "undefined") void refreshSpriteCatalog();
}
