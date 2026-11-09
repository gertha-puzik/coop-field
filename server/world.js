import { terrainAt, terrainBodyContact } from "./testmap.js";
/**
 * Geometry of the drawn «test» location (W4 carve, behavior-preserving):
 * PNG alpha-mask decode, paint pixel/coverage probes, marching-squares edge
 * tracing + Chaikin smoothing — a bit-exact port of the client's
 * src/lib/sim/test-field.ts math (seed and smoothing must match, otherwise
 * the server would allow cells the client has already clipped away).
 * Reads the mutable world state (testMap, TEST_*, TEST_PAINT) ONLY as live
 * bindings from ./testmap.js — the single writer there is rebuildTestGeometry.
 * Pure helpers: no writes, no sockets, no wire format.
 */
import zlib from "node:zlib";
import { TEST_ROOM, OBJECT_DIMS, TREE_SPRITE_IDS, ROCK_SPRITE_IDS } from "./config.js";
import { testMap, TEST_ISLAND, TEST_CELLS, TEST_WIDTH, TEST_HEIGHT, TEST_PAINT } from "./testmap.js";
import {
  ELEV_STEP_MAX,
  JUMP_CHARGE_FULL,
  JUMP_CHARGE_HALF,
  JUMP_MAX_DROP,
  JUMP_MAX_UP,
  TERRAIN_MAX_LEVEL,
} from "./protocol.js";
/* ---------- пиксельная отрисовка: PNG-декод и маска земли ---------- */

/** Канонический размер клетки пиксельной отрисовки (зеркало PAINT_CELL_W/H
 *  из test-field.ts): рисунок хранится в px мира cols*100 x rows*150. */
const PAINT_CELL_W = 100;
const PAINT_CELL_H = 150;

/**
 * Минимальный PNG-декодер (альфа-маска): браузерный canvas.toDataURL даёт
 * 8-бит RGBA/RGB без interlace, фильтры строк 0–4 — этого достаточно. Возвращает
 * { w, h, mask } (mask[i] = альфа > 127) или null — битый/чужой формат.
 */
function decodePaintPng(b64) {
  try {
    const buf = Buffer.from(String(b64), "base64");
    if (buf.length < 8 + 12 + 12) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
    let off = 8;
    let w = 0;
    let h = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idat = [];
    while (off + 12 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString("ascii", off + 4, off + 8);
      const data = buf.subarray(off + 8, off + 8 + len);
      if (type === "IHDR") {
        w = data.readUInt32BE(0);
        h = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        interlace = data[12];
      } else if (type === "IDAT") {
        idat.push(data);
      } else if (type === "IEND") {
        break;
      }
      off += 12 + len;
    }
    if (!w || !h || bitDepth !== 8 || interlace !== 0) return null;
    if (colorType !== 6 && colorType !== 2) return null;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = colorType === 6 ? 4 : 3;
    const stride = w * bpp;
    if (raw.length < (stride + 1) * h) return null;
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const filter = raw[y * (stride + 1)];
      const src = y * (stride + 1) + 1;
      const dst = src;
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? raw[dst + x - bpp] : 0;
        const b = y > 0 ? raw[dst + x - (stride + 1)] : 0;
        const c = x >= bpp && y > 0 ? raw[dst + x - (stride + 1) - bpp] : 0;
        let v = raw[src + x];
        if (filter === 1) v = (v + a) & 0xff;
        else if (filter === 2) v = (v + b) & 0xff;
        else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        }
        raw[dst + x] = v;
      }
      for(let x=0;x<w;x++)mask[y*w+x]=colorType===2 || raw[src+x*bpp+3]>127 ? 1 : 0;
    }
    return { w, h, mask };
  } catch {
    return null;
  }
}

/** Пиксель маски (канонические px мира): закрашен ли (вне рисунка — true). */
function paintPxOn(x, y) {
  if (!TEST_PAINT) return true;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= TEST_PAINT.w || yi >= TEST_PAINT.h) return false;
  return TEST_PAINT.mask[yi * TEST_PAINT.w + xi] === 1;
}

/** Exact current ground; traced outline is a rendering approximation only. */
export function testPointInIsland(x,y) {
  return TEST_PAINT ? paintPxOn(x*PAINT_CELL_W,y*PAINT_CELL_H) : pointInPolygon(TEST_ISLAND,x,y);
}

/** Доля закрашенных пикселей клетки (0-based): боевая клетка/заход ставятся
 *  только на место, покрашенное целиком (зеркало paintCellCoverage клиента). */
function paintCellCoverage(c, r) {
  if (!TEST_PAINT) return 1;
  const x0 = c * PAINT_CELL_W;
  const y0 = r * PAINT_CELL_H;
  if (x0 < 0 || y0 < 0 || x0 + PAINT_CELL_W > TEST_PAINT.w || y0 + PAINT_CELL_H > TEST_PAINT.h) return 0;
  let on = 0;
  for (let y = y0; y < y0 + PAINT_CELL_H; y++) {
    const row = y * TEST_PAINT.w;
    for (let x = x0; x < x0 + PAINT_CELL_W; x++) on += TEST_PAINT.mask[row + x];
  }
  return on / (PAINT_CELL_W * PAINT_CELL_H);
}

/**
 * Контуры закрашенной области на сетке 1/50 клетки — точный порт tracePaintLoops
 * из src/lib/sim/test-field.ts (шаг сетки, строгое «все пиксели ячейки»,
 * схлопывание, Чайкин ×3, дрожь ±2%, Чайкин ×1 и ПОРЯДОК вызовов rnd — иначе
 * сервер и клиент разъедутся картинкой).
 */
function tracePaintLoops() {
  if (!TEST_PAINT) return [];
  const G = 50;
  const mask = TEST_PAINT.mask;
  const w = TEST_PAINT.w;
  const bw = testMap.cols * G;
  const bh = testMap.rows * G;
  const inside = (gx, gy) => {
    if (gx < 0 || gy < 0 || gx >= bw || gy >= bh) return false;
    const x0 = Math.round((gx * PAINT_CELL_W) / G);
    const y0 = Math.round((gy * PAINT_CELL_H) / G);
    const x1 = Math.round(((gx + 1) * PAINT_CELL_W) / G);
    const y1 = Math.round(((gy + 1) * PAINT_CELL_H) / G);
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      for (let x = x0; x < x1; x++) if (mask[row + x] !== 1) return false;
    }
    return true;
  };
  const edges = [];
  const byVertex = new Map();
  const addEdge = (x1, y1, x2, y2) => {
    const id = edges.length;
    edges.push([x1, y1, x2, y2]);
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ]) {
      const k = `${x},${y}`;
      const arr = byVertex.get(k);
      if (arr) arr.push(id);
      else byVertex.set(k, [id]);
    }
  };
  for (let gy = 0; gy < bh; gy++) {
    for (let gx = 0; gx < bw; gx++) {
      if (!inside(gx, gy)) continue;
      if (!inside(gx, gy - 1)) addEdge(gx, gy, gx + 1, gy);
      if (!inside(gx, gy + 1)) addEdge(gx, gy + 1, gx + 1, gy + 1);
      if (!inside(gx - 1, gy)) addEdge(gx, gy, gx, gy + 1);
      if (!inside(gx + 1, gy)) addEdge(gx + 1, gy, gx + 1, gy + 1);
    }
  }
  const rnd = mulberry32(hashStr((testMap.seed || TEST_ROOM) + ":paint"));
  const used = new Array(edges.length).fill(false);
  const loops = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop = [
      [edges[i][0], edges[i][1]],
      [edges[i][2], edges[i][3]],
    ];
    let guard = 0;
    while (guard++ <= edges.length) {
      const [tx, ty] = loop[loop.length - 1];
      const cands = (byVertex.get(`${tx},${ty}`) || []).filter((si) => !used[si]);
      if (cands.length === 0) break;
      const si = cands[0];
      used[si] = true;
      const [ex1, ey1, ex2, ey2] = edges[si];
      const next = ex1 === tx && ey1 === ty ? [ex2, ey2] : [ex1, ey1];
      if (next[0] === loop[0][0] && next[1] === loop[0][1]) break;
      loop.push(next);
    }
    if (loop.length >= 4) {
      const pts = [];
      for (const [gx, gy] of loop) {
        const p = { x: gx / G, y: gy / G };
        const n = pts.length;
        if (n >= 2) {
          const a = pts[n - 2];
          const b = pts[n - 1];
          if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) {
            pts[n - 1] = p;
            continue;
          }
        }
        pts.push(p);
      }
      let poly = chaikin(pts, 3);
      poly = poly.map((p) => ({
        x: p.x + (rnd() * 2 - 1) * 0.02,
        y: p.y + (rnd() * 2 - 1) * 0.02,
      }));
      poly = chaikin(poly, 1);
      loops.push(poly);
    }
  }
  return loops;
}

/* ---------- геометрия кромки локации — точный порт src/lib/sim/test-field.ts.
   Клиент и сервер обязаны считать одно и то же: сид и сглаживание совпадают,
   иначе сервер разрешит клетку, которую клиент уже подрезал картинкой. ---------- */

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chaikin(pts, iterations) {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const out = [];
    const n = cur.length;
    for (let i = 0; i < n; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % n];
      out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    cur = out;
  }
  return cur;
}

/** Точка внутри замкнутого полигона (луч, количество пересечений нечётно). */
function pointInPolygon(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const hit = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

/** Контур расширенных на полклетки зон на сетке 0,5 клетки (марширующие квадраты). */
function traceMaskOutline(zoneRects, margin) {
  const G = 2; // единиц сетки в клетке (шаг 0,5 клетки)
  const rects = zoneRects.map(([c0, r0, c1, r1]) => ({
    gx0: (c0 - margin) * G,
    gy0: (r0 - margin) * G,
    gx1: (c1 + 1 + margin) * G,
    gy1: (r1 + 1 + margin) * G,
  }));
  const minX = Math.min(...rects.map((r) => r.gx0));
  const maxX = Math.max(...rects.map((r) => r.gx1));
  const minY = Math.min(...rects.map((r) => r.gy0));
  const maxY = Math.max(...rects.map((r) => r.gy1));
  const insideCell = (gx, gy) => rects.some((r) => gx >= r.gx0 && gx < r.gx1 && gy >= r.gy0 && gy < r.gy1);
  const vkey = (x, y) => `${x},${y}`;
  const edges = [];
  const byVertex = new Map();
  const addEdge = (x1, y1, x2, y2) => {
    const id = edges.length;
    edges.push([x1, y1, x2, y2]);
    for (const [x, y] of [
      [x1, y1],
      [x2, y2],
    ]) {
      const k = vkey(x, y);
      const arr = byVertex.get(k);
      if (arr) arr.push(id);
      else byVertex.set(k, [id]);
    }
  };
  for (let gy = minY; gy < maxY; gy++) {
    for (let gx = minX; gx < maxX; gx++) {
      if (!insideCell(gx, gy)) continue;
      if (!insideCell(gx, gy - 1)) addEdge(gx, gy, gx + 1, gy);
      if (!insideCell(gx, gy + 1)) addEdge(gx, gy + 1, gx + 1, gy + 1);
      if (!insideCell(gx - 1, gy)) addEdge(gx, gy, gx, gy + 1);
      if (!insideCell(gx + 1, gy)) addEdge(gx + 1, gy, gx + 1, gy + 1);
    }
  }
  const used = new Array(edges.length).fill(false);
  let best = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop = [
      [edges[i][0], edges[i][1]],
      [edges[i][2], edges[i][3]],
    ];
    let guard = 0;
    while (guard++ <= edges.length) {
      const [tx, ty] = loop[loop.length - 1];
      const cands = (byVertex.get(vkey(tx, ty)) || []).filter((si) => !used[si]);
      if (cands.length === 0) break;
      const si = cands[0];
      used[si] = true;
      const [ex1, ey1, ex2, ey2] = edges[si];
      const next = ex1 === tx && ey1 === ty ? [ex2, ey2] : [ex1, ey1];
      if (next[0] === loop[0][0] && next[1] === loop[0][1]) break;
      loop.push(next);
    }
    if (loop.length > best.length) best = loop;
  }
  return best;
}

/** Полигон кромки в клеточных долях: с пиксельной отрисовкой — контуры кисти
 *  (все петли: острова и дыры), без неё — зоны + полклетки, Чайкин ×3, дрожь ±5%, Чайкин ×1. */
function buildIsland(map) {
  if (TEST_PAINT) {
    const loops = tracePaintLoops();
    if (loops.length > 0) {
      const flat = [];
      for (const l of loops) flat.push(...l);
      return flat;
    }
    // пустой рисунок — весь мир (страховка, как у зон без контура)
    return [
      { x: -map.margin, y: -map.margin },
      { x: map.cols + map.margin, y: -map.margin },
      { x: map.cols + map.margin, y: map.rows + map.margin },
      { x: -map.margin, y: map.rows + map.margin },
    ];
  }
  const rnd = mulberry32(hashStr(map.seed || TEST_ROOM));
  const zoneRects = map.zones.map((z) => [z.c0, z.r0, z.c1, z.r1]);
  const outline = traceMaskOutline(zoneRects, map.margin);
  if (outline.length === 0) {
    return [
      { x: -map.margin, y: -map.margin },
      { x: map.cols + map.margin, y: -map.margin },
      { x: map.cols + map.margin, y: map.rows + map.margin },
      { x: -map.margin, y: map.rows + map.margin },
    ];
  }
  const pts = [];
  for (const [gx, gy] of outline) {
    const p = { x: gx / 2, y: gy / 2 };
    const n = pts.length;
    if (n >= 2) {
      const a = pts[n - 2];
      const b = pts[n - 1];
      if ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y)) {
        pts[n - 1] = p;
        continue;
      }
    }
    pts.push(p);
  }
  let poly = chaikin(pts, 3);
  poly = poly.map((p) => ({
    x: p.x + (rnd() * 2 - 1) * 0.05,
    y: p.y + (rnd() * 2 - 1) * 0.05,
  }));
  poly = chaikin(poly, 1);
  return poly;
}

/** Клетка целиком внутри кромки: 4 угла, середины сторон и центр. */
// Lazy initialization: testmap invokes these functions during the import cycle.
var islandCellCache;
function testCellInIsland(c,r,island=TEST_ISLAND){
  islandCellCache ??= new WeakMap();
  let cache=islandCellCache.get(island);
  if(!cache){cache=new Map();islandCellCache.set(island,cache);}
  const key=`${c},${r}`;
  if(cache.has(key))return cache.get(key);
  const inside=computeCellInIsland(c,r,island);cache.set(key,inside);return inside;
}
function computeCellInIsland(c, r, island = TEST_ISLAND) {
  if(TEST_PAINT)return paintCellCoverage(c,r)>=.995;
  for (let dy = 0; dy <= 2; dy++) {
    for (let dx = 0; dx <= 2; dx++) {
      if (!pointInPolygon(island, c + dx * 0.5, r + dy * 0.5)) return false;
    }
  }
  return true;
}

/** Маска проходимости «теста» (0-based): зоны с клетками минус клетки, задетые
 *  кромкой (сглаженный край подрезает углы зон — такие клетки недоступны для
 *  прыжков, а сетка у кромки на клиенте рисуется с клипом по тому же полигону),
 *  минус клетки, задетые телами препятствий — «обтекаемые» эллипсы у земли со
 *  свободной позицией, масштабом и поворотом (зеркало test-field.ts клиента;
 *  земля/покрытие — наземный декор, ходьбе не мешают).
 *  Зелёные зоны в бою не участвуют — это только мирная территория. */
function buildCells(map, island) {
  const mask = Array.from({ length: map.rows }, () => new Array(map.cols).fill(false));
  for (const z of map.zones) {
    if (z.kind !== 'cells') continue;
    for (let r = z.r0; r <= z.r1; r++) {
      for (let c = z.c0; c <= z.c1; c++) mask[r][c] = true;
    }
  }
  // одиночные боевые клетки (объекты kind «battle») — тоже боевые клетки:
  // шаги, прыжки и удары работают по ним, как по зонам
  for (const o of map.objects || []) {
    if (o.kind !== 'battle') continue;
    if (Number.isInteger(o.c) && Number.isInteger(o.r) && o.c >= 0 && o.r >= 0 && o.c < map.cols && o.r < map.rows) {
      mask[o.r][o.c] = true;
    }
  }
  // Блокируют только ДЕРЕВЬЯ: камень — платформа уровня 1, его клетка
  // проходима (на неё заходит шаг по правилам рельефа). Клетки камней по-прежнему
  // остаются в obstacleBlockedCells — они используются для поиска спавна (room.js).
  const blocked = new Set();
  for (const b of obstacleBodiesOf(map)) {
    if (b.o.kind !== 'tree') continue;
    for (let r = Math.max(0, Math.floor(b.y) - 1); r <= Math.min(map.rows - 1, Math.ceil(b.y) + 1); r++) {
      for (let c = Math.max(0, Math.floor(b.x) - 1); c <= Math.min(map.cols - 1, Math.ceil(b.x) + 1); c++) {
        if (ellipseHitsCell(b, c, r)) blocked.add(`${c},${r}`);
      }
    }
  }
  for (let r = 0; r < map.rows; r++) {
    for (let c = 0; c < map.cols; c++) {
      if (mask[r][c] && (!testCellInIsland(c, r, island) || blocked.has(`${c},${r}`))) mask[r][c] = false;
    }
  }
  return mask;
}

/** Тела препятствий (камень/дерево): точка опоры, полуоси эллипса и поворот —
 *  ровно как в ObstacleBody клиента (клетка для индекса — 100×150 px). */
function obstacleBodiesOf(map) {
  return (map.objects || [])
    .filter((o) => o.kind === 'stone' || o.kind === 'tree')
    .map((o) => {
      const base = objectBase(o);
      const body = obstacleBodyPx(o);
      return {
        o,
        x: base.x,
        y: base.y,
        hw: body.hw * objectScale(o),
        h: body.h * objectScale(o),
        rot: (objectRotDeg(o) * Math.PI) / 180,
      };
    });
}

/** Клетки (0-based), задетые телами препятствий (эллипс против клетки). */
function obstacleBlockedCells(map) {
  const blocked = new Set();
  for (const b of obstacleBodiesOf(map)) {
    for (let r = Math.max(0, Math.floor(b.y) - 1); r <= Math.min(map.rows - 1, Math.ceil(b.y) + 1); r++) {
      for (let c = Math.max(0, Math.floor(b.x) - 1); c <= Math.min(map.cols - 1, Math.ceil(b.x) + 1); c++) {
        if (ellipseHitsCell(b, c, r)) blocked.add(`${c},${r}`);
      }
    }
  }
  return blocked;
}

/** Задевает ли эллипс тела клетку (0-based): точный тест в системе эллипса. */
function ellipseHitsCell(b, c, r) {
  const cx = b.x * 100;
  const cy = b.y * 150;
  const rx = b.hw + 2;
  const ry = b.h + 2;
  const ex = Math.hypot(rx * Math.cos(b.rot), ry * Math.sin(b.rot));
  const ey = Math.hypot(rx * Math.sin(b.rot), ry * Math.cos(b.rot));
  if (cx + ex < c * 100 || cx - ex > (c + 1) * 100) return false;
  if (cy + ey < r * 150 || cy - ey > (r + 1) * 150) return false;
  const cos = Math.cos(-b.rot);
  const sin = Math.sin(-b.rot);
  const hit = (px, py) => {
    const dx = px - cx;
    const dy = py - cy;
    const ux = dx * cos - dy * sin;
    const uy = dx * sin + dy * cos;
    return (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry) <= 1;
  };
  if (hit(cx, cy)) return true;
  const x0 = c * 100;
  const y0 = r * 150;
  return hit(x0, y0) || hit(x0 + 100, y0) || hit(x0, y0 + 150) || hit(x0 + 100, y0 + 150);
}

/** Точка опоры объекта в клеточных долях (зеркало objectBase из test-map.ts):
 *  свободные x/y у новых конфигов, у старых — из клетки и положения в ней. */
function objectBase(o) {
  if (Number.isFinite(o.x) && Number.isFinite(o.y)) return { x: o.x, y: o.y };
  const PO = { center: [0, 0], left: [-0.25, 0], right: [0.25, 0], top: [0, -0.25], bottom: [0, 0.25] };
  const po = PO[o.pos || 'center'] || PO.center;
  return { x: o.c + 0.5 + po[0], y: o.r + 1 + po[1] };
}

function objectSprite(o) {
  if (o.kind === 'tree') return TREE_SPRITE_IDS.has(o.spr) ? o.spr : 'tree-1';
  return ROCK_SPRITE_IDS.has(o.spr) ? o.spr : 'rock-1';
}

function objectScale(o) {
  return Number.isFinite(o.s) ? o.s : 1;
}

function objectRotDeg(o) {
  return Number.isFinite(o.rot) ? o.rot : 0;
}

/** Физическое тело препятствия у земли в px (зеркало obstacleBodyPx из test-map.ts):
 *  [полуширина, высота вверх] до масштаба. */
function obstacleBodyPx(o) {
  if (o.kind === 'tree') return { hw: 14, h: 16 };
  const dims = OBJECT_DIMS[objectSprite(o)] || [57, 42];
  return { hw: dims[0] * 0.38, h: dims[1] * 0.32 };
}

function testCellWalkable(c, r) {
  return TEST_CELLS[r]?.[c] === true;
}

/** Проходимая ли клетка в 1-based координатах сервера. */
function testWalkable(x, y) {
  return testCellWalkable(x - 1, y - 1);
}


/** Высота камня (уровней над землёй его клетки): камень — платформа уровня 1,
 *  на неё можно зайти шагом. Зеркало STONE_LEVEL из src/lib/sim/test-map.ts. */
const STONE_LEVEL = 1;

/** Кэш клеток камней текущего конфига: тест точный (эллипс против клетки),
 *  пересчёт — только при смене объекта конфига (rebuildTestGeometry всегда
 *  кладёт НОВЫЙ объект testMap — WeakMap-семантика через сравнение ссылок). */
let stoneCache = { map: null, cells: null };

/** Клетки (0-based), задетые телом КАМНЯ: камень — платформа уровня STONE_LEVEL.
 *  Поднимает эффективный уровень рельефа (см. testElev) и больше не блокирует
 *  боевую клетку (см. buildCells) — на камень забираются. */
function stoneCellsOf(map) {
  if (stoneCache.map === map && stoneCache.cells) return stoneCache.cells;
  const cells = new Set();
  for (const b of obstacleBodiesOf(map)) {
    if (b.o.kind !== 'stone') continue;
    for (let r = Math.max(0, Math.floor(b.y) - 1); r <= Math.min(map.rows - 1, Math.ceil(b.y) + 1); r++) {
      for (let c = Math.max(0, Math.floor(b.x) - 1); c <= Math.min(map.cols - 1, Math.ceil(b.x) + 1); c++) {
        if (ellipseHitsCell(b, c, r)) cells.add(`${c},${r}`);
      }
    }
  }
  stoneCache = { map, cells };
  return cells;
}

/** Уровень рельефа клетки (1-based координаты сервера; вне карты — 0).
 *  Эффективный уровень = явные высоты карты + камень (платформа STONE_LEVEL),
 *  зажатые в TERRAIN_MAX_LEVEL. Зеркало elevLevelAt клиента (test-field.ts):
 *  обе стороны считают перепады по одному правилу. */
function testElev(x, y) {
  const base = terrainAt(testMap.elev,x-.5,y-.5);
  const c = x - 1;
  const r = y - 1;
  const stone = c >= 0 && r >= 0 && c < testMap.cols && r < testMap.rows && stoneCellsOf(testMap).has(`${c},${r}`);
  return Math.min(TERRAIN_MAX_LEVEL, base + (stone ? STONE_LEVEL : 0));
}

/** Явный грунт отдельно от опоры предмета (0-based). */
function terrainPointLevelAt(x,y) { return terrainAt(testMap.elev,x,y); }
function terrainLevelAt(c, r) {
  return terrainAt(testMap.elev,c+.5,r+.5);
}
function supportLevelAt(x, y) {
  const stone = obstacleBodiesOf(testMap).some(b => {
    if (b.o.kind !== 'stone') return false;
    const dx = (x-b.x)*100, dy = (y-b.y)*150;
    const cos = Math.cos(-b.rot), sin = Math.sin(-b.rot);
    return ((dx*cos-dy*sin)/(b.hw+2))**2 + ((dx*sin+dy*cos)/(b.h+2))**2 <= 1;
  });
  return Math.min(TERRAIN_MAX_LEVEL, terrainAt(testMap.elev,x,y) + (stone ? STONE_LEVEL : 0));
}

/** Перепад больше одного уровня — стенка: шагом не проходится, только
 *  прыжком (elevJumpOk). Зеркало клиентского elevWalkBlocked.
 *  Переходы через клетку захода перепадом не считаются: заход — переход между
 *  мирами. */
/** Доля клетки на один уровень: 26px / 150px, зеркало TERRAIN_LIFT_CELLS. */
const TERRAIN_LIFT_CELLS = 26 / 150;

/** Уровень нарисованного верха под точкой в долях клетки. Зеркало surfaceLevelOf. */
function surfaceLevel(x, y) {
  const c = Math.floor(x);
  if (c < 0 || c >= TEST_WIDTH) return 0;
  const r0 = Math.floor(y);
  let best = -1;
  for (let k = 0; k <= TERRAIN_MAX_LEVEL; k++) {
    const r = r0 + k;
    if (r < 0 || r >= TEST_HEIGHT) break;
    const e = testElev(c + 1, r + 1);
    const top = r - e * TERRAIN_LIFT_CELLS;
    if (y < top || y >= top + 1) continue;
    if (e > best) best = e;
  }
  if (best >= 0) return best;
  if (r0 < 0 || r0 >= TEST_HEIGHT) return 0;
  return testElev(c + 1, r0 + 1);
}

/** Точка в южной стене обрыва. Зеркало pointInSouthWallOf. */
function inSouthWall(x, y) {
  const c = Math.floor(x);
  if (c < 0 || c >= TEST_WIDTH) return false;
  const rBase = Math.floor(y);
  for (let k = 0; k <= TERRAIN_MAX_LEVEL; k++) {
    const r = rBase - k;
    if (r < 0 || r >= TEST_HEIGHT) continue;
    const e = testElev(c + 1, r + 1);
    if (e <= 0) continue;
    const southR = r + 1;
    const south = southR < 0 || southR >= TEST_HEIGHT ? 0 : testElev(c + 1, southR + 1);
    if (e - south <= ELEV_STEP_MAX) continue;
    const yTop = r + 1 - e * TERRAIN_LIFT_CELLS;
    const yBot = r + 1 - south * TERRAIN_LIFT_CELLS;
    if (y >= yTop && y < yBot) return true;
  }
  return false;
}

/** Пересечение круглого тела у лап с клетками, отделёнными непроходимым перепадом.
 * rx/ry — радиус в долях клетки; результат 0..1 — глубина проникновения.
 * Переданный level фиксирует текущую опору, чтобы граница не меняла сторону проверки. */
const EMPTY_TERRAIN={};
function terrainBodyOverlap(x,y,rx,ry,level,levelAt) {
  return terrainBodyContact(testMap.elev??EMPTY_TERRAIN,testMap.cols,testMap.rows,x,y,rx,ry,level);
}

function cliffBetween(x0, y0, x1, y1) {
  if (testEntryCell(x0 - 1, y0 - 1) || testEntryCell(x1 - 1, y1 - 1)) return false;
  return Math.abs(testElev(x1, y1) - testElev(x0, y0)) > ELEV_STEP_MAX;
}

/** Прыжок между уровнями при доле заряда fill (0..1). Зеркало elevJumpOk
 *  в src/lib/sim/test-map.ts: |Δ|≤1 свободно, |Δ|=2 — половина шкалы,
 *  |Δ|=3 — полная, вверх на 4+ нельзя, вниз на 4+ — полная шкала. */
function elevJumpOk(from, to, fill) {
  const d = to - from;
  const ad = Math.abs(d);
  if (ad <= ELEV_STEP_MAX) return true;
  const f = Number.isFinite(fill) ? Math.min(1, Math.max(0, fill)) : 0;
  if (d > JUMP_MAX_UP) return false;
  if (ad > JUMP_MAX_DROP) return false;
  if (ad <= 2) return f >= JUMP_CHARGE_HALF;
  if (ad <= 3 || d < 0) return f >= JUMP_CHARGE_FULL;
  return false;
}

/** Ближайшая проходимая клетка (1-based) к точке в клеточных долях мира. */
function nearestTestCell(fx, fy) {
  const c0 = Math.min(TEST_WIDTH - 1, Math.max(0, Math.round(fx)));
  const r0 = Math.min(TEST_HEIGHT - 1, Math.max(0, Math.round(fy)));
  if (testCellWalkable(c0, r0)) return { x: c0 + 1, y: r0 + 1 };
  for (let rad = 1; rad < Math.max(TEST_WIDTH, TEST_HEIGHT); rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || c >= TEST_WIDTH || r < 0 || r >= TEST_HEIGHT) continue;
        if (testCellWalkable(c, r)) return { x: c + 1, y: r + 1 };
      }
    }
  }
  return null;
}

/** Клетка захода (0-based) на этой клетке или null: травяная клетка с направлением
 *  шага в бой. Проходима и в мирном режиме (это трава), и в боевом — это выход из зоны. */
function testEntryCell(c, r) {
  const o = (testMap.objects || []).find((oo) => oo.c === c && oo.r === r);
  return o && o.kind === 'entry' && o.dir ? o : null;
}

/** Пиксель маски по декодированному рисунку (для проверок sanitize до rebuild). */
function paintPxMask(decoded, x, y) {
  if (!decoded) return true;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= decoded.w || yi >= decoded.h) return false;
  return decoded.mask[yi * decoded.w + xi] === 1;
}

/** Доля закрашенных пикселей клетки по декодированному рисунку. */
function paintCellCoverageMask(decoded, c, r) {
  if (!decoded) return 1;
  const x0 = c * 100;
  const y0 = r * 150;
  if (x0 < 0 || y0 < 0 || x0 + 100 > decoded.w || y0 + 150 > decoded.h) return 0;
  let on = 0;
  for (let y = y0; y < y0 + 150; y++) {
    const row = y * decoded.w;
    for (let x = x0; x < x0 + 100; x++) on += decoded.mask[row + x];
  }
  return on / (100 * 150);
}

export {
  decodePaintPng, paintPxOn, paintCellCoverage, tracePaintLoops, traceMaskOutline,
  buildIsland, testCellInIsland, buildCells, obstacleBodiesOf, obstacleBlockedCells,
  pointInPolygon, objectBase, objectSprite, objectScale, objectRotDeg, obstacleBodyPx,
  terrainLevelAt, terrainPointLevelAt, supportLevelAt, terrainBodyOverlap, testCellWalkable, testWalkable, testElev, cliffBetween, elevJumpOk, surfaceLevel, inSouthWall, nearestTestCell, testEntryCell,
  paintPxMask, paintCellCoverageMask,
  hashStr, mulberry32, chaikin,
};
