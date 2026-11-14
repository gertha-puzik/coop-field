// @ts-nocheck
// Математика кадра шапки 3:1 («как в Твиттере»): покрытие рамки и вырез исходника.
import assert from 'node:assert/strict';
import { clampOffset, coverScale, cropRect } from '../src/components/players/banner-crop-math.ts';

assert.equal(coverScale(600, 200, 1200, 400), 2, 'маленькая картинка растягивается до рамки');
assert.equal(coverScale(300, 1000, 1200, 400), 4, 'узкая высокая — по ширине');
assert.equal(coverScale(4000, 400, 1200, 400), 1, 'очень широкая — по высоте');
assert.deepEqual(clampOffset({ x: 50, y: 50 }, 1200, 400, 1, 1200, 400), { x: 0, y: 0 }, 'край не открывается');
assert.deepEqual(clampOffset({ x: -5000, y: 0 }, 2400, 400, 1, 1200, 400), { x: -1200, y: 0 }, 'правый край');
assert.deepEqual(clampOffset({ x: -10, y: -999 }, 300, 1000, 4, 1200, 400), { x: 0, y: -999 }, 'высокая: двигается по Y');
assert.deepEqual(clampOffset({ x: 0, y: -5000 }, 300, 1000, 4, 1200, 400), { x: 0, y: -3600 }, 'высокая: низ');
assert.deepEqual(cropRect({ x: -100, y: -50 }, 2, 1200, 400), { sx: 50, sy: 25, sw: 600, sh: 200 });
console.log('banner-crop: ok');
