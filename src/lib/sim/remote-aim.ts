/** Те же формулы, что wrap360 / wrap180 в settings.ts. Модуль без импортов, чтобы его гонял node. */
function wrap360(a: number): number {
  return ((a % 360) + 360) % 360;
}

function wrap180(a: number): number {
  const x = wrap360(a);
  return x > 180 ? x - 360 : x;
}

/**
 * Сетевой угол чужой стрелы и то, что рисуем между пакетами.
 * target — последний пришедший угол. display — угол кадра.
 * vel — °/мс по кратчайшей дуге между двумя последними разными сэмплами.
 */
export interface RemoteAim {
  target: number;
  display: number;
  prevDeg: number;
  prevAt: number;
  vel: number;
}

/** Ошибка больше этого — прыжок (вход в комнату или телепорт угла). */
export const AIM_SNAP_DEG = 40;
/** На сколько мс вперёд можно дорисовать скорость, пока пакет свежий. */
const AIM_EXTRAP_MS = 48;
/** Потолок этой дорисовки, чтобы стрела не убегала, когда пакеты кончились. */
const AIM_EXTRAP_MAX_DEG = 6;
/** После этого возраста сэмпла предсказание затухает до нуля и стрела садится на target. */
const AIM_STALE_MS = 100;
/** Постоянная сглаживания кадра к цели, мс. */
const AIM_EASE_MS = 28;
/** Потолок скорости: быстрее самого быстрого удержания J/L (200°/с), но не бесконечность. */
const AIM_VEL_MAX = 0.5;

export function createRemoteAim(angle: number, now: number): RemoteAim {
  const deg = wrap360(angle);
  return { target: deg, display: deg, prevDeg: deg, prevAt: now, vel: 0 };
}

/**
 * Новый сэмпл. snap — игрок только что появился: рисуем угол сразу.
 * Иначе перенацеливаем и берём скорость по кратчайшей дуге; скачок > 40° тоже сразу.
 */
export function noteRemoteAim(aim: RemoteAim | undefined, angle: number, now: number, snap: boolean): RemoteAim {
  const deg = wrap360(angle);
  if (!aim || snap) return createRemoteAim(deg, now);
  if (Math.abs(wrap180(deg - aim.target)) < 0.05) {
    aim.vel = 0;
    aim.prevDeg = deg;
    aim.prevAt = now;
    aim.target = deg;
    return aim;
  }
  const dt = now - aim.prevAt;
  if (dt >= 8 && dt <= 220) {
    let vel = wrap180(deg - aim.prevDeg) / dt;
    if (vel > AIM_VEL_MAX) vel = AIM_VEL_MAX;
    else if (vel < -AIM_VEL_MAX) vel = -AIM_VEL_MAX;
    aim.vel = vel;
  } else if (dt > 220) {
    aim.vel = 0;
  }
  aim.prevDeg = deg;
  aim.prevAt = now;
  aim.target = deg;
  if (Math.abs(wrap180(deg - aim.display)) > AIM_SNAP_DEG) {
    aim.display = deg;
    aim.vel = 0;
  }
  return aim;
}

/** Один кадр: кратчайшая дуга к слегка упреждённой цели. Упреждение гаснет, когда сэмпл стареет. */
export function stepRemoteAim(aim: RemoteAim, now: number, dt: number): void {
  if (!(dt > 0)) return;
  const age = Math.max(0, now - aim.prevAt);
  const predictMs = Math.min(age, AIM_EXTRAP_MS);
  const fade = age >= AIM_STALE_MS ? 0 : 1 - age / AIM_STALE_MS;
  let extra = aim.vel * predictMs * fade;
  if (extra > AIM_EXTRAP_MAX_DEG) extra = AIM_EXTRAP_MAX_DEG;
  else if (extra < -AIM_EXTRAP_MAX_DEG) extra = -AIM_EXTRAP_MAX_DEG;
  const goal = wrap360(aim.target + extra);
  const err = wrap180(goal - aim.display);
  if (Math.abs(err) > AIM_SNAP_DEG) {
    aim.display = goal;
    return;
  }
  const alpha = 1 - Math.exp(-dt / AIM_EASE_MS);
  aim.display = wrap360(aim.display + err * alpha);
}
