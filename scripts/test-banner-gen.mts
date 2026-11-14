// @ts-nocheck
// Генератор пиксельной шапки профиля: детерминизм от seed, размер, ночное небо. Без DOM.
import assert from 'node:assert/strict';
import { BANNER_H, BANNER_W, generateBanner } from '../src/lib/sim/banner-gen.ts';

assert.equal(BANNER_W, 120);
assert.equal(BANNER_H, 40);
const a = generateBanner('a');
assert.equal(a.length, 120 * 40 * 4, 'RGBA 120×40');
assert.deepEqual(generateBanner('a'), a, 'тот же seed → те же байты');

const b = generateBanner('b');
let diff = 0;
for (let i = 0; i < a.length; i += 4) {
  if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
}
assert.ok(diff > 120 * 40 * 0.05, `разные seed → разные шапки (отличий ${diff})`);

for (const seed of ['a', 'b', 'acc-123', '']) {
  const px = generateBanner(seed);
  for (let i = 3; i < px.length; i += 4) assert.equal(px[i], 255, 'непрозрачно');
}

// Ночное небо: в среднем светлеет к горизонту (сравниваем 2-ю строку и 12-ю).
const lum = (px, y) => {
  let s = 0;
  for (let x = 0; x < 120; x++) {
    const i = (y * 120 + x) * 4;
    s += px[i] + px[i + 1] + px[i + 2];
  }
  return s / 120;
};
let darkerTop = 0;
for (let k = 0; k < 20; k++) {
  const px = generateBanner('seed-' + k);
  if (lum(px, 1) < lum(px, 12)) darkerTop++;
}
assert.ok(darkerTop >= 16, `верх неба темнее горизонта (${darkerTop}/20)`);
console.log('banner-gen: ok');
