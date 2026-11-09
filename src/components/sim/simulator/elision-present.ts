import { terrainTiles } from '@/lib/sim/terrain-shape';
import type { EditorPlace } from '@/lib/sim/editor-model';
/**
 * Кадр Элизии для WebGL-вида: собирает то, что 2D-цикл уже посчитал
 * (камера, свой кот, чужие, камни и деревья), без второго перевода
 * сетевых координат. Клетки здесь 0-based, px мира — col/fx × размер клетки.
 * Babylon подключается отдельно и этот модуль не импортирует.
 */
import type { DummyConfig, SpriteId } from '@/lib/sim/settings';
import { RAB_SPRITE, SPRITES } from '@/lib/sim/settings';
import { dummyIsDrawn } from '@/lib/sim/targeting';
import { currentTestMap, drawDirtPatch, drawEntryMark, drawGroundCover, drawTestDecorItem, effectiveElevRecord, elevLevelAt, terrainLevelAt, supportLevelAt, hashStr, paintCanvas, TERRAIN_LIFT_PX, testFieldGeometry } from '@/lib/sim/test-field';
import { grassPattern, packRevision } from '@/lib/sim/textures';
import {
  OBJECT_DIMS,
  objectBase,
  objectMir,
  objectPosOffset,
  objectRotDeg,
  objectScale,
  objectSprite,
  type TestMapObject,
} from '@/lib/sim/test-map';
import type { Engine } from './sim-model';
import {
  elisionSpritePose,
  type ElisionSpace,
  selfWorldPx,
  spriteSizePx,
  type ElisionActor,
  type ElisionDay,
  type ElisionFrame,
} from '@/lib/sim/elision-scene';

type SpriteImg = { width: number; height: number };

export type ElisionPresentInput = {
  now: number;
  jelly: Record<string, number>;
  space: ElisionSpace;
  remoteSpace: Map<string, ElisionSpace>;
  editor: boolean;
  editorPlacement?: EditorPlace | null;
  day: ElisionDay;
  dayProgress: number;
  jumpTarget: ElisionFrame['jumpTarget'];
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

let surface: HTMLCanvasElement | null = null;
let surfaceMap: ReturnType<typeof currentTestMap> | null = null;
let surfacePaint: HTMLCanvasElement | null = null;
let surfacePack = -1;
let paintRev = 0;
let surfaceEditor = false;

/** Полный атлас поверхности: кисть/трава, покрытия, заходы и сетка на всех уровнях. */
function framePaint(cols: number, rows: number, cellW: number, cellH: number, editor: boolean) {
  const map = currentTestMap();
  const real = paintCanvas();
  const revision = packRevision();
  const w = Math.max(1, Math.round(cols * cellW));
  const h = Math.max(1, Math.round(rows * cellH));
  if (!surface) surface = document.createElement('canvas');
  if (surfaceMap === map && surfacePaint === real && surfacePack === revision &&
      surface.width === w && surface.height === h && surfaceEditor === editor) {
    return { paint: surface, paintRev };
  }
  surfaceEditor = editor;
  surfaceMap = map;
  surfacePaint = real;
  surfacePack = revision;
  surface.width = w;
  surface.height = h;
  const g = surface.getContext('2d');
  if (!g) return { paint: null, paintRev };
  g.imageSmoothingEnabled = false;
  const geo = testFieldGeometry(cellW, cellH);
  if (real) g.drawImage(real, 0, 0, w, h);
  else {
    g.fillStyle = grassPattern(g) ?? '#2a461c';
    g.fill(geo.path);
  }
  g.save();
  g.clip(geo.path);
  if (!real) {
    for (const o of map.objects ?? []) {
      if (o.kind === 'ground') drawGroundCover(g, o, cellW, cellH);
      if (o.kind === 'dirt') {
        const po = objectPosOffset(o);
        drawDirtPatch(g, cellW, cellH, (o.c + 0.5 + po.dx) * cellW,
          (o.r + 0.5 + po.dy) * cellH, hashStr(o.id) & 7);
      }
    }
  }
  // Soft level tint: every higher surface is lighter, without covering the texture.
  for (const b of terrainTiles(effectiveElevRecord(map),cols,rows)) {
    if(!b.level)continue;
    g.fillStyle = `rgba(255, 245, 200, ${Math.min(.5, b.level * .025)})`;
    g.fillRect(b.x * cellW, b.y * cellH, b.w * cellW, b.d * cellH);
  }
  const battle = new Set<string>();
  for (const zone of map.zones) {
    if (zone.kind !== 'cells') continue;
    for (let r = zone.r0; r <= zone.r1; r++)
      for (let c = zone.c0; c <= zone.c1; c++) battle.add(`${c},${r}`);
  }
  for (const o of map.objects ?? []) {
    if (o.kind === 'battle') battle.add(`${o.c},${o.r}`);
    if (o.kind === 'entry' && o.dir)
      drawEntryMark(g, cellW, cellH, (o.c + 0.5) * cellW, (o.r + 0.5) * cellH, o.dir);
  }
  if (!real) {
    for (const decor of geo.decor) drawTestDecorItem(g, decor, cellW, cellH);
  }
  g.fillStyle = 'rgba(250, 214, 80, 0.1)';
  g.strokeStyle = 'rgba(233, 196, 61, 0.8)';
  g.lineWidth = 1;
  for (const key of battle) {
    const [c, r] = key.split(',').map(Number);
    g.fillRect(c * cellW, r * cellH, cellW, cellH);
    g.strokeRect(c * cellW + 0.5, r * cellH + 0.5, cellW - 1, cellH - 1);
  }
  if (editor) {
    g.strokeStyle = 'rgba(240,255,235,.2)';
    g.lineWidth = 1;
    g.beginPath();
    for (let c = 0; c <= cols; c++) { g.moveTo(c*cellW,0); g.lineTo(c*cellW,h); }
    for (let r = 0; r <= rows; r++) { g.moveTo(0,r*cellH); g.lineTo(w,r*cellH); }
    g.stroke();
  }
  g.restore();
  paintRev += 1;
  return { paint: surface, paintRev };
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
    pose: elisionSpritePose(input.now, input.jelly[id === input.controlled ? 'main' : id] ?? 0, size.h,
      id === input.controlled ? input.space : input.remoteSpace.get(id)),
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
    isProp: true,
    x: footX - w / 2,
    y: footY - h,
    w,
    h,
    lift: terrainLevelAt(Math.floor(base.x), Math.floor(base.y)) * TERRAIN_LIFT_PX,
    url: `/tex/${spr}.png`,
    mirror: objectMir(o) === 1,
    rot: objectRotDeg(o),
  };
}

export function collectElisionFrame(input: ElisionPresentInput): ElisionFrame {
  const decals: ElisionActor[] = [];
  {
    const self = selfWorldPx(input.engine, input.cellW, input.cellH, input.peace, input.now);
    pushActor(
      decals,
      catActor(
        input.controlled,
        input.selfSprite,
        input.selfScale,
        self,
        self.lift,
        input.peace && input.engine.face === -1,
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
      const size = spriteSizePx(input.cellH, remote.scale, aspectOf(input.spriteImage(remote.sprite)));
      const lift = (free ? supportLevelAt(free.x + size.w/2/input.cellW, free.y + size.h/input.cellH) : elevLevelAt(col, row)) * TERRAIN_LIFT_PX + remoteHop(free?.jpUntil, input.now);
      pushActor(
        decals,
        catActor(remote.id, remote.sprite, remote.scale, top, lift, free?.face === -1, input, true),
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
    for (const object of input.objects) {
      if (input.editor && object.id === input.editorPlacement?.pickId) continue;
      pushActor(decals, propActor(object, input.cellW, input.cellH));
    }
    const place = input.editor ? input.editorPlacement : null;
    if (place) {
      const ghost = propActor({ id: '__ghost', kind: place.kind, c: Math.floor(place.x), r: Math.floor(place.y),
        x: place.x, y: place.y, s: place.s, rot: place.rot, spr: place.spr, mir: place.mir }, input.cellW, input.cellH);
      if (ghost) pushActor(decals, { ...ghost, opacity: .6 });
    }
  }
  const painted = framePaint(input.cols, input.rows, input.cellW, input.cellH, input.editor);
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
    elev: effectiveElevRecord(currentTestMap()),
    terrainLiftStep: TERRAIN_LIFT_PX,
    day: input.day,
    dayProgress: input.dayProgress,
    jumpTarget: input.jumpTarget,
    decals,
    controlledId: input.controlled,
    paint: painted.paint,
    paintRev: painted.paintRev,
  };
}
