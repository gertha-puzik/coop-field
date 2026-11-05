/**
 * Sprint dust particles: a com-of-earth/grass mote thrown from under the paws
 * while the cat sprints in peace mode — type, spawn cadence and palettes only.
 * Carved verbatim from the simulator.tsx module belt (W5a stage 1,
 * behavior-preserving).
 *
 * Consumers: simulator.tsx keeps the particle references (sprintPartsRef,
 * sprintAccRef) and the rAF update/draw of the particles — physics stepping and
 * rendering intentionally stay in the component this stage.
 */

/** Темп появления частиц спринта: один комочек каждые столько мс бега. */
export const SPRINT_SPAWN_MS = 26;
/** Гравитация частиц спринта, px мира / с²: взлетев — падают обратно в траву. */
export const SPRINT_GRAVITY = 520;
/** Палитры частиц спринта: комочки земли и клочки травы. */
export const SPRINT_DIRT = ['#5b4632', '#6d5740', '#7e684b', '#4e3d2b'];
export const SPRINT_GRASS = ['#3f6d2a', '#4d7f33', '#5b913d', '#356023'];

/** Частица спринта: комочек земли/травы, вылетающий из-под лап. x/y — точка
 *  на грунте (px мира), z — высота над землёй; vz тянется вниз гравитацией,
 *  приземлившаяся или отжившая частица убирается. */
export type SprintPart = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  ttl: number;
  size: number;
  col: string;
};

/** Новый комочек из-под лап: летит против направления бега веером вверх. */
export function spawnSprintPart(arr: SprintPart[], fxPx: number, fyPx: number, bx: number, by: number) {
  const dirt = Math.random() < 0.55;
  const pal = dirt ? SPRINT_DIRT : SPRINT_GRASS;
  const back = 36 + Math.random() * 84;
  const side = (Math.random() - 0.5) * 64;
  arr.push({
    x: fxPx + (Math.random() - 0.5) * 10,
    y: fyPx + (Math.random() - 0.5) * 6,
    z: 2 + Math.random() * 4,
    vx: -bx * back + side * -by,
    vy: -by * back + side * bx,
    vz: 95 + Math.random() * 150,
    life: 0,
    ttl: 300 + Math.random() * 320,
    size: 2 + Math.random() * 2.5,
    col: pal[(Math.random() * pal.length) | 0],
  });
  if (arr.length > 90) arr.splice(0, arr.length - 90); // страховка от переполнения
}
