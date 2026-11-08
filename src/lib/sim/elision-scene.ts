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
 * Камера повторяет `screenToWorld` (`geometry.ts`): ортографический вид под 45°,
 * тот же zoom и yaw. Так курсор на 2D-холсте попадает в ту же точку мира,
 * которую показывает WebGL. Пивные гроты этот вид не считают.
 */

export type ElisionDay = 'morning' | 'day' | 'evening' | 'night';

/** Спрайт на плоскости земли. x/y — левый верх в px мира (y вниз). */
export type ElisionActor = {
  id: string;
  model?: string;
  modelScale?: number;
  heading?: number;
  isProp?: boolean;
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
  /** Высоты клеток из той же карты, что использует ходьба. */
  elev: Record<string, number>;
  terrainLiftStep: number;
  day: ElisionDay;
  /** Коты и камни/деревья. Редактор прячет вид: список может быть пустым. */
  decals: ElisionActor[];
  controlledId: string;
  /** Атлас поверхности: кисть/трава, покрытия, заходы и боевые клетки. */
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

/** Направление экранного верха на плоскости карты = −down (без подъёма). */
export function elisionCameraUp(yaw: number): { x: number; y: number; z: number } {
  const down = elisionCameraDown(yaw);
  return { x: -down.x, y: 0, z: -down.z };
}

/**
 * Грани для наклонной RH-камеры: сжатие вертикали компенсирует наклон,
 * поэтому плоская земля совпадает с screenToWorld, высота сдвигает верх на −lift.
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
  const halfH = (viewH * Math.SQRT1_2) / (2 * z);
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
 * Высота остаётся в lift: наклонная камера проецирует её в тот же сдвиг, что 2D.
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

/** Камера под 45°: плоская земля не сжимается, высота видна как подъём и стена. */
export function elisionCameraPose(camX: number, camY: number, yaw: number, distance: number) {
  return {
    x: camX + Math.sin(yaw) * distance,
    y: distance,
    z: camY + Math.cos(yaw) * distance,
    pitch: -Math.PI / 4,
    yaw,
  };
}

type TerrainPart = { positions: number[]; indices: number[]; uvs: number[]; uvs2: number[] };

/** Геометрия поднятых верхов и только открытых перепадов; UV берутся из общего атласа карты. */
export function elisionTerrainGeometry(
  cols: number, rows: number, cellW: number, cellH: number,
  elev: Record<string, number>, liftStep: number,
): { tops: TerrainPart; walls: TerrainPart } {
  const part = (): TerrainPart => ({ positions: [], indices: [], uvs: [], uvs2: [] });
  const tops = part();
  const walls = part();
  const level = (c: number, r: number) =>
    c < 0 || r < 0 || c >= cols || r >= rows ? 0 : Math.max(0, elev[`${c},${r}`] ?? 0);
  const quad = (out: TerrainPart, points: number[][], uv: number[]) => {
    const i = out.positions.length / 3;
    out.positions.push(...points.flat());
    out.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    out.uvs.push(...uv);
    out.uvs2.push(0, 0, 1, 0, 1, 1, 0, 1);
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lv = level(c, r);
      if (!lv) continue;
      const x = c * cellW, z = r * cellH, y = lv * liftStep;
      const u0 = c / cols, u1 = (c + 1) / cols, v0 = r / rows, v1 = (r + 1) / rows;
      quad(tops, [[x,y,z], [x+cellW,y,z], [x+cellW,y,z+cellH], [x,y,z+cellH]],
        [u0,v0, u1,v0, u1,v1, u0,v1]);
      const edges = [
        { dc: 0, dr: -1, a: [x,z], b: [x+cellW,z], uv: [u0,v0,u1,v0] },
        { dc: 1, dr: 0, a: [x+cellW,z], b: [x+cellW,z+cellH], uv: [u1,v0,u1,v1] },
        { dc: 0, dr: 1, a: [x+cellW,z+cellH], b: [x,z+cellH], uv: [u1,v1,u0,v1] },
        { dc: -1, dr: 0, a: [x,z+cellH], b: [x,z], uv: [u0,v1,u0,v0] },
      ];
      for (const edge of edges) {
        const nb = level(c + edge.dc, r + edge.dr);
        if (nb >= lv) continue;
        const bottom = nb * liftStep;
        const [ax,az] = edge.a, [bx,bz] = edge.b;
        quad(walls, [[ax,bottom,az], [bx,bottom,bz], [bx,y,bz], [ax,y,az]],
          [...edge.uv, edge.uv[2],edge.uv[3], edge.uv[0],edge.uv[1]]);
      }
    }
  }
  return { tops, walls };
}


/** Спрайт стоит у точки опоры, а не лежит на земле вместе с соседним спрайтом. */
export function elisionActorFoot(actor: ElisionActor) {
  return worldPxToScene(actor.x + actor.w / 2, actor.y + actor.h, actor.lift + 0.2);
}

/** Препятствие перед игроком мягко просвечивает, не меняя коллизий. */
export function elisionObstacleAlpha(actor: ElisionActor, self: ElisionActor | undefined, yaw: number): number {
  if (!actor.isProp || !self) return 1;
  const rect = (item: ElisionActor) => {
    const foot = elisionActorFoot(item);
    const x = foot.x * Math.cos(yaw) - foot.z * Math.sin(yaw);
    const y = foot.x * Math.sin(yaw) + foot.z * Math.cos(yaw) - foot.y;
    return { x: x - item.w/2, y: y - item.h, w: item.w, h: item.h, footY: y };
  };
  const a = rect(actor), b = rect(self);
  if (a.footY < b.footY - 1) return 1;
  const width = Math.max(0, Math.min(a.x+a.w, b.x+b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y+a.h, b.y+b.h) - Math.max(a.y, b.y));
  return width * height > b.w * b.h * 0.18 ? 0.38 : 1;
}

/** Постоянный малый bias разруливает точное совпадение плоскостей, без прыжков сортировки. */
export function elisionDepthBias(id: string): number {
  let hash = 0;
  for (const letter of id) hash = (hash * 31 + letter.charCodeAt(0)) >>> 0;
  return -(1 + hash % 997) / 1000;
}


/**
 * Вершины карточки относительно ног: XY — картинка, Z — направление к камере.
 * Поворот старого спрайта может опустить угол ниже ног. Поднимаем такой угол
 * вдоль луча камеры (Y и Z одинаково), сохраняя экранную проекцию Z−Y.
 * Поэтому повёрнутый камень не режется грунтом и не теряет прежний угол.
 */
export function elisionSpriteVertices(w: number, h: number, rot: number, mirror: boolean): number[] {
  const angle = -rot * Math.PI/180;
  const c = Math.cos(angle), s = Math.sin(angle);
  return [[-w/2,0], [w/2,0], [w/2,h], [-w/2,h]].flatMap(([px, py]) => {
    const x = px * (mirror ? -1 : 1);
    const rx = x*c - py*s, ry = x*s + py*c;
    return [rx, Math.max(0, ry), Math.max(0, -ry)];
  });
}
