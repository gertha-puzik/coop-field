/**
 * Операции пиксельного редактора шапки (сетка 120×40, RGBA). Без DOM.
 */
// Зеркало BANNER_W/BANNER_H из src/lib/sim/banner-gen.ts (без импорта: модуль
// гоняется unit-тестом под node strip-types, где алиас @/ не резолвится).
const BANNER_W = 120;
const BANNER_H = 40;

export type RGBA = readonly [number, number, number, number];

function put(px: Uint8ClampedArray, x: number, y: number, c: RGBA): void {
  if (x < 0 || y < 0 || x >= BANNER_W || y >= BANNER_H) return;
  const i = (y * BANNER_W + x) * 4;
  px[i] = c[0];
  px[i + 1] = c[1];
  px[i + 2] = c[2];
  px[i + 3] = c[3];
}

/** Кисть: 1 — точка, 2 — квадрат 2×2 вправо-вниз, 3 — квадрат 3×3 с центром. */
export function stamp(px: Uint8ClampedArray, x: number, y: number, size: 1 | 2 | 3, c: RGBA): void {
  const from = size === 3 ? -1 : 0;
  const to = size === 1 ? 0 : 1;
  for (let dy = from; dy <= to; dy++) for (let dx = from; dx <= to; dx++) put(px, x + dx, y + dy, c);
}

/** Линия кистью между двумя клетками (Брезенхем) — без дыр при быстром движении. */
export function strokeLine(
  px: Uint8ClampedArray,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  size: 1 | 2 | 3,
  c: RGBA,
): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    stamp(px, x0, y0, size, c);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
}

/** Заливка 4-связной области одного цвета. */
export function floodFill(px: Uint8ClampedArray, x: number, y: number, c: RGBA): void {
  if (x < 0 || y < 0 || x >= BANNER_W || y >= BANNER_H) return;
  const at = (y * BANNER_W + x) * 4;
  const t = [px[at], px[at + 1], px[at + 2], px[at + 3]];
  if (t[0] === c[0] && t[1] === c[1] && t[2] === c[2] && t[3] === c[3]) return;
  const same = (i: number) => px[i] === t[0] && px[i + 1] === t[1] && px[i + 2] === t[2] && px[i + 3] === t[3];
  const stack = [x, y];
  while (stack.length) {
    const cy = stack.pop() as number;
    const cx = stack.pop() as number;
    if (cx < 0 || cy < 0 || cx >= BANNER_W || cy >= BANNER_H) continue;
    const i = (cy * BANNER_W + cx) * 4;
    if (!same(i)) continue;
    put(px, cx, cy, c);
    stack.push(cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1);
  }
}

/** Цвет клетки (пипетка). */
export function pick(px: Uint8ClampedArray, x: number, y: number): RGBA {
  const i = (Math.max(0, Math.min(BANNER_H - 1, y)) * BANNER_W + Math.max(0, Math.min(BANNER_W - 1, x))) * 4;
  return [px[i], px[i + 1], px[i + 2], px[i + 3]];
}

export const toHex = (c: RGBA): string => '#' + [c[0], c[1], c[2]].map((v) => v.toString(16).padStart(2, '0')).join('');

export function fromHex(hex: string): RGBA {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}
