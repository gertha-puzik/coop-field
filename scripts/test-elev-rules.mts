// @ts-nocheck
// Правила высоты: шаг при перепаде ≤1, прыжок по доле шкалы.
// Запуск — через npm run test:unit (node --experimental-strip-types).
import {
  objectSprite, sanitizeTestMap, TEST_MAP_DEFAULT,
  elevJumpOk,
  elevStepOk,
  terrainBodyOverlap,
  contactFraction,
  jumpFillOf,
  pointInSouthWallOf,
  surfaceLevelOf,
  TERRAIN_LIFT_CELLS,
  TERRAIN_MAX_LEVEL,
} from "../src/lib/sim/test-map.ts";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

assert(TERRAIN_MAX_LEVEL === 20, "двадцать уровней над землёй");
assert(elevStepOk(0, 1) && elevStepOk(4, 3) && elevStepOk(2, 2), "шаг на 1 и по ровному");
assert(!elevStepOk(0, 2) && !elevStepOk(5, 3), "перепад 2 шагом нельзя");

assert(elevJumpOk(0, 1, 0), "перепад 1 прыжком даже с тапа");
assert(!elevJumpOk(0, 2, 0.49), "перепад 2 ниже половины шкалы");
assert(elevJumpOk(0, 2, 0.5) && elevJumpOk(3, 1, 0.5), "перепад 2 с половины, вверх и вниз");
assert(!elevJumpOk(0, 3, 0.5), "перепад 3 половиной нельзя");
assert(elevJumpOk(0, 3, 1) && elevJumpOk(3, 0, 1), "перепад 3 только полной шкалой");
assert(!elevJumpOk(0, 4, 1) && !elevJumpOk(2, 6, 1), "вверх на 4+ нельзя");
assert(elevJumpOk(8, 0, 1) && !elevJumpOk(8, 0, 0.5), "вниз на 4+ — только полная шкала");
assert(jumpFillOf(0.15) === 0, "тап — пустая шкала");
assert(Math.abs(jumpFillOf(0.15 + 0.85 * 0.5) - 0.5) < 1e-9, "половина заряда приседа — середина шкалы");
assert(jumpFillOf(1) === 1, "полный присед — полная шкала");

const cols = 6;
const rows = 6;
const elev = new Map([["2,3", 6]]);
const levelAt = (c, r) => elev.get(`${c},${r}`) ?? 0;
const lift = 6 * TERRAIN_LIFT_CELLS;
assert(Math.abs(lift - 6 * 26 / 150) < 1e-9, "подъём уровня — 26px клетки 150px");
assert(surfaceLevelOf(2.5, 3 - lift + 0.2, cols, rows, levelAt) === 6, "спина плато — это его верх");
assert(surfaceLevelOf(2.5, 2.5, cols, rows, levelAt) === 6, "нарисованный верх закрывает северную клетку");
assert(surfaceLevelOf(2.5, 1.5, cols, rows, levelAt) === 0, "трава севернее нарисованного верха — земля");
assert(surfaceLevelOf(1.5, 3.5, cols, rows, levelAt) === 0, "клетка сбоку от плато не становится стеной");
assert(pointInSouthWallOf(2.5, 3.5, cols, rows, levelAt), "южная стена плато непроходима");
assert(!pointInSouthWallOf(3.5, 3.5, cols, rows, levelAt), "восток от плато — не его стена");
const step = new Map([["2,3", 1]]);
const stepAt = (c, r) => step.get(`${c},${r}`) ?? 0;
assert(!pointInSouthWallOf(2.5, 3.9, cols, rows, stepAt), "перепад в 1 — ступенька, не стена");

console.log("elev rules: ok");

const retiredTreeMap = structuredClone(TEST_MAP_DEFAULT);
retiredTreeMap.objects = [{id:'retired-tree',kind:'tree',spr:'tree3d-200',c:2,r:2,x:2.5,y:3,s:1.2,rot:37,mir:1}];
const restoredTree = sanitizeTestMap(retiredTreeMap).map?.objects?.[0];
assert(restoredTree?.spr === 'tree-1', 'снятая модель становится обычным деревом');
assert(restoredTree?.x === 2.5 && restoredTree?.y === 3 && restoredTree?.s === 1.2 && restoredTree?.rot === 37, 'дерево сохраняет позицию и трансформации');
assert(objectSprite({kind:'tree',spr:'tree3d-001'}) === 'tree-1', 'сырой старый ID также имеет видимый fallback');

const customTreeMap = structuredClone(TEST_MAP_DEFAULT);
customTreeMap.objects = [
  { id: 'pine', kind: 'tree', spr: 'x-sosna-test', c: 2, r: 2, x: 2.5, y: 2.8, s: 1, rot: 0 },
  { id: 'cover', kind: 'ground', cv: 'x-my-grass', c: 3, r: 3 },
];
const customKept = sanitizeTestMap(customTreeMap).map;
assert(customKept?.objects?.find((o) => o.kind === 'tree')?.spr === 'x-sosna-test', 'кастомный x-* spr переживает клиентский sanitize без каталога');
assert(customKept?.objects?.find((o) => o.kind === 'ground')?.cv === 'x-my-grass', 'кастомный x-* cover переживает клиентский sanitize');

const highAt=(c:number,r:number)=>c===4&&r===3?2:0;
const rx=.28,ry=28/150;
for(const [x,y] of [[3.72,3.5],[5.28,3.5],[4.5,3-ry],[4.5,4+ry]])
  assert(terrainBodyOverlap(x,y,rx,ry,0,highAt)<1e-7,'тело касается стены, лапы остаются снаружи');
for(const [x,y] of [[3.74,3.5],[5.26,3.5],[4.5,3-ry+.02],[4.5,4+ry-.02]])
  assert(terrainBodyOverlap(x,y,rx,ry,0,highAt)>0,'корпус не проходит внутрь стены ни с одной стороны');
assert(terrainBodyOverlap(3.99,3.5,rx,ry,0,(c,r)=>c===4&&r===3?1:0)===0,'один уровень по-прежнему перешагивается');
assert(terrainBodyOverlap(4.5,3.5,rx,ry,2,highAt)===0,'на плато тело помещается');
assert(terrainBodyOverlap(4.02,3.5,rx,ry,2,highAt)>0,'край плато удерживает тело, а не одну точку');
assert(terrainBodyOverlap(3.8,2.8,rx,ry,0,highAt)===0,'скруглённое тело не цепляет дальний диагональный угол');

const touch=contactFraction(t=>t>.3723);
assert(touch<=.3723&&.3723-touch<.001,'шаг доводится до касания без просвета размером в кадр');
assert(contactFraction(()=>false)===1,'свободный шаг проходит целиком');
assert(contactFraction(()=>true)===0,'прижатое тело не углубляется в стену');
