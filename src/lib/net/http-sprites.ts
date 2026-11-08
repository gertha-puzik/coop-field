/**
 * Публичный каталог спрайтов (менеджер спрайтов, server/sprites.js) — общий
 * для ОБЕИХ сайтов (у гротов гости тоже выбирают скин на экране входа),
 * поэтому модуль живёт в общем графе и не тянет Elysiae-маршрутов.
 *
 * Контракт сервера:
 *   GET /sprites/catalog → 200 {ok:true, items:[{id,name,category,src}]}
 *   (публичный, без сессии; src базовых = /sprites/<id>.png — статика
 *   варианта, загруженных = /sprites/file/<id>.png — API-отдача).
 *
 * Ошибка сети/парса ⇒ null: потребитель (sprite-catalog.ts) деградирует на
 * статичный массив SPRITES из lib/sim/settings — экран выбора не ломается.
 * Админские CRUD-ручки живут отдельно в ./http-admin-sprites.ts (бандл
 * только страницы /admin — изоляция сайтов, §10.4).
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";

/** Запись публичного каталога (модель карусели выбора скина). */
export type SpriteCatalogItem = {
  id: string;
  name: string;
  category: string;
  src: string;
};

/** Разбор items: битые строки выбрасываем — каталог не врёт, а сужается. */
function parseItems(raw: unknown): SpriteCatalogItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SpriteCatalogItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as ApiRow;
    const id = asText(row.id);
    if (!id) continue;
    out.push({
      id,
      name: asText(row.name, id),
      category: asText(row.category),
      // пустой src не оставляем: карусель рисует <img src>, битый URL — мусор
      src: asText(row.src) || `/sprites/${id}.png`,
    });
  }
  return out.length ? out : null;
}

/**
 * Каталог с сервера; null — недоступен/отказал (деградация на статичный
 * массив settings.SPRITES у вызывающего).
 */
export async function httpSpriteCatalog(): Promise<SpriteCatalogItem[] | null> {
  const { status, row } = await apiFetch("/sprites/catalog");
  if (status !== 200 || row?.ok !== true) return null;
  return parseItems(row.items);
}
