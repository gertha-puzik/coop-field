/**
 * Поле комнаты «тест» — другой формат играбельной площади вместо жёсткой сетки 10×6.
 *
 * Мир: зоны из конфига локации (см. test-map.ts; раскладка по умолчанию — лужайка
 * 10×7, переход 3×5 и закуток 6×6, клетка 100×150 px как на обычном поле). Поверх
 * зон нарисована локация с неровным («природным») краем: тёмная трава и земляная
 * кромка. В боевом режиме ходьба идёт строго по клеткам зон вида «cells», в мирном —
 * шагами по якорным точкам (центр клетки и середины её сторон, а в зелёных зонах —
 * просто трава), по ним же наводится мышь.
 *
 * Кромка строится детерминированно (сид от кода комнаты): расширяем зоны на
 * полклетки, снимаем контур маски (марширующие квадраты), сглаживаем алгоритмом
 * Чайкина и добавляем лёгкую дрожь вершин. Сглаживание подрезает углы зон, поэтому
 * клетка считается проходимой только когда целиком внутри кромки — сетку у кромки
 * рисуем с клипом по полигону, и картинка с ходьбой всегда совпадают.
 *
 * Конфиг локации редактируется редактором локации и приходит с сервера событием
 * «map»/полем field.map: setTestMap подменяет конфиг и сбрасывает все кэши —
 * следующая отрисовка и все проверки ходьбы уже считают новую локацию.
 */

import { TEST_MAP_DEFAULT, isObstacleKind, type TestMap, type TestMapObject, type TestMapZone } from './test-map';

/** Код комнаты с новым форматом (сервер принимает только латиницу). */
export const TEST_ROOM_ID = 'test';

/** Текущий конфиг локации: по умолчанию — зашитая раскладка, замещается с сервера. */
let currentMap: TestMap = TEST_MAP_DEFAULT;

/** Активный конфиг локации (для отрисовки доски, списка зон редактора и т.п.). */
export function currentTestMap(): TestMap {
  return currentMap;
}

/** Подмена конфига локации: все кэши геометрии, якорей и декора сбрасываются. */
export function setTestMap(map: TestMap): void {
  currentMap = map;
  islandPoly = null;
  peaceCache = null;
  geoCache = null;
  objCache = null;
}

/** Зона — боевая (с клетками) или зелёная (только мирный режим). */
function isCellsZone(z: TestMapZone): boolean {
  return z.kind === 'cells';
}

export type Pt = { x: number; y: number };

/* ---------- проходимость клетки с учётом кромки ---------- */

/** Полигон локации в клеточных долях — считается один раз на конфиг. */
let islandPoly: Pt[] | null = null;
function islandPolygon(): Pt[] {
  if (!islandPoly) islandPoly = buildTestPolygon(currentMap.seed);
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

/** Проходимая ли клетка мира (0-based) в боевом режиме: в зоне с клетками, не задета
 *  кромкой и не занята препятствием (камень/дерево стоят на клетке намертво;
 *  земля — наземный декор, через неё ходят). */
export function testWalkableCell(c: number, r: number): boolean {
  if (!currentMap.zones.some((z) => isCellsZone(z) && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1)) return false;
  if (testObstacleAt(c, r)) return false;
  return testCellInIsland(c, r);
}

/** Клетка зоны с клетками, задетая кромкой (не целиком внутри) — для красной пометки.
 *  Клетки с препятствиями (камень/дерево) сюда не попадают: у них своя спрайт-пометка,
 *  и красная заливка «край локации» рядом с камнем только путала бы. */
export function testClippedCells(): { c: number; r: number }[] {
  const out: { c: number; r: number }[] = [];
  for (let r = 0; r < currentMap.rows; r++) {
    for (let c = 0; c < currentMap.cols; c++) {
      if (testWalkableCell(c, r)) continue;
      if (testObstacleAt(c, r)) continue;
      if (currentMap.zones.some((z) => isCellsZone(z) && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1)) out.push({ c, r });
    }
  }
  return out;
}

/** Все непроходимые клетки мира — для BFS-маршрута по клику (боевой режим). */
export function testNonWalkableCells(): { c: number; r: number }[] {
  const out: { c: number; r: number }[] = [];
  for (let r = 0; r < currentMap.rows; r++) {
    for (let c = 0; c < currentMap.cols; c++) {
      if (!testWalkableCell(c, r)) out.push({ c, r });
    }
  }
  return out;
}

/** Ближайшая проходимая клетка (0-based) к точке в клеточных долях: спиральный поиск. */
export function nearestWalkableCell(c: number, r: number): { c: number; r: number } {
  const c0 = Math.min(currentMap.cols - 1, Math.max(0, Math.round(c)));
  const r0 = Math.min(currentMap.rows - 1, Math.max(0, Math.round(r)));
  if (testWalkableCell(c0, r0)) return { c: c0, r: r0 };
  for (let rad = 1; rad < Math.max(currentMap.cols, currentMap.rows); rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
        const cc = c0 + dc;
        const rr = r0 + dr;
        if (cc < 0 || cc >= currentMap.cols || rr < 0 || rr >= currentMap.rows) continue;
        if (testWalkableCell(cc, rr)) return { c: cc, r: rr };
      }
    }
  }
  return { c: 4, r: 3 };
}

/* ---------- препятствия: камни и деревья ---------- */

/** Индекс препятствий по клеткам — пересобирается при смене конфига локации. */
let objCache: { map: TestMap; idx: Map<string, TestMapObject> } | null = null;

function objectIndex(): Map<string, TestMapObject> {
  if (!objCache || objCache.map !== currentMap) {
    const idx = new Map<string, TestMapObject>();
    for (const o of currentMap.objects ?? []) idx.set(`${o.c},${o.r}`, o);
    objCache = { map: currentMap, idx };
  }
  return objCache.idx;
}

/** Препятствие, занимающее клетку (0-based), или null — клетка свободна.
 *  Земля препятствием не считается: это наземный декор (проталина). */
export function testObstacleAt(c: number, r: number): TestMapObject | null {
  const o = objectIndex().get(`${c},${r}`);
  return o && isObstacleKind(o.kind) ? o : null;
}

/** Любой объект на клетке (включая землю) — для отрисовки. */
export function testObjectAt(c: number, r: number): TestMapObject | null {
  return objectIndex().get(`${c},${r}`) ?? null;
}

/** Все препятствия локации — для отрисовки и редактора. */
export function testObjects(): TestMapObject[] {
  return currentMap.objects ?? [];
}

/** Все точки внутри клетки препятствия (включая границы) стоят намертво:
 *  и центр, и середины сторон, и углы — так вокруг камня остаётся чистый обход.
 *  Земля (проталина) — наземный декор: точкам она не мешает. */
function pointBlockedByObject(x: number, y: number): boolean {
  for (const o of currentMap.objects ?? []) {
    if (!isObstacleKind(o.kind)) continue;
    if (x >= o.c && x <= o.c + 1 && y >= o.r && y <= o.r + 1) return true;
  }
  return false;
}

/* ---------- точки мира: область боя, кромка, проходимость ---------- */

/** Точка (клеточные доли) внутри боевой зоны (kind «cells»): там мирный режим
 *  сменяется боем — включается привязка к клеткам и вид сверху. */
export function testPointInCellsZone(x: number, y: number): boolean {
  return currentMap.zones.some(
    (z) => isCellsZone(z) && x >= z.c0 && x <= z.c1 + 1 && y >= z.r0 && y <= z.r1 + 1,
  );
}

/** Точка (клеточные доли) внутри нарисованной кромки локации. */
export function testPointInIsland(x: number, y: number): boolean {
  return pointInPolygon(islandPolygon(), x, y);
}

/** Точка проходима в мирном режиме (свободная ходьба по пикселям): внутри кромки
 *  и не внутри препятствия (камень/дерево). Земля и боевые зоны не мешают:
 *  вход в боевую зону переключает режим, а не блокирует шаг. */
export function testPeacePointFree(x: number, y: number): boolean {
  if (!pointInPolygon(islandPolygon(), x, y)) return false;
  return !pointBlockedByObject(x, y);
}

/* ---------- перспектива мирного режима ---------- */

/** Масштаб спрайта на глубине wy (в клеточных долях мира): верхний край локации —
 *  дальний (меньше), нижний — ближний (больше). Сила эффекта анимируется камерой
 *  (camFx.dp): в бою эффект плавно гаснет до 1. */
export const PEACE_DEPTH_FAR = 0.72;
export const PEACE_DEPTH_NEAR = 1.18;

export function peaceDepthScale(wy: number): number {
  const denom = Math.max(1, currentMap.rows);
  const t = Math.min(1, Math.max(0, wy / denom));
  return PEACE_DEPTH_FAR + (PEACE_DEPTH_NEAR - PEACE_DEPTH_FAR) * t;
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
  const rects = currentMap.zones.map((z) => ({
    gx0: Math.round((z.c0 - currentMap.margin) * G),
    gy0: Math.round((z.r0 - currentMap.margin) * G),
    gx1: Math.round((z.c1 + 1 + currentMap.margin) * G),
    gy1: Math.round((z.r1 + 1 + currentMap.margin) * G),
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
      { x: -currentMap.margin, y: -currentMap.margin },
      { x: currentMap.cols + currentMap.margin, y: -currentMap.margin },
      { x: currentMap.cols + currentMap.margin, y: currentMap.rows + currentMap.margin },
      { x: -currentMap.margin, y: currentMap.rows + currentMap.margin },
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
 * Шаги в мирном режиме идут по якорным точкам — центр, середины сторон и углы
 * каждой клеточной зоны (в мировых клеточных долях). Точки образуют шахматную
 * полрешётки (шаг полклетки), соседние точки соединены в граф для маршрута
 * по клику. Точки вне нарисованной кромки не участвуют — мирный режим живёт
 * внутри локации.
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
    if (pointBlockedByObject(x, y)) return; // клетка с камнем/деревом непроходима
    seen.add(k);
    pts.push({ x, y });
  };
  for (let r = 0; r < currentMap.rows; r++) {
    for (let c = 0; c < currentMap.cols; c++) {
      if (!currentMap.zones.some((z) => c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1)) continue;
      add(c + 0.5, r + 0.5);
      add(c + 0.5, r);
      add(c + 0.5, r + 1);
      add(c, r + 0.5);
      add(c + 1, r + 0.5);
      // углы клетки — те самые «точки привязки» со скриншота (общие для соседних
      // клеток, дубли отсеивает seen)
      add(c, r);
      add(c + 1, r);
      add(c, r + 1);
      add(c + 1, r + 1);
    }
  }
  // соседи: только ближайшие точки решётки — полшага по оси (0.5) или его
  // диагональ (√0.5 ≈ 0.707). Рёбра длиной в клетку (1.0) не создаются: прыжок
  // никогда не перескакивает через промежуточную точку
  const adj: number[][] = pts.map(() => []);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = Math.abs(pts[i].x - pts[j].x);
      const dy = Math.abs(pts[i].y - pts[j].y);
      if (Math.hypot(dx, dy) <= 0.75 + 1e-9) {
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

/** Точка в зонах с клетками — декор туда не ставим, чтобы сетка читалась.
 *  Зелёные зоны наоборот живут декором: трава и цветы — их смысл. */
function inZones(x: number, y: number): boolean {
  return currentMap.zones.some(
    (z) => isCellsZone(z) && x >= z.c0 && x <= z.c1 + 1 && y >= z.r0 && y <= z.r1 + 1,
  );
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

/** Один предмет декора на канвасе: кустики травы (0–2) и цветы (3–7).
 *  m — множитель перспективы мирного режима (дальние предметы мельче). */
export function drawTestDecorItem(
  ctx: CanvasRenderingContext2D,
  d: DecorItem,
  cellW: number,
  cellH: number,
  m = 1,
): void {
  const x = d.x * cellW;
  const y = d.y * cellH;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(d.rot);
  ctx.scale(d.s * m * (d.v % 2 === 0 ? 1 : -1), d.s * m);
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

/* ---------- препятствия: спрайты камня и дерева ---------- */

/**
 * Спрайт физического препятствия — рисуется фигурами в стиле локации (никаких
 * внешних картинок: одинаковый вид на всех клиентах, нечего догружать и терять).
 * Точка опоры — (baseX, baseY) = низ клетки (основание ствола / подошва камня),
 * спрайт растёт вверх. m — множитель перспективы, v — зерно вариаций (зеркалит
 * и слегка меняет размер, чтобы деревья не стояли близнецами).
 */
export function drawTestObject(
  ctx: CanvasRenderingContext2D,
  kind: 'stone' | 'tree',
  cellW: number,
  cellH: number,
  baseX: number,
  baseY: number,
  m = 1,
  v = 0,
): void {
  const flip = v % 2 === 0 ? 1 : -1;
  const k = 0.94 + (v % 5) * 0.03;
  ctx.save();
  ctx.translate(baseX, baseY);
  ctx.scale(m * k * flip, m * k);
  // тень под ногами — общая для обоих видов
  ctx.beginPath();
  ctx.ellipse(0, 1, kind === 'tree' ? 30 : 25, kind === 'tree' ? 7 : 6, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fill();
  if (kind === 'stone') {
    // валун: основной корпус, светлая грань сверху-слева, тёмный низ, трещины и мох
    ctx.beginPath();
    ctx.moveTo(-26, 0);
    ctx.quadraticCurveTo(-32, -16, -18, -26);
    ctx.quadraticCurveTo(-6, -35, 10, -30);
    ctx.quadraticCurveTo(27, -24, 26, -9);
    ctx.quadraticCurveTo(25, -2, 18, 0);
    ctx.closePath();
    ctx.fillStyle = '#7f858e';
    ctx.fill();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#4d525a';
    ctx.stroke();
    // светлая грань
    ctx.beginPath();
    ctx.moveTo(-16, -24);
    ctx.quadraticCurveTo(-6, -32, 8, -28);
    ctx.quadraticCurveTo(0, -22, -8, -17);
    ctx.closePath();
    ctx.fillStyle = '#9aa0a9';
    ctx.fill();
    // тёмный низ
    ctx.beginPath();
    ctx.moveTo(-24, -6);
    ctx.quadraticCurveTo(-2, -12, 24, -6);
    ctx.quadraticCurveTo(20, -1, 14, 0);
    ctx.lineTo(-20, 0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(60, 64, 71, 0.55)';
    ctx.fill();
    // трещины
    ctx.strokeStyle = 'rgba(52, 56, 63, 0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(-6, -24);
    ctx.lineTo(-1, -14);
    ctx.lineTo(-8, -7);
    ctx.moveTo(12, -26);
    ctx.lineTo(9, -15);
    ctx.stroke();
    // мох у основания
    ctx.beginPath();
    ctx.ellipse(-15, -3, 8, 3.6, -0.25, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(77, 112, 60, 0.85)';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(16, -2, 5, 2.6, 0.2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // дерево: ствол с корневым расширением и крона из трёх шапок листвы
    ctx.beginPath();
    ctx.moveTo(-8, 0);
    ctx.quadraticCurveTo(-7, -22, -5.5, -44);
    ctx.lineTo(5.5, -44);
    ctx.quadraticCurveTo(7, -22, 8, 0);
    ctx.quadraticCurveTo(12, -1, 14, 2);
    ctx.lineTo(-14, 2);
    ctx.quadraticCurveTo(-12, -1, -8, 0);
    ctx.closePath();
    ctx.fillStyle = '#66452a';
    ctx.fill();
    // тёмная сторона ствола
    ctx.beginPath();
    ctx.moveTo(2, 0);
    ctx.quadraticCurveTo(4, -22, 4.5, -44);
    ctx.lineTo(5.5, -44);
    ctx.quadraticCurveTo(7, -22, 8, 0);
    ctx.closePath();
    ctx.fillStyle = '#523620';
    ctx.fill();
    // крона: общая тёмная подложка и три светлых шапки — каждая окружность отдельным
    // путём: в одном пути соединительные линии при зеркалировании дают дыры (nonzero)
    ctx.fillStyle = '#3c5f2a';
    for (const [cx2, cy2, r2] of [[-22, -60, 24], [23, -58, 25], [0, -78, 30]]) {
      ctx.beginPath();
      ctx.arc(cx2, cy2, r2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#4c7434';
    for (const [cx2, cy2, r2] of [[-14, -66, 17], [14, -64, 16], [0, -86, 20]]) {
      ctx.beginPath();
      ctx.arc(cx2, cy2, r2, 0, Math.PI * 2);
      ctx.fill();
    }
    // блики листвы
    ctx.fillStyle = 'rgba(122, 168, 84, 0.75)';
    for (const [cx2, cy2, r2] of [[-8, -88, 9], [-24, -62, 7]]) {
      ctx.beginPath();
      ctx.arc(cx2, cy2, r2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

/* ---------- наземный декор: проталина земли ---------- */

/**
 * Спрайт «земля» — проталина на траве, рисуется на самом грунте (под сеткой,
 * декором и котами). Ходьбе не мешает: это «почва», а не препятствие.
 * Центр пятна — центр клетки (x, y в px), форма и крапинки зависят от зерна v,
 * чтобы проталины не были близнецами. m — множитель перспективы.
 */
export function drawDirtPatch(
  ctx: CanvasRenderingContext2D,
  cellW: number,
  cellH: number,
  x: number,
  y: number,
  v = 0,
): void {
  const flip = v % 2 === 0 ? 1 : -1;
  const k = 0.92 + (v % 4) * 0.04;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k * flip, k);
  const w = cellW * 0.5;
  const h = cellH * 0.5;
  // неровное пятно: 8-угольник с дрожью вершин по зерну
  ctx.beginPath();
  const n = 8;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const wob = 0.82 + (((v * 37 + i * 61) % 23) / 23) * 0.26;
    const px = Math.cos(a) * w * wob;
    const py = Math.sin(a) * h * wob;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  // земля: тёмный край, основа, светлая середина
  ctx.fillStyle = '#3c2c1c';
  ctx.fill();
  ctx.save();
  ctx.scale(0.88, 0.84);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const wob = 0.85 + (((v * 53 + i * 29) % 19) / 19) * 0.2;
    const px = Math.cos(a) * w * wob;
    const py = Math.sin(a) * h * wob;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = '#58422c';
  ctx.fill();
  ctx.restore();
  // борозды/крапинки: тёмные комки и светлые крупинки
  const rndBits = 5 + (v % 3);
  for (let i = 0; i < rndBits; i++) {
    const a = (((v * 31 + i * 97) % 100) / 100) * Math.PI * 2;
    const rr = 0.15 + (((v * 17 + i * 43) % 100) / 100) * 0.55;
    const px = Math.cos(a) * w * rr;
    const py = Math.sin(a) * h * rr;
    const dark = (v + i) % 2 === 0;
    ctx.beginPath();
    ctx.ellipse(px, py, 2.4, 1.6, a, 0, Math.PI * 2);
    ctx.fillStyle = dark ? 'rgba(38, 27, 16, 0.75)' : 'rgba(122, 98, 66, 0.6)';
    ctx.fill();
  }
  // травинки по краю — переход проталины в траву
  for (let i = 0; i < 3; i++) {
    const a = (((v * 13 + i * 71) % 100) / 100) * Math.PI * 2;
    const px = Math.cos(a) * w * 0.95;
    const py = Math.sin(a) * h * 0.95;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(px + 2, py - 4, px + (i % 2 === 0 ? 4 : -3), py - 6);
    ctx.strokeStyle = 'rgba(77, 112, 60, 0.9)';
    ctx.lineWidth = 1.3;
    ctx.stroke();
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
  const polygon = buildTestPolygon(currentMap.seed);
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
    decor: buildTestDecor(polygon, currentMap.seed),
  };
  return geoCache;
}
