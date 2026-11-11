// @ts-nocheck
// Кэш пропорций спрайтов + clamp роста с провода. Без DOM/Babylon.
import assert from 'node:assert/strict';
import {
  catScaleOf,
  clearSpriteAspectsForTests,
  rememberSpriteAspect,
  spriteAspectOf,
} from '../src/lib/sim/sprite-aspect.ts';
import { spriteSizePx } from '../src/lib/sim/elision-scene.ts';

clearSpriteAspectsForTests();
assert.equal(spriteAspectOf('missing'), 2 / 3, 'пустой кэш → портретный дефолт');

// Ландшафтный окрас: без img билборд раньше садился в 2/3 и тянул текстуру.
rememberSpriteAspect('mine-coat', 600, 400);
assert.equal(spriteAspectOf('mine-coat'), 1.5, 'кэш по id');
const sized = spriteSizePx(150, 67, spriteAspectOf('mine-coat'));
assert.equal(sized.h, (150 - 10) * 0.67, 'рост 67% от высоты клетки');
assert.equal(sized.w, sized.h * 1.5, 'ширина из кэшированного aspect, не 2/3');

rememberSpriteAspect('/sprites/file/mine-coat.png', 300, 200);
assert.equal(spriteAspectOf('other', null, '/sprites/file/mine-coat.png'), 1.5, 'кэш по URL текстуры');

// Живой img обновляет кэш и побеждает устаревшее значение.
assert.equal(spriteAspectOf('mine-coat', { width: 363, height: 229 }), 363 / 229, 'img приоритетнее кэша');
assert.equal(spriteAspectOf('mine-coat'), 363 / 229, 'кэш обновился от img');

assert.equal(catScaleOf(67), 67);
assert.equal(catScaleOf(3.2), 100, 'легаси size → 100');
assert.equal(catScaleOf(undefined), 100);
assert.equal(catScaleOf(59), 100);
assert.equal(catScaleOf(101), 100);
assert.equal(catScaleOf('80'), 80);

clearSpriteAspectsForTests();
console.log('sprite-aspect: ok');
