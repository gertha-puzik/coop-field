/**
 * Текстуры локации «тест» — спрайты пака «Pixel Art Top Down - Basic v1.2.3»
 * (Cainos, CC0), лежат в /public/tex и нарезаны скриптом scripts/slice_pack.py.
 *
 * Нарезаны все виды пака: 3 дерева (tree-1..3), 10 камней (rock-1..10 — валун,
 * булышки и плоские ступени), кустики, травинки и покрытия земли (трава, цветы,
 * плитка на траве — 48 px тайлы, каменный пол — 96 px).
 *
 * Спрайты грузятся один раз лениво (по первому обращению из отрисовки); пока
 * картинка не догрузилась, packImg возвращает null — рисующие функции в этом
 * случае падают назад на прежнюю векторную графику, поэтому игра не ломается
 * ни при медленной сети, ни при отсутствии файлов. Паттерны травы, боевого
 * пола и покрытий кэшируются на контекст канваса (WeakMap), т.к. createPattern
 * привязан к нему. Тайлы покрытий уже увеличены ×3 (NEAREST) — тайл 16 px
 * превращён в 48 px мира, пол 32 px — в 96 px: заливка идёт 1:1 в мировых
 * пикселях без DOMMatrix.
 */

import { GROUND_COVER_OPTS, type GroundCover } from './test-map';

/** Имена доступных спрайтов пака. */
export type PackName =
  | `plant-${number}`
  | 'tree-1'
  | 'tree-2'
  | 'tree-3'
  | 'rock-1'
  | 'rock-2'
  | 'rock-3'
  | 'rock-4'
  | 'rock-5'
  | 'rock-6'
  | 'rock-7'
  | 'rock-8'
  | 'rock-9'
  | 'rock-10'
  | 'bush-s'
  | 'bush-m'
  | 'bush-h'
  | 'grass-ground'
  | 'stone-floor'
  | GroundCover
  | `tuft-${number}`;

/** Количество нарезанных вариантов травинок (tuft-00..tuft-15). */
export const PACK_TUFT_COUNT = 16;

const SRC: Record<string, string> = {
  'tree-1': '/tex/tree-1.png',
  'tree-2': '/tex/tree-2.png',
  'tree-3': '/tex/tree-3.png',
  'rock-1': '/tex/rock-1.png',
  'rock-2': '/tex/rock-2.png',
  'rock-3': '/tex/rock-3.png',
  'rock-4': '/tex/rock-4.png',
  'rock-5': '/tex/rock-5.png',
  'rock-6': '/tex/rock-6.png',
  'rock-7': '/tex/rock-7.png',
  'rock-8': '/tex/rock-8.png',
  'rock-9': '/tex/rock-9.png',
  'rock-10': '/tex/rock-10.png',
  'bush-s': '/tex/bush-s.png',
  'bush-m': '/tex/bush-m.png',
  'bush-h': '/tex/bush-h.png',
  'grass-ground': '/tex/grass-ground.png',
  'stone-floor': '/tex/stone-floor.png',
};
for (const c of GROUND_COVER_OPTS) SRC[c.id] = `/tex/${c.id}.png`;
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
const requestedPlants=new Set<string>();
export function packImg(name: PackName): HTMLImageElement | null {
  ensureStarted();
  if(name.startsWith('plant-')&&!requestedPlants.has(name)&&typeof Image!=='undefined'){
    requestedPlants.add(name);const image=new Image();image.onload=()=>imgs.set(name,image);image.src=`/tex/${name}.png`;
  }
  return imgs.get(name) ?? null;
}

type PatEntry = {
  grass?: CanvasPattern | null;
  stone?: CanvasPattern | null;
  covers?: Map<string, CanvasPattern | null>;
};
const patCache = new WeakMap<CanvasRenderingContext2D, PatEntry>();

function patEntry(ctx: CanvasRenderingContext2D): PatEntry {
  let e = patCache.get(ctx);
  if (!e) {
    e = {};
    patCache.set(ctx, e);
  }
  return e;
}

/** Бесшовный паттерн травы (оливковая зелень с цветами), либо null. */
export function grassPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const img = packImg('grass-ground');
  if (!img) return null;
  const e = patEntry(ctx);
  if (e.grass === undefined) e.grass = ctx.createPattern(img, 'repeat');
  return e.grass ?? null;
}

/** Бесшовный паттерн каменного пола боевой зоны, либо null. */
export function stonePattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const img = packImg('stone-floor');
  if (!img) return null;
  const e = patEntry(ctx);
  if (e.stone === undefined) e.stone = ctx.createPattern(img, 'repeat');
  return e.stone ?? null;
}

/** Паттерн покрытия земли (тайл 48/96 px мира, повтор от начала мира — соседние
 *  покрашенные клетки сходятся швами в сплошной настил), либо null. */
export function coverPattern(ctx: CanvasRenderingContext2D, name: GroundCover): CanvasPattern | null {
  const img = packImg(name);
  if (!img) return null;
  const e = patEntry(ctx);
  if (!e.covers) e.covers = new Map();
  if (!e.covers.has(name)) e.covers.set(name, ctx.createPattern(img, 'repeat'));
  return e.covers.get(name) ?? null;
}

/** Меняется при догрузке пака: кэш атласа WebGL повторяет отрисовку после загрузки тайлов. */
export function packRevision(): number {
  ensureStarted();
  return imgs.size;
}
