// @ts-nocheck
// Правила высоты: шаг при перепаде ≤1, прыжок по доле шкалы.
// Запуск — через npm run test:unit (node --experimental-strip-types).
import { elevJumpOk, elevStepOk, jumpFillOf, TERRAIN_MAX_LEVEL } from "../src/lib/sim/test-map.ts";

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

console.log("elev rules: ok");
