/**
 * Кадр Элизии для WebGL-вида: собирает то, что 2D-цикл уже посчитал
 * (камера, свой кот, чужие, камни и деревья), без второго перевода
 * сетевых координат. Клетки здесь 0-based, px мира — col/fx × размер клетки.
 * Babylon подключается отдельно и этот модуль не импортирует.
 */
import type { DummyConfig, SpriteId } from '@/lib/sim/settings';
import { RAB_SPRITE, SPRITES } from '@/lib/sim/settings';
import { dummyIsDrawn } from '@/lib/sim/targeting';
import { currentTestMap, elevLevelAt, paintCanvas, TERRAIN_LIFT_PX, testFieldGeometry } from '@/lib/sim/test-field';
import { grassPattern } from '@/lib/sim/textures';
import {
  OBJECT_DIMS,
  objectBase,
  objectMir,
  objectRotDeg,
  objectScale,
  objectSprite,
  type TestMapObject,
} from '@/lib/sim/test-map';
import type { Engine } from './sim-model';
import {
  selfWorldPx,
  spriteSizePx,
  type ElisionActor,
  type ElisionDay,
  type ElisionFrame,
} from '@/lib/sim/elision-scene';

type SpriteImg = { width: number; height: number };

export type ElisionPresentInput = {
  now: number;
  editor: boolean;
  day: ElisionDay;
  camX: number;
  camY: number;
  yaw: number;
  zoom: number;
  viewW: number;
  viewH: number;
  cols: number;
  rows: number;
  cellW: number;
  cellH: number;
  peace: boolean;
  engine: Engine;
  controlled: string;
  selfSprite: SpriteId;
  selfScale: number;
  mainSprite: SpriteId;
  mainScale: number;
  mainAt: { col: number; row: number } | null;
  remotes: DummyConfig[];
  remoteFree: Map<string, { x: number; y: number; face?: 1 | -1; jpUntil?: number }>;
  remoteDraw: Map<string, { col: number; row: number }>;
  drag: { key: string; x: number; y: number; w: number; h: number } | null;
  spriteImage: (id: string) => SpriteImg | undefined;
  objects: TestMapObject[];
  rab: { col: number; row: number; scale: number } | null;
};

function spriteUrl(id: string): string {
  if (id === RAB_SPRITE.id) return RAB_SPRITE.src;
  return SPRITES.find((s) => s.id === id)?.src ?? SPRITES[0]?.src ?? '';
}

function aspectOf(img: SpriteImg | undefined): number {
  return img && img.height > 0 ? img.width / img.height : 2 / 3;
}

function remoteHop(jpUntil: number | undefined, now: number): number {
  if (!jpUntil || jpUntil <= now) return 0;
  const t = 1 - (jpUntil - now) / 430;
  return Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * TERRAIN_LIFT_PX;
}

let islandCv: HTMLCanvasElement | null = null;
let islandKey = '';
let islandReady = false;
let paintRev = 0;
let paintSeen: HTMLCanvasElement | null = null;
let mapSeen: ReturnType<typeof currentTestMap> | null = null;

/** Нет рисунка кисти — остров травы на прозрачном холсте, как 2D-заливка geo.path. */
function islandPaint(cols: number, rows: number, cellW: number, cellH: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const key = `${cols}x${rows}@${cellW}x${cellH}`;
  const w = Math.max(1, Math.round(cols * cellW));
  const h = Math.max(1, Math.round(rows * cellH));
  if (!islandCv || islandCv.width !== w || islandCv.height !== h) {
    islandCv = document.createElement('canvas');
    islandCv.width = w;
    islandCv.height = h;
    islandKey = '';
    islandReady = false;
  }
  if (islandKey === key && islandReady) return islandCv;
  const g = islandCv.getContext('2d');
  if (!g) return islandCv;
  g.clearRect(0, 0, w, h);
  g.imageSmoothingEnabled = false;
  const geo = testFieldGeometry(cellW, cellH);
  const pat = grassPattern(g);
  g.fillStyle = pat ?? '#2a461c';
  g.fill(geo.path);
  g.save();
  g.clip(geo.path);
  const elev = currentTestMap().elev ?? {};
  for (const cell of Object.keys(elev)) {
    const lv = elev[cell];
    if (!lv) continue;
    const [c, r] = cell.split(',').map(Number);
    if (!Number.isFinite(c) || !Number.isFinite(r)) continue;
    g.fillStyle = `rgba(232, 214, 150, ${Math.min(0.28, 0.06 + lv * 0.03)})`;
    g.fillRect(c * cellW, r * cellH, cellW, cellH);
  }
  g.restore();
  const becameReady = !!pat && !islandReady;
  islandReady = !!pat;
  if (islandKey !== key || becameReady) paintRev += 1;
  islandKey = key;
  return islandCv;
}

function framePaint(cols: number, rows: number, cellW: number, cellH: number): { paint: HTMLCanvasElement | null; paintRev: number } {
  const map = currentTestMap();
  if (mapSeen !== map) {
    mapSeen = map;
    islandKey = '';
    islandReady = false;
    paintSeen = null;
    paintRev += 1;
  }
  const real = paintCanvas();
  if (real) {
    if (paintSeen !== real) {
      paintSeen = real;
      paintRev += 1;
    }
    return { paint: real, paintRev };
  }
  paintSeen = null;
  return { paint: islandPaint(cols, rows, cellW, cellH), paintRev };
}

function pushActor(out: ElisionActor[], actor: ElisionActor | null) {
  if (actor && actor.url && actor.w >= 1 && actor.h >= 1) out.push(actor);
}

/** Левый верх кота. drag — уже px мира (верх спрайта), как в 2D. */
function catActor(
  id: string,
  sprite: string,
  scale: number,
  topLeft: { x: number; y: number },
  lift: number,
  mirror: boolean,
  input: ElisionPresentInput,
  dragBox: boolean,
): ElisionActor | null {
  const drag = input.drag;
  if (drag && drag.key === id) {
    return {
      id,
      x: drag.x,
      y: drag.y,
      w: dragBox ? drag.w : spriteSizePx(input.cellH, scale, aspectOf(input.spriteImage(sprite))).w,
      h: dragBox ? drag.h : spriteSizePx(input.cellH, scale, aspectOf(input.spriteImage(sprite))).h,
      lift,
      url: spriteUrl(sprite),
      mirror,
      rot: 0,
    };
  }
  const size = spriteSizePx(input.cellH, scale, aspectOf(input.spriteImage(sprite)));
  return {
    id,
    x: topLeft.x,
    y: topLeft.y,
    w: size.w,
    h: size.h,
    lift,
    url: spriteUrl(sprite),
    mirror,
    rot: 0,
  };
}

function propActor(o: TestMapObject, cellW: number, cellH: number): ElisionActor | null {
  if (o.kind !== 'stone' && o.kind !== 'tree') return null;
  const spr = objectSprite(o);
  const dims = OBJECT_DIMS[spr] ?? [57, 42];
  const sc = objectScale(o);
  const w = dims[0] * sc;
  const h = dims[1] * sc;
  const base = objectBase(o);
  const footX = base.x * cellW;
  const footY = base.y * cellH;
  return {
    id: `prop:${o.id}`,
    x: footX - w / 2,
    y: footY - h,
    w,
    h,
    lift: elevLevelAt(o.c, o.r) * TERRAIN_LIFT_PX,
    url: `/tex/${spr}.png`,
    mirror: objectMir(o) === 1,
    rot: objectRotDeg(o),
  };
}

export function collectElisionFrame(input: ElisionPresentInput): ElisionFrame {
  const decals: ElisionActor[] = [];
  if (!input.editor) {
    const self = selfWorldPx(input.engine, input.cellW, input.cellH, input.peace, input.now);
    pushActor(
      decals,
      catActor(
        input.controlled,
        input.selfSprite,
        input.selfScale,
        self,
        self.lift,
        input.peace && input.engine.face === 1,
        input,
        true,
      ),
    );
    if (input.controlled !== 'main' && input.mainAt) {
      pushActor(
        decals,
        catActor(
          'main',
          input.mainSprite,
          input.mainScale,
          { x: input.mainAt.col * input.cellW, y: input.mainAt.row * input.cellH },
          elevLevelAt(input.mainAt.col, input.mainAt.row) * TERRAIN_LIFT_PX,
          false,
          input,
          true,
        ),
      );
    }
    for (const remote of input.remotes) {
      if (remote.id === input.controlled) continue;
      if (!dummyIsDrawn(remote, input.controlled)) continue;
      const free = input.remoteFree.get(remote.id);
      const vis = input.remoteDraw.get(remote.id);
      const col = vis?.col ?? remote.col;
      const row = vis?.row ?? remote.row;
      const top = free
        ? { x: free.x * input.cellW, y: free.y * input.cellH }
        : { x: col * input.cellW, y: row * input.cellH };
      const lift = elevLevelAt(Math.floor(col), Math.floor(row)) * TERRAIN_LIFT_PX + remoteHop(free?.jpUntil, input.now);
      pushActor(
        decals,
        catActor(remote.id, remote.sprite, remote.scale, top, lift, free?.face === 1, input, true),
      );
    }
    if (input.rab) {
      pushActor(
        decals,
        catActor(
          'rab',
          RAB_SPRITE.id,
          input.rab.scale,
          { x: input.rab.col * input.cellW, y: input.rab.row * input.cellH },
          elevLevelAt(input.rab.col, input.rab.row) * TERRAIN_LIFT_PX,
          false,
          input,
          false,
        ),
      );
    }
    for (const object of input.objects) pushActor(decals, propActor(object, input.cellW, input.cellH));
  }
  const painted = framePaint(input.cols, input.rows, input.cellW, input.cellH);
  return {
    camX: input.camX,
    camY: input.camY,
    yaw: input.yaw,
    zoom: input.zoom,
    viewW: input.viewW,
    viewH: input.viewH,
    cellW: input.cellW,
    cellH: input.cellH,
    cols: input.cols,
    rows: input.rows,
    editor: input.editor,
    day: input.day,
    decals,
    paint: painted.paint,
    paintRev: painted.paintRev,
  };
}
