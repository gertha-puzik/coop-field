// @ts-nocheck
// Тропинка: маска клеток, детерминированный контур (Чайкин + дрожь), травинки.
// path-field тянет ./textures без расширения — нужен unit-ts-loader.
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./unit-ts-loader.mjs', import.meta.url));

const {
  buildPathLoops,
  buildPathTufts,
  pathCellsOf,
} = await import('../src/lib/sim/path-field.ts');
const { sanitizeTestMap } = await import('../src/lib/sim/test-map.ts');

const cells = pathCellsOf([
  { id: 'a', kind: 'path', c: 2, r: 3, pos: 'center' },
  { id: 'b', kind: 'dirt', c: 1, r: 1, pos: 'center' },
  { id: 'c', kind: 'path', c: 3, r: 3, pos: 'center' },
]);
assert.equal(cells.size, 2);
assert.ok(cells.has('2,3') && cells.has('3,3'));

const empty = buildPathLoops(new Set(), 10, 7, 'seed');
assert.equal(empty.length, 0, 'пустая маска → нет петель');

const line = new Set(['4,4', '5,4', '6,4']);
const loopsA = buildPathLoops(line, 12, 10, 'room-a');
const loopsB = buildPathLoops(line, 12, 10, 'room-a');
assert.ok(loopsA.length >= 1, 'линейка клеток даёт контур');
assert.equal(JSON.stringify(loopsA), JSON.stringify(loopsB), 'один сид → тот же контур');

const loopsOther = buildPathLoops(line, 12, 10, 'room-b');
assert.notEqual(JSON.stringify(loopsA), JSON.stringify(loopsOther), 'другой сид → другая дрожь');

const tufts = buildPathTufts(loopsA, 'room-a', 100, 150);
assert.ok(tufts.length > 0, 'по краю сеются травинки');
assert.ok(tufts.every((t) => t.kind >= 0 && t.kind <= 2), 'только tuft 0–2');

// Клиентский sanitize принимает kind path и не выкидывает его при paint.
// Длина кратна 4 — иначе paintFormatError режет «не base64».
const fakePng = 'iVBORw0KGgoA';
const withPaint = sanitizeTestMap({
  v: 2,
  cols: 10,
  rows: 6,
  seed: 's',
  zones: [{ id: 'g', kind: 'green', c0: 0, r0: 0, c1: 9, r1: 5 }],
  objects: [
    { id: 'p1', kind: 'path', c: 2, r: 2, pos: 'center' },
    { id: 'd1', kind: 'dirt', c: 3, r: 2, pos: 'center' },
    { id: 'g1', kind: 'ground', c: 4, r: 2, pos: 'center', cv: 'flower-1' },
  ],
  paint: fakePng,
});
assert.equal(withPaint.error, undefined, withPaint.error);
const kinds = (withPaint.map?.objects ?? []).map((o) => o.kind).sort();
assert.deepEqual(kinds, ['path'], 'при paint остаются только path (dirt/ground запекаются)');

// Серверное зеркало (без paint — сервер ещё и декодирует PNG)
const serverMap = await import('../server/testmap.js');
const srv = serverMap.sanitizeTestMap({
  v: 2,
  cols: 10,
  rows: 6,
  seed: 's',
  zones: [{ id: 'g', kind: 'green', c0: 0, r0: 0, c1: 9, r1: 5 }],
  objects: [
    { id: 'p1', kind: 'path', c: 2, r: 2, pos: 'center' },
    { id: 'd1', kind: 'dirt', c: 3, r: 2, pos: 'center' },
  ],
});
assert.equal(srv.error, undefined, srv.error);
assert.deepEqual(
  (srv.map?.objects ?? []).map((o) => o.kind).sort(),
  ['dirt', 'path'],
  'сервер принимает path рядом с dirt',
);

console.log('path-field: ok');
