/**
 * Тропинка (kind «path»): клетки объединяются в маску, контур — марширующими
 * квадратами на сетке 1/8 клетки, Чайкин + дрожь от сеяного ГПСЧ, заливка
 * паттерном земли и травинки по краю. Геометрия кэшируется с GeoCache.
 * Модуль самодостаточен (без импорта test-field), чтобы не было цикла с кэшем.
 */
import type { TestMapObject } from './test-map';
import { PACK_TUFT_COUNT, packImg, type PackName } from './textures';

type Pt = { x: number; y: number };

/** Шаг сетки контура: 1/8 клетки — гладко и дешевле PAINT_GRID=50. */
const PATH_GRID = 8;

/** FNV-1a — тот же алгоритм, что hashStr в test-field (края одинаковые у всех). */
function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chaikin(pts: Pt[], iterations: number): Pt[] {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const out: Pt[] = [];
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

/** Травинка вдоль края тропинки (тот же контракт, что DecorItem kind 0–2). */
export type PathTuft = {
  kind: number;
  x: number;
  y: number;
  s: number;
  rot: number;
  v: number;
};

/** Клетки тропинки из объектов карты. */
export function pathCellsOf(objects: TestMapObject[] | undefined): Set<string> {
  const cells = new Set<string>();
  for (const o of objects ?? []) {
    if (o.kind === 'path') cells.add(`${o.c},${o.r}`);
  }
  return cells;
}

/**
 * Контуры маски клеток: граничные рёбра сцепляются в петли, сглаживание как
 * у кромки острова. Дрожь от hashStr(seed + ':path') — одинаковая у всех.
 */
export function buildPathLoops(
  cells: Set<string>,
  cols: number,
  rows: number,
  seed: string,
): Pt[][] {
  if (cells.size === 0 || cols < 1 || rows < 1) return [];
  const G = PATH_GRID;
  const bw = cols * G;
  const bh = rows * G;
  const inside = (gx: number, gy: number): boolean => {
    if (gx < 0 || gy < 0 || gx >= bw || gy >= bh) return false;
    const c = Math.floor(gx / G);
    const r = Math.floor(gy / G);
    return cells.has(`${c},${r}`);
  };
  const edges: [number, number, number, number][] = [];
  const byVertex = new Map<string, number[]>();
  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
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
  const used = new Array<boolean>(edges.length).fill(false);
  const rnd = mulberry32(hashStr(seed + ':path'));
  const loops: Pt[][] = [];
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop: [number, number][] = [
      [edges[i][0], edges[i][1]],
      [edges[i][2], edges[i][3]],
    ];
    let guard = 0;
    while (guard++ <= edges.length) {
      const [tx, ty] = loop[loop.length - 1];
      const cands = (byVertex.get(`${tx},${ty}`) ?? []).filter((si) => !used[si]);
      if (cands.length === 0) break;
      const si = cands[0];
      used[si] = true;
      const [ex1, ey1, ex2, ey2] = edges[si];
      const next: [number, number] = ex1 === tx && ey1 === ty ? [ex2, ey2] : [ex1, ey1];
      if (next[0] === loop[0][0] && next[1] === loop[0][1]) break;
      loop.push(next);
    }
    if (loop.length < 4) continue;
    const pts: Pt[] = [];
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
  return loops;
}

/** Path2D в px мира из петель (клеточные доли). */
export function pathLoopsToPath2D(loops: Pt[][], cellW: number, cellH: number): Path2D {
  const path = new Path2D();
  for (const loop of loops) {
    loop.forEach((p, i) => {
      const px = p.x * cellW;
      const py = p.y * cellH;
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    });
    path.closePath();
  }
  return path;
}

/** Травинки вдоль контура: шаг ~12–18 px мира, только tuft (kind 0–2). */
export function buildPathTufts(loops: Pt[][], seed: string, cellW = 100, cellH = 150): PathTuft[] {
  const rnd = mulberry32(hashStr(seed + ':path-tuft'));
  const items: PathTuft[] = [];
  const stepPx = 14;
  for (const loop of loops) {
    if (loop.length < 2) continue;
    let carry = rnd() * stepPx;
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i];
      const b = loop[(i + 1) % loop.length];
      const dx = (b.x - a.x) * cellW;
      const dy = (b.y - a.y) * cellH;
      const len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      let t = carry;
      while (t < len) {
        const u = t / len;
        items.push({
          kind: Math.floor(rnd() * 3),
          x: a.x + (b.x - a.x) * u + (rnd() * 2 - 1) * 0.04,
          y: a.y + (b.y - a.y) * u + (rnd() * 2 - 1) * 0.04,
          s: 0.7 + rnd() * 0.55,
          rot: (rnd() * 2 - 1) * 0.45,
          v: Math.floor(rnd() * 1000),
        });
        t += stepPx * (0.85 + rnd() * 0.35);
      }
      carry = t - len;
    }
  }
  return items;
}

/** Процедурная плитка земли (зеркало paintDirtPattern) — без зависимости от paint.ts. */
let dirtTile: HTMLCanvasElement | null = null;
export function pathDirtPattern(ctx: CanvasRenderingContext2D): CanvasPattern | string {
  if (typeof document === 'undefined') return '#58422c';
  if (!dirtTile) {
    const cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 16;
    const g = cv.getContext('2d');
    if (!g) return '#58422c';
    g.fillStyle = '#58422c';
    g.fillRect(0, 0, 16, 16);
    let v = 7;
    const rnd = () => {
      v = (v * 1103515245 + 12345) & 0x7fffffff;
      return v / 0x7fffffff;
    };
    for (let i = 0; i < 26; i++) {
      g.fillStyle = rnd() > 0.5 ? 'rgba(38, 27, 16, 0.5)' : 'rgba(122, 98, 66, 0.45)';
      g.fillRect(Math.floor(rnd() * 16), Math.floor(rnd() * 16), 1 + Math.floor(rnd() * 2), 1);
    }
    dirtTile = cv;
  }
  return ctx.createPattern(dirtTile, 'repeat') ?? '#58422c';
}

function drawPathTuft(ctx: CanvasRenderingContext2D, d: PathTuft, cellW: number, cellH: number): void {
  const x = d.x * cellW;
  const y = d.y * cellH;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(d.rot * 0.3);
  const flip = d.v % 2 === 0 ? 1 : -1;
  const name = `tuft-${String(d.v % PACK_TUFT_COUNT).padStart(2, '0')}` as PackName;
  const img = packImg(name);
  if (img) {
    const w = img.naturalWidth * d.s * 1.7;
    const h = img.naturalHeight * d.s * 1.7;
    ctx.imageSmoothingEnabled = false;
    ctx.scale(flip, 1);
    ctx.drawImage(img, -w / 2, -h, w, h);
  } else {
    // Фоллбек до догрузки пака — короткие травинки.
    ctx.strokeStyle = '#3d6b2a';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(flip * 2, -6 * d.s, flip * (d.v % 3), -12 * d.s);
    ctx.stroke();
  }
  ctx.restore();
}

/** Заливка тропинки + травинки по краю (уже в клипе кромки острова). */
export function drawPathSurface(
  ctx: CanvasRenderingContext2D,
  path: Path2D,
  tufts: PathTuft[],
  cellW: number,
  cellH: number,
): void {
  if (!path) return;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = pathDirtPattern(ctx);
  ctx.fill(path, 'nonzero');
  // Лёгкая кромка — читается стык с травой.
  ctx.strokeStyle = 'rgba(48, 34, 20, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.stroke(path);
  ctx.restore();
  for (const d of tufts) drawPathTuft(ctx, d, cellW, cellH);
}

export type PathGeo = {
  loops: Pt[][];
  path: Path2D;
  tufts: PathTuft[];
};

/** Собрать геометрию тропинки для текущего списка объектов. */
export function buildPathGeo(
  objects: TestMapObject[] | undefined,
  cols: number,
  rows: number,
  seed: string,
  cellW: number,
  cellH: number,
): PathGeo | null {
  const cells = pathCellsOf(objects);
  if (cells.size === 0) return null;
  const loops = buildPathLoops(cells, cols, rows, seed);
  if (loops.length === 0) return null;
  return {
    loops,
    path: pathLoopsToPath2D(loops, cellW, cellH),
    tufts: buildPathTufts(loops, seed, cellW, cellH),
  };
}
