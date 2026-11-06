// @ts-nocheck
// Правила высоты: шаг при перепаде ≤1, прыжок по доле шкалы.
// Запуск — через npm run test:unit (node --experimental-strip-types).
import {
  elevJumpOk,
  elevStepOk,
  jumpFillOf,
  pointInSouthWallOf,
  surfaceLevelOf,
  TERRAIN_LIFT_CELLS,
  TERRAIN_MAX_LEVEL,
} from "../src/lib/sim/test-map.ts";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

assert(TERRAIN_MAX_LEVEL === 10, "десять уровней над землёй");
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
