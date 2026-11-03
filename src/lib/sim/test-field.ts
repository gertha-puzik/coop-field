/**
 * Поле комнаты «тест» — другой формат играбельной площади вместо жёсткой сетки 10×6.
 *
 * Мир: лужайка 10×7 клеток, переход направо 3×5 и закуток 6×6 (клетка 100×150 px,
 * как на обычном поле). Поверх зон нарисована локация с неровным («природным»)
 * краем: тёмная трава и земляная кромка. В боевом режиме ходьба идёт строго по
 * клеткам трёх зон, в мирном — шагами по якорным точкам (центр клетки и середины
 * её сторон), по ним же наводится мышь.
 *
 * Кромка строится один раз детерминированно (сид от кода комнаты): расширяем зоны
 * на полклетки, снимаем контур маски (марширующие квадраты), сглаживаем алгоритмом
 * Чайкина и добавляем лёгкую дрожь вершин. Сглаживание подрезает углы зон, поэтому
 * клетка считается проходимой только когда целиком внутри кромки — сетку у кромки
 * рисуем с клипом по полигону, и картинка с ходьбой всегда совпадают.
 */

/** Код комнаты с новым форматом (сервер принимает только латиницу). */
export const TEST_ROOM_ID = 'test';

/** Размер мира в клетках: 19 колонок × 7 рядов. */
export const TEST_COLS = 19;
export const TEST_ROWS = 7;

/** Зоны клеточной ходьбы (боевой режим), 0-based, включительно: [c0, r0, c1, r1]. */
export const TEST_ZONES: { name: string; c0: number; r0: number; c1: number; r1: number }[] = [
  { name: 'Лужайка', c0: 0, r0: 0, c1: 9, r1: 6 },
  { name: 'Переход', c0: 10, r0: 1, c1: 12, r1: 5 },
  { name: 'Закуток', c0: 13, r0: 0, c1: 18, r1: 5 },
];

/** Насколько (в долях клетки) нарисованная кромка отступает от играбельных зон. */
export const TEST_MARGIN = 0.5;

export type Pt = { x: number; y: number };

/* ---------- проходимость клетки с учётом кромки ---------- */

/** Полигон локации в клеточных долях — считается один раз (мир фиксированный). */
let islandPoly: Pt[] | null = null;
function islandPolygon(): Pt[] {
  if (!islandPoly) islandPoly = buildTestPolygon(TEST_ROOM_ID);
  return islandPoly;
}

/** Клетка целиком внутри нарисованной кромки: 4 угла, середины сторон и центр.
 *  Сглаженный край подрезает углы зон — такие клетки «задеты» кромкой. */
export function testCellInIsland(c: number, r: number): boolean {
  const poly = islandPolygon();
  for (let dy = 0; dy <= 2; dy++) {
    for (let dx = 0; dx <= 2; dx++) {
      if (!pointInPolygon(poly, c + dx * 0.5, r + dy * 0.5)) return false;
    }
  }
  return true;
}

/** Проходимая ли клетка мира (0-based) в боевом режиме: в зоне и не задета кромкой. */
export function testWalkableCell(c: number, r: number): boolean {
  if (!TEST_ZONES.some((z) => c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1)) return false;
  return testCellInIsland(c, r);
}

/** Клетка в зоне, но задетая кромкой (не целиком внутри) — для красной пометки. */
export function testClippedCells(): { c: number; r: number }[] {
  const out: { c: number; r: number }[] = [];
  for (let r = 0; r < TEST_ROWS; r++) {
    for (let c = 0; c < TEST_COLS; c++) {
      if (testWalkableCell(c, r)) continue;
      if (TEST_ZONES.some((z) => c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1)) out.push({ c, r });
    }
  }
  return out;
}

/** Все непроходимые клетки мира — для BFS-маршрута по клику (боевой режим). */
export function testNonWalkableCells(): { c: number; r: number }[] {
  const out: { c: number; r: number }[] = [];
  for (let r = 0; r < TEST_ROWS; r++) {
    for (let c = 0; c < TEST_COLS; c++) {
      if (!testWalkableCell(c, r)) out.push({ c, r });
    }
  }
  return out;
}

/** Ближайшая проходимая клетка (0-based) к точке в клеточных долях: спиральный поиск. */
export function nearestWalkableCell(c: number, r: number): { c: number; r: number } {
  const c0 = Math.min(TEST_COLS - 1, Math.max(0, Math.round(c)));
  const r0 = Math.min(TEST_ROWS - 1, Math.max(0, Math.round(r)));
  if (testWalkableCell(c0, r0)) return { c: c0, r: r0 };
  for (let rad = 1; rad < Math.max(TEST_COLS, TEST_ROWS); rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
        const cc = c0 + dc;
        const rr = r0 + dr;
        if (cc < 0 || cc >= TEST_COLS || rr < 0 || rr >= TEST_ROWS) continue;
        if (testWalkableCell(cc, rr)) return { c: cc, r: rr };
      }
    }
  }
  return { c: 4, r: 3 };
}

/* ---------- детерминированный шум ---------- */

/** Хэш строки в 32-битное число (FNV-1a). */
export function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Быстрый сеяный ГПСЧ — одинаковая трава у всех игроков и при перезаходах. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- контур локации ---------- */

/** Точка внутри замкнутого полигона (луч, количество пересечений нечётно). */
export function pointInPolygon(poly: Pt[], x: number, y: number): boolean {
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

/** Сглаживание Чайкина: каждый отрезок делится на две четвертные точки. */
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

function polygonBBox(poly: Pt[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * Граница маски на сетке 0,5 клетки: расширенные зоны ложатся на эту сетку
 * без остатка, поэтому объединение ячеек в точности равно маске. Собираем
 * граничные рёбра полиомино (у каждой вершины ровно два — зонных развилок нет,
 * прямоугольники перекрываются, а не касаются) и сцепляем их в один цикл.
 */
function traceMaskOutline(): [number, number][] {
  const G = 2; // единиц сетки в клетке (шаг 0,5 клетки)
  const rects = TEST_ZONES.map((z) => ({
    gx0: Math.round((z.c0 - TEST_MARGIN) * G),
    gy0: Math.round((z.r0 - TEST_MARGIN) * G),
    gx1: Math.round((z.c1 + 1 + TEST_MARGIN) * G),
    gy1: Math.round((z.r1 + 1 + TEST_MARGIN) * G),
  }));
  const minX = Math.min(...rects.map((r) => r.gx0));
  const maxX = Math.max(...rects.map((r) => r.gx1));
  const minY = Math.min(...rects.map((r) => r.gy0));
  const maxY = Math.max(...rects.map((r) => r.gy1));
  const insideCell = (gx: number, gy: number) =>
    rects.some((r) => gx >= r.gx0 && gx < r.gx1 && gy >= r.gy0 && gy < r.gy1);
  const vkey = (x: number, y: number) => `${x},${y}`;
  const edges: [number, number, number, number][] = [];
  const byVertex = new Map<string, number[]>();
  const addEdge = (x1: number, y1: number, x2: number, y2: number) => {
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
  const used = new Array<boolean>(edges.length).fill(false);
  let best: [number, number][] = [];
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
      const cands = (byVertex.get(vkey(tx, ty)) ?? []).filter((si) => !used[si]);
      if (cands.length === 0) break;
      const si = cands[0];
      used[si] = true;
      const [ex1, ey1, ex2, ey2] = edges[si];
      const next: [number, number] = ex1 === tx && ey1 === ty ? [ex2, ey2] : [ex1, ey1];
      if (next[0] === loop[0][0] && next[1] === loop[0][1]) break;
      loop.push(next);
    }
    if (loop.length > best.length) best = loop;
  }
  return best;
}

/** Полигон локации в клеточных долях: зоны + полями, сглаженный и с дрожью вершин. */
export function buildTestPolygon(seed: string): Pt[] {
  const rnd = mulberry32(hashStr(seed));
  const outline = traceMaskOutline();
  if (outline.length === 0) {
    // страховка (теоретически недостижимо): прямоугольник вокруг всех зон
    return [
      { x: -TEST_MARGIN, y: -TEST_MARGIN },
      { x: TEST_COLS + TEST_MARGIN, y: -TEST_MARGIN },
      { x: TEST_COLS + TEST_MARGIN, y: TEST_ROWS + TEST_MARGIN },
      { x: -TEST_MARGIN, y: TEST_ROWS + TEST_MARGIN },
    ];
  }
  // в клеточные доли со схлопыванием коллинеарных вершин (длинные прямые участки)
  const pts: Pt[] = [];
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
  // сглаживание Чайкина: скруглённые углы, форма «арахиса» из макета
  let poly = chaikin(pts, 3);
  // дрожь вершин: неровный «нарисованный» край (±5% клетки)
  poly = poly.map((p) => ({
    x: p.x + (rnd() * 2 - 1) * 0.05,
    y: p.y + (rnd() * 2 - 1) * 0.05,
  }));
  poly = chaikin(poly, 1);
  return poly;
}

/* ---------- якорные точки мирного режима ---------- */

/**
 * Шаги в мирном режиме идут по якорным точкам — центр и середины сторон каждой
 * клеточной зоны (в мировых клеточных долях). Точки образуют шахматную полрешётки
 * (шаг полклетки), соседние точки соединены в граф для маршрута по клику.
 * Точки вне нарисованной кромки не участвуют — мирный режим живёт внутри локации.
 */
type PeaceAnchors = {
  /** точки в клеточных долях мира */
  pts: Pt[];
  /** индексы соседей (расстояние до клетки включительно) */
  adj: number[][];
};

let peaceCache: PeaceAnchors | null = null;

function peaceAnchorData(): PeaceAnchors {
  if (peaceCache) return peaceCache;
  const poly = islandPolygon();
  const seen = new Set<string>();
  const pts: Pt[] = [];
  const add = (x: number, y: number) => {
    const k = `${x},${y}`;
    if (seen.has(k)) return;
    if (!pointInPolygon(poly, x, y)) return;
    seen.add(k);
    pts.push({ x, y });
  };
  for (let r = 0; r < TEST_ROWS; r++) {
    for (let c = 0; c < TEST_COLS; c++) {
      if (!TEST_ZONES.some((z) => c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1)) continue;
      add(c + 0.5, r + 0.5);
      add(c + 0.5, r);
      add(c + 0.5, r + 1);
      add(c, r + 0.5);
      add(c + 1, r + 0.5);
    }
  }
  // соседи: все точки в пределах клетки (полшага по осям, полшага по диагонали,
  // целая сторона) — маршрут не пересекает пустоту вне локации
  const adj: number[][] = pts.map(() => []);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = Math.abs(pts[i].x - pts[j].x);
      const dy = Math.abs(pts[i].y - pts[j].y);
      if (Math.hypot(dx, dy) <= 1.05 + 1e-9) {
        adj[i].push(j);
        adj[j].push(i);
      }
    }
  }
  peaceCache = { pts, adj };
  return peaceCache;
}

/** Все якорные точки мирного режима (клеточных долях мира). */
export function peaceAnchorPoints(): Pt[] {
  return peaceAnchorData().pts;
}

/** Ближайшая якорная точка к точке мира (клеточных долях), не дальше maxDistPx. */
export function nearestPeaceAnchor(
  wx: number,
  wy: number,
  cellW: number,
  cellH: number,
  maxDistPx: number,
): { i: number; x: number; y: number } | null {
  const { pts } = peaceAnchorData();
  let best = -1;
  let bestD = maxDistPx * maxDistPx;
  for (let i = 0; i < pts.length; i++) {
    const dx = (pts[i].x - wx) * cellW;
    const dy = (pts[i].y - wy) * cellH;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best < 0 ? null : { i: best, x: pts[best].x, y: pts[best].y };
}

/** Маршрут по якорям (индексы, без стартовой): BFS по графу соседей. */
export function peaceRoute(from: number, to: number): number[] {
  const { adj } = peaceAnchorData();
  if (from === to) return [];
  const prev = new Map<number, number>();
  const queue = [from];
  prev.set(from, -1);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === to) break;
    for (const nb of adj[cur]) {
      if (prev.has(nb)) continue;
      prev.set(nb, cur);
      queue.push(nb);
    }
  }
  if (!prev.has(to)) return [];
  const path: number[] = [];
  let cur = to;
  while (cur !== from && cur !== -1) {
    path.push(cur);
    cur = prev.get(cur) ?? -1;
  }
  path.reverse();
  return path;
}

/** Сосед якоря i в направлении dirDeg (0° вправо, по часовой): самый точный по углу
 *  (окно ±45°), угол считается в экранных пикселях с учётом неквадратной клетки. */
export function peaceStepNeighbor(i: number, dirDeg: number, cellW: number, cellH: number): number | null {
  const { pts, adj } = peaceAnchorData();
  let best = -1;
  let bestDiff = 45;
  for (const nb of adj[i] ?? []) {
    const deg = wrap360((Math.atan2((pts[nb].y - pts[i].y) * cellH, (pts[nb].x - pts[i].x) * cellW) * 180) / Math.PI);
    let diff = Math.abs(deg - dirDeg);
    if (diff > 180) diff = 360 - diff;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = nb;
    }
  }
  return best < 0 ? null : best;
}

function wrap360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/* ---------- декор: трава и цветы ---------- */

export type DecorItem = {
  kind: number;
  /** позиция в клеточных долях */
  x: number;
  y: number;
  /** масштаб 0.7..1.5 и поворот */
  s: number;
  rot: number;
  /** зерно для вариаций внутри пресета */
  v: number;
};

/** Точка в играбельных зонах (клеточных долях) — декор туда не ставим, чтобы сетка читалась. */
function inZones(x: number, y: number): boolean {
  return TEST_ZONES.some((z) => x >= z.c0 && x <= z.c1 + 1 && y >= z.r0 && y <= z.r1 + 1);
}

/** Пресеты травы и цветов: раскиданы по сиду комнаты, одинаковые у всех. */
export function buildTestDecor(poly: Pt[], seed: string, count = 110): DecorItem[] {
  const rnd = mulberry32(hashStr(seed + ':decor'));
  const bb = polygonBBox(poly);
  const items: DecorItem[] = [];
  let attempts = 0;
  while (items.length < count && attempts < 6000) {
    attempts += 1;
    const x = bb.x0 + rnd() * (bb.x1 - bb.x0);
    const y = bb.y0 + rnd() * (bb.y1 - bb.y0);
    if (!pointInPolygon(poly, x, y)) continue;
    if (inZones(x, y)) continue;
    items.push({
      kind: Math.floor(rnd() * 8),
      x,
      y,
      s: 0.75 + rnd() * 0.75,
      rot: (rnd() * 2 - 1) * 0.5,
      v: Math.floor(rnd() * 1000),
    });
  }
  return items;
}

/** Один предмет декора на канвасе: кустики травы (0–2) и цветы (3–7). */
export function drawTestDecorItem(
  ctx: CanvasRenderingContext2D,
  d: DecorItem,
  cellW: number,
  cellH: number,
): void {
  const x = d.x * cellW;
  const y = d.y * cellH;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(d.rot);
  ctx.scale(d.s * (d.v % 2 === 0 ? 1 : -1), d.s);
  if (d.kind <= 2) {
    // кустик травы: 4–6 травинок-дуг
    const blades = 4 + (d.v % 3);
    const dark = d.kind === 1;
    for (let i = 0; i < blades; i++) {
      const off = (i - (blades - 1) / 2) * 2.4;
      const h = 8 + ((d.v + i * 37) % 7);
      ctx.beginPath();
      ctx.moveTo(off * 0.4, 0);
      ctx.quadraticCurveTo(off * 0.8, -h * 0.6, off + off * 0.5, -h);
      ctx.strokeStyle = dark ? '#3b5730' : '#4d703c';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  } else {
    // цветок: стебель + 5 лепестков + сердцевина
    const colors: [string, string][][] = [
      [
        ['#e9e7da', '#d9b64a'],
        ['#f2f0e4', '#c9a23c'],
      ],
      [
        ['#e3c96a', '#8a6d2f'],
        ['#dfbf52', '#7a5f28'],
      ],
      [
        ['#cf8fb8', '#f1e3a2'],
      ],
    ];
    const group = d.kind <= 4 ? 0 : d.kind <= 6 ? 1 : 2;
    const pair = colors[group][d.v % colors[group].length];
    const [petal, center] = pair;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -5);
    ctx.strokeStyle = '#3b5730';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + (d.v % 7) * 0.1;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * 3.1, Math.sin(a) * 3.1 - 7, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = petal;
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, -7, 1.7, 0, Math.PI * 2);
    ctx.fillStyle = center;
    ctx.fill();
  }
  ctx.restore();
}

/* ---------- кэш геометрии ---------- */

type GeoCache = {
  key: string;
  polygon: Pt[];
  path: Path2D;
  /** bbox полигона в px — границы камеры */
  bboxPx: { x0: number; y0: number; x1: number; y1: number };
  decor: DecorItem[];
};

let geoCache: GeoCache | null = null;

/**
 * Геометрия локации для рисования: полигон в клеточных долях, готовый Path2D в px,
 * bbox и декор. Считается один раз; перегенерируется при смене размера клетки.
 */
export function testFieldGeometry(cellW = 100, cellH = 150): GeoCache {
  const key = `${cellW}x${cellH}`;
  if (geoCache && geoCache.key === key) return geoCache;
  const polygon = buildTestPolygon(TEST_ROOM_ID);
  const path = new Path2D();
  polygon.forEach((p, i) => {
    const px = p.x * cellW;
    const py = p.y * cellH;
    if (i === 0) path.moveTo(px, py);
    else path.lineTo(px, py);
  });
  path.closePath();
  const bb = polygonBBox(polygon);
  geoCache = {
    key,
    polygon,
    path,
    bboxPx: { x0: bb.x0 * cellW, y0: bb.y0 * cellH, x1: bb.x1 * cellW, y1: bb.y1 * cellH },
    decor: buildTestDecor(polygon, TEST_ROOM_ID),
  };
  return geoCache;
}
