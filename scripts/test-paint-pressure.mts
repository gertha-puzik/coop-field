// @ts-nocheck
// Давление пера: множитель размера кисти (мышь без изменений, перо 0..1 → пол..1).
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./unit-ts-loader.mjs', import.meta.url));

const {
  PAINT_PRESSURE_MIN,
  paintPressureFactor,
  clearPaintDirty,
  takePaintDirty,
} = await import('../src/lib/sim/paint.ts');

assert.equal(paintPressureFactor('mouse', 0.5), 1, 'мышь игнорирует pressure');
assert.equal(paintPressureFactor('mouse', 0), 1);
assert.equal(paintPressureFactor('touch', 0.2), 1, 'тач без пера — полный размер');
assert.equal(paintPressureFactor('pen', 1), 1, 'полное нажатие = 100%');
assert.equal(paintPressureFactor('pen', 0.5), 0.5);
assert.equal(paintPressureFactor('pen', 0), PAINT_PRESSURE_MIN, 'нулевое → пол');
assert.equal(paintPressureFactor('pen', -1), PAINT_PRESSURE_MIN);
assert.equal(paintPressureFactor('pen', Number.NaN), PAINT_PRESSURE_MIN);
assert.equal(paintPressureFactor('pen', 0.01), PAINT_PRESSURE_MIN, 'ниже пола — пол');
assert.equal(paintPressureFactor('pen', 1.5), 1, 'выше 1 — clamp');

clearPaintDirty();
assert.equal(takePaintDirty(100, 100), null, 'без штампа dirty пуст');

console.log('ok: paint pressure factor');
