/**
 * Pure geometry helpers of the cell-based engine: sprite boxes in cells, peace
 * half-box conversion, occlusion rects, the arrow anchor fraction math and the
 * entry-cell search. Carved verbatim from the simulator.tsx module belt
 * (W5a stage 1, behavior-preserving).
 *
 * Consumers: simulator.tsx (scene drawing, input, strike beam) and sibling
 * lib/sim modules. All functions are pure — canvas ctx is only ever passed in;
 * no React, no refs, no module state.
 *
 * ARROW_ANCHOR_F lives in engine-consts.ts (it is also consumed by the draw
 * belt of simulator.tsx directly): anchorOf/anchorAtPx below are the single
 * named source of the anchor formula — keep the inline copy in the block-lock
 * draw in sync (known debt, see audit SIM-04).
 */

import { ARROW_ANCHOR_F } from './engine-consts';
import type { SimSettings } from './settings';
import { testEntries } from './test-field';

export function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** Габариты спрайта персонажа/мишени в клетке (col,row): привязан к левому верхнему углу клетки.
 *  scalePct — рост модельки в % от высоты клетки (свой кот — s.character.spriteScale,
 *  манекен — свой DummyConfig.scale). */
export function spriteBoxOf(s: SimSettings, aspect: number, col: number, row: number, scalePct: number) {
  const k = scalePct / 100;
  const h = (s.field.cellH - 10) * k;
  const w = h * aspect;
  return { x: col * s.field.cellW, y: row * s.field.cellH, w, h, k };
}

/** Полгабарита своей модельки в клеточных долях: перевод якорной точки мира
 *  (центр и середины сторон клетки) в свободную позицию (левый верх спрайта)
 *  и обратно, чтобы центр модельки вставал точно на якорь. */
export function peaceHalfBox(s: SimSettings, img: HTMLImageElement | undefined) {
  const aspect = img && img.height > 0 ? img.width / img.height : 2 / 3;
  const b = spriteBoxOf(s, aspect, 0, 0, s.character.spriteScale);
  return { dx: b.w / 2 / s.field.cellW, dy: b.h / 2 / s.field.cellH };
}

/** Прямоугольник в px мира (габарит модельки/объекта для проверки перекрытия). */
export type PxRect = { x0: number; y0: number; x1: number; y1: number };

/** Какая доля прямоугольника b накрыта прямоугольником a (0..1, по площади). */
export function coveredRatio(a: PxRect, b: PxRect): number {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const area = (b.x1 - b.x0) * (b.y1 - b.y0);
  return area > 0 ? (ix * iy) / area : 0;
}

/** Радиус физического тела мирного кота у земли (px мира): доля ширины модельки —
 *  крупный кот занимает больше места, мелкий пролезает там, где крупному тесно. */
export function peaceBodyRadius(spriteW: number): number {
  return Math.max(12, spriteW * 0.3);
}

/** Ближайшая клетка захода к клетке (манхэттен) — куда телепортировать при выходе
 *  из боя, когда заход, через который вошли, уже не существует (правка локации). */
export function nearestEntryCell(col: number, row: number): { c: number; r: number } | null {
  let best: { c: number; r: number } | null = null;
  let bd = Infinity;
  for (const o of testEntries()) {
    const d = Math.abs(o.c - col) + Math.abs(o.r - row);
    if (d < bd) {
      bd = d;
      best = { c: o.c, r: o.r };
    }
  }
  return best;
}

/** Точка закрепления стрелы: сидит на одной и той же доле (ARROW_ANCHOR_F) ширины/высоты модельки. */
export function anchorOf(s: SimSettings, aspect: number, col: number, row: number, scalePct: number) {
  const b = spriteBoxOf(s, aspect, col, row, scalePct);
  return {
    ax: b.x + b.w * ARROW_ANCHOR_F,
    ay: b.y + b.h * ARROW_ANCHOR_F + s.arrow.anchorOffsetY,
    k: b.k,
  };
}

/** Точка закрепления по координатам спрайта в px — для перетаскиваемого манекена,
 *  который на время drag'а оторван от своей клетки. */
export function anchorAtPx(s: SimSettings, aspect: number, x: number, y: number, scalePct: number) {
  const b = spriteBoxOf(s, aspect, 0, 0, scalePct);
  return {
    ax: x + b.w * ARROW_ANCHOR_F,
    ay: y + b.h * ARROW_ANCHOR_F + s.arrow.anchorOffsetY,
    k: b.k,
  };
}

/** Экранные CSS-пиксели канваса → px мира. Камера: translate(центр); scale(z);
 *  rotate(yaw); translate(−cam). yaw = 0 — вид сверху без поворота. */
export function screenToWorld(
  sx: number,
  sy: number,
  vw: number,
  vh: number,
  camX: number,
  camY: number,
  z: number,
  yaw: number,
): { x: number; y: number } {
  const dx = (sx - vw / 2) / Math.max(0.05, z);
  const dy = (sy - vh / 2) / Math.max(0.05, z);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: dx * c + dy * s + camX, y: -dx * s + dy * c + camY };
}

/** Глубина для сортировки билбордов: больше — ближе к нижнему краю экрана. */
export function viewDepth(x: number, y: number, camX: number, camY: number, yaw: number): number {
  return -Math.sin(yaw) * (x - camX) + Math.cos(yaw) * (y - camY);
}

/** Какая половина тела поражена при входе луча через данный край прямоугольника. */
export function entrySide(hit: { edge: 'left' | 'right' | 'top' | 'bottom'; nx: number }): 'left' | 'right' {
  if (hit.edge === 'left') return 'left';
  if (hit.edge === 'right') return 'right';
  return hit.nx < 50 ? 'left' : 'right';
}
