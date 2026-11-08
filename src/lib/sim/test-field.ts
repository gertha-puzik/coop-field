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
  mapHasPaint,
  mapElevOf,
  pointInSouthWallOf,
  surfaceLevelOf,
  objectBase,
  objectMir,
  objectRotDeg,
  objectScale,
  objectSprite,
  obstacleBodyPx,
  groundCoverOf,
  STONE_LEVEL,
  TERRAIN_MAX_LEVEL,
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

/** Подмена конфига локации: все кэши геометрии, якорей и декора сбрасываются.
 *  Пиксельная отрисовка: если в конфиге рисунок и он уже декодирован — остаётся;
 *  новый рисунок сбрасывает декод (до готовности форма локации считается по зонам,
 *  как в конфигах до кисти). */
export function setTestMap(map: TestMap): void {
  currentMap = map;
  islandPoly = null;
  islandLoopsCache = undefined;
  cellClipCache.clear();
  cellClipFull = null;
  peaceCache = null;
  geoCache = null;
  objCache = null;
  if (mapHasPaint(map)) {
    if (paintPng !== map.paint) {
      paintPng = map.paint ?? null;
      paintCv = null;
      paintMask = null;
      paintW = 0;
      paintH = 0;
    }
  } else {
    paintPng = null;
    paintCv = null;
    paintMask = null;
    paintW = 0;
    paintH = 0;
  }
}

/** Зона — боевая (с клетками) или зелёная (только мирный режим). */
function isCellsZone(z: TestMapZone): boolean {
  return z.kind === 'cells';
}

export type Pt = { x: number; y: number };

/* ---------- пиксельная отрисовка: декод рисунка, маска земли, контур ---------- */

/** Канонический размер клетки для пиксельной отрисовки: рисунок локации всегда
 *  хранится в пикселях мира cols*100 x rows*150 — одна и та же геометрия у всех
 *  игроков и на сервере, независимо от локальных настроек клетки. При отрисовке
 *  рисунок растягивается на фактический размер клетки. */
export const PAINT_CELL_W = 100;
export const PAINT_CELL_H = 150;

/** Запрошенный (ещё не декодированный или декодированный) PNG локации. */
let paintPng: string | null = null;
/** Декодированный рисунок: канвас — для отрисовки, маска — для контура. */
let paintCv: HTMLCanvasElement | null = null;
let paintMask: Uint8Array | null = null; // 0/1 по пикселям (альфа > 127 — земля)
let paintW = 0;
let paintH = 0;

/** Декодированный канвас отрисовки (null — нет рисунка или ещё не готов). */
export function paintCanvas(): HTMLCanvasElement | null {
  return paintCv;
}

/** Есть ли у текущей локации пиксельная отрисовка. */
export function paintActive(): boolean {
  return paintPng != null;
}

/** Готов ли рисунок (декодирован) — до готовности форма считается по зонам. */
export function paintReady(): boolean {
  return paintCv != null && paintMask != null;
}

/**
 * Декодировать PNG локации (если он ещё не декодирован) и пересобрать кэши
 * геометрии: контур локации теперь идёт по маске рисунка. Возвращает true,
 * когда рисунок готов (или локация без рисунка); false — декодировать нечем.
 * Decoding асинхронный (Image), вызывается после каждой смены конфига.
 */
export function ensurePaintDecoded(): Promise<boolean> {
  if (!paintPng) return Promise.resolve(false);
  if (paintCv && paintMask) return Promise.resolve(true);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      if (!paintPng) return resolve(false);
      const wExpected = currentMap.cols * PAINT_CELL_W;
      const hExpected = currentMap.rows * PAINT_CELL_H;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (w !== wExpected || h !== hExpected) {
        // Чужой размер — рисунок не применяем (форма остаётся по зонам).
        paintPng = null;
        return resolve(false);
      }
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const g = cv.getContext('2d', { willReadFrequently: true });
      if (!g) return resolve(false);
      g.imageSmoothingEnabled = false;
      g.drawImage(img, 0, 0);
      let data: Uint8ClampedArray;
      try {
        data = g.getImageData(0, 0, w, h).data;
      } catch {
        return resolve(false);
      }
      const mask = new Uint8Array(w * h);
      for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 127 ? 1 : 0;
      paintCv = cv;
      paintMask = mask;
      paintW = w;
      paintH = h;
      islandPoly = null;
      geoCache = null;
      cellClipCache.clear();
      cellClipFull = null;
      resolve(true);
    };
    img.onerror = () => {
      paintPng = null; // битый рисунок — локация живёт по зонам
      resolve(false);
    };
    img.src = `data:image/png;base64,${paintPng}`;
  });
}

/**
 * Подмена активного рисунка готовым канвасом (редактор рисует мазки прямо в
 * свой черновой холст — картинка на поле обновляется без декодирования PNG).
 * rebuild=false — во время мазка: маска обновляется, контур пересчитается по
 * окончании мазка (марширующие квадраты на весь мир каждый кадр — дорого).
 */
export function setPaintOverride(cv: HTMLCanvasElement | null, rebuild: boolean): void {
  paintCv = cv;
  paintW = cv?.width ?? 0;
  paintH = cv?.height ?? 0;
  if (cv) {
    const g = cv.getContext('2d', { willReadFrequently: true });
    if (g) {
      try {
        const data = g.getImageData(0, 0, cv.width, cv.height).data;
        const mask = new Uint8Array(cv.width * cv.height);
        for (let i = 0; i < mask.length; i++) mask[i] = data[i * 4 + 3] > 127 ? 1 : 0;
        paintMask = mask;
      } catch {
        paintMask = null;
      }
    }
  } else {
    paintMask = null;
  }
  if (rebuild) {
    islandPoly = null;
    islandLoopsCache = undefined;
    geoCache = null;
    cellClipCache.clear();
    cellClipFull = null;
  }
}

/* ---------- клипы клеток рельефа: дешёвая замена полного контура ---------- */

/**
 * Клип-пути клеток плато. Раньше каждая клетка рельефа (верх и стена) вырезала
 * себя полным контуром локации (Path2D на десятки тысяч вершин, марширующие
 * квадраты + сглаживание): на локации с рельефом это ~180 клипов за кадр —
 * на слабых машинах именно это «сильно тормозило», а в программном рендере
 * подвешивало вкладку намертво. Теперь: клетка целиком внутри кромки — клип не
 * нужен вовсе; клетка на кромке — маленький путь по маске рисунка (граница
 * следует самому пикселю кисти, без сглаживания); без рисунка — полный контур,
 * как раньше.
 */

/** Кэш клип-путей клеток; ключ «c,r@cellWxcellH». */
const cellClipCache = new Map<string, Path2D | null>();
/** Полный контур локации для клипов (случай без рисунка кисти). */
let cellClipFull: Path2D | null = null;

/** Сетка клипа клетки: шаг 2 px канонического мира — как PAINT_GRID у контура. */
const CELL_CLIP_STEP = 2;

/** Закрашен ли пиксель маски (без выхода за границы — false). */
function maskAt(x: number, y: number): boolean {
  if (!paintMask) return true;
  if (x < 0 || y < 0 || x >= paintW || y >= paintH) return false;
  return paintMask[y * paintW + x] === 1;
}

/** Ячейка сетки клипа закрашена, если под ней есть хоть один непрозрачный пиксель
 *  (клип разрешающий: режет только то, что и так за пределами кисти). */
function clipCellOn(px: number, py: number): boolean {
  for (let dy = 0; dy < CELL_CLIP_STEP; dy++) {
    for (let dx = 0; dx < CELL_CLIP_STEP; dx++) {
      if (maskAt(px + dx, py + dy)) return true;
    }
  }
  return false;
}

/** Полный контур локации как Path2D (клеточные доли × размер клетки). */
function fullClipPath(cellW: number, cellH: number): Path2D {
  if (cellClipFull) return cellClipFull;
  const path = new Path2D();
  const loops = islandLoops();
  const build = (l: Pt[]) => {
    l.forEach((p, i) => {
      const px = p.x * cellW;
      const py = p.y * cellH;
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    });
    path.closePath();
  };
  if (loops) {
    for (const l of loops) build(l);
  } else {
    build(islandPolygon());
  }
  cellClipFull = path;
  return path;
}

/**
 * Клип-путь клетки рельефа (в px мира, как рисуется плато): null — клип не
 * нужен (клетка с запасом на подъём целиком внутри кромки). Регион проверки и
 * резки — клетка, поднятая на максимальный уровень рельефа: верх плато
 * рисуется со сдвигом вверх, и именно он мог вылезти за кромку.
 */
export function terrainCellClipPath(c: number, r: number, cellW: number, cellH: number): Path2D | null {
  const key = `${c},${r}@${cellW}x${cellH}`;
  const hit = cellClipCache.get(key);
  if (hit !== undefined) return hit;
  let out: Path2D | null = null;
  if (!paintReady()) {
    // Локация без рисунка: форма по зонам — режем полным контуром, как раньше.
    out = fullClipPath(cellW, cellH);
  } else {
    // Регион клетки с запасом вверх на максимальный подъём (и пара пикселей
    // на стыки): верх плато уезжает вверх, стена остаётся в клетке.
    const y0px = r * PAINT_CELL_H - TERRAIN_MAX_LEVEL * TERRAIN_LIFT_PX - 2;
    const y1px = (r + 1) * PAINT_CELL_H + 2;
    const x0px = c * PAINT_CELL_W - 2;
    const x1px = (c + 1) * PAINT_CELL_W + 2;
    const gx0 = Math.floor(x0px / CELL_CLIP_STEP);
    const gy0 = Math.floor(y0px / CELL_CLIP_STEP);
    const gx1 = Math.ceil(x1px / CELL_CLIP_STEP);
    const gy1 = Math.ceil(y1px / CELL_CLIP_STEP);
    // Быстрый тест «клетка целиком на земле»: если вся область региона закрашена
    // — клип не нужен; если вся пуста — рисовать нечего (пустой путь).
    let any = false;
    let all = true;
    for (let gy = gy0; gy < gy1 && (all || !any); gy++) {
      for (let gx = gx0; gx < gx1; gx++) {
        if (clipCellOn(gx * CELL_CLIP_STEP, gy * CELL_CLIP_STEP)) any = true;
        else all = false;
        if (any && !all) break;
      }
    }
    if (all) {
      out = null; // целиком над закрашенной землёй — режется только за кромкой мира
    } else {
      // Кромка пересекает регион: маленький путь по маске (граничные рёбра
      // ячеек сетки сцепляются в замкнутые петли — как у большого контура).
      out = buildCellClipLoops(gx0, gy0, gx1, gy1, cellW, cellH);
    }
  }
  cellClipCache.set(key, out);
  return out;
}

/** Петли маски внутри региона → Path2D в px мира. */
function buildCellClipLoops(gx0: number, gy0: number, gx1: number, gy1: number, cellW: number, cellH: number): Path2D {
  const path = new Path2D();
  const on = (gx: number, gy: number): boolean => {
    if (gx < gx0 || gy < gy0 || gx >= gx1 || gy >= gy1) return false;
    return clipCellOn(gx * CELL_CLIP_STEP, gy * CELL_CLIP_STEP);
  };
  // горизонтальные рёбра: (gx,gy)-(gx+1,gy) — граница между «on» сверху и снизу
  const hKey = (gx: number, gy: number) => `${gx},${gy}h`;
  const vKey = (gx: number, gy: number) => `${gx},${gy}v`;
  const hEdges = new Map<string, [number, number, number, number]>(); // ключ → px мира
  const vEdges = new Map<string, [number, number, number, number]>();
  const byVertex = new Map<string, string[]>();
  const link = (vk: string, ek: string) => {
    const arr = byVertex.get(vk);
    if (arr) arr.push(ek);
    else byVertex.set(vk, [ek]);
  };
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const cur = on(gx, gy);
      const up = gy > gy0 ? on(gx, gy - 1) : false;
      const left = gx > gx0 ? on(gx - 1, gy) : false;
      if (cur !== up) {
        // горизонтальное ребро на y = gy*step
        const x0 = gx * CELL_CLIP_STEP;
        const x1 = (gx + 1) * CELL_CLIP_STEP;
        const y = gy * CELL_CLIP_STEP;
        const k = hKey(gx, gy);
        hEdges.set(k, [x0, y, x1, y]);
        link(`${gx},${gy}`, k);
        link(`${gx + 1},${gy}`, k);
      }
      if (cur !== left) {
        const y0 = gy * CELL_CLIP_STEP;
        const y1 = (gy + 1) * CELL_CLIP_STEP;
        const x = gx * CELL_CLIP_STEP;
        const k = vKey(gx, gy);
        vEdges.set(k, [x, y0, x, y1]);
        link(`${gx},${gy}`, k);
        link(`${gx},${gy + 1}`, k);
      }
    }
  }
  const used = new Set<string>();
  for (const startKey of [...hEdges.keys(), ...vEdges.keys()]) {
    if (used.has(startKey)) continue;
    used.add(startKey);
    const e0 = hEdges.get(startKey) ?? vEdges.get(startKey)!;
    const loop: [number, number][] = [[e0[0], e0[1]], [e0[2], e0[3]]];
    let guard = 0;
    while (guard++ <= hEdges.size + vEdges.size) {
      const [tx, ty] = loop[loop.length - 1];
      const cands = (byVertex.get(`${Math.round(tx / CELL_CLIP_STEP)},${Math.round(ty / CELL_CLIP_STEP)}`) ?? []).filter((k) => !used.has(k));
      if (cands.length === 0) break;
      const nk = cands[0];
      used.add(nk);
      const e = hEdges.get(nk) ?? vEdges.get(nk)!;
      const next: [number, number] = e[0] === tx && e[1] === ty ? [e[2], e[3]] : [e[0], e[1]];
      if (next[0] === loop[0][0] && next[1] === loop[0][1]) break;
      loop.push(next);
    }
    if (loop.length >= 4) {
      loop.forEach(([px, py], i) => {
        const wx = (px / PAINT_CELL_W) * cellW;
        const wy = (py / PAINT_CELL_H) * cellH;
        if (i === 0) path.moveTo(wx, wy);
        else path.lineTo(wx, wy);
      });
      path.closePath();
    }
  }
  return path;
}

/** Пиксель маски (канонические px мира): закрашен ли. Вне рисунка — true,
 *  чтобы проверки не «отрезали» локацию без рисунка. */
function paintPx(x: number, y: number): boolean {
  if (!paintMask) return true;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  if (xi < 0 || yi < 0 || xi >= paintW || yi >= paintH) return false;
  return paintMask[yi * paintW + xi] === 1;
}

/** Точка (клеточные доли) на закрашенной земле: пиксель маски под точкой. */
export function paintPointOn(x: number, y: number): boolean {
  return paintPx(x * PAINT_CELL_W, y * PAINT_CELL_H);
}

/** Доля закрашенных пикселей клетки (0-based) — годится ли место под боевую
 *  клетку/заход: объект ставится только на место, покрашенное целиком. */
export function paintCellCoverage(c: number, r: number): number {
  if (!paintMask) return 1;
  const x0 = c * PAINT_CELL_W;
  const y0 = r * PAINT_CELL_H;
  if (x0 < 0 || y0 < 0 || x0 + PAINT_CELL_W > paintW || y0 + PAINT_CELL_H > paintH) return 0;
  let on = 0;
  for (let y = y0; y < y0 + PAINT_CELL_H; y++) {
    const row = y * paintW;
    for (let x = x0; x < x0 + PAINT_CELL_W; x++) on += paintMask[row + x];
  }
  return on / (PAINT_CELL_W * PAINT_CELL_H);
}

/** Шаг сетки контура маски: 1/50 клетки (2x3 px канонического мира) — контур
 *  повторяет кисть достаточно гладко, а циклов обхода немного. */
const PAINT_GRID = 50;

/**
 * Контуры закрашенной области на сетке 1/50 клетки: граничные рёбра ячеек
 * (у каждой вершины ровно два ребра контура) сцепляются в циклы — все острова
 * и дыры. Возвращает список петель в клеточных долях; направление обхода у
 * внешних границ и дыр противоположное — заливка nonzero рисует дыры дырками.
 */
function tracePaintLoops(): Pt[][] {
  if (!paintMask) return [];
  const G = PAINT_GRID;
  const bw = currentMap.cols * G;
  const bh = currentMap.rows * G;
  // ячейка сетки закрашена, только если закрашены все её пиксели (строго):
  // ходьба чуть меньше нарисованного — безопасно, наоборот не бывает
  const inside = (gx: number, gy: number): boolean => {
    if (gx < 0 || gy < 0 || gx >= bw || gy >= bh) return false;
    const x0 = Math.round((gx * PAINT_CELL_W) / G);
    const y0 = Math.round((gy * PAINT_CELL_H) / G);
    const x1 = Math.round(((gx + 1) * PAINT_CELL_W) / G);
    const y1 = Math.round(((gy + 1) * PAINT_CELL_H) / G);
    for (let y = y0; y < y1; y++) {
      const row = y * paintW!;
      for (let x = x0; x < x1; x++) {
        if (paintMask![row + x] !== 1) return false;
      }
    }
    return true;
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
    if (loop.length >= 4) {
      // в клеточные доли со схлопыванием коллинеарных вершин
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
      // сглаживание кистевого угловатого края: Чайкин ×3, дрожь ±2% клетки, Чайкин ×1
      let poly = chaikin(pts, 3);
      poly = poly.map((p) => ({
        x: p.x + (rndShared() * 2 - 1) * 0.02,
        y: p.y + (rndShared() * 2 - 1) * 0.02,
      }));
      poly = chaikin(poly, 1);
      loops.push(poly);
    }
  }
  return loops;
}

/** Общий сеяный ГПСЧ контура (один на конфиг — последовательность вызовов фиксирована). */
let rndShared: () => number = Math.random;

/**
 * Полигон локации из пиксельной отрисовки: все петли контура одна за другой.
 * Лучевые проверки (pointInPolygon) считают нечётность пересечений — петли
 * вместе работают как единая фигура с дырками.
 */
function buildPaintPolygon(): Pt[] {
  rndShared = mulberry32(hashStr(currentMap.seed + ':paint'));
  const loops = tracePaintLoops();
  if (loops.length === 0) {
    return [
      { x: 0, y: 0 },
      { x: currentMap.cols, y: 0 },
      { x: currentMap.cols, y: currentMap.rows },
      { x: 0, y: currentMap.rows },
    ];
  }
  const out: Pt[] = [];
  for (const l of loops) out.push(...l);
  return out;
}

/* ---------- проходимость клетки с учётом кромки ---------- */

/** Полигон локации в клеточных долях — считается один раз на конфиг.
 *  С готовой пиксельной отрисовкой контур идёт по маске рисунка (кисть задаёт
 *  форму локации), без него — по зонам, как в конфигах до кисти. */
let islandPoly: Pt[] | null = null;
let islandLoopsCache: Pt[][] | null | undefined;
function islandPolygon(): Pt[] {
  if (!islandPoly) {
    if (paintReady()) {
      const loops = tracePaintLoops();
      islandLoopsCache = loops;
      const flat: Pt[] = [];
      for (const l of loops) flat.push(...l);
      islandPoly = flat.length > 0 ? flat : buildTestPolygon(currentMap.seed);
    } else {
      islandLoopsCache = null;
      islandPoly = buildTestPolygon(currentMap.seed);
    }
  }
  return islandPoly;
}

/** Петли контура (для Path2D с отдельными подпутями); null — контур одиночный. */
function islandLoops(): Pt[][] | null {
  islandPolygon();
  return islandLoopsCache ?? null;
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

/** Боевая ли клетка (0-based): клетка зон вида «cells» или одиночная боевая
 *  клетка (объект kind «battle», ставится на закрашенное кистью место). */
export function isBattleCell(c: number, r: number): boolean {
  if (currentMap.zones.some((z) => isCellsZone(z) && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1)) return true;
  return (currentMap.objects ?? []).some((o) => o.kind === 'battle' && o.c === c && o.r === r);
}

/** Проходимая ли клетка мира (0-based) в боевом режиме: боевая клетка (зона или
 *  одиночная), не задета кромкой и не занята деревом. Камень — платформа
 *  уровня 1: его клетка проходима, на неё заходит шаг (перепад 1). Земля —
 *  наземный декор, через неё ходят. Зеркало buildCells на сервере. */
export function testWalkableCell(c: number, r: number): boolean {
  if (!isBattleCell(c, r)) return false;
  if (treeAtCell(c, r)) return false;
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
      if (isBattleCell(c, r)) out.push({ c, r });
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
  /** клетки (0-based), задетые телом КАМНЯ: камень — платформа уровня 1
   *  (поднимает рельеф и больше не блокирует ходьбу, см. elevLevelAt) */
  stoneCells: Set<string>;
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
  stoneCells: Set<string>;
  flat: Map<string, TestMapObject[]>;
} {
  if (!objCache || objCache.map !== currentMap) {
    const obstacles: ObstacleBody[] = [];
    const cells = new Map<string, TestMapObject[]>();
    const stoneCells = new Set<string>();
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
              if (o.kind === 'stone') stoneCells.add(`${c},${r}`);
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
    objCache = { map: currentMap, obstacles, cells, stoneCells, flat };
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

/** Насколько глубоко точка (клеточные доли) внутри боевых зон вдоль оси —
 *  расстояние в долях клетки до ближайшей кромки зоны по этой оси; 0 — точка
 *  вне зон (или на самой кромке). Стенка мирной ходьбы стоит на этой кромке. */
export function testPeaceBattleDepth(x: number, y: number, axis: 'x' | 'y'): number {
  let best = 0;
  for (const z of currentMap.zones) {
    if (!isCellsZone(z)) continue;
    if (axis === 'x') {
      if (y >= z.r0 && y <= z.r1 + 1 && x > z.c0 && x < z.c1 + 1) {
        best = Math.max(best, Math.min(x - z.c0, z.c1 + 1 - x));
      }
    } else {
      if (x >= z.c0 && x <= z.c1 + 1 && y > z.r0 && y < z.r1 + 1) {
        best = Math.max(best, Math.min(y - z.r0, z.r1 + 1 - y));
      }
    }
  }
  return best;
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
export function testPeaceObjectDepth(x: number, y: number, cellW: number, cellH: number, bodyRadius = 5): number {
  const px = x * cellW;
  const py = y * cellH;
  const m = bodyRadius; // физическое тело кота у лап, а не нулевая точка
  let overlap = 0;
  for (const b of objectIndex().obstacles) {
    if (b.o.kind === 'stone') continue; // камень — платформа: кот заходит НА клетку камня, тело не стена
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
    overlap = Math.max(overlap,1-Math.hypot(ux/rx,uy/ry));
  }
  return overlap;
}

export function testPeaceObjectsFree(x: number, y: number, cellW: number, cellH: number, bodyRadius = 5): boolean {
  return testPeaceObjectDepth(x,y,cellW,cellH,bodyRadius) <= 0;
}

/* ---------- точки мира: область боя, кромка, проходимость ---------- */

/** Точка (клеточные доли) внутри боевой зоны (kind «cells»): там мирный режим
 *  сменяется боем — включается привязка к клеткам и вид сверху. */
export function testPointInCellsZone(x: number, y: number): boolean {
  const c = Math.floor(x);
  const r = Math.floor(y);
  if (c >= 0 && r >= 0 && (currentMap.objects ?? []).some((o) => o.kind === 'battle' && o.c === c && o.r === r)) {
    return true;
  }
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

/* ---------- рельеф: уровни высоты, плато и обрывы ---------- */

/** Подъём экранной земли на один уровень рельефа, px мира. Клетка 150 px высотой,
 *  26 px — заметный уступ, не ломающий чтение поля. */
export const TERRAIN_LIFT_PX = 26;

/** Уровень рельефа клетки (0-based) текущей локации: 0 — базовая земля,
 *  до TERRAIN_MAX_LEVEL. Правила общие с сервером (testElev): перепад больше
 *  одного уровня — стенка, шагом не проходится (см. elevWalkBlocked). */
/** Клетка (0-based) под телом камня — платформа уровня 1. */
function stoneCellAt(c: number, r: number): boolean {
  return objectIndex().stoneCells.has(`${c},${r}`);
}

/** Клетка (0-based) под телом ДЕРЕВА: дерево — единственное оставшееся
 *  непроходимое препятствие (камень — платформа, на него забираются). */
function treeAtCell(c: number, r: number): boolean {
  return (objectIndex().cells.get(`${c},${r}`) ?? []).some((o) => o.kind === 'tree');
}

export function elevLevelAt(c: number, r: number): number {
  // Камень — платформа уровня STONE_LEVEL: эффективный уровень клетки = явные
  // высоты карты + камень, зажатые в TERRAIN_MAX_LEVEL (зеркало testElev в
  // server/world.js — обе стороны считают перепады по одному правилу).
  return Math.min(TERRAIN_MAX_LEVEL, mapElevOf(currentMap, c, r) + (stoneCellAt(c, r) ? STONE_LEVEL : 0));
}

/** Эффективная карта высот (редкая, ключи «c,r» → уровень): явные высоты карты
 *  плюс клетки камней (платформа STONE_LEVEL), всё зажато в TERRAIN_MAX_LEVEL.
 *  Единый источник для отрисовки рельефа (2D plateau-pass и атлас/геометрия
 *  WebGL) — логика ходьбы читает elevLevelAt напрямую. */
let effElevCache: { map: TestMap; rec: Record<string, number> } | null = null;
export function effectiveElevRecord(map: TestMap): Record<string, number> {
  if (effElevCache && effElevCache.map === map) return effElevCache.rec;
  const rec: Record<string, number> = {};
  for (const [key, v] of Object.entries(map.elev ?? {})) {
    const base = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
    if (base <= 0) continue;
    const [c, r] = key.split(',').map(Number);
    if (!Number.isFinite(c) || !Number.isFinite(r) || c < 0 || r < 0 || c >= map.cols || r >= map.rows) continue;
    rec[key] = Math.min(TERRAIN_MAX_LEVEL, base + (stoneCellAt(c, r) ? STONE_LEVEL : 0));
  }
  if (map === currentMap) {
    for (const key of objectIndex().stoneCells) {
      if (rec[key] != null) continue;
      rec[key] = Math.min(TERRAIN_MAX_LEVEL, STONE_LEVEL);
    }
  } else {
    // чужой конфиг (не текущий): считаем клетки камней напрямую
    for (const o of map.objects ?? []) {
      if (o.kind !== 'stone') continue;
      const base = objectBase(o);
      const body = obstacleBodyPx(o);
      const ob = { o, x: base.x, y: base.y, hw: body.hw * objectScale(o), h: body.h * objectScale(o), rot: (objectRotDeg(o) * Math.PI) / 180 };
      for (let r = Math.max(0, Math.floor(ob.y) - 1); r <= Math.min(map.rows - 1, Math.ceil(ob.y) + 1); r++) {
        for (let c = Math.max(0, Math.floor(ob.x) - 1); c <= Math.min(map.cols - 1, Math.ceil(ob.x) + 1); c++) {
          const key = `${c},${r}`;
          if (rec[key] == null && ellipseHitsCell(ob, c, r)) rec[key] = Math.min(TERRAIN_MAX_LEVEL, STONE_LEVEL);
        }
      }
    }
  }
  effElevCache = { map, rec };
  return rec;
}

/** Есть ли рельеф на локации — быстрый пропуск целых проходов отрисовки.
 *  Камни — платформы уровня 1: рельефная отрисовка нужна и без явных высот. */
export function elevAny(): boolean {
  const e = currentMap.elev;
  if (e && Object.keys(e).length > 0) return true;
  for (const o of currentMap.objects ?? []) {
    if (o.kind === 'stone') return true;
  }
  return false;
}

/** Подъём земли (px) в точке (клеточные доли мира) — уровень её клетки. */
export function elevLiftAtPoint(x: number, y: number): number {
  return elevLevelAt(Math.floor(x), Math.floor(y)) * TERRAIN_LIFT_PX;
}

/** Уровень нарисованного верха под точкой (доли клетки), не логической клетки.
 *  Спина высокого плато рисуется севернее своей клетки — ходить нужно по картинке. */
export function surfaceLevelAt(x: number, y: number): number {
  return surfaceLevelOf(x, y, currentMap.cols, currentMap.rows, elevLevelAt);
}

/** Точка в южной стене обрыва (доли клетки). */
export function pointInSouthWall(x: number, y: number): boolean {
  return pointInSouthWallOf(x, y, currentMap.cols, currentMap.rows, elevLevelAt);
}

/**
 * Грунт под визуальной точкой экрана (px мира): поднятая земля рисуется
 * со сдвигом вверх на уровень рельефа, поэтому обратная проекция камеры без
 * поправки попадает НЕ в ту клетку: клик по видимой поверхности возвышенности
 * (ближний ракурс) без неё указывает в клетку ПЕРЕД обрывом — кот «упирается
 * в стенку» вместо подъёма. Ищем с ряда курсора вверх (не выше TERRAIN_MAX_LEVEL):
 * первая клетка (с самой южной стороны), чей поднятый верх накрывает точку,
 * и есть грунт под курсором; её сдвиг возвращаем в мировые координаты.
 */
export function groundPointAtWorld(
  x: number,
  y: number,
  cellW: number,
  cellH: number,
): { x: number; y: number } {
  const c = Math.floor(x / cellW);
  if (c < 0 || c >= currentMap.cols) return { x, y };
  const r0 = Math.floor(y / cellH);
  let bestLift = -1;
  for (let k = 0; k <= TERRAIN_MAX_LEVEL; k++) {
    const r = r0 + k;
    if (r < 0 || r >= currentMap.rows) break;
    const lift = elevLevelAt(c, r) * TERRAIN_LIFT_PX;
    const top = r * cellH - lift;
    if (y < top || y >= top + cellH) continue;
    if (lift > bestLift) bestLift = lift;
  }
  if (bestLift >= 0) return { x, y: y + bestLift };
  return { x, y };
}

/** Уровень клетки-соседа для стены обрыва: вне мира или за нарисованной кромкой
 *  базы нет — считаем 0 (стена уходит до самой земли). */
function elevNeighborForWall(c: number, r: number): number {
  if (c < 0 || r < 0 || c >= currentMap.cols || r >= currentMap.rows) return 0;
  if (!pointInPolygon(islandPolygon(), c + 0.5, r + 0.5)) return 0;
  return elevLevelAt(c, r);
}

/** Куда смотрит камера: ближайший прямой угол. Лицевая стена блока строится
 *  на этой грани поднятой земли, чтобы после поворота обрыва смотрела на игрока.
 *  yaw 0 — юг (как было до поворотов). */
type FaceDir = 's' | 'e' | 'n' | 'w';

const FACE_STEP: Record<FaceDir, { dc: number; dr: number }> = {
  s: { dc: 0, dr: 1 },
  e: { dc: 1, dr: 0 },
  n: { dc: 0, dr: -1 },
  w: { dc: -1, dr: 0 },
};

function terrainFaceOf(yaw: number): FaceDir {
  const k = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
  return (['s', 'e', 'n', 'w'] as const)[k];
}

/** Сдвиг «вверх экрана» в мировых пикселях. У прямого угла это одна ось
 *  (yaw 0 — север), поэтому ряд клеток не уезжает вкось при другом ракурсе. */
export function terrainLiftShift(liftPx: number, yaw: number): { dx: number; dy: number } {
  return { dx: -Math.sin(yaw) * liftPx, dy: -Math.cos(yaw) * liftPx };
}

function oppositeFace(face: FaceDir): FaceDir {
  return face === 's' ? 'n' : face === 'n' ? 's' : face === 'e' ? 'w' : 'e';
}

/** Боковые грани относительно лицевой: складки по бокам блока, не на лице. */
function sideFaces(face: FaceDir): [FaceDir, FaceDir] {
  return face === 's' || face === 'n' ? ['w', 'e'] : ['n', 's'];
}

/** Прямоугольник лицевой стены: от ближней грани поднятой земли наружу на перепад.
 *  При yaw 0 совпадает с прежней южной стеной. */
function faceWallRect(
  c: number,
  r: number,
  cellW: number,
  cellH: number,
  face: FaceDir,
  yaw: number,
): { e: number; x: number; y: number; w: number; h: number; face: FaceDir } | null {
  const e = elevLevelAt(c, r);
  if (e <= 0) return null;
  const step = FACE_STEP[face];
  const nb = elevNeighborForWall(c + step.dc, r + step.dr);
  if (nb >= e) return null;
  const drop = (e - nb) * TERRAIN_LIFT_PX;
  const shift = terrainLiftShift(e * TERRAIN_LIFT_PX, yaw);
  const gx = c * cellW + shift.dx;
  const gy = r * cellH + shift.dy;
  if (face === 's') return { e, x: gx, y: gy + cellH, w: cellW, h: drop, face };
  if (face === 'n') return { e, x: gx, y: gy - drop, w: cellW, h: drop, face };
  if (face === 'e') return { e, x: gx + cellW, y: gy, w: drop, h: cellH, face };
  return { e, x: gx - drop, y: gy, w: drop, h: cellH, face };
}

/** Точка сортировки лицевой стены (внешний край, на пиксель ближе к камере)
 *  или null — стены нет. Единый источник для ключа билборда и отрисовки. */
export function terrainWallAnchor(
  c: number,
  r: number,
  cellW: number,
  cellH: number,
  yaw: number,
): { x: number; y: number } | null {
  const g = faceWallRect(c, r, cellW, cellH, terrainFaceOf(yaw), yaw);
  if (!g) return null;
  if (g.face === 's') return { x: g.x + g.w / 2, y: g.y + g.h - 1 };
  if (g.face === 'n') return { x: g.x + g.w / 2, y: g.y + 1 };
  if (g.face === 'e') return { x: g.x + g.w - 1, y: g.y + g.h / 2 };
  return { x: g.x + 1, y: g.y + g.h / 2 };
}

/** Дальняя (верхняя на экране) точка верха клетки — ключ глубины билборда. */
export function terrainTopAnchor(
  c: number,
  r: number,
  cellW: number,
  cellH: number,
  liftPx: number,
  yaw: number,
): { x: number; y: number } {
  const face = terrainFaceOf(yaw);
  const shift = terrainLiftShift(liftPx, yaw);
  const gx = c * cellW + shift.dx;
  const gy = r * cellH + shift.dy;
  if (face === 's') return { x: gx + cellW / 2, y: gy };
  if (face === 'n') return { x: gx + cellW / 2, y: gy + cellH };
  if (face === 'e') return { x: gx, y: gy + cellH / 2 };
  return { x: gx + cellW, y: gy + cellH / 2 };
}

/**
 * Лицевая стена обрыва одной клетки: срез дёрна на грани, которая смотрит
 * в камеру. Верх сдвинут вверх экрана, чтобы ряд одной оси оставался прямым.
 * Рисуется ОТДЕЛЬНО от верха: свой ключ глубины — внешний край
 * стены, поэтому кот перед фасадом рисуется поверх, а кот за ним — под стеной.
 */
export function drawTerrainWall(
  ctx: CanvasRenderingContext2D,
  cellW: number,
  cellH: number,
  c: number,
  r: number,
  yaw = 0,
): void {
  const g = faceWallRect(c, r, cellW, cellH, terrainFaceOf(yaw), yaw);
  if (!g) return;
  const { x, y, w, h, face, e } = g;
  // градиент от кромки травы к внешнему краю (к игроку)
  const x0 = face === 'w' ? x + w : x;
  const y0 = face === 'n' ? y + h : y;
  const x1 = face === 'e' ? x + w : face === 'w' ? x : x;
  const y1 = face === 's' ? y + h : face === 'n' ? y : y;
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  grad.addColorStop(0, '#6d5438');
  grad.addColorStop(0.3, '#58412b');
  grad.addColorStop(1, '#382a1a');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  // нависшая трава: тёмная линия у кромки верха + светлый срез дёрна
  ctx.fillStyle = 'rgba(18, 13, 5, 0.5)';
  if (face === 's') ctx.fillRect(x, y, w, 2);
  else if (face === 'n') ctx.fillRect(x, y + h - 2, w, 2);
  else if (face === 'e') ctx.fillRect(x, y, 2, h);
  else ctx.fillRect(x + w - 2, y, 2, h);
  ctx.fillStyle = 'rgba(214, 196, 140, 0.14)';
  const turf = Math.max(0, Math.min(3, (face === 's' || face === 'n' ? h : w) - 2));
  if (turf > 0) {
    if (face === 's') ctx.fillRect(x, y + 2, w, turf);
    else if (face === 'n') ctx.fillRect(x, y + h - 2 - turf, w, turf);
    else if (face === 'e') ctx.fillRect(x + 2, y, turf, h);
    else ctx.fillRect(x + w - 2 - turf, y, turf, h);
  }
  // детерминированные камешки на срезе (по клетке — у всех игроков одинаковые)
  const along = face === 's' || face === 'n' ? w : h;
  const across = face === 's' || face === 'n' ? h : w;
  const v = (c * 7 + r * 13 + e * 5) % 4;
  ctx.fillStyle = 'rgba(24, 18, 10, 0.35)';
  for (let i = 0; i <= v; i++) {
    const alongT = 0.14 + 0.24 * i + ((c * 31 + i * 17) % 10) / 60;
    const acrossT = 0.35 + ((r * 23 + i * 29) % 10) / 22;
    const px =
      face === 's' || face === 'n'
        ? x + along * alongT
        : face === 'e'
          ? x + across * acrossT
          : x + across * (1 - acrossT);
    const py =
      face === 's'
        ? y + across * acrossT
        : face === 'n'
          ? y + across * (1 - acrossT)
          : y + along * alongT;
    const rr2 = 1.6 + ((c + r + i) % 3);
    ctx.beginPath();
    ctx.arc(px, py, rr2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Верх плато одной клетки: поднятая на уровень рельефа земля (пиксельный рисунок
 * клетки или травяной тайл), лёгкая подсветка уровней 2+ и боковые складки.
 * Рисуется с ключом глубины = ПОДНЯТЫЙ верхний край клетки: тогда кот, стоящий
 * на плато (его лапы всегда ниже поднятого верха своей клетки), рисуется
 * ПОВЕРХ своей земли и больше не «проваливается» в неё на половине клетки.
 */
export function drawTerrainTop(
  ctx: CanvasRenderingContext2D,
  cellW: number,
  cellH: number,
  c: number,
  r: number,
  pat: CanvasPattern | null,
  /** Пиксельная отрисовка локации: верх плато поднимает кусок рисунка клетки. */
  paintSrc?: HTMLCanvasElement | null,
  /** Угол камеры: боковые складки и дальняя кромка следуют за лицевой гранью. */
  yaw = 0,
): void {
  const e = elevLevelAt(c, r);
  if (e <= 0) return;
  const lift = e * TERRAIN_LIFT_PX;
  const shift = terrainLiftShift(lift, yaw);
  const x = c * cellW + shift.dx;
  const y = r * cellH + shift.dy;
  // верх плато: кусок пиксельной отрисовки клетки, поднятый вверх экрана; чем
  // выше — тем светлее. Без рисунка — травяной тайл пака, как раньше.
  if (paintSrc) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      paintSrc,
      c * PAINT_CELL_W,
      r * PAINT_CELL_H,
      PAINT_CELL_W,
      PAINT_CELL_H,
      x,
      y,
      cellW + 0.5,
      cellH + 0.5,
    );
    ctx.restore();
  } else if (pat) {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = pat;
    ctx.fillRect(x, y, cellW + 0.5, cellH + 0.5);
    ctx.restore();
  } else {
    ctx.fillStyle = '#2c4a1d';
    ctx.fillRect(x, y, cellW + 0.5, cellH + 0.5);
  }
  if (e >= 2) {
    ctx.fillStyle = `rgba(255, 238, 176, ${(0.055 * (e - 1)).toFixed(3)})`;
    ctx.fillRect(x, y, cellW + 0.5, cellH + 0.5);
  }
  // Складки по бокам лицевой грани и тёмная кромка с дальней стороны.
  // При yaw 0 это прежние восточная/западная полоски и северная губа.
  const face = terrainFaceOf(yaw);
  const gy = y;
  const t = 7;
  for (const side of sideFaces(face)) {
    const step = FACE_STEP[side];
    const nb = elevNeighborForWall(c + step.dc, r + step.dr);
    if (nb >= e) continue;
    const drop = Math.min((e - nb) * TERRAIN_LIFT_PX, cellH);
    ctx.fillStyle = '#58412b';
    let sx = x;
    let sy = gy;
    let sw = t;
    let sh = cellH + drop;
    if (side === 'e' || side === 'w') {
      sx = side === 'w' ? x : x + cellW - t;
      sy = face === 's' ? gy : gy - drop;
      sw = t;
      sh = cellH + drop;
    } else {
      sy = side === 'n' ? gy : gy + cellH - t;
      sx = face === 'e' ? x : x - drop;
      sw = cellW + drop;
      sh = t;
    }
    ctx.fillRect(sx, sy, sw, sh);
    ctx.fillStyle = 'rgba(18, 13, 5, 0.45)';
    if (face === 's') ctx.fillRect(sx, sy, sw, 2);
    else if (face === 'n') ctx.fillRect(sx, sy + sh - 2, sw, 2);
    else if (face === 'e') ctx.fillRect(sx, sy, 2, sh);
    else ctx.fillRect(sx + sw - 2, sy, 2, sh);
  }
  const far = oppositeFace(face);
  const farStep = FACE_STEP[far];
  if (elevNeighborForWall(c + farStep.dc, r + farStep.dr) < e) {
    ctx.fillStyle = '#3a2a1c';
    if (far === 'n') ctx.fillRect(x, gy, cellW, 6);
    else if (far === 's') ctx.fillRect(x, gy + cellH - 6, cellW, 6);
    else if (far === 'w') ctx.fillRect(x, gy, 6, cellH);
    else ctx.fillRect(x + cellW - 6, gy, 6, cellH);
  }
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
    // клетка с деревом непроходима; клетка с камнем — платформа уровня 1,
    // якоря на ней нужны (мирный кот забирается на камень шагом)
    if (treeAtCell(Math.floor(x), Math.floor(y))) return;
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
  const sprite = (name: PackName, sc: number): boolean => {
    const img = packImg(name);
    if (!img) return false;
    const w = img.naturalWidth * sc;
    const h = img.naturalHeight * sc;
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
    drawn = sprite('bush-s', d.s * m * 1.15);
  } else if (d.kind <= 6) {
    drawn = sprite('bush-m', d.s * m * 1.15);
  } else {
    drawn = sprite('bush-h', d.s * m);
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
  const flip = (v % 2 === 0 ? 1 : -1) * (objectMir(o) === 1 ? -1 : 1);
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
  /** Сдвиг поднятой земли: у клеток плато настил лежит на верхе. */
  dy = 0,
  dx = 0,
): void {
  const cv = groundCoverOf(o);
  const x0 = o.c * cellW + dx;
  const y0 = o.r * cellH + dy;
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
  const polygon = islandPolygon();
  const path = new Path2D();
  const loops = islandLoops();
  if (loops) {
    // несколько петель (острова и дыры кисти): каждая — своя замкнутая подпуть,
    // иначе между петлями протягиваются соединительные линии
    for (const l of loops) {
      l.forEach((p, i) => {
        const px = p.x * cellW;
        const py = p.y * cellH;
        if (i === 0) path.moveTo(px, py);
        else path.lineTo(px, py);
      });
      path.closePath();
    }
  } else {
    polygon.forEach((p, i) => {
      const px = p.x * cellW;
      const py = p.y * cellH;
      if (i === 0) path.moveTo(px, py);
      else path.lineTo(px, py);
    });
    path.closePath();
  }
  const bb = polygonBBox(polygon);
  geoCache = {
    key,
    polygon,
    path,
    bboxPx: { x0: bb.x0 * cellW, y0: bb.y0 * cellH, x1: bb.x1 * cellW, y1: bb.y1 * cellH },
    // С рисунком процедурного декора нет: кисть сама рисует траву, цветы и кусты.
    decor: paintReady() ? [] : buildTestDecor(polygon, currentMap.seed),
  };
  return geoCache;
}
