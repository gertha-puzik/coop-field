/**
 * Чистая геометрия вида Элизии. Сюда не импортируется Babylon: юнит-тест и
 * сборщик кадра живут без WebGL, а сам движок подгружается отдельно
 * (`elision-babylon.ts`) и пользуется только этими формулами.
 *
 * Координаты. Сеть — 1-based, канвас — 0-based (`col = x - 1`). К этому модулю
 * числа уже приходят как px мира канваса: x вправо, y вниз, без клетки «+1».
 * Единственный перевод в сцену — `worldPxToScene`: (x, подъём, z = y), ось Y
 * сцены вверх. Второго сдвига здесь нет.
 *
 * Камера повторяет `screenToWorld` (`geometry.ts`): ортографический вид сверху,
 * тот же zoom и yaw. Так курсор на 2D-холсте попадает в ту же точку мира,
 * которую показывает WebGL. Пивные гроты этот вид не считают.
 */

export type ElisionDay = 'morning' | 'day' | 'evening' | 'night';

/** Спрайт на плоскости земли. x/y — левый верх в px мира (y вниз). */
export type ElisionActor = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Высота над землёй, px мира. В сцене это Y, не экранный сдвиг. */
  lift: number;
  url: string;
  /** Отразить по горизонтали (мирный бег лицом вправо). */
  mirror: boolean;
  /** Поворот декали вокруг вертикали, градусы. */
  rot: number;
};

export type ElisionFrame = {
  camX: number;
  camY: number;
  /** Радианы, как `camYawRef` / `screenToWorld`. */
  yaw: number;
  zoom: number;
  viewW: number;
  viewH: number;
  cellW: number;
  cellH: number;
  cols: number;
  rows: number;
  editor: boolean;
  day: ElisionDay;
  /** Коты и камни/деревья. Редактор прячет вид: список может быть пустым. */
  decals: ElisionActor[];
  /** Рисунок кисти либо запасной холст острова. null — заливка цветом. */
  paint: HTMLCanvasElement | null;
  /** Растёт, когда пиксели paint сменились (тот же холст могли перерисовать). */
  paintRev: number;
};

export interface ElisionView {
  /** 'webgl1' | 'webgl2'. WebGPU сюда не попадает: вид создаёт Engine, не WebGPUEngine. */
  readonly webgl: 'webgl1' | 'webgl2';
  /** paint — земля из рисунка кисти; flat — заливки, рисунка ещё нет; unread — пиксели не прочитались. */
  readonly ground: 'boot' | 'flat' | 'paint' | 'unread';
  frame(frame: ElisionFrame): void;
  destroy(): void;
}

/** px мира канваса (y вниз) → сцена Babylon (Y вверх). lift — высота, не строка сетки. */
export function worldPxToScene(x: number, y: number, lift: number): { x: number; y: number; z: number } {
  return { x, y: lift, z: y };
}

/**
 * Куда смотрит «низ экрана» в плоскости XZ при данном yaw.
 * Совпадает с screenToWorld: dx вдоль right, dy вдоль down.
 */
export function elisionCameraRight(yaw: number): { x: number; z: number } {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}

export function elisionCameraDown(yaw: number): { x: number; z: number } {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}

/** Вектор up ортокамеры: экранный верх = −down. Y сцены не участвует. */
export function elisionCameraUp(yaw: number): { x: number; y: number; z: number } {
  const down = elisionCameraDown(yaw);
  return { x: -down.x, y: 0, z: -down.z };
}

/**
 * Обычные грани ортопроекции для правой системы координат Babylon.
 * Отражённая проекция (left > right) инвертирует также плоскости frustum:
 * видимые декали отсекаются, хотя большая земля ещё попадает в кадр.
 */
export function elisionOrtho(
  viewW: number,
  viewH: number,
  zoom: number,
): { left: number; right: number; bottom: number; top: number } {
  const z = Math.max(0.05, zoom);
  const halfW = viewW / (2 * z);
  const halfH = viewH / (2 * z);
  return { left: -halfW, right: halfW, bottom: -halfH, top: halfH };
}

export type SelfLeap = {
  battle: boolean;
  t0: number;
  dur: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  l0: number;
  l1: number;
};

export type SelfBody = {
  fx: number;
  fy: number;
  col: number;
  row: number;
  liftV: number;
  leapZ: number;
  leap: SelfLeap | null;
};

/**
 * Левый верх своего кота в px мира. Мирный режим — fx/fy (их уже ведёт update,
 * в том числе на дуге прыжка). Боевой прыжок — лерп пикселей, как selfDraw.
 * Сдвига «поднятой земли» на экран здесь нет: высота остаётся в lift.
 */
export function selfWorldPx(
  e: SelfBody,
  cellW: number,
  cellH: number,
  peace: boolean,
  now: number,
): { x: number; y: number; lift: number } {
  if (!peace && e.leap?.battle) {
    const dur = e.leap.dur > 0 ? e.leap.dur : 1;
    const t = Math.min(1, Math.max(0, (now - e.leap.t0) / dur));
    return {
      x: e.leap.x0 + (e.leap.x1 - e.leap.x0) * t,
      y: e.leap.y0 + (e.leap.y1 - e.leap.y0) * t,
      lift: e.leap.l0 + (e.leap.l1 - e.leap.l0) * t + e.leapZ,
    };
  }
  if (peace) return { x: e.fx * cellW, y: e.fy * cellH, lift: e.liftV + e.leapZ };
  return { x: e.col * cellW, y: e.row * cellH, lift: e.liftV };
}

/** Габарит модельки: как spriteBoxOf, без привязки к SimSettings. */
export function spriteSizePx(cellH: number, scalePct: number, aspect: number): { w: number; h: number } {
  const h = Math.max(1, (cellH - 10) * (scalePct / 100));
  const a = aspect > 0 ? aspect : 2 / 3;
  return { w: h * a, h };
}
