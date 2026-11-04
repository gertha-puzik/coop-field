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

import {
  TEST_MAP_DEFAULT,
  OBJECT_DIMS,
  isObstacleKind,
  objectBase,
  objectRotDeg,
  objectScale,
  objectSprite,
  obstacleBodyPx,
  groundCoverOf,
  type TestMap,
  type TestMapEntryDir,
  type TestMapObject,
  type TestMapZone,
} from './test-map';
import { PACK_TUFT_COUNT, coverPattern, packImg, type PackName } from './textures';

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

/* ---------- препятствия: камни и деревья (свободная постановка) ---------- */

/** Тело препятствия для коллизий и индексов: точка опоры (доли клетки),
 *  размеры у земли (px, уже с масштабом), поворот (рад). */
export type ObstacleBody = {
  o: TestMapObject;
  /** точка опоры в клеточных долях мира */
  x: number;
  y: number;
  /** полуось по x и высота вверх по y, px мира (с масштабом) */
  hw: number;
  h: number;
  /** поворот в радианах */
  rot: number;
};

/** Расчётные клетки считаются при клетке 100×150 px — как на сервере и в бою;
 *  мирная ходьба считает точные эллипсы по фактическим размерам клетки. */
const IDX_CELL_W = 100;
const IDX_CELL_H = 150;

/** Индексы объектов локации — пересобираются при смене конфига. */
let objCache: {
  map: TestMap;
  /** тела препятствий (камень/дерево) для коллизий и рисования */
  obstacles: ObstacleBody[];
  /** клетки (0-based), задетые телом препятствия — маска боя/якорей */
  cells: Map<string, TestMapObject[]>;
  /** клеточные объекты (земля/покрытие/заход) по своей клетке */
  flat: Map<string, TestMapObject[]>;
} | null = null;

/** Задевает ли эллипс тела клетку (0-based): точный тест в системе эллипса. */
function ellipseHitsCell(b: ObstacleBody, c: number, r: number): boolean {
  const cx = b.x * IDX_CELL_W;
  const cy = b.y * IDX_CELL_H;
  const rx = b.hw + 2;
  const ry = b.h + 2;
  // быстрый отсев по bbox повёрнутого эллипса
  const ex = Math.hypot(rx * Math.cos(b.rot), ry * Math.sin(b.rot));
  const ey = Math.hypot(rx * Math.sin(b.rot), ry * Math.cos(b.rot));
  if (cx + ex < c * IDX_CELL_W || cx - ex > (c + 1) * IDX_CELL_W) return false;
  if (cy + ey < r * IDX_CELL_H || cy - ey > (r + 1) * IDX_CELL_H) return false;
  const cos = Math.cos(-b.rot);
  const sin = Math.sin(-b.rot);
  const hit = (px: number, py: number): boolean => {
    const dx = px - cx;
    const dy = py - cy;
    const ux = dx * cos - dy * sin;
    const uy = dx * sin + dy * cos;
    return (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry) <= 1;
  };
  if (hit(cx, cy)) return true; // центр эллипса в клетке (после отсева — точно да)
  const x0 = c * IDX_CELL_W;
  const y0 = r * IDX_CELL_H;
  return hit(x0, y0) || hit(x0 + IDX_CELL_W, y0) || hit(x0, y0 + IDX_CELL_H) || hit(x0 + IDX_CELL_W, y0 + IDX_CELL_H);
}

function objectIndex(): {
  obstacles: ObstacleBody[];
  cells: Map<string, TestMapObject[]>;
  flat: Map<string, TestMapObject[]>;
} {
  if (!objCache || objCache.map !== currentMap) {
    const obstacles: ObstacleBody[] = [];
    const cells = new Map<string, TestMapObject[]>();
    const flat = new Map<string, TestMapObject[]>();
    for (const o of currentMap.objects ?? []) {
      if (isObstacleKind(o.kind)) {
        const base = objectBase(o);
        const body = obstacleBodyPx(o);
        const ob: ObstacleBody = {
          o,
          x: base.x,
          y: base.y,
          hw: body.hw * objectScale(o),
          h: body.h * objectScale(o),
          rot: (objectRotDeg(o) * Math.PI) / 180,
        };
        obstacles.push(ob);
        for (let r = Math.max(0, Math.floor(ob.y) - 1); r <= Math.min(currentMap.rows - 1, Math.ceil(ob.y) + 1); r++) {
          for (let c = Math.max(0, Math.floor(ob.x) - 1); c <= Math.min(currentMap.cols - 1, Math.ceil(ob.x) + 1); c++) {
            if (ellipseHitsCell(ob, c, r)) {
              const arr = cells.get(`${c},${r}`);
              if (arr) arr.push(o);
              else cells.set(`${c},${r}`, [o]);
            }
          }
        }
      } else {
        const key = `${o.c},${o.r}`;
        const arr = flat.get(key);
        if (arr) arr.push(o);
        else flat.set(key, [o]);
      }
    }
    objCache = { map: currentMap, obstacles, cells, flat };
  }
  return objCache;
}

/** Препятствие, задевающее клетку (0-based) телом, или null — клетка свободна.
 *  Земля и покрытие — не препятствия: это наземный декор, через них ходят. */
export function testObstacleAt(c: number, r: number): TestMapObject | null {
  return objectIndex().cells.get(`${c},${r}`)?.[0] ?? null;
}

/** Любой объект, чья клетка совпадает с заданной (для редактора). */
export function testObjectAt(c: number, r: number): TestMapObject | null {
  return objectIndex().flat.get(`${c},${r}`)?.[0] ?? testObstacleAt(c, r);
}

/** Все объекты локации — для отрисовки и редактора. */
export function testObjects(): TestMapObject[] {
  return currentMap.objects ?? [];
}

/** Тела препятствий (камень/дерево) — для мирных коллизий и контуров редактора. */
export function testObstacleBodies(): ObstacleBody[] {
  return objectIndex().obstacles;
}

/* ---------- клетки захода ---------- */

/** Клетка захода (0-based) на этой клетке или null — там другой объект/пусто. */
export function testEntryAt(c: number, r: number): TestMapObject | null {
  const o = objectIndex().flat.get(`${c},${r}`)?.[0];
  return o && o.kind === 'entry' && o.dir ? o : null;
}

/** Все клетки захода локации. */
export function testEntries(): TestMapObject[] {
  return (currentMap.objects ?? []).filter((o) => o.kind === 'entry' && !!o.dir);
}

/** Строгий режим заходов: на локации есть хотя бы одна клетка захода — боевые
 *  клетки запираются (вход в бой — только с захода в боевом режиме, выход — на
 *  заход или кнопкой). Нет ни одного захода — работает прежняя открытая логика. */
export function testEntryStrict(): boolean {
  return (currentMap.objects ?? []).some((o) => o.kind === 'entry' && !!o.dir);
}

/** Точка (клеточные доли) на боевой клетке, проходимой в бою: в мирном режиме
 *  при строгих заходах такие клетки заперты — свободная ходьба в зону не пускает. */
export function testPeaceBattleBlocked(x: number, y: number): boolean {
  return testWalkableCell(Math.floor(x), Math.floor(y));
}
/** Клетки, непроходимые для боевого маршрута по клику: всё вне зон клеточной
 *  ходьбы, КРОМЕ клеток захода — маршрут может завершаться на заходе (выход). */
export function testBattleRouteBlocked(): { c: number; r: number }[] {
  const entries = new Set((currentMap.objects ?? []).filter((o) => o.kind === 'entry').map((o) => `${o.c},${o.r}`));
  const out: { c: number; r: number }[] = [];
  for (let r = 0; r < currentMap.rows; r++) {
    for (let c = 0; c < currentMap.cols; c++) {
      if (entries.has(`${c},${r}`)) continue;
      if (!testWalkableCell(c, r)) out.push({ c, r });
    }
  }
  return out;
}

/* ---------- физические тела препятствий: настоящие размеры, не клетка ---------- */

/**
 * Свободны ли ноги кота (точка опоры, клеточные доли) от физических тел
 * препятствий. Тела — «обтекаемые» эллипсы у основания спрайта с его свободной
 * позицией, масштабом и поворотом (увеличенный или развёрнутый объект занимает
 * столько же места, сколько нарисован); земля, покрытие и заходы — не тела.
 */
export function testPeaceObjectsFree(x: number, y: number, cellW: number, cellH: number): boolean {
  const px = x * cellW;
  const py = y * cellH;
  const m = 5; // запас на ширину корпуса кота у земли
  for (const b of objectIndex().obstacles) {
    const dx = px - b.x * cellW;
    const dy = py - b.y * cellH;
    const rx = b.hw + m;
    const ry = b.h + m;
    let ux = dx;
    let uy = dy;
    if (b.rot !== 0) {
      const cos = Math.cos(-b.rot);
      const sin = Math.sin(-b.rot);
      ux = dx * cos - dy * sin;
      uy = dx * sin + dy * cos;
    }
    if ((ux * ux) / (rx * rx) + (uy * uy) / (ry * ry) <= 1) return false;
  }
  return true;
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
 *  локации. Препятствия проверяет testPeaceObjectsFree по точке опоры кота —
 *  у них физические тела по настоящим размерам спрайтов, а не вся клетка. */
export function testPeacePointFree(x: number, y: number): boolean {
  return pointInPolygon(islandPolygon(), x, y);
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
    if (testObstacleAt(Math.floor(x), Math.floor(y))) return; // клетка с камнем/деревом непроходима
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

/** Один предмет декора на канвасе. Спрайты пака: травинки (kind 0–2, 16
 *  вариантов по зерну v), кустики (3–4 мелкий, 5–6 средний, 7 крупный); пока
 *  спрайт не догрузился — прежняя векторная графика.
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
  // для спрайтов поворот почти убран (пиксель-арт не любит сильных наклонов),
  // зеркало и разброс размера остаются
  ctx.rotate(d.rot * 0.3);
  const flip = d.v % 2 === 0 ? 1 : -1;
  const sprite = (name: PackName, sc: number, shadow = false): boolean => {
    const img = packImg(name);
    if (!img) return false;
    const w = img.naturalWidth * sc;
    const h = img.naturalHeight * sc;
    if (shadow) {
      ctx.beginPath();
      ctx.ellipse(0, 0, w * 0.34, w * 0.13, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fill();
    }
    ctx.imageSmoothingEnabled = false;
    ctx.scale(flip, 1);
    ctx.drawImage(img, -w / 2, -h, w, h);
    return true;
  };
  let drawn = true;
  if (d.kind <= 2) {
    // травинка: 16 нарезанных вариантов по зерну
    drawn = sprite(`tuft-${String(d.v % PACK_TUFT_COUNT).padStart(2, '0')}` as PackName, d.s * m * 1.7);
  } else if (d.kind <= 4) {
    drawn = sprite('bush-s', d.s * m * 1.15, true);
  } else if (d.kind <= 6) {
    drawn = sprite('bush-m', d.s * m * 1.15, true);
  } else {
    drawn = sprite('bush-h', d.s * m, true);
  }
  ctx.restore();
  if (drawn) return;

  // ——— запасной векторный вариант (спрайт ещё не догрузился) ———
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

/* ---------- препятствия: спрайты камня и дерева (свободные, с масштабом и поворотом) ---------- */

/**
 * Спрайт физического препятствия — картинка пака, прижатая низом-центром к точке
 * опоры. Вид, масштаб и поворот берутся из объекта (вариант spr, размер s,
 * угол rot); поворот — вокруг точки опоры. m — множитель перспективы, v — зерно
 * вариаций: у старых объектов (без явного масштаба) слегка «гуляет» размер и
 * зеркало, чтобы деревья не стояли близнецами; у новых масштаб задан в редакторе.
 */
function drawPackSprite(
  ctx: CanvasRenderingContext2D,
  name: PackName,
  targetW: number,
): boolean {
  const img = packImg(name);
  if (!img) return false;
  const w = targetW;
  const h = (w * img.naturalHeight) / img.naturalWidth;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, -w / 2, -h, w, h);
  return true;
}

export function drawTestObject(
  ctx: CanvasRenderingContext2D,
  o: TestMapObject,
  cellW: number,
  cellH: number,
  baseX: number,
  baseY: number,
  m = 1,
  v = 0,
): void {
  const flip = v % 2 === 0 ? 1 : -1;
  const legacy = typeof o.s !== 'number';
  const k = legacy ? 0.94 + (v % 5) * 0.03 : 1;
  const scale = objectScale(o);
  const sprName = objectSprite(o);
  // ширина: у legacy — «видовая» (дерево от высоты клетки, камень 54 px), у новых —
  // натуральная ширина спрайта × масштаб: камни разных видов и так разного размера
  const dims = OBJECT_DIMS[sprName] ?? [57, 42];
  const baseW = legacy ? (o.kind === 'tree' ? cellH * 0.92 * 0.813 : 54) : dims[0];
  const w = baseW * scale * m * k;
  const h = w * (dims[1] / dims[0]);
  const rot = (objectRotDeg(o) * Math.PI) / 180;
  ctx.save();
  ctx.translate(baseX, baseY);
  // тень под ногами — до поворота, остаётся «лежащей на земле»
  ctx.beginPath();
  ctx.ellipse(0, 1, w * (o.kind === 'tree' ? 0.28 : 0.42), o.kind === 'tree' ? 7 : Math.max(4, w * 0.1), 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.32)';
  ctx.fill();
  if (rot !== 0) ctx.rotate(rot);
  ctx.scale(k * flip, k);
  // спрайт пака; пока не догрузился — прежняя векторная фигура (для tree-1/rock-1)
  const ok = drawPackSprite(ctx, sprName as PackName, w / k);
  if (ok) {
    ctx.restore();
    return;
  }
  if (o.kind === 'stone') {
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

/**
 * Габарит отрисовки препятствия (px мира) — тот же расчёт, что в drawTestObject:
 * ширина по виду/масштабу/зерну, поворот вокруг точки опоры (bbox повёрнутого
 * прямоугольника). Пока текстура не догрузилась — габарит векторного заменителя.
 * Нужен для проверки «объект закрывает модельку игрока» (прозрачность перекрытия):
 * считать можно только по тем же числам, что рисуют.
 */
export function testObjectDrawRect(
  o: TestMapObject,
  cellH: number,
  baseX: number,
  baseY: number,
  m = 1,
  v = 0,
): { x0: number; y0: number; x1: number; y1: number } {
  const legacy = typeof o.s !== 'number';
  const k = legacy ? 0.94 + (v % 5) * 0.03 : 1;
  const sprName = objectSprite(o);
  const dims = OBJECT_DIMS[sprName] ?? [57, 42];
  const baseW = legacy ? (o.kind === 'tree' ? cellH * 0.92 * 0.813 : 54) : dims[0];
  const w = baseW * objectScale(o) * m * k;
  const h = w * (dims[1] / dims[0]);
  const rot = (objectRotDeg(o) * Math.PI) / 180;
  // углы прямоугольника спрайта (низ-центр в точке опоры) до поворота
  const corners = [
    [-w / 2, 0],
    [w / 2, 0],
    [-w / 2, -h],
    [w / 2, -h],
  ];
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [cx, cy] of corners) {
    const px = baseX + cx * cos - cy * sin;
    const py = baseY + cx * sin + cy * cos;
    if (px < x0) x0 = px;
    if (py < y0) y0 = py;
    if (px > x1) x1 = px;
    if (py > y1) y1 = py;
  }
  return { x0, y0, x1, y1 };
}

/* ---------- наземные покрытия: плитка/цветы/пол на клетке ---------- */

/**
 * Покрытие земли (kind «ground»): тайл пака ложится паттерном на клетку.
 * Паттерн повторяется от начала мира — соседние покрашенные клетки сходятся
 * в сплошной настил без швов. Пока текстура не догрузилась — цветная заливка
 * в тона покрытия, чтобы клетка не «моргала».
 */
export function drawGroundCover(
  ctx: CanvasRenderingContext2D,
  o: TestMapObject,
  cellW: number,
  cellH: number,
): void {
  const cv = groundCoverOf(o);
  const x0 = o.c * cellW;
  const y0 = o.r * cellH;
  const pat = coverPattern(ctx, cv);
  if (pat) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = pat;
    ctx.fillRect(x0, y0, cellW + 0.5, cellH + 0.5);
    ctx.restore();
    return;
  }
  // запасной фон: примерные тона групп покрытий
  const tone = cv.startsWith('flower')
    ? '#4a6b33'
    : cv.startsWith('slab')
      ? '#57683f'
      : cv.startsWith('floor')
        ? '#8f8d82'
        : '#42582c';
  ctx.fillStyle = tone;
  ctx.fillRect(x0, y0, cellW + 0.5, cellH + 0.5);
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

/**
 * Разметка клетки захода: светло-жёлтый градиент, вытекающий из боевой клетки
 * (яркое ребро со стороны шага, дальше — прозрачность), плюс при withCheck —
 * две галочки по центру. Галочки можно не рисовать здесь, чтобы наложить их
 * поверх спрайтов отдельным проходом (см. drawEntryCheck). cx/cy — центр клетки.
 */
export function drawEntryMark(
  ctx: CanvasRenderingContext2D,
  cellW: number,
  cellH: number,
  cx: number,
  cy: number,
  dir: TestMapEntryDir,
  withCheck = true,
): void {
  const x0 = cx - cellW / 2;
  const y0 = cy - cellH / 2;
  // градиент: от края к боевой клетке (ярко) к противоположному краю (прозрачно)
  const gx = dir === 'left' ? x0 : dir === 'right' ? x0 + cellW : cx;
  const gy = dir === 'up' ? y0 : dir === 'down' ? y0 + cellH : cy;
  const tx = dir === 'left' ? x0 + cellW : dir === 'right' ? x0 : cx;
  const ty = dir === 'up' ? y0 + cellH : dir === 'down' ? y0 : cy;
  const g = ctx.createLinearGradient(gx, gy, tx, ty);
  g.addColorStop(0, 'rgba(250, 214, 80, 0.4)');
  g.addColorStop(0.55, 'rgba(250, 214, 80, 0.14)');
  g.addColorStop(1, 'rgba(250, 214, 80, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(x0, y0, cellW, cellH);
  // светлая кромка со стороны боевой клетки — граница «входа»
  ctx.save();
  ctx.strokeStyle = 'rgba(246, 208, 61, 0.55)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  if (dir === 'left') {
    ctx.moveTo(x0 + 1, y0 + 1);
    ctx.lineTo(x0 + 1, y0 + cellH - 1);
  } else if (dir === 'right') {
    ctx.moveTo(x0 + cellW - 1, y0 + 1);
    ctx.lineTo(x0 + cellW - 1, y0 + cellH - 1);
  } else if (dir === 'up') {
    ctx.moveTo(x0 + 1, y0 + 1);
    ctx.lineTo(x0 + cellW - 1, y0 + 1);
  } else {
    ctx.moveTo(x0 + 1, y0 + cellH - 1);
    ctx.lineTo(x0 + cellW - 1, y0 + cellH - 1);
  }
  ctx.stroke();
  ctx.restore();
  if (withCheck) drawEntryCheck(ctx, cx, cy);
}

/**
 * Галочки клетки захода — отдельным проходом: их рисуют поверх котов и
 * препятствий, чтобы вход в бой читался по любой картинке на земле.
 * cx/cy — центр клетки захода в px мира.
 */
export function drawEntryCheck(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.save();
  // две галочки по центру: тёмная подложка + светлый штрих сверху (видно на траве)
  const check = (dx: number, dy: number) => {
    for (const pass of [0, 1]) {
      ctx.beginPath();
      ctx.moveTo(cx + dx - 7, cy - 1 + dy);
      ctx.lineTo(cx + dx - 2.5, cy + 4.5 + dy);
      ctx.lineTo(cx + dx + 6, cy - 6 + dy);
      ctx.strokeStyle = pass === 0 ? 'rgba(24, 32, 16, 0.5)' : 'rgba(255, 255, 255, 0.95)';
      ctx.lineWidth = pass === 0 ? 5.6 : 3;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
  };
  check(-6, 0);
  check(8, 0);
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
