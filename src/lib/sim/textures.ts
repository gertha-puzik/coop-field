/**
 * Текстуры локации «тест» — спрайты пака «Pixel Art Top Down - Basic v1.2.3»
 * (Cainos, CC0), лежат в /public/tex и нарезаны скриптом scripts/slice_pack.py.
 *
 * Спрайты грузятся один раз лениво (по первому обращению из отрисовки); пока
 * картинка не догрузилась, packImg возвращает null — рисующие функции в этом
 * случае падают назад на прежнюю векторную графику, поэтому игра не ломается
 * ни при медленной сети, ни при отсутствии файлов. Паттерны травы и боевого
 * пола кэшируются на контекст канваса (WeakMap), т.к. createPattern привязан
 * к нему. Картинки уже увеличены ×3 (NEAREST) — тайл 16 px превращён в 48 px
 * мира, так что заливка идёт 1:1 в мировых пикселях без DOMMatrix.
 */

/** Имена доступных спрайтов пака. */
export type PackName =
  | 'tree'
  | 'rock'
  | 'bush-s'
  | 'bush-m'
  | 'bush-h'
  | 'grass-ground'
  | 'stone-floor'
  | `tuft-${number}`;

/** Количество нарезанных вариантов травинок (tuft-00..tuft-15). */
export const PACK_TUFT_COUNT = 16;

const SRC: Record<string, string> = {
  tree: '/tex/tree.png',
  rock: '/tex/rock.png',
  'bush-s': '/tex/bush-s.png',
  'bush-m': '/tex/bush-m.png',
  'bush-h': '/tex/bush-h.png',
  'grass-ground': '/tex/grass-ground.png',
  'stone-floor': '/tex/stone-floor.png',
};
for (let i = 0; i < PACK_TUFT_COUNT; i++) SRC[`tuft-${String(i).padStart(2, '0')}`] = `/tex/tuft-${String(i).padStart(2, '0')}.png`;

const imgs = new Map<string, HTMLImageElement>();
let started = false;

function ensureStarted(): void {
  if (started || typeof document === 'undefined') return;
  started = true;
  for (const [name, src] of Object.entries(SRC)) {
    const img = new Image();
    // onload до src: закэшированный PNG может «загрузиться» синхронно
    img.onload = () => {
      imgs.set(name, img);
    };
    img.src = src;
    if (img.complete && img.naturalWidth > 0) imgs.set(name, img);
  }
}

/** Спрайт пака или null, пока не догрузился (рисовалка тогда идёт вектором). */
export function packImg(name: PackName): HTMLImageElement | null {
  ensureStarted();
  return imgs.get(name) ?? null;
}

type PatEntry = { grass?: CanvasPattern | null; stone?: CanvasPattern | null };
const patCache = new WeakMap<CanvasRenderingContext2D, PatEntry>();

/** Бесшовный паттерн травы (оливковая зелень с цветами), либо null. */
export function grassPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const img = packImg('grass-ground');
  if (!img) return null;
  let e = patCache.get(ctx);
  if (!e) {
    e = {};
    patCache.set(ctx, e);
  }
  if (e.grass === undefined) e.grass = ctx.createPattern(img, 'repeat');
  return e.grass ?? null;
}

/** Бесшовный паттерн каменного пола боевой зоны, либо null. */
export function stonePattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const img = packImg('stone-floor');
  if (!img) return null;
  let e = patCache.get(ctx);
  if (!e) {
    e = {};
    patCache.set(ctx, e);
  }
  if (e.stone === undefined) e.stone = ctx.createPattern(img, 'repeat');
  return e.stone ?? null;
}
