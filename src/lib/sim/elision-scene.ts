import { terrainTiles, terrainAt } from './terrain-shape.ts';
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

/** Вертикальная карточка спрайта с опорой у ног. x/y — левый верх в px мира (y вниз). */
export type ElisionActor = {
  id: string;
  isProp?: boolean;
  opacity?: number;
  pose?: { scaleX: number; scaleY: number; rot: number; sway: number; lift: number };
  x: number;
  y: number;
  w: number;
  h: number;
  /** Высота над землёй, px мира. В сцене это Y, не экранный сдвиг. */
  lift: number;
  url: string;
  /** Decoded animation frame; texture upload is cached per source frame. */
  image?: HTMLCanvasElement;
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
  dayProgress: number;
  jumpTarget: { x: number; y: number; lift: number; ok: boolean } | null;
  /** Коты и камни/деревья. Редактор прячет вид: список может быть пустым. */
  decals: ElisionActor[];
  controlledId: string;
  /** Атлас поверхности: кисть/трава, покрытия, заходы и боевые клетки. */
  paint: HTMLCanvasElement | null;
  /** Растёт, когда пиксели paint сменились (тот же холст могли перерисовать). */
  paintRev: number;
  /** Кусок атласа, тронутый мазком (px атласа). Без поля — полная заливка GPU. */
  paintDirty?: { x: number; y: number; w: number; h: number } | null;
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
): { tops: TerrainPart; walls: TerrainPart; fringe: TerrainPart } {
  const part = (): TerrainPart => ({ positions: [], indices: [], uvs: [], uvs2: [] });
  const tops = part();
  const walls = part();
  const fringe = part();
  const level = (x: number, y: number) =>
    x < 0 || y < 0 || x >= cols || y >= rows ? 0 : terrainAt(elev,x,y);
  const quad = (out: TerrainPart, points: number[][], uv: number[]) => {
    const i = out.positions.length / 3;
    out.positions.push(...points.flat());
    out.indices.push(i, i + 1, i + 2, i, i + 2, i + 3);
    out.uvs.push(...uv);
    out.uvs2.push(0, 0, 1, 0, 1, 1, 0, 1);
  };
  for (const tile of terrainTiles(elev,cols,rows)) {
      const {x:c,y:r,w,d,level:lv}=tile;
      if (!lv) continue;
      const x = c * cellW, z = r * cellH, y = lv * liftStep;
      const cw=w*cellW,ch=d*cellH;
      const u0 = c / cols, u1 = (c + w) / cols, v0 = r / rows, v1 = (r + d) / rows;
      quad(tops, [[x,y,z], [x+cw,y,z], [x+cw,y,z+ch], [x,y,z+ch]],
        [u0,v0, u1,v0, u1,v1, u0,v1]);
      const edges = [
        { dc: 0, dr: -1, a: [x,z], b: [x+cw,z], uv: [u0,v0,u1,v0] },
        { dc: 1, dr: 0, a: [x+cw,z], b: [x+cw,z+ch], uv: [u1,v0,u1,v1] },
        { dc: 0, dr: 1, a: [x+cw,z+ch], b: [x,z+ch], uv: [u1,v1,u0,v1] },
        { dc: -1, dr: 0, a: [x,z+ch], b: [x,z], uv: [u0,v1,u0,v0] },
      ];
      for (const edge of edges) {
        const nb = level((edge.a[0]+edge.b[0])/2/cellW+edge.dc*1e-6, (edge.a[1]+edge.b[1])/2/cellH+edge.dr*1e-6);
        if (nb >= lv) continue;
        const bottom = nb * liftStep;
        const [ax,az] = edge.a, [bx,bz] = edge.b;
        quad(walls, [[ax,bottom,az], [bx,bottom,bz], [bx,y,bz], [ax,y,az]],
          [...edge.uv, edge.uv[2],edge.uv[3], edge.uv[0],edge.uv[1]]);
        // UV2 repeats the stone texture at a fixed world scale, independent
        // of the elevation delta. Neighboring levels no longer stretch it.
        const length = Math.hypot(bx-ax,bz-az), height = y-bottom;
        walls.uvs2.splice(-8,8,(ax+az)/64,bottom/64,(bx+bz)/64,bottom/64,(bx+bz)/64,y/64,(ax+az)/64,y/64);
        // Hanging grass follows only exposed edges; same-level neighbors
        // have no seam. Small teeth are visual only and keep collision exact.
        const segments = Math.max(2, Math.ceil(length / 7));
        const tooth = (n: number) => Math.min(height, 2 + ((Math.round(c*17+r*31)+n*13) % 6));
        for (let i=0;i<segments;i++) {
          const t0=i/segments,t1=(i+1)/segments;
          const x0=ax+(bx-ax)*t0+edge.dc*.4,z0=az+(bz-az)*t0+edge.dr*.4;
          const x1=ax+(bx-ax)*t1+edge.dc*.4,z1=az+(bz-az)*t1+edge.dr*.4;
          const uA=edge.uv[0]+(edge.uv[2]-edge.uv[0])*t0;
          const vA=edge.uv[1]+(edge.uv[3]-edge.uv[1])*t0;
          const uB=edge.uv[0]+(edge.uv[2]-edge.uv[0])*t1;
          const vB=edge.uv[1]+(edge.uv[3]-edge.uv[1])*t1;
          quad(fringe,[[x0,y+.15,z0],[x1,y+.15,z1],[x1,y-tooth(i+1),z1],[x0,y-tooth(i),z0]],
            [uA,vA,uB,vB,uB,vB,uA,vA]);
        }
      }
  }
  return { tops, walls, fringe };
}


/** Спрайт стоит у точки опоры, а не лежит на земле вместе с соседним спрайтом. */
export function elisionActorFoot(actor: ElisionActor) {
  return worldPxToScene(actor.x + actor.w / 2, actor.y + actor.h, actor.lift + 0.2);
}

/** Препятствие перед игроком мягко просвечивает, не меняя коллизий. */
export function elisionObstacleAlpha(actor: ElisionActor, self: ElisionActor | undefined, yaw: number): number {
  if (!actor.isProp || !self || /\/rock-/.test(actor.url)) return 1;
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

/** Общие с 2D параметры пружины: опора не меняется при сжатии и повороте. */
export type ElisionSpace = { holding: boolean; since: number; releaseAt: number; charge: number };
export function elisionSpritePose(now: number, amp: number, h: number, sp?: ElisionSpace) {
  let scaleX = 1, scaleY = 1, rot = 0, sway = 0, lift = 0;
  if (sp?.holding) {
    const p = Math.min(1, Math.max(0, (now - sp.since) / 4000));
    scaleY *= 1 - 0.42*p; scaleX *= 1 + 0.2*p;
    rot += Math.sin(now*0.05)*0.05*p;
    sway = Math.sin(now*0.031)*1.4*p;
  } else if (sp?.releaseAt && now - sp.releaseAt < 1100) {
    const t = Math.max(0, now - sp.releaseAt);
    const q = Math.exp(-t/220)*Math.cos(t*0.042), ch = sp.charge;
    scaleY *= 1 + 0.55*ch*q; scaleX *= 1 - 0.3*ch*q;
    rot += 0.05*ch*q; lift = Math.max(0,h*0.22*ch*q);
  }
  const wob = Math.sin(now*0.045);
  return {scaleX:scaleX*(1+amp*0.22*wob),scaleY:scaleY*(1-amp*0.22*wob),
    rot:rot+amp*0.08*Math.cos(now*0.045),sway,lift};
}

/** Горизонтальная составляющая мирового движения в текущем виде камеры. */
export function elisionScreenX(x: number, y: number, yaw: number) {
  return x*Math.cos(yaw)-y*Math.sin(yaw);
}

/** Цвета заданы в серединах фаз; циклическая интерполяция непрерывна в том числе ночью→утром. */
export function elisionDayTint(progress: number): [number, number, number] {
  if (!Number.isFinite(progress)) progress = 1.5;
  const colors = [[1,0.94,0.82],[1,1,1],[1,0.8,0.66],[0.42,0.5,0.72]];
  const p = ((progress-0.5)%4+4)%4, i = Math.floor(p), t0 = p-i;
  const t = t0*t0*(3-2*t0);
  return colors[i].map((v,c)=>v+(colors[(i+1)%4][c]-v)*t) as [number,number,number];
}

export function elisionRotatedSize(w: number, h: number, yaw: number) {
  const c=Math.abs(Math.cos(yaw)),s=Math.abs(Math.sin(yaw));
  return {w:w*c+h*s,h:w*s+h*c};
}

/** Высота дуги, достаточная для пересечения границ допустимой поверхности.
 * Проверяем обе стороны каждого пересечения сетки, а не только середину полёта.
 * Промежуточные скалы выше старта/посадки не становятся проходимыми от этой поправки. */
export function elisionLeapClearance(
  x0:number,y0:number,x1:number,y1:number,l0:number,l1:number,zH:number,liftStep:number,
  levelAt:(c:number,r:number)=>number,
):number {
  const cuts=[.000001,.5,.999999];
  for(const [a,b] of [[x0,x1],[y0,y1]]) {
    if(Math.abs(b-a)<1e-9) continue;
    for(let n=Math.ceil(Math.min(a,b));n<=Math.floor(Math.max(a,b));n++) {
      const t=(n-a)/(b-a);
      if(t>0&&t<1) cuts.push(Math.max(.000001,t-.000001),Math.min(.999999,t+.000001));
    }
  }
  for(const t of cuts) {
    const floor=levelAt(Math.floor(x0+(x1-x0)*t),Math.floor(y0+(y1-y0)*t))*liftStep;
    if(floor>Math.max(l0,l1)+.001) continue;
    const base=l0+(l1-l0)*t;
    zH=Math.max(zH,(floor-base)/Math.sin(Math.PI*t)+.5);
  }
  return zH;
}
