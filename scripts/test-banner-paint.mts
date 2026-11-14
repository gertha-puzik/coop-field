// @ts-nocheck
// Операции пиксельного редактора шапки 120×40: заливка и кисть. Без DOM.
import assert from 'node:assert/strict';
import { floodFill, stamp } from '../src/components/players/banner-paint-ops.ts';

const W = 120, H = 40;
const blank = () => {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 11; px[i + 1] = 16; px[i + 2] = 38; px[i + 3] = 255; }
  return px;
};
const count = (px, rgba) => {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] === rgba[0] && px[i + 1] === rgba[1] && px[i + 2] === rgba[2]) n++;
  return n;
};
const RED = [255, 0, 0, 255], WHITE = [255, 255, 255, 255];

const a = blank();
floodFill(a, 5, 5, RED);
assert.equal(count(a, RED), W * H, 'заливка чистого поля красит всё');

const b = blank();
for (let i = 0; i < 10; i++) { stamp(b, 20 + i, 10, 1, WHITE); stamp(b, 20 + i, 19, 1, WHITE); stamp(b, 20, 10 + i, 1, WHITE); stamp(b, 29, 10 + i, 1, WHITE); }
floodFill(b, 25, 15, RED);
assert.equal(count(b, RED), 64, 'заливка внутри рамки 10×10 — только внутренность');

const c = blank();
stamp(c, 0, 0, 3, WHITE);
assert.equal(count(c, WHITE), 4, 'кисть 3 у угла не выходит за границы');
const d = blank();
stamp(d, 50, 20, 3, WHITE);
assert.equal(count(d, WHITE), 9, 'кисть 3 = 3×3');
stamp(d, 50, 20, 2, WHITE);
const e = blank();
stamp(e, 50, 20, 2, WHITE);
assert.equal(count(e, WHITE), 4, 'кисть 2 = 2×2');

const f = blank();
floodFill(f, 3, 3, [11, 16, 38, 255]);
assert.equal(count(f, [11, 16, 38]), W * H, 'заливка тем же цветом — ничего не ломает');
console.log('banner-paint: ok');
