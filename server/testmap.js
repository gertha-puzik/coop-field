/**
 * «Test» location config domain (W4 carve, behavior-preserving): the canonical
 * map JSON (load → sanitize → save, editor setmap handler) and SOLE OWNER of
 * the mutable shared world state — testMap + TEST_WIDTH/HEIGHT/ISLAND/CELLS/
 * OBST_CELLS/OBST_BODIES/TEST_PAINT. State is exported as live bindings:
 * rebuildTestGeometry() here is the only writer, everyone else reads. Init
 * order is kept exactly as pre-carve: loadTestMap() runs at import time, then
 * rebuildTestGeometry(). sanitizeTestMap mirrors the client's test-map.ts
 * validation one-to-one (limits via server/protocol.js, W3).
 */
import fs from "node:fs";
import { sanitizeLocationFields, locationFile, loadLocationMap, locationFromRoom, placeOf, locationCatalogue } from "./location-world.js";
import path from "node:path";
import {
  DATA_DIR, TEST_ROOM,
  OBJECT_SCALE_MIN, OBJECT_SCALE_MAX, PLANT_SPRITE_IDS, TREE_SPRITE_IDS, ROCK_SPRITE_IDS,
} from "./config.js";
import { EV, GROUND_COVER_IDS, TERRAIN_MAX_LEVEL, TEST_MAP_LIMITS } from "./protocol.js";
import { writeFileAtomic } from "./atomic-file.js";
import {
  decodePaintPng, paintPxMask, paintCellCoverageMask,
  buildIsland, buildCells, obstacleBlockedCells, obstacleBodiesOf,
  nearestTestCell, testPointInIsland, testWalkable,
} from "./world.js";
import { send, broadcast, fieldPayload, rooms } from "./room.js";
import { rememberCat } from "./persist.js";

// Exact rectangular terrain mirror of src/lib/sim/terrain-shape.ts.
export const TERRAIN_RECT_LIMIT = 10000;
const eps = 1e-7;
const round = (n) => Math.round(n * 10000) / 10000;
export const terrainRectKey = (b) => [b.x, b.y, b.w, b.d].map(round).join(',');
export function decodeTerrainRect(key, level) {
    const a = key.split(',').map(Number);
    if ((a.length !== 2 && a.length !== 4) || a.some(n => !Number.isFinite(n)))
        return null;
    const [x, y, w = 1, d = 1] = a;
    return { x, y, w, d, level };
}
export function sanitizeTerrainElev(raw, cols, rows, max) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    if (Object.keys(raw).length > TERRAIN_RECT_LIMIT)
        return null;
    const clean = {};
    let count = 0;
    for (const [key, value] of Object.entries(raw)) {
        if (count++ >= TERRAIN_RECT_LIMIT)
            break;
        if (!/^\d+(?:\.\d+)?,\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?,\d+(?:\.\d+)?)?$/.test(key))
            continue;
        const level = Math.min(max, Math.max(0, Math.round(Number(value) * 10) / 10));
        const b = decodeTerrainRect(key, level);
        if (!b || !Number.isFinite(level) || b.x < 0 || b.y < 0 || b.x >= cols || b.y >= rows || b.w <= 0 || b.d <= 0)
            continue;
        if (key.split(',').length === 2) {
            if (!Number.isInteger(b.x) || !Number.isInteger(b.y) || !level)
                continue;
            clean[`${b.x},${b.y}`] = level;
        }
        else {
            b.w = round(Math.min(b.w, cols - b.x));
            b.d = round(Math.min(b.d, rows - b.y));
            if (b.w < .0001 || b.d < .0001)
                continue;
            clean[terrainRectKey(b)] = level;
        }
    }
    return clean;
}
export function intersects(a, b) {
    return a.x < b.x + b.w - eps && a.x + a.w > b.x + eps && a.y < b.y + b.d - eps && a.y + a.d > b.y + eps;
}
/** At most four disjoint pieces; no implicit rounding to a whole cell. */
export function subtractTerrainRect(a, b) {
    if (!intersects(a, b))
        return [a];
    const x0 = Math.max(a.x, b.x), x1 = Math.min(a.x + a.w, b.x + b.w);
    const y0 = Math.max(a.y, b.y), y1 = Math.min(a.y + a.d, b.y + b.d);
    return [
        { ...a, w: x0 - a.x }, { ...a, x: x1, w: a.x + a.w - x1 },
        { ...a, x: x0, w: x1 - x0, d: y0 - a.y }, { ...a, x: x0, y: y1, w: x1 - x0, d: a.y + a.d - y1 },
    ].filter(r => r.w > eps && r.d > eps).map(r => ({ ...r, x: round(r.x), y: round(r.y), w: round(r.w), d: round(r.d) }));
}
const indices = new WeakMap();
function makeIndex(elev) {
    const cells = new Map(), rects = [];
    // Legacy cells are the base; rectangle overrides always win, even after JSON roundtrips.
    for (const [key, level] of Object.entries(elev)) {
        if (key.split(',').length !== 4)
            continue;
        const b = decodeTerrainRect(key, level);
        if (!b)
            continue;
        rects.push(b);
        for (let r = Math.floor(b.y); r < Math.ceil(b.y + b.d - eps); r++)
            for (let c = Math.floor(b.x); c < Math.ceil(b.x + b.w - eps); c++) {
                const k = `${c},${r}`;
                const list = cells.get(k) ?? [];
                list.push(b);
                cells.set(k, list);
            }
    }
    return { cells, rects };
}
export function terrainIndex(elev) {
    let index = indices.get(elev);
    if (!index) {
        index = makeIndex(elev);
        indices.set(elev, index);
    }
    return index;
}
export function invalidateTerrain(elev) { indices.delete(elev); tileCaches.delete(elev); contactCaches.delete(elev); }
export function terrainAt(elev, x, y) {
    if (!elev)
        return 0;
    const c = Math.floor(x), r = Math.floor(y), list = terrainIndex(elev).cells.get(`${c},${r}`) ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
        const b = list[i];
        if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.d)
            return b.level;
    }
    return elev[`${c},${r}`] ?? 0;
}
/** Geometry partition: each tile and its neighboring edge segments have a constant level.
 * Only nearby rectangle boundaries subdivide a cell; a 0.1-wide block does not
 * force the whole world onto a ten-times denser grid.
 */
export function terrainTiles(elev, cols, rows) {
    const out = [], index = terrainIndex(elev);
    for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
            const xs = new Set([c, c + 1]), ys = new Set([r, r + 1]);
            for (let nr = r - 1; nr <= r + 1; nr++)
                for (let nc = c - 1; nc <= c + 1; nc++) {
                    for (const b of index.cells.get(`${nc},${nr}`) ?? []) {
                        for (const v of [b.x, b.x + b.w])
                            if (v > c + eps && v < c + 1 - eps)
                                xs.add(v);
                        for (const v of [b.y, b.y + b.d])
                            if (v > r + eps && v < r + 1 - eps)
                                ys.add(v);
                    }
                }
            const xx = [...xs].sort((a, b) => a - b), yy = [...ys].sort((a, b) => a - b);
            for (let j = 0; j < yy.length - 1; j++)
                for (let i = 0; i < xx.length - 1; i++) {
                    const x = xx[i], y = yy[j], w = xx[i + 1] - x, d = yy[j + 1] - y;
                    out.push({ x, y, w, d, level: terrainAt(elev, x + w / 2, y + d / 2) });
                }
        }
    return out;
}
/** Exact body contact against rectangular cliffs, including subcell ledges. */
const tileCaches = new WeakMap();
export function cachedTerrainTiles(elev, cols, rows) {
    const cached = tileCaches.get(elev);
    if (cached && cached.cols === cols && cached.rows === rows)
        return cached.tiles;
    const tiles = terrainTiles(elev, cols, rows);
    tileCaches.set(elev, { cols, rows, tiles });
    return tiles;
}
const contactCaches = new WeakMap();
export function terrainBodyContact(elev,cols,rows,x,y,rx,ry,level) {
  if(!(rx>0&&ry>0))return 0;
  let index=contactCaches.get(elev);
  if(!index||index.cols!==cols||index.rows!==rows){
    const cells=new Map();
    // Build once per terrain revision; each movement probe visits nearby cells only.
    if(Object.keys(elev).length)for(const b of cachedTerrainTiles(elev,cols,rows)){
      const key=`${Math.floor(b.x)},${Math.floor(b.y)}`;
      const list=cells.get(key)??[];list.push(b);cells.set(key,list);
    }
    index={cols,rows,cells};contactCaches.set(elev,index);
  }
  let overlap=0;
  for(let r=Math.max(0,Math.floor(y-ry));r<=Math.min(rows-1,Math.floor(y+ry));r++)
  for(let c=Math.max(0,Math.floor(x-rx));c<=Math.min(cols-1,Math.floor(x+rx));c++){
    const tiles=index.cells.get(`${c},${r}`);
    if(!tiles){
      if(Math.abs(level)<=1+eps)continue;
      const dx=(x-Math.max(c,Math.min(c+1,x)))/rx,dy=(y-Math.max(r,Math.min(r+1,y)))/ry;
      overlap=Math.max(overlap,1-Math.hypot(dx,dy));continue;
    }
    for(const b of tiles){
      if(b.x>x+rx||b.x+b.w<x-rx||b.y>y+ry||b.y+b.d<y-ry||Math.abs(b.level-level)<=1+eps)continue;
      const dx=(x-Math.max(b.x,Math.min(b.x+b.w,x)))/rx,dy=(y-Math.max(b.y,Math.min(b.y+b.d,y)))/ry;
      overlap=Math.max(overlap,1-Math.hypot(dx,dy));
    }
  }
  return overlap;
}

const MAP_FILE = path.join(DATA_DIR, "test-map.json");
export let activeLocationId=1;

export let testMap = loadTestMap();
export let TEST_WIDTH = testMap.cols;
export let TEST_HEIGHT = testMap.rows;
export let TEST_ISLAND = [];
export let TEST_CELLS = [];
/** Клетки (0-based), задетые телами препятствий — для спавна и проверок занятия. */
export let TEST_OBST_CELLS = new Set();
/** Тела препятствий (эллипсы с поворотом) — точечная проверка мирных точек. */
export let TEST_OBST_BODIES = [];

/** Декодированный рисунок текущей локации: { w, h, mask: Uint8Array 0/1 } или null. */
export let TEST_PAINT = null;

/** Пересборка геометрии «теста» из конфига: на старте и после каждой правки редактором.
 *  Пиксельная отрисовка: рисунок декодируется ДО геометрии — контур локации
 *  строится по маске кисти (не декодировался — форма считается по зонам). */
function rebuildTestGeometry(previousMap) {
  TEST_WIDTH = testMap.cols;
  TEST_HEIGHT = testMap.rows;
  const sameGround=previousMap && previousMap.cols===testMap.cols && previousMap.rows===testMap.rows &&
    previousMap.paint===testMap.paint && previousMap.seed===testMap.seed && previousMap.margin===testMap.margin &&
    (TEST_PAINT && testMap.paint || JSON.stringify(previousMap.zones)===JSON.stringify(testMap.zones));
  if(!sameGround)TEST_PAINT = testMap.paint ? decodePaintPng(testMap.paint) : null;
  if (testMap.paint && !TEST_PAINT) console.warn("paint decode failed — форма локации по зонам");
  if(!sameGround)TEST_ISLAND = buildIsland(testMap);
  const cellObjects=map=>(map.objects??[]).filter(o=>o.kind==='tree'||o.kind==='battle');
  const sameCells=sameGround && JSON.stringify(previousMap.zones)===JSON.stringify(testMap.zones) &&
    JSON.stringify(cellObjects(previousMap))===JSON.stringify(cellObjects(testMap));
  if(!sameCells)TEST_CELLS = buildCells(testMap, TEST_ISLAND);
  TEST_OBST_CELLS = obstacleBlockedCells(testMap);
  TEST_OBST_BODIES = obstacleBodiesOf(testMap);
}

/* ---------- конфиг локации: загрузка, проверка, сохранение, правка редактором ---------- */

/** Раскладка по умолчанию — трава с боевым полигоном (v2), как в src/lib/sim/test-map.ts. */
function defaultTestMap() {
  return {
    v: 2,
    cols: 19,
    rows: 7,
    margin: 0.5,
    seed: 'test',
    zones: [
      { id: 'z1', name: 'Лужайка', kind: 'green', c0: 0, r0: 0, c1: 9, r1: 6 },
      { id: 'z2', name: 'Полигон', kind: 'cells', c0: 10, r0: 1, c1: 15, r1: 5 },
      { id: 'z3', name: 'Заросли', kind: 'green', c0: 16, r0: 0, c1: 18, r1: 6 },
    ],
    objects: [],
  };
}

/** Порт sanitizeTestMap из src/lib/sim/test-map.ts — правила совпадают один в один. */
function sanitizeTestMap(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'конфиг не распознан' };
  const asInt = (v) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? n : null;
  };
  if (raw.v !== 1 && raw.v !== 2) return { error: 'неизвестная версия конфига' };
  const cols = asInt(raw.cols);
  const rows = asInt(raw.rows);
  if (cols === null || rows === null) return { error: 'размер мира не распознан' };
  if (cols < TEST_MAP_LIMITS.colsMin || cols > TEST_MAP_LIMITS.colsMax) return { error: 'ширина мира должна быть 6–60' };
  if (rows < TEST_MAP_LIMITS.rowsMin || rows > TEST_MAP_LIMITS.rowsMax) return { error: 'высота мира должна быть 3–40' };
  if (!Array.isArray(raw.zones)) return { error: 'список зон пуст' };
  if (raw.zones.length > TEST_MAP_LIMITS.zonesMax) return { error: 'зон не больше 48' };
  // Препятствия необязательны (старые конфиги без objects читаются как «пусто»):
  // камень/дерево стоят свободно (точка опоры, масштаб, поворот), через их тело
  // нельзя пройти ни в бою, ни в мирном; земля и покрытие — наземный декор.
  let objects = [];
  if (raw.objects != null) {
    if (!Array.isArray(raw.objects)) return { error: 'список препятствий не распознан' };
    if (raw.objects.length > TEST_MAP_LIMITS.objectsMax) return { error: 'объектов не больше 2000' };
    const taken = new Set();
    for (let i = 0; i < raw.objects.length; i++) {
      const o = raw.objects[i];
      const kind =
        o &&
        (o.kind === 'plant' ? 'plant' : o.kind === 'stone'
          ? 'stone'
          : o.kind === 'tree'
            ? 'tree'
            : o.kind === 'dirt'
              ? 'dirt'
              : o.kind === 'entry'
                ? 'entry'
                : o.kind === 'ground'
                  ? 'ground'
                  : o.kind === 'battle'
                    ? 'battle'
                    : o.kind === 'path'
                      ? 'path'
                      : null);
      if (!kind) return { error: `объект №${i + 1}: неизвестный тип` };
      // Свободная точка опоры камня/дерева: дробные x/y; у старых конфигов её нет —
      // считаем из клетки и положения в ней (зеркало sanitizeTestMap клиента).
      let x = 0;
      let y = 0;
      if (kind === 'stone' || kind === 'tree' || kind === 'plant') {
        const fx = Number(o.x);
        const fy = Number(o.y);
        if (Number.isFinite(fx) && Number.isFinite(fy)) {
          x = Math.min(cols + 0.5, Math.max(-0.5, Math.round(fx * 100) / 100));
          y = Math.min(rows + 1.5, Math.max(-0.5, Math.round(fy * 100) / 100));
        } else {
          const c0 = Number.isFinite(Number(o.c)) ? Math.round(Number(o.c)) : 0;
          const r0 = Number.isFinite(Number(o.r)) ? Math.round(Number(o.r)) : 0;
          const PO = { center: [0, 0], left: [-0.25, 0], right: [0.25, 0], top: [0, -0.25], bottom: [0, 0.25] };
          const po = PO[o.pos || 'center'] || PO.center;
          x = Math.min(cols + 0.5, Math.max(-0.5, Math.round((c0 + 0.5 + po[0]) * 100) / 100));
          y = Math.min(rows + 1.5, Math.max(-0.5, Math.round((r0 + 1 + po[1]) * 100) / 100));
        }
      }
      const c = Number.isFinite(Number(o.c)) ? asInt(o.c) : Math.floor(x);
      const r = Number.isFinite(Number(o.r)) ? asInt(o.r) : Math.floor(y);
      if (c === null || r === null || c < 0 || r < 0 || c >= cols || r >= rows) {
        return { error: `препятствие №${i + 1}: вне границ мира` };
      }
      // Положение спрайта в клетке (как в src/lib/sim/test-map.ts): нет — центр.
      const pos = o.pos === 'left' || o.pos === 'right' || o.pos === 'top' || o.pos === 'bottom' ? o.pos : 'center';
      // Направление захода обязательно и только для заходов (зеркало клиента).
      let dir = null;
      if (kind === 'entry') {
        if (o.dir !== 'left' && o.dir !== 'right' && o.dir !== 'up' && o.dir !== 'down') {
          return { error: `заход №${i + 1}: не задано направление шага` };
        }
        dir = o.dir;
      }
      // Масштаб, поворот и вариант спрайта — только у препятствий (зеркало клиента).
      let s;
      let rot;
      let spr;
      let cv;
      let mir;
      if (kind === 'stone' || kind === 'tree' || kind === 'plant') {
        const sn = Number(o.s);
        s = Number.isFinite(sn) ? Math.min(OBJECT_SCALE_MAX, Math.max(OBJECT_SCALE_MIN, Math.round(sn * 100) / 100)) : undefined;
        const rn = Math.round(Number(o.rot));
        rot = Number.isFinite(rn) ? ((rn % 360) + 360) % 360 : undefined;
        spr = kind === 'plant' ? (PLANT_SPRITE_IDS.has(o.spr)?o.spr:'plant-001') : kind === 'tree' ? (TREE_SPRITE_IDS.has(o.spr) ? o.spr : 'tree-1') : ROCK_SPRITE_IDS.has(o.spr) ? o.spr : 'rock-1';
        mir = o.mir === 1 ? 1 : undefined;
      }
      if (kind === 'ground') {
        cv = GROUND_COVER_IDS.includes(String(o.cv)) ? String(o.cv) : 'flower-1';
      }
      // Земля/покрытие/заход — по клетке на объект; камень и дерево стоят свободно.
      if (kind !== 'stone' && kind !== 'tree' && kind !== 'plant') {
        const key = `${c},${r}`;
        if (taken.has(key)) continue;
        taken.add(key);
      }
      objects.push({
        id: `o${i + 1}`,
        kind,
        c,
        r,
        ...(kind === 'stone' || kind === 'tree' || kind === 'plant' ? { x, y, s, rot, spr, mir } : {}),
        ...(kind === 'ground' ? { cv } : {}),
        pos,
        dir,
      });
    }
  }
  // Пиксельная отрисовка (зеркало sanitizeTestMap клиента): строгий формат и
  // декод — рисунок обязан совпадать с миром в пикселях (cols*100 x rows*150).
  let paint = null;
  let paintDecoded = null;
  if (raw.paint != null) {
    if (typeof raw.paint !== 'string' || !raw.paint) return { error: 'рисунок локации не распознан' };
    if (raw.paint.length > 3500000) return { error: 'рисунок локации слишком велик' };
    if (!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.paint)) {
      return { error: 'рисунок локации не base64' };
    }
    if (!raw.paint.startsWith('iVBORw0KGgo')) return { error: 'рисунок локации не PNG' };
    paintDecoded = decodePaintPng(raw.paint);
    if (!paintDecoded) return { error: 'рисунок локации не декодируется' };
    if (paintDecoded.w !== cols * 100 || paintDecoded.h !== rows * 150) {
      return { error: 'рисунок локации не совпадает с размером мира' };
    }
    paint = raw.paint;
  }
  // С рисунком проталины и покрытия не нужны: они «запечены» в пиксели кистью.
  if (paint) objects = objects.filter((o) => o.kind !== 'dirt' && o.kind !== 'ground');
  const zones = [];
  for (let i = 0; i < raw.zones.length; i++) {
    const z = raw.zones[i];
    const kind = z && (z.kind === 'green' ? 'green' : z.kind === 'cells' ? 'cells' : null);
    if (!kind) return { error: `зона №${i + 1}: неизвестный тип` };
    const c0 = asInt(z.c0);
    const r0 = asInt(z.r0);
    const c1 = asInt(z.c1);
    const r1 = asInt(z.r1);
    if (c0 === null || r0 === null || c1 === null || r1 === null) {
      return { error: `зона №${i + 1}: координаты не распознаны` };
    }
    if (c0 < 0 || r0 < 0 || c0 > c1 || r0 > r1 || c1 >= cols || r1 >= rows) {
      return { error: `зона №${i + 1}: выходит за границы мира` };
    }
    const name =
      String(z.name ?? '').trim().slice(0, TEST_MAP_LIMITS.nameMax) || (kind === 'cells' ? 'Клетки' : 'Зелёная зона');
    zones.push({ id: `z${i + 1}`, name, kind, c0, r0, c1, r1 });
  }

  // Клетки захода: только на траве, и по направлению шага обязана быть боевая
  // клетка (зеркало проверки из src/lib/sim/test-map.ts).
  const battleAt = (c, r) =>
    (c >= 0 &&
      r >= 0 &&
      c < cols &&
      r < rows &&
      zones.some((z) => z.kind === 'cells' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1)) ||
    objects.some((o) => o.kind === 'battle' && o.c === c && o.r === r);
  for (const o of objects) {
    if (o.kind !== 'entry' || !o.dir) continue;
    if (battleAt(o.c, o.r)) {
      return { error: `заход на клетке ${o.c}×${o.r}: клетка захода стоит на боевых клетках — поставьте её на траве рядом с зоной` };
    }
    const dx = o.dir === 'left' ? -1 : o.dir === 'right' ? 1 : 0;
    const dy = o.dir === 'up' ? -1 : o.dir === 'down' ? 1 : 0;
    if (!battleAt(o.c + dx, o.r + dy)) {
      return { error: `заход на клетке ${o.c}×${o.r}: по направлению шага должна быть боевая клетка` };
    }
  }
  // Зоны обязаны срастаться в один островок (касание сторонами, не углами) —
  // но только без пиксельной отрисовки: с рисунком форма локации из пикселей,
  // зоны — просто списки боевых областей и могут стоять островами.
  if (paint) {
    // Логика боевых клеток (зеркало редактора): боевая клетка и заход ставятся
    // только на место, покрашенное кистью целиком.
    for (const o of objects) {
      if (o.kind !== 'battle' && o.kind !== 'entry') continue;
      if (paintCellCoverageMask(paintDecoded, o.c, o.r) < 0.995) {
        return {
          error: `${o.kind === 'battle' ? 'боевая клетка' : 'заход'} на клетке ${o.c}×${o.r}: место покрашено не целиком — закрасьте область клетки кистью`,
        };
      }
    }
  } else {
  const cells = new Set();
  for (const z of zones) {
    for (let r = z.r0; r <= z.r1; r++) {
      for (let c = z.c0; c <= z.c1; c++) cells.add(`${c},${r}`);
    }
  }
  const start = cells.values().next().value;
  const seen = new Set(start===undefined?[]:[start]);
  const queue = start===undefined?[]:[start];
  while (queue.length > 0) {
    const [c, r] = queue.pop().split(',').map(Number);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${c + dc},${r + dr}`;
      if (cells.has(k) && !seen.has(k)) {
        seen.add(k);
        queue.push(k);
      }
    }
  }
  if (seen.size !== cells.size) {
    return { error: 'зоны должны соединяться в одну локацию (касаться сторонами, не углами)' };
  }
  }
  // Клетки спавна: необязательный список (старые конфиги без него — «пусто»).
  // Ставятся только на траве (зелёной зоне) и не на боевых клетках: новичок
  // появляется в мирном режиме. Дубликаты схлопываются, порядок сохраняется
  // (порт sanitizeTestMap из src/lib/sim/test-map.ts).
  const spawns = [];
  if (raw.spawns != null) {
    if (!Array.isArray(raw.spawns)) return { error: 'список клеток спавна не распознан' };
    if (raw.spawns.length > TEST_MAP_LIMITS.spawnsMax) return { error: 'клеток спавна не больше 64' };
    const seenSp = new Set();
    for (let i = 0; i < raw.spawns.length; i++) {
      const s = raw.spawns[i];
      const c = asInt(s && s.c);
      const r = asInt(s && s.r);
      if (c === null || r === null) return { error: `спавн №${i + 1}: координаты не распознаны` };
      if (c < 0 || r < 0 || c >= cols || r >= rows) {
        return { error: `спавн №${i + 1}: вне границ мира` };
      }
      const onGreen = zones.some((z) => z.kind === 'green' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1);
      const onBattle =
        zones.some((z) => z.kind === 'cells' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1) ||
        objects.some((o) => o.kind === 'battle' && o.c === c && o.r === r);
      // С рисунком спавн — на любом закрашенном месте не на боевых клетках;
      // без рисунка — по-старому, только в зелёной зоне.
      if ((paint && onBattle) || (!paint && (!onGreen || onBattle))) {
        return { error: `спавн №${i + 1}: клетка спавна ставится на траве (зелёной зоне), не на боевых клетках` };
      }
      if (paint && paintPxMask(paintDecoded, (c + 0.5) * 100, (r + 0.5) * 150) !== true) {
        return { error: `спавн №${i + 1}: место не закрашено кистью — закрасьте клетку в редакторе` };
      }
      const key = `${c},${r}`;
      if (seenSp.has(key)) continue;
      seenSp.add(key);
      spawns.push({ c, r });
    }
  }
  // Карта высот рельефа (зеркало sanitizeTestMap клиента): разреженный словарь
  // «c,r» → уровень 1..3; нули, мусор и клетки вне мира выбрасываются.
  let elev;
  if (raw.elev != null) {
    if (typeof raw.elev !== 'object' || Array.isArray(raw.elev)) return { error: 'карта высот не распознана' };
    elev = sanitizeTerrainElev(raw.elev, cols, rows, TERRAIN_MAX_LEVEL);
    if(!elev)return {error:"слишком много участков рельефа"};
    if (Object.keys(elev).length === 0) elev = undefined;
  }
  const location=sanitizeLocationFields(raw,cols,rows);if(location.error)return {error:location.error};
  return {
    map: {
      ...location,
      v: raw.v,
      cols,
      rows,
      margin: 0.5,
      seed: typeof raw.seed === 'string' && raw.seed.trim() ? raw.seed.trim().slice(0, TEST_MAP_LIMITS.nameMax) : 'test',
      zones,
      objects,
      spawns,
      ...(elev ? { elev } : {}),
      ...(paint ? { paint } : {}),
    },
  };
}

function loadTestMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    const r = sanitizeTestMap(raw);
    if (r.map) {
      // Миграция legacy-раскладки (v1: клетки везде) — поле теперь делится на
      // траву (мирный режим) и боевые клетки. Файл без v2 заменяем дефолтом
      // новой раскладки, чтобы на сервере не жила старая карта навсегда.
      if (r.map.v < 2) {
        const fresh = defaultTestMap();
        try {
          backupTestMap(); // старая раскладка не исчезает — лежит в data/backups
          fs.mkdirSync(DATA_DIR, { recursive: true });
          writeFileAtomic(MAP_FILE, JSON.stringify(fresh, null, 2));
        } catch {}
        console.warn('map file v1 (legacy) — миграция к раскладке v2 (трава + боевой полигон)');
        return fresh;
      }
      return r.map;
    }
    // Битый/устаревший файл не молча выбрасываем: копия остаётся рядом, чтобы
    // локацию можно было восстановить, а не собирать заново с нуля.
    try {
      const quarantine = path.join(DATA_DIR, `test-map.invalid-${Date.now()}.json`);
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.copyFileSync(MAP_FILE, quarantine);
      console.warn(`map file invalid (${r.error}) — копия в ${quarantine}`);
    } catch {}
    console.warn(`map file invalid (${r.error}) — откат к раскладке по умолчанию`);
  } catch (e) {
    /* файла ещё нет — работаем на раскладке по умолчанию; ошибка чтения существующего
     * файла (не ENOENT) — видимая, чтобы потеря карты не прошла незамеченной */
    if (e && e.code !== 'ENOENT') console.warn('map file read failed:', e?.message || e);
  }
  return defaultTestMap();
}

/** Прошлая версия карты — в data/backups (последние 8): неудачную правку редактора
 *  или потерю файла можно откатить, а не собирать локацию заново. */
function backupTestMap() {
  try {
    const file=locationFile(activeLocationId);
    if (!fs.existsSync(file)) return;
    const dir = path.join(DATA_DIR, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const prefix=activeLocationId===1?"test-map-":`location-${activeLocationId}-`;
    fs.copyFileSync(file, path.join(dir, `${prefix}${stamp}.json`));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    while (old.length > 8) fs.unlinkSync(path.join(dir, old.shift()));
  } catch (e) {
    console.warn("map backup failed:", e?.message || e);
  }
}

function saveTestMap() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  backupTestMap();
  writeFileAtomic(locationFile(activeLocationId), JSON.stringify(testMap, null, 2));
}

rebuildTestGeometry();

/**
 * Редактор локации: клиент → ["setmap", { map }]. Сохранить корректный конфиг
 * локации в data/test-map.json может только админ — роль берётся с WS-сессии
 * сокета (bindAccount в auth.js), контракт тот же, что у adminGate в
 * sprites.js (не админ — молчаливый отказ с info). Не-админам редактор и
 * кнопка закрыты клиентом (chrome.tsx), этот гейт — защита глубины от
 * самодельных кадров. Чтение карты (кадры map/field при входе) гейтом не
 * затрагивается: обычные игроки продолжают играть на опубликованной локации.
 * После сохранения геометрия перестраивается, всем в комнате уходит
 * ["map", map] и свежий field (коты, оставшиеся за пределами новой
 * локации, переезжают на ближайшую клетку).
 */
const SETMAP_MIN_GAP_MS = 10000;

function setMap(ws, payload = {}) {
  // Сохраняет локацию только админ (лечит «Сохранять может любой игрок»).
  if (ws.account?.role !== "admin") {
    send(ws, EV.INFO, 'Редактор: сохранение локации доступно только администраторам.');
    return;
  }
  if (ws.room?.fmt !== 'test' || !ws.room.sockets.has(ws)) {
    send(ws, EV.INFO, 'Редактор: сначала войдите в локацию.');
    return;
  }
  const now = Date.now();
  // Троттлинг на ЛЮБОЙ setmap-кадр участника локации: кадр
  // запускает тяжёлую работу (PNG-декод, пересборку всей геометрии, запись
  // с бэкапами), так что повторные записи ограничены. Счётчик
  // живёт на сокете (по аналогии с lastJoin); отброшенный кадр окно
  // не продлевает — окно отсчитывается от последнего пропущенного кадра.
  if (now - (ws.lastSetmap || 0) < SETMAP_MIN_GAP_MS) {
    send(ws, EV.INFO, 'Редактор: слишком часто.');
    return;
  }
  ws.lastSetmap = now;
  const r = sanitizeTestMap({...payload?.map,place:placeOf(payload?.map??{},activeLocationId)});
  if (!r.map) {
    send(ws, EV.INFO, `Редактор: ${r.error}.`);
    return;
  }
  const previousMap = testMap;
  testMap = r.map;
  rebuildTestGeometry(previousMap);
  // Не сохранившаяся на диск правка умерла бы при первом же рестарте («карта
  // слетела») — ошибка записи видна автору сразу, а не после деплоя.
  try {
    saveTestMap();
  } catch (e) {
    console.warn('map save failed:', e?.message || e);
    testMap = previousMap;
    rebuildTestGeometry();
    send(ws, EV.INFO, `Редактор: сохранить локацию на диск не удалось — ${e?.message || e}. Правка осталась в черновике, попробуйте ещё раз.`);
    return;
  }
  // Small acknowledgement follows the successful atomic write, before expensive
  // player relocation and the full map broadcast. Only the author receives it.
  send(ws,EV.INFO,'Редактор: сохранено.');
  const room = rooms.get(ws.room.code);
  if (room && room.sockets.size > 0) {
    for (const cat of room.cats.values()) {
      if (cat.fm === 1) {
        const fx = Number.isFinite(cat.fx) ? cat.fx : 0;
        const fy = Number.isFinite(cat.fy) ? cat.fy : 0;
        if (!testPointInIsland(fx, fy) && !testPointInIsland(fx + 0.45, fy + 0.45)) {
          const c = nearestTestCell(fx, fy);
          if (c) {
            cat.fm = 0;
            cat.x = c.x;
            cat.y = c.y;
          }
        }
      } else if (!testWalkable(cat.x, cat.y)) {
        const c = nearestTestCell(cat.x - 1, cat.y - 1);
        if (c) {
          cat.x = c.x;
          cat.y = c.y;
        }
      }
      rememberCat(cat);
    }
    for (const w of room.sockets.keys()) send(w, EV.MAP, testMap);
    broadcast(room, EV.FIELD, fieldPayload(room));
  }
  if(rooms.size&&JSON.stringify(previousMap.place)!==JSON.stringify(testMap.place)){const catalogue=locationCatalogue();for(const other of rooms.values())if(other.fmt==='test'&&other!==room)broadcast(other,EV.LOCATIONS,catalogue);}
  console.log(`map set: ${testMap.cols}x${testMap.rows}, zones=${testMap.zones.length}, objects=${(testMap.objects || []).length}, spawns=${(testMap.spawns || []).length}`);
}

/** Legacy geometry functions read live bindings. A synchronous room operation
 * gets its own cached snapshot; finally restores the previous world, including
 * nested field/catalog calls. Never hold this scope across an await.
 */
const locationWorlds=new Map();
const captureWorld=()=>({testMap,TEST_WIDTH,TEST_HEIGHT,TEST_ISLAND,TEST_CELLS,TEST_OBST_CELLS,TEST_OBST_BODIES,TEST_PAINT});
function restoreWorld(s){({testMap,TEST_WIDTH,TEST_HEIGHT,TEST_ISLAND,TEST_CELLS,TEST_OBST_CELLS,TEST_OBST_BODIES,TEST_PAINT}=s);}
export function withTestLocation(id,fn){
  id=Number(id)||1;if(id===activeLocationId)return fn();
  const previous=activeLocationId,snapshot=captureWorld();locationWorlds.set(previous,snapshot);let activated=false;
  try{
    activeLocationId=id;
    const stored=locationWorlds.get(id);
    if(stored)restoreWorld(stored);
    else{testMap=loadLocationMap(id);rebuildTestGeometry();}
    activated=true;const result=fn();
    if(result&&typeof result.then==='function')throw new Error('World scope must be synchronous');
    return result;
  }finally{if(activated)locationWorlds.set(id,captureWorld());restoreWorld(snapshot);activeLocationId=previous;}
}

export {
  MAP_FILE, rebuildTestGeometry, defaultTestMap, sanitizeTestMap, saveTestMap, setMap, loadTestMap,
};
