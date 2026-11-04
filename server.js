import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 3780;
// На VPS порт задаёт systemd-юнит: Environment=PORT=8787 (образец — deploy/vps/coop-field.service).
// Локальный запуск без переменных слушает 3780 — на него настроен клиент разработки.
/** 1 = требовать заголовок Origin (не-браузерные клиенты без Origin не пускаются).
 *  По умолчанию 0: скрипты тестов (scripts/test-ws.mjs) подключаются без Origin. */
const REQUIRE_ORIGIN = process.env.REQUIRE_ORIGIN === "1";
const WS_HOSTNAME = "coop.89-232-184-77.sslip.io";
const FRONT_HOSTNAME = "abnocw.89-232-184-77.sslip.io";
const DEFAULT_ORIGINS = [
  "http://localhost:3780",
  "http://127.0.0.1:3780",
  `https://${WS_HOSTNAME}`,
  `https://${FRONT_HOSTNAME}`,
];

function allowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function isAllowedOrigin(origin) {
  if (!origin) return !REQUIRE_ORIGIN;
  if (allowedOrigins().has(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
    return protocol === "https:" && /^coop-field(-[a-z0-9-]+)?\.vercel\.app$/.test(hostname);
  } catch {
    return false;
  }
}
const WIDTH = 10;
const HEIGHT = 6;
/** Потолок комнаты. Клеток на поле 60, но в одну комнату пускаем не больше этого числа. */
const MAX_PLAYERS = 30;
/** Кулдаун шага на сервере. Ходы, пришедшие раньше, не теряются — встают
 *  в очередь MOVE_QUEUE_MAX и применяются ровно в момент снятия кулдауна. */
const MOVE_COOLDOWN_MS = 80;
/** Глубина очереди шагов: залипшая клавиша не должна превращаться в длинный буфер. */
const MOVE_QUEUE_MAX = 3;
/** Кулдаун на повторный join: самое дорогое событие (снимок field всей комнате). */
const JOIN_COOLDOWN_MS = 1000;
/** Пауза между ping-ами. Браузер отвечает pong сам, клиентский код не нужен. */
const HEARTBEAT_MS = 30_000;
/** Потолок входящего кадра: протокол состоит из коротких JSON-строк,
 *  дефолтные 100 МиБ библиотеки ws здесь только помогали расходу памяти. */
const MAX_PAYLOAD = 4 * 1024;
/**
 * Короткий предохранитель от пачки aim подряд. Угол в cat.deg пишется сразу.
 * Если с прошлой рассылки прошло больше этого — пакет уходит сразу.
 * Более плотный залп не копится в очереди: остаётся последний угол и уходит
 * по короткому таймеру, так что свежий угол не застревает.
 * 20 мс — не сглаживание картинки (его делает клиент), а только отсечка всплеска.
 */
const AIM_MIN_GAP_MS = 20;
/** Нижняя граница отклика удара в симе — 30 мс. Кулдаун чуть ниже, чтобы легитимный удар не отбрасывался. */
const STRIKE_COOLDOWN_MS = 25;
/**
 * Окно «полёта» удара, мс: применение откладывается на этот срок, и блок цели
 * перепроверяется в момент касания. Удар, брошенный в неблокирующего, но ещё
 * «висящий в воздухе», когда цель встала в блок, всё равно уходит в «Лапы».
 * Клиент присылает свой отклик удара (flightMs); без него — 170 мс.
 */
const STRIKE_CATCH_MS = 170;
const STRIKE_CATCH_MAX_MS = 600;
/** Одно сообщение комнате. Длиннее обрезается, чаще этого интервала — отказ. */
const CHAT_MAX_LEN = 200;
const CHAT_COOLDOWN_MS = 450;
const CHAT_HISTORY = 40;
/**
 * Зоны abnocw (id → подпись и урон при пресете 0,0). Совпадает с DEFAULT_SETTINGS.combat.zones.
 * Когтей и зубов нет: weapon в логе пустой.
 */
const STRIKE_ZONES = {
  tail: { part: "Хвост", damage: 2 },
  paws: { part: "Лапы", damage: 6 },
  back: { part: "Спина", damage: 12 },
  muzzle: { part: "Морда", damage: 18 },
  belly: { part: "Живот", damage: 25 },
  neck: { part: "Шея", damage: 30 },
  throat: { part: "Горло", damage: 42 },
};
const SPAWNS = [
  [4, 3],
  [5, 3],
  [3, 4],
  [6, 3],
  [4, 4],
  [5, 4],
  [2, 3],
  [7, 3],
];
const PALETTE = ["#d85e90", "#4b8fd0", "#e6b84d", "#73a13a", "#bf5af2", "#2dd4bf", "#ff9f0a", "#64d2ff"];
const NAMES = ["Сырь", "Пухляшик", "Травожуй"];
const SPRITES = ["blestyashka", "puhlyashik", "puzatik", "razdora", "pohititel", "syrstyashka", "ryzhiy", "trehcvetny", "negr", "chis", "lera", "anya1", "anya2", "serebristyy", "evr", "drel", "maslina", "buran", "sumrak", "izya", "kameshechek"];
/**
 * Манекен «ПОЧУХАТЬ»: общий предмет комнаты, не персонаж. Не в боевом режиме,
 * но клетка под ним непроходима. Позиция в клеточных долях (x — по ширине,
 * y — по высоте, 0 — левый верх спрайта). Тащить может любой игрок; когда кто-то
 * держит манекен, комната видит курсор с его именем.
 */
const DUMMY_DEFAULT = { x: 7, y: 2, sprite: "puhlyashik" };

/* ---------- размеры спрайтов пака и их варианты.
   Объявлены ДО loadTestMap(): sanitizeTestMap читает их при загрузке карты —
   раньше константы стояли ниже по файлу, sanitize падал с «Cannot access
   before initialization», пустой catch молча подменял сохранённую карту
   дефолтом при каждом старте сервера (карта «слетала» после каждого деплоя). ---------- */
const OBJECT_DIMS = {
  'tree-1': [113, 139],
  'tree-2': [97, 136],
  'tree-3': [79, 120],
  'rock-1': [57, 42],
  'rock-2': [11, 10],
  'rock-3': [16, 14],
  'rock-4': [24, 19],
  'rock-5': [24, 19],
  'rock-6': [27, 22],
  'rock-7': [27, 27],
  'rock-8': [18, 16],
  'rock-9': [19, 16],
  'rock-10': [31, 19],
};
const TREE_SPRITE_IDS = new Set(['tree-1', 'tree-2', 'tree-3']);
const ROCK_SPRITE_IDS = new Set(Object.keys(OBJECT_DIMS).filter((k) => k.startsWith('rock')));
const GROUND_COVER_IDS = new Set([
  'grass-1', 'grass-2',
  'flower-1', 'flower-2', 'flower-3', 'flower-4',
  'slab-1', 'slab-2', 'slab-3', 'slab-4',
  'floor-1', 'floor-2', 'floor-3',
]);
const OBJECT_SCALE_MIN = 0.4;
const OBJECT_SCALE_MAX = 3.5;
/**
 * Боевая мишень «РАБ»: общий предмет комнаты в боевом режиме — по ней проходят
 * удары, её клетка непроходима. Спрайт один у всех мишеней, позиция фиксирована.
 */
const RAB_CELL = { x: 4, y: 2 };

/**
 * Комната «тест» — другой формат поля: нарисованная локация с лужайкой, переходом
 * и закутком. В боевом режиме ходьба по клеткам трёх зон, в мирном — свободная
 * (клиент шлёт позицию freemove, сервер зажимает её в мир локации и обновляет
 * логическую клетку — ближайшую проходимую — для ударов и препятствий).
 */
const TEST_ROOM = 'test';
/** Пароль редактора локации (событие setmap). По умолчанию — как в настройках клиента. */
const ADMIN_PASS = String(process.env.ADMIN_PASS || "1946");
/** Конфиг локации «теста» живёт в data/test-map.json рядом с server.js: правится
 *  редактором локации и переживает перезапуски (apply.sh копирует только server.js
 *  и package*.json — каталог data не трогает). */
const DATA_DIR = path.join(__dirname, "data");
const MAP_FILE = path.join(DATA_DIR, "test-map.json");

let testMap = loadTestMap();
let TEST_WIDTH = testMap.cols;
let TEST_HEIGHT = testMap.rows;
let TEST_ISLAND = [];
let TEST_CELLS = [];
/** Клетки (0-based), задетые телами препятствий — для спавна и проверок занятия. */
let TEST_OBST_CELLS = new Set();
/** Тела препятствий (эллипсы с поворотом) — точечная проверка мирных точек. */
let TEST_OBST_BODIES = [];

/** Пересборка геометрии «теста» из конфига: на старте и после каждой правки редактором. */
function rebuildTestGeometry() {
  TEST_WIDTH = testMap.cols;
  TEST_HEIGHT = testMap.rows;
  TEST_ISLAND = buildIsland(testMap);
  TEST_CELLS = buildCells(testMap, TEST_ISLAND);
  TEST_OBST_CELLS = obstacleBlockedCells(testMap);
  TEST_OBST_BODIES = obstacleBodiesOf(testMap);
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

/** Полигон кромки в клеточных долях: зоны + полклетки, Чайкин ×3, дрожь ±5%, Чайкин ×1. */
function buildIsland(map) {
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
function testCellInIsland(c, r, island = TEST_ISLAND) {
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
  const blocked = obstacleBlockedCells(map);
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
  if (cols < 6 || cols > 60) return { error: 'ширина мира должна быть 6–60' };
  if (rows < 3 || rows > 40) return { error: 'высота мира должна быть 3–40' };
  if (!Array.isArray(raw.zones) || raw.zones.length === 0) return { error: 'список зон пуст' };
  if (raw.zones.length > 48) return { error: 'зон не больше 48' };
  // Препятствия необязательны (старые конфиги без objects читаются как «пусто»):
  // камень/дерево стоят свободно (точка опоры, масштаб, поворот), через их тело
  // нельзя пройти ни в бою, ни в мирном; земля и покрытие — наземный декор.
  let objects = [];
  if (raw.objects != null) {
    if (!Array.isArray(raw.objects)) return { error: 'список препятствий не распознан' };
    if (raw.objects.length > 2000) return { error: 'объектов не больше 2000' };
    const taken = new Set();
    for (let i = 0; i < raw.objects.length; i++) {
      const o = raw.objects[i];
      const kind =
        o &&
        (o.kind === 'stone'
          ? 'stone'
          : o.kind === 'tree'
            ? 'tree'
            : o.kind === 'dirt'
              ? 'dirt'
              : o.kind === 'entry'
                ? 'entry'
                : o.kind === 'ground'
                  ? 'ground'
                  : null);
      if (!kind) return { error: `объект №${i + 1}: неизвестный тип` };
      // Свободная точка опоры камня/дерева: дробные x/y; у старых конфигов её нет —
      // считаем из клетки и положения в ней (зеркало sanitizeTestMap клиента).
      let x = 0;
      let y = 0;
      if (kind === 'stone' || kind === 'tree') {
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
      if (kind === 'stone' || kind === 'tree') {
        const sn = Number(o.s);
        s = Number.isFinite(sn) ? Math.min(OBJECT_SCALE_MAX, Math.max(OBJECT_SCALE_MIN, Math.round(sn * 100) / 100)) : undefined;
        const rn = Math.round(Number(o.rot));
        rot = Number.isFinite(rn) ? ((rn % 360) + 360) % 360 : undefined;
        spr = kind === 'tree' ? (TREE_SPRITE_IDS.has(o.spr) ? o.spr : 'tree-1') : ROCK_SPRITE_IDS.has(o.spr) ? o.spr : 'rock-1';
      }
      if (kind === 'ground') {
        cv = GROUND_COVER_IDS.has(String(o.cv)) ? String(o.cv) : 'flower-1';
      }
      // Земля/покрытие/заход — по клетке на объект; камень и дерево стоят свободно.
      if (kind !== 'stone' && kind !== 'tree') {
        const key = `${c},${r}`;
        if (taken.has(key)) continue;
        taken.add(key);
      }
      objects.push({
        id: `o${i + 1}`,
        kind,
        c,
        r,
        ...(kind === 'stone' || kind === 'tree' ? { x, y, s, rot, spr } : {}),
        ...(kind === 'ground' ? { cv } : {}),
        pos,
        dir,
      });
    }
  }
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
      String(z.name ?? '').trim().slice(0, 24) || (kind === 'cells' ? 'Клетки' : 'Зелёная зона');
    zones.push({ id: `z${i + 1}`, name, kind, c0, r0, c1, r1 });
  }
  if (!zones.some((z) => z.kind === 'cells')) {
    return { error: 'нужна хотя бы одна зона с клетками — иначе бой не работает' };
  }
  // Клетки захода: только на траве, и по направлению шага обязана быть боевая
  // клетка (зеркало проверки из src/lib/sim/test-map.ts).
  const battleAt = (c, r) =>
    c >= 0 && r >= 0 && c < cols && r < rows && zones.some((z) => z.kind === 'cells' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1);
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
  // Зоны обязаны срастаться в один островок (касание сторонами, не углами):
  // иначе контур кромки распадается на несколько петель и локация собирается неверно.
  const cells = new Set();
  for (const z of zones) {
    for (let r = z.r0; r <= z.r1; r++) {
      for (let c = z.c0; c <= z.c1; c++) cells.add(`${c},${r}`);
    }
  }
  const start = cells.values().next().value;
  const seen = new Set([start]);
  const queue = [start];
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
  return {
    map: {
      v: raw.v,
      cols,
      rows,
      margin: 0.5,
      seed: typeof raw.seed === 'string' && raw.seed.trim() ? raw.seed.trim().slice(0, 24) : 'test',
      zones,
      objects,
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

/** Запись атомарная (tmp + rename): обрыв не оставляет на диске полудохлый JSON —
 *  именно недописанный файл при загрузке превращается в «карта слетела на старую». */
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Прошлая версия карты — в data/backups (последние 8): неудачную правку редактора
 *  или потерю файла можно откатить, а не собирать локацию заново. */
function backupTestMap() {
  try {
    if (!fs.existsSync(MAP_FILE)) return;
    const dir = path.join(DATA_DIR, "backups");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.copyFileSync(MAP_FILE, path.join(dir, `test-map-${stamp}.json`));
    const old = fs.readdirSync(dir).filter((f) => f.startsWith("test-map-")).sort();
    while (old.length > 8) fs.unlinkSync(path.join(dir, old.shift()));
  } catch (e) {
    console.warn("map backup failed:", e?.message || e);
  }
}

function saveTestMap() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  backupTestMap();
  writeFileAtomic(MAP_FILE, JSON.stringify(testMap, null, 2));
}

rebuildTestGeometry();

/**
 * Редактор локации: клиент → ["setmap", { pass, map }]. При верном пароле и
 * корректном конфиге локация сохраняется в data/test-map.json, геометрия
 * перестраивается, всем в комнате уходит ["map", map] и свежий field (коты,
 * оставшиеся за пределами новой локации, переезжают на ближайшую клетку).
 */
const SETMAP_MIN_GAP_MS = 1000;

function setMap(ws, payload = {}) {
  const now = Date.now();
  // Лимит — только для неверного пароля (перебор): верный пароль отвечает сразу,
  // даже на ошибочный конфиг — редактор не должен молча терять нажатия.
  if (String(payload?.pass || '') !== ADMIN_PASS) {
    if (now - (ws.lastBadMap || 0) < SETMAP_MIN_GAP_MS) return;
    ws.lastBadMap = now;
    send(ws, 'info', 'Редактор: неверный пароль.');
    return;
  }
  const r = sanitizeTestMap(payload?.map);
  if (!r.map) {
    send(ws, 'info', `Редактор: ${r.error}.`);
    return;
  }
  testMap = r.map;
  rebuildTestGeometry();
  // Не сохранившаяся на диск правка умерла бы при первом же рестарте («карта
  // слетела») — ошибка записи видна автору сразу, а не после деплоя.
  try {
    saveTestMap();
  } catch (e) {
    console.warn('map save failed:', e?.message || e);
    send(ws, 'info', `Редактор: локация применилась, но записать её на диск не удалось — ${e?.message || e}. После рестарта сервера она потеряется.`);
  }
  const room = rooms.get(TEST_ROOM);
  if (room && room.sockets.size > 0) {
    for (const cat of room.cats.values()) {
      if (cat.fm === 1) {
        const fx = Number.isFinite(cat.fx) ? cat.fx : 0;
        const fy = Number.isFinite(cat.fy) ? cat.fy : 0;
        if (!pointInPolygon(TEST_ISLAND, fx, fy) && !pointInPolygon(TEST_ISLAND, fx + 0.45, fy + 0.45)) {
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
    for (const w of room.sockets.keys()) send(w, 'map', testMap);
    broadcast(room, 'field', fieldPayload(room));
  }
  console.log(`map set: ${testMap.cols}x${testMap.rows}, zones=${testMap.zones.length}, objects=${(testMap.objects || []).length}`);
}

/* ---------- позиции котов между запусками сервера.
   Рестарт (деплой) раньше выбрасывал всех на спавн — включая АФК-котов, которые
   честно стояли на месте. Теперь последняя позиция каждого кота «теста» живёт
   в data/test-cats.json и возвращается хозяину при join. ---------- */
const CATS_FILE = path.join(DATA_DIR, "test-cats.json");
const CATS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // записи старше месяца не восстанавливаем
const CATS_SAVE_GAP_MS = 3000; // писать на диск не чаще раза в 3 с

let catBook = loadCatBook();
let catBookDirty = false;
let catBookLastSave = 0;

function loadCatBook() {
  try {
    const raw = JSON.parse(fs.readFileSync(CATS_FILE, "utf8"));
    if (raw && typeof raw === "object" && raw.cats && typeof raw.cats === "object") {
      return raw.cats;
    }
  } catch (e) {
    if (e && e.code !== "ENOENT") console.warn("cats file read failed:", e?.message || e);
  }
  return {};
}

/** Слив книги позиций на диск: грязный флаг + троттлинг, force — при выходе кота
 *  и на остановке сервера. Атомарно и с обрезкой устаревших записей. */
function flushCatBook(force = false) {
  const now = Date.now();
  if (!catBookDirty) return;
  if (!force && now - catBookLastSave < CATS_SAVE_GAP_MS) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    for (const key of Object.keys(catBook)) {
      if (now - (catBook[key]?.ts || 0) > CATS_TTL_MS) delete catBook[key];
    }
    writeFileAtomic(CATS_FILE, JSON.stringify({ v: 1, savedAt: now, cats: catBook }, null, 2));
    catBookDirty = false;
    catBookLastSave = now;
  } catch (e) {
    console.warn("cats save failed:", e?.message || e);
  }
}

/** Кот стоит на новом месте — помечаем книгу грязной (пишется общим сливом). */
function rememberCat(cat) {
  if (!cat || !cat.login) return;
  catBook[String(cat.login).toLowerCase()] = {
    login: cat.login,
    fm: cat.fm ? 1 : 0,
    fx: Number.isFinite(cat.fx) ? cat.fx : undefined,
    fy: Number.isFinite(cat.fy) ? cat.fy : undefined,
    x: cat.x,
    y: cat.y,
    ts: Date.now(),
  };
  catBookDirty = true;
}

/** Мирная точка не внутри тела препятствия (эллипс с поворотом, чуть проще
 *  клиентского — на граничных точках лучше вернуть кота, чем оставить на спавне). */
function peacePointFreeOfObjects(fx, fy) {
  const px = fx * 100;
  const py = fy * 150;
  for (const b of TEST_OBST_BODIES) {
    if (!(b.hw > 0) || !(b.h > 0)) continue;
    const cos = Math.cos(-b.rot);
    const sin = Math.sin(-b.rot);
    const dx = px - b.x * 100;
    const dy = py - b.y * 150;
    const ux = dx * cos - dy * sin;
    const uy = dx * sin + dy * cos;
    if ((ux * ux) / (b.hw * b.hw) + (uy * uy) / (b.h * b.h) <= 1) return false;
  }
  return true;
}

/** Возврат кота на прежнее место после рестарта сервера. Мирная точка — только
 *  внутри локации и вне тел препятствий, боевая — на свободной проходимой клетке;
 *  иначе кот остаётся на обычном спавне. */
function restoreCatPosition(room, cat) {
  const rec = catBook[String(cat.login || "").toLowerCase()];
  if (!rec || Date.now() - (rec.ts || 0) > CATS_TTL_MS) return;
  if (rec.fm === 1 && Number.isFinite(rec.fx) && Number.isFinite(rec.fy)) {
    const fx = Math.round(rec.fx * 100) / 100;
    const fy = Math.round(rec.fy * 100) / 100;
    const inside =
      pointInPolygon(TEST_ISLAND, fx, fy) || pointInPolygon(TEST_ISLAND, fx + 0.45, fy + 0.45);
    if (inside && peacePointFreeOfObjects(fx, fy)) {
      cat.fm = 1;
      cat.fx = fx;
      cat.fy = fy;
      const cell = nearestTestCell(fx, fy);
      if (cell) {
        cat.x = cell.x;
        cat.y = cell.y;
      }
      return;
    }
  }
  if (
    rec.fm === 0 &&
    Number.isInteger(rec.x) &&
    Number.isInteger(rec.y) &&
    testWalkable(rec.x, rec.y) &&
    !occupied(room, rec.x, rec.y, cat.id)
  ) {
    cat.fm = 0;
    cat.x = rec.x;
    cat.y = rec.y;
  }
}

const rooms = new Map();
let nextId = 1001;

function send(ws, event, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify([event, payload]));
}

/** Нормализация кода комнаты: латиница/цифры/дефис/подчёркивание, до 24 символов.
 *  Одна и для join, и для списка комнат — иначе состав покажется не для той комнаты. */
function normalizeRoomCode(code) {
  return (
    String(code || "demo")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 24) || "demo"
  );
}

function roomOf(code) {
  const key = normalizeRoomCode(code);
  if (!rooms.has(key)) {
    rooms.set(key, {
      code: key,
      fmt: key === TEST_ROOM ? 'test' : 'grid',
      cats: new Map(),
      sockets: new Map(),
      chat: [],
      chatSeq: 0,
      dummy: null,
      dummyLast: null,
      dummyGrab: null,
      rab: null,
    });
  }
  return rooms.get(key);
}

/** Клетка предмета (0-based) по его клеточным долям: центр округляется в пределы поля. */
function objCell(pos) {
  return {
    cx: Math.min(WIDTH - 1, Math.max(0, Math.round(pos.x))),
    cy: Math.min(HEIGHT - 1, Math.max(0, Math.round(pos.y))),
  };
}

function occupied(room, x, y, exceptId) {
  for (const cat of room.cats.values()) {
    if (cat.id !== exceptId && cat.x === x && cat.y === y) return true;
  }
  // Предметы комнаты — физические препятствия: на их клетки нельзя ступать и там нельзя спавниться.
  // В «тесте» манекена и мишени нет — проверки не нужны.
  if (room.fmt === 'test') return false;
  if (room.dummy) {
    const c = objCell(room.dummy);
    if (c.cx === x - 1 && c.cy === y - 1) return true;
  }
  if (room.rab && RAB_CELL.x === x - 1 && RAB_CELL.y === y - 1) return true;
  return false;
}

function spawnCell(room) {
  const test = room.fmt === 'test';
  const W = test ? TEST_WIDTH : WIDTH;
  const H = test ? TEST_HEIGHT : HEIGHT;
  const ok = (x, y) => (test ? testWalkable(x, y) : true);
  if (test) {
    // Новичок в «тесте» появляется в мирном режиме — на траве (зелёная зона):
    // бой сам включится, когда игрок дойдёт до боевых клеток.
    const green = testMap.zones.filter((z) => z.kind === 'green');
    for (const z of green) {
      for (let y = z.r0 + 1; y <= z.r1 + 1; y++) {
        for (let x = z.c0 + 1; x <= z.c1 + 1; x++) {
          if (x < 1 || y < 1 || x > W || y > H) continue;
          if (!testCellInIsland(x - 1, y - 1)) continue;
          const onObj = TEST_OBST_CELLS.has(`${x - 1},${y - 1}`);
          if (onObj) continue;
          if (!occupied(room, x, y)) return [x, y];
        }
      }
    }
    // Зелёных зон нет или все заняты — fallback на боевые клетки.
  }
  for (const [x, y] of SPAWNS) {
    if (ok(x, y) && !occupied(room, x, y)) return [x, y];
  }
  for (let y = 1; y <= H; y++) {
    for (let x = 1; x <= W; x++) {
      if (ok(x, y) && !occupied(room, x, y)) return [x, y];
    }
  }
  return null;
}

function pickSprite(payload, slot) {
  const raw = String(payload.sprite || "").trim();
  if (SPRITES.includes(raw)) return raw;
  return SPRITES[slot % SPRITES.length];
}

function publicCat(cat, room) {
  const base = {
    id: cat.id,
    login: cat.login,
    color: cat.color,
    sprite: cat.sprite,
    x: cat.x,
    y: cat.y,
    deg: cat.deg,
    size: cat.size,
    blocking: !!cat.blocking,
  };
  // Комната «тест»: режим свободной ходьбы и позиция в клеточных долях —
  // новичкам и после переподключения (иначе свободный кот замрёт на клетке).
  if (room?.fmt === 'test') {
    base.fm = cat.fm ? 1 : 0;
    const fx = cat.fm ? cat.fx ?? cat.x - 1 : cat.x - 1;
    const fy = cat.fm ? cat.fy ?? cat.y - 1 : cat.y - 1;
    base.fx = Math.round(fx * 100) / 100;
    base.fy = Math.round(fy * 100) / 100;
  }
  return base;
}

function fieldPayload(room) {
  const test = room.fmt === 'test';
  const W = test ? TEST_WIDTH : WIDTH;
  const H = test ? TEST_HEIGHT : HEIGHT;
  const users = {};
  for (const cat of room.cats.values()) {
    if (!users[cat.x]) users[cat.x] = Array(H + 1).fill(null);
    users[cat.x][cat.y] = publicCat(cat, room);
  }
  return {
    huntMode: false,
    width: W,
    height: H,
    format: test ? 'test' : undefined,
    room: room.code,
    // Конфиг локации «теста»: клиент рисует поле по нему и хранит как эталон
    // сохранённой локации (редактор откатывается к нему при закрытии без записи).
    ...(test ? { map: testMap } : {}),
    users,
    cats: [...room.cats.values()].map((c) => publicCat(c, room)),
    location: { name: test ? 'Пробная лужайка' : 'Расщелина меж скал', bg: test ? 4234811 : 71085 },
    dummy: room.dummy
      ? { on: true, x: room.dummy.x, y: room.dummy.y, sprite: room.dummy.sprite, grab: room.dummyGrab || null }
      : null,
    rab: room.rab ? { on: true } : null,
  };
}

function broadcast(room, event, payload, exceptWs) {
  for (const ws of room.sockets.keys()) {
    if (ws !== exceptWs) send(ws, event, payload);
  }
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  const cat = room.sockets.get(ws);
  room.sockets.delete(ws);
  // Ушедший тащил манекен — комната больше не видит курсор с его именем.
  if (room.dummyGrab && cat && room.dummyGrab === cat.login) {
    room.dummyGrab = null;
    broadcast(room, "dummyDrop", {});
  }
  if (cat) {
    clearAimTimer(cat);
    clearMoveTimer(cat);
    cat.moveQueue = [];
    room.cats.delete(cat.id);
    rememberCat(cat); // последняя позиция уходит в книгу — рестарт вернёт кота на место
    flushCatBook(true);
    broadcast(room, "move", { id: cat.id, x: 0, y: 0 });
    console.log(`ws leave room=${room.code} cat=${cat.login}#${cat.id}`);
  }
  ws.room = null;
  if (room.sockets.size === 0) rooms.delete(room.code);
}

function refuseJoin(ws, room, reason) {
  send(ws, "info", reason);
  send(ws, "noplace", { room: room.code, reason });
}

function join(ws, payload = {}) {
  const now = Date.now();
  if (now - (ws.lastJoin || 0) < JOIN_COOLDOWN_MS) {
    send(ws, "info", "Слишком часто. Подождите секунду.");
    return;
  }
  ws.lastJoin = now;
  if (ws.room) leave(ws);
  const room = roomOf(payload.room);
  if (room.cats.size >= MAX_PLAYERS) {
    refuseJoin(ws, room, `В комнате уже ${MAX_PLAYERS} котов — мест нет. Смените ?room=.`);
    return;
  }
  const cell = spawnCell(room);
  if (!cell) {
    // Двух котов в одну клетку не ставим: нет свободной клетки — отказ, не очередь.
    refuseJoin(ws, room, "На поле нет свободных клеток.");
    return;
  }
  const slot = room.cats.size;
  const login = uniqueLogin(room, sanitizeLogin(payload.login, NAMES[slot] || `Кот ${slot + 1}`));
  // Рост модельки, выбранный при спавне: клиент шлёт проценты (60–100).
  // Вне диапазона/не число — 100% (обычный рост).
  const sizeRaw = Number(payload.size);
  const size = Number.isFinite(sizeRaw) ? Math.min(100, Math.max(60, Math.round(sizeRaw))) : 100;
  const cat = {
    id: nextId++,
    login,
    color: PALETTE[slot % PALETTE.length],
    sprite: pickSprite(payload, slot),
    x: cell[0],
    y: cell[1],
    deg: 0,
    size,
    lastMove: 0,
    lastStrike: 0,
    lastAim: 0,
    lastChat: 0,
    // Блок (удержание К): любые удары по этому коту проводятся в «Лапы» (см. strike),
    // кроме хвоста — удар в хвост блок не ловит (исключение из правила).
    blocking: false,
    // Пресет брони 0–0,9: strike режет входящий урон по кривой замеров владельца.
    armor: 0,
    // Шаги, ждущие снятия кулдауна (см. queueMove), и их таймер.
    moveQueue: [],
    moveTimer: null,
    // В «тесте» новый кот — в мирном режиме (спавн на траве): fm=1, чтобы у соседей
    // до первого freemove не рисовалась боевая стрела (она видна только при fm=0).
    fm: room.fmt === 'test' ? 1 : 0,
  };
  room.cats.set(cat.id, cat);
  room.sockets.set(ws, cat);
  ws.room = room;
  // Рестарт сервера не выбрасывает кота на спавн: возвращаем его последнюю позицию
  // (см. restoreCatPosition) — особенно важно для АФК-котов.
  restoreCatPosition(room, cat);
  send(ws, "you", publicCat(cat, room));
  send(ws, "field", fieldPayload(room));
  if (room.chat?.length) send(ws, "chatlog", room.chat);
  broadcast(room, "move", publicCat(cat, room), ws);
}

function move(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const step = parseMove(payload);
  if (!step) return;
  const now = Date.now();
  if (now - cat.lastMove < MOVE_COOLDOWN_MS) {
    // Раньше такой шаг глотался молча: клиент уже нарисовал его, эха нет —
    // предикт расходился с сервером и следующий эхо откатывал кота на клетку
    // назад (телепорт). Теперь шаг встаёт в короткую очередь и обязательно
    // выполняется или честно отказывается.
    queueMove(ws, cat, payload);
    return;
  }
  applyMove(ws, cat, payload);
}

/** Нормализация хода: {-1..1, -1..1}, не (0,0), числа конечны. */
function parseMove(payload = {}) {
  let dx = Number(payload.x);
  let dy = Number(payload.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  dx = Math.max(-1, Math.min(1, Math.trunc(dx)));
  dy = Math.max(-1, Math.min(1, Math.trunc(dy)));
  if (dx === 0 && dy === 0) return null;
  return { dx, dy };
}

function applyMove(ws, cat, payload) {
  const room = ws.room;
  if (!room || room.sockets.get(ws) !== cat) return;
  const step = parseMove(payload);
  if (!step) return;
  const now = Date.now();
  const nx = cat.x + step.dx;
  const ny = cat.y + step.dy;
  const inBounds =
    room.fmt === 'test'
      ? testWalkable(nx, ny) || !!testEntryCell(nx - 1, ny - 1)
      : nx >= 1 && nx <= WIDTH && ny >= 1 && ny <= HEIGHT;
  if (!inBounds) {
    send(ws, "info", room.fmt === 'test' ? "Край локации." : "Край поля.");
    // refuse — тот же отказ, но с кодом: клиент откатывает предикт по коду,
    // а не по подстроке русского текста (текст менять можно свободно).
    send(ws, "refuse", { code: "edge", text: "Край поля." });
    return;
  }
  if (occupied(room, nx, ny, cat.id)) {
    send(ws, "info", "Клетка занята.");
    send(ws, "refuse", { code: "cell_busy", text: "Клетка занята." });
    return;
  }

  cat.x = nx;
  cat.y = ny;
  // Стрела живёт отдельно от шага: без deg в пакете оставляем последний угол,
  // а не разворачиваем её по направлению клетки.
  const sentDeg = normalizeDeg(payload.deg ?? payload.angle);
  if (sentDeg != null) cat.deg = sentDeg;
  clearAimTimer(cat);
  cat.aimDirty = false;
  cat.lastAim = now;
  cat.lastMove = now;
  const patch = publicCat(cat, room);
  // Шагнувшему — одно эхо. Второй экземпляр той же клетки (broadcast без except)
  // клиент читал как отказ предикта: спрайт шагал назад и следующим кадром
  // перепрыгивал клетку.
  send(ws, "update cat", patch);
  broadcast(room, "update cat", patch, ws);
}

function clearMoveTimer(cat) {
  if (!cat?.moveTimer) return;
  clearTimeout(cat.moveTimer);
  cat.moveTimer = null;
}

/** Разогнать очередь шагов: каждый — в момент снятия кулдауна. */
function pumpMoveQueue(ws, cat) {
  if (cat.moveTimer) return;
  const wait = MOVE_COOLDOWN_MS - (Date.now() - cat.lastMove);
  cat.moveTimer = setTimeout(() => {
    cat.moveTimer = null;
    const room = ws.room;
    if (!room || room.sockets.get(ws) !== cat) return;
    const next = cat.moveQueue.shift();
    if (next === undefined) return;
    applyMove(ws, cat, next);
    if (cat.moveQueue.length > 0) pumpMoveQueue(ws, cat);
  }, Math.max(0, wait));
}

/** Шаг раньше кулдауна: в очередь, а не в мусорку. */
function queueMove(ws, cat, payload) {
  if (cat.moveQueue.length >= MOVE_QUEUE_MAX) {
    // Залп длиннее очереди — честный отказ, клиент откатит предикт.
    send(ws, "info", "Слишком быстро.");
    send(ws, "refuse", { code: "cooldown", text: "Слишком быстро." });
    return;
  }
  cat.moveQueue.push(payload);
  pumpMoveQueue(ws, cat);
}

/**
 * Смена скина. Клиент → ["sprite", { sprite }].
 * Остальным в комнате сразу → ["update cat", { id, x, y, deg, sprite, login }].
 * Клетка не меняется. Неизвестный id спрайта молча отбрасывается.
 */
function setSprite(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const sprite = String(payload.sprite || "").trim();
  if (!SPRITES.includes(sprite) || sprite === cat.sprite) return;
  cat.sprite = sprite;
  broadcast(
    room,
    "update cat",
    publicCat(cat, room),
    ws,
  );
}

function clearAimTimer(cat) {
  if (!cat?.aimTimer) return;
  clearTimeout(cat.aimTimer);
  cat.aimTimer = null;
}

function normalizeDeg(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(wrap360(n) * 10) / 10;
}

/** Запомнить угол сразу. Рассылаем его сразу, а залп теснее AIM_MIN_GAP_MS схлопываем до последнего. */
function setDeg(ws, deg) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat || deg == null) return;
  if (deg === cat.deg && !cat.aimDirty) return;
  cat.deg = deg;
  const elapsed = Date.now() - (cat.lastAim || 0);
  if (elapsed >= AIM_MIN_GAP_MS) {
    clearAimTimer(cat);
    broadcastDeg(room, cat, ws);
    return;
  }
  cat.aimDirty = true;
  if (cat.aimTimer) return;
  cat.aimTimer = setTimeout(() => {
    cat.aimTimer = null;
    if (!cat.aimDirty || ws.room !== room) return;
    broadcastDeg(room, cat, ws);
  }, AIM_MIN_GAP_MS - elapsed);
}

function broadcastDeg(room, cat, exceptWs) {
  cat.aimDirty = false;
  cat.lastAim = Date.now();
  broadcast(room, "update cat", publicCat(cat, room), exceptWs);
}

function aim(ws, payload = {}) {
  const cat = ws.room && ws.room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const deg = normalizeDeg(payload.deg ?? payload.angle);
  if (deg == null) return;
  setDeg(ws, deg);
}

function wrap360(a) {
  return ((a % 360) + 360) % 360;
}

function wrap180(a) {
  const x = wrap360(a);
  return x > 180 ? x - 360 : x;
}

/** Сосед, на которого точнее указывает стрела. То же правило, что pickStrikeTarget в симе. */
function aimedNeighbor(room, cat, angle) {
  if (!Number.isFinite(angle)) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const other of room.cats.values()) {
    if (other.id === cat.id) continue;
    const dx = other.x - cat.x;
    const dy = other.y - cat.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) continue;
    const phi = wrap360((Math.atan2(dy, dx) * 180) / Math.PI);
    const diff = Math.abs(wrap180(phi - wrap360(angle)));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = other;
    }
  }
  return best;
}

/**
 * С диагонали зона не берётся из полос тела: морда / хвост / лапы, как в landStrike.
 * dx, dy — шаг от бьющего к цели, каждый -1 или 1.
 */
function diagonalZone(dx, dy) {
  if (Math.abs(dx) !== 1 || Math.abs(dy) !== 1) return null;
  if (dy === 1) return "muzzle";
  if (dx === -1 && dy === -1) return "tail";
  return "paws";
}

function resolveZone(raw) {
  const key = String(raw || "").trim();
  if (STRIKE_ZONES[key]) return [key, STRIKE_ZONES[key]];
  const lower = key.toLowerCase();
  for (const [id, zone] of Object.entries(STRIKE_ZONES)) {
    if (zone.part.toLowerCase() === lower) return [id, zone];
  }
  return null;
}

// ---------------- Броня ----------------
/**
 * Броня режет получаемый урон. Кривая — замеры владельца: референс-удар при броне 0,0
 * даёт 40% урона, дальше: 0,1 → 38,67; 0,12 → 37,64; 0,2 → 34,62; 0,35 → 31,62;
 * 0,66 → 26,55; 0,78 → 20,93. Между точками — линейная интерполяция, после 0,78 —
 * экстраполяция по наклону последнего отрезка (0,9 ≈ 15,31). Множитель = урон(броня)/40:
 * броня 0,0 урон не меняет, 0,8 пропускает половину, 0,9 — около 38%.
 * Тот же список лежит в src/lib/sim/settings.ts — меняйте синхронно.
 */
const ARMOR_CURVE = [
  [0.0, 40.0],
  [0.1, 38.67],
  [0.12, 37.64],
  [0.2, 34.62],
  [0.35, 31.62],
  [0.66, 26.55],
  [0.78, 20.93],
];

function armorMultiplier(armor) {
  const a = Number.isFinite(armor) ? Math.min(0.9, Math.max(0, Number(armor))) : 0;
  const base = ARMOR_CURVE[0][1];
  if (a <= ARMOR_CURVE[0][0]) return 1;
  for (let i = 1; i < ARMOR_CURVE.length; i++) {
    const [a1, p1] = ARMOR_CURVE[i];
    if (a <= a1) {
      const [a0, p0] = ARMOR_CURVE[i - 1];
      return (p0 + ((p1 - p0) * (a - a0)) / (a1 - a0)) / base;
    }
  }
  const [a0, p0] = ARMOR_CURVE[ARMOR_CURVE.length - 2];
  const [a1, p1] = ARMOR_CURVE[ARMOR_CURVE.length - 1];
  return (p1 + ((p1 - p0) * (a - a1)) / (a1 - a0)) / base;
}

/**
 * Пресет брони. Клиент → ["armor", { armor: 0.3 }]. Значение зажимается в 0–0,9
 * и округляется до десятых; хранится на коте. Соседям не бродкастится: удар и так
 * уходит всем в fight уже с порезанным бронёй урона (см. strike).
 */
function armor(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat) return;
  const raw = Number(payload.armor);
  cat.armor = Number.isFinite(raw) ? Math.min(0.9, Math.max(0, Math.round(raw * 10) / 10)) : 0;
}

/**
 * Удар. Клиент → ["strike", { target, zone, angle, damage }].
 * Комнате → ["fight", { attackerId, attacker, targetId, name, part, zone, weapon, damage, isAttacking }].
 * name / part / weapon / isAttacking — поля боевого лога. isAttacking свой у каждого сокета.
 * damage — урон бьющего (его пресет «Урон игрока»); сервер нормализует число 0..100,
 * а без числа берёт урон зоны из серверной таблицы. Оружие пустое: когти и зубы
 * в этот обмен не входят, нокаута нет.
 */
function strike(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const now = Date.now();
  if (now - cat.lastStrike < STRIKE_COOLDOWN_MS) return;

  const targetId = Number(payload.target ?? payload.id);
  const angle = Number(payload.angle);
  const resolved = resolveZone(payload.zone ?? payload.part);
  if (!Number.isInteger(targetId) || !resolved || !Number.isFinite(angle)) {
    cat.lastStrike = now;
    send(ws, "info", "Удар не разобран.");
    return;
  }
  const [zoneId0, zone0] = resolved;
  let zoneId = zoneId0;
  let zone = zone0;
  const target = room.cats.get(targetId);
  if (!target || target.id === cat.id) {
    cat.lastStrike = now;
    send(ws, "info", "Цель не в комнате.");
    return;
  }
  const aimed = aimedNeighbor(room, cat, angle);
  if (!aimed) {
    cat.lastStrike = now;
    send(ws, "info", "Рядом никого.");
    return;
  }
  if (aimed.id !== target.id) {
    cat.lastStrike = now;
    send(ws, "info", "Стрела смотрит не на эту цель.");
    return;
  }
  cat.lastStrike = now;
  // Блок цели: любой удар — в «Лапы», стойка бьющего (прямая/диагональ) не важна.
  // Исключение — хвост: удар в хвост блок не ловит, он проходит хвостом.
  if (target.blocking && zoneId0 !== "tail") {
    zoneId = "paws";
    zone = STRIKE_ZONES.paws;
  } else {
    const forced = diagonalZone(target.x - cat.x, target.y - cat.y);
    if (forced && zoneId !== forced) {
      cat.lastStrike = now;
      send(ws, "info", "С этой диагонали бьётся другая часть.");
      return;
    }
  }
  // Урон присылает бьющий (его пресет «Урон игрока», проценты энергии 0..100).
  // Число округляем и зажимаем; нет числа — фолбэк на серверную таблицу зон.
  const dmgRaw = Number(payload.damage);
  const damage = Number.isFinite(dmgRaw) ? Math.min(100, Math.max(0, Math.round(dmgRaw))) : zone.damage;
  // Лаповый урон из пресета бьющего: если на моменте касания удар переводится
  // в «Лапы», списываем именно лаповый урон, а не урон исходной зоны.
  const pawsRaw = Number(payload.pawsDamage);
  const pawsDamage = Number.isFinite(pawsRaw) ? Math.min(100, Math.max(0, Math.round(pawsRaw))) : null;
  // Окно полёта: блок, вставший после нажатия бьющего, но до касания, ловит удар.
  const flightRaw = Number(payload.flightMs);
  const flightMs = Number.isFinite(flightRaw)
    ? Math.min(STRIKE_CATCH_MAX_MS, Math.max(0, Math.round(flightRaw)))
    : STRIKE_CATCH_MS;
  const attackerId = cat.id;
  const thrown = {
    attacker: cat.login,
    attackerId: cat.id,
    targetId: target.id,
    name: target.login,
    part: zone.part,
    zone: zoneId,
    weapon: "",
    damage,
  };
  setTimeout(() => {
    // Цель вышла за время полёта — удар исчезает вместе с ней.
    if (!room.cats.has(targetId)) return;
    let part = thrown.part;
    let finalZoneId = thrown.zone;
    let finalDamage = thrown.damage;
    // Перепроверка блока в момент касания: удар «в полёте» блок ловит.
    // Исключение — хвост: блок не переносит удар из хвоста в «Лапы».
    if (target.blocking && zoneId0 !== "tail") {
      finalZoneId = "paws";
      part = STRIKE_ZONES.paws.part;
      if (pawsDamage !== null) finalDamage = pawsDamage;
      else if (zoneId0 !== "paws") finalDamage = STRIKE_ZONES.paws.damage;
    }
    // Броня цели режет любой входящий урон — и переведённый блоком в «Лапы»,
    // и хвост (блок хвост не ловит, а броня режет его как любой другой).
    finalDamage = Math.round(finalDamage * armorMultiplier(target.armor));
    const entry = {
      attacker: cat.login,
      attackerId,
      targetId: target.id,
      name: target.login,
      part,
      zone: finalZoneId,
      weapon: "",
      damage: finalDamage,
    };
    for (const sock of room.sockets.keys()) {
      send(sock, "fight", {
        ...entry,
        isAttacking: room.sockets.get(sock)?.id === attackerId,
      });
    }
  }, flightMs);
}

/**
 * Невидимые и bidi-символы: нулевая ширина даёт подмену имён («Сы\u200Bрь» выглядит
 * как «Сырь»), bidi-управляющие переворачивают строку чата. Вырезаем и из логина,
 * и из текста сообщений. Составные эмодзи (ZWJ) тоже распадаются — осознанная цена.
 */
const INVISIBLE_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function clipChars(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("");
}

function sanitizeChat(raw) {
  const text = String(raw ?? "")
    .replace(INVISIBLE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clipChars(text, CHAT_MAX_LEN);
}

/** Логин: только видимые символы, одинарные пробелы, не длиннее 24 код-поинтов. */
function sanitizeLogin(raw, fallback) {
  const text = clipChars(
    String(raw ?? "")
      .replace(INVISIBLE_RE, "")
      .replace(/\s+/g, " ")
      .trim(),
    24,
  );
  return text || fallback;
}

/** Имя, не совпадающее с уже сидящими в комнате (без учёта регистра):
 *  «Альфа» и «альфа» в одном чате — это одна и та же персона для читающего. */
function uniqueLogin(room, base) {
  const taken = new Set();
  for (const cat of room.cats.values()) taken.add(cat.login.toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  const stem = clipChars(base, 21);
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Чат комнаты. Клиент → ["chat", { text }].
 * Всем в комнате, включая отправителя → ["chat", { seq, id, login, color, text, ts }].
 * Новичку после field приходит ["chatlog", те же объекты], не больше CHAT_HISTORY.
 */
function chat(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const source = typeof payload === "string" ? payload : payload?.text ?? payload?.message ?? "";
  // Предрез по код-поинтам, а не по UTF-16: slice(0, 2000) мог разрезать суррогатную пару.
  const text = sanitizeChat(clipChars(String(source), 2000));
  if (!text) return;
  const now = Date.now();
  if (now - (cat.lastChat || 0) < CHAT_COOLDOWN_MS) {
    send(ws, "info", "Сообщения слишком частые.");
    return;
  }
  cat.lastChat = now;
  if (!room.chat) room.chat = [];
  room.chatSeq = (room.chatSeq || 0) + 1;
  const entry = {
    seq: room.chatSeq,
    id: cat.id,
    login: cat.login,
    color: cat.color,
    text,
    ts: now,
  };
  room.chat.push(entry);
  if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
  broadcast(room, "chat", entry);
}

/**
 * Манекен «ПОЧУХАТЬ». Клиент → ["dummy", { on, sprite? }].
 * Включение ставит манекен туда, где его выключили (или в дефолт), sprite обновляет
 * скин из списка персонажей. Комнате (и включившему тоже) → один пакет dummyState.
 */
function dummyToggle(ws, payload = {}) {
  const room = ws.room;
  if (!room) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  // В «тесте» — чистый полигон: манекен и мишень недоступны.
  if (room.fmt === 'test') {
    send(ws, "info", "В «Элизии Эйдес» манекен недоступен.");
    return;
  }
  const on = !!payload.on;
  if (on) {
    if (!room.dummy) room.dummy = room.dummyLast ? { ...room.dummyLast } : { ...DUMMY_DEFAULT };
    const sprite = String(payload.sprite || "").trim();
    if (SPRITES.includes(sprite)) room.dummy.sprite = sprite;
  } else {
    if (room.dummy) room.dummyLast = { ...room.dummy };
    room.dummy = null;
    room.dummyGrab = null;
  }
  broadcast(room, "dummyState", {
    on,
    x: room.dummy?.x ?? DUMMY_DEFAULT.x,
    y: room.dummy?.y ?? DUMMY_DEFAULT.y,
    sprite: room.dummy?.sprite ?? DUMMY_DEFAULT.sprite,
    grab: room.dummyGrab || null,
  });
}

/** Округление координат манекена до сотых: точности перетаскивания хватает, пакет короче. */
function normDummyCoord(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(0, n)) * 100) / 100;
}

/**
 * Перетаскивание манекена. Клиент → ["dummyMove", { x, y }] — координаты в клеточных
 * долях, уже зажатые клиентом; сервер перепроверяет и рассылает остальным
 * ["dummyMove", { x, y }]. Отправителю эхо не нужно: он уже нарисовал позицию.
 */
function dummyMove(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat || !room.dummy) return;
  const x = normDummyCoord(payload.x, WIDTH - 1);
  const y = normDummyCoord(payload.y, HEIGHT - 1);
  if (x == null || y == null) return;
  room.dummy.x = x;
  room.dummy.y = y;
  broadcast(room, "dummyMove", { x, y }, ws);
}

/**
 * Кто-то взял манекен: комната (включая взявшего) видит курсор с именем тащщего.
 * Клиент → ["dummyGrab"]. Комнате → ["dummyGrab", { login }].
 */
function dummyGrab(ws) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat || !room.dummy) return;
  room.dummyGrab = cat.login;
  broadcast(room, "dummyGrab", { login: room.dummyGrab });
}

/** Манекен отпущен. Клиент → ["dummyDrop"]. Комнате → ["dummyDrop"]. */
function dummyDrop(ws) {
  const room = ws.room;
  if (!room || !room.dummyGrab) return;
  const cat = room.sockets.get(ws);
  if (cat && room.dummyGrab !== cat.login) return;
  room.dummyGrab = null;
  broadcast(room, "dummyDrop", {});
}

/**
 * Боевая мишень «РАБ». Клиент → ["rab", { on }]. Включение/выключение уходит всей
 * комнате (и включившему тоже) пакетом rabState. Позиция фиксирована (RAB_CELL).
 */
function rabToggle(ws, payload = {}) {
  const room = ws.room;
  if (!room) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  if (room.fmt === 'test') {
    send(ws, "info", "В «Элизии Эйдес» мишень недоступна.");
    return;
  }
  const on = !!payload.on;
  room.rab = on ? { on: true } : null;
  broadcast(room, "rabState", { on });
}

/**
 * Удар по мишени РАБ. Клиент → ["rabHit", { zone, part, damage }].
 * Остальным в комнате → ["rabHit", { zone, part, damage }]: качание «желе» и
 * всплывающий урон над мишенью. Бьющему эхо не уходит — он уже анимировал удар
 * локально в момент попадания. Урон зажимаем 0..100, строки режем.
 */
function rabHit(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) return;
  const zone = String(payload.zone || "").trim().slice(0, 32);
  const part = String(payload.part || "").trim().slice(0, 32);
  if (!zone && !part) return;
  const dmgRaw = Number(payload.damage);
  const damage = Number.isFinite(dmgRaw) ? Math.min(100, Math.max(0, Math.round(dmgRaw))) : 0;
  for (const sock of room.sockets.keys()) {
    if (sock === ws) continue;
    send(sock, "rabHit", { zone, part, damage });
  }
}

/**
 * Блок (удержание К). Клиент → ["block", { on }]. Комнате (кроме отправителя) →
 * ["block", { id, on }]. Пока блок держится, strike проводит любые удары по этому
 * коту в зону «Лапы», кроме хвоста — удар в хвост блок не ловит (см. strike).
 * Состояние также входит в publicCat — новички видят его в field.
 */
function block(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat) return;
  cat.blocking = !!payload.on;
  broadcast(room, "block", { id: cat.id, on: cat.blocking }, ws);
}

/** Темп рассылки свободных позиций: чаще — спам, реже — рваное движение у соседей. */
const FREE_MOVE_GAP_MS = 50;

/**
 * Свободная ходьба в мирном режиме комнаты «тест». Клиент → ["freemove", { x, y, stop?, sp? }]
 * — позиция в клеточных долях мира (уже зажатая кромкой локации). Сервер перепроверяет
 * (конечные числа, запас за кромку), обновляет логическую клетку кота (ближайшая
 * проходимая — для ударов и препятствий) и раз в FREE_MOVE_GAP_MS рассылает остальным
 * ["freemove", { id, x, y, cx, cy, sp }]. stop=true — финальная позиция остановки, уходит без темпа.
 * sp=1 — кот спринтит (Shift): чужие клиенты рисуют комочки земли/травы из-под лап.
 */
function freeMove(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat || room.fmt !== 'test') return;
  const x = Number(payload.x);
  const y = Number(payload.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const nx = Math.min(TEST_WIDTH + 0.6, Math.max(-0.6, x));
  const ny = Math.min(TEST_HEIGHT + 0.6, Math.max(-0.6, y));
  // Точка обязана лежать на локации: клиент зажимает ходьбу нарисованной кромкой,
  // сервер перепроверяет по тому же полигону. Спрайт крупнее клетки, у кромки его
  // угол может чуть выходить за полигон при полностью легальной ходьбе — поэтому
  // достаточно, чтобы внутри была хотя бы одна из двух точек (угол и середина).
  if (!pointInPolygon(TEST_ISLAND, nx, ny) && !pointInPolygon(TEST_ISLAND, nx + 0.45, ny + 0.45)) return;
  cat.fm = 1;
  cat.fx = Math.round(nx * 100) / 100;
  cat.fy = Math.round(ny * 100) / 100;
  cat.fsp = payload.stop ? 0 : payload.sp === 1 || payload.sp === true ? 1 : 0;
  const cell = nearestTestCell(cat.fx, cat.fy);
  if (cell) {
    cat.x = cell.x;
    cat.y = cell.y;
  }
  const now = Date.now();
  rememberCat(cat); // позиция в книге (на диск — общим сливом, не чаще 3 с)
  if (!payload.stop && now - (cat.lastFree || 0) < FREE_MOVE_GAP_MS) return;
  cat.lastFree = now;
  broadcast(room, "freemove", { id: cat.id, x: cat.fx, y: cat.fy, cx: cat.x, cy: cat.y, sp: cat.fsp ? 1 : 0 }, ws);
}

/**
 * Возврат в клеточный бой комнаты «тест»: клиент щёлкает на ближайшую проходимую
 * клетку и шлёт ["cellsync", { x, y }] (1-based). Сервер проверяет зону, при занятой
 * клетке ищет свободную рядом, запоминает режим fm=0 и рассылает publicCat всей
 * комнате (и самому отправителю — его onCat синхронизирует клетку).
 */
function cellsync(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat || room.fmt !== 'test') return;
  const x = Math.round(Number(payload.x));
  const y = Math.round(Number(payload.y));
  // Проходимая боевая клетка или клетка захода: в бой входят с захода (кнопкой),
  // и сервер обязан принять его клетку — иначе чужие не увидят смену режима (fm).
  if (!Number.isInteger(x) || !Number.isInteger(y) || (!testWalkable(x, y) && !testEntryCell(x - 1, y - 1))) return;
  if (occupied(room, x, y, cat.id)) {
    outer: for (let rad = 1; rad <= 6; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          const nx = x + dc;
          const ny = y + dr;
          if (testWalkable(nx, ny) && !occupied(room, nx, ny, cat.id)) {
            cat.x = nx;
            cat.y = ny;
            break outer;
          }
        }
      }
    }
  } else {
    cat.x = x;
    cat.y = y;
  }
  cat.fm = 0;
  rememberCat(cat);
  broadcast(room, "update cat", publicCat(cat, room));
}

/**
 * Состав комнат для выбора: клиент → ["rooms", { ids: ["grot-1", ...] }],
 * сервер → ["roomsinfo", [{ id, count, logins }]] в порядке запроса.
 * Пустой комнаты в rooms нет — отвечаем нулём, НЕ создавая её (roomOf растит карту).
 * Опрос частый (экран выбора обновляется каждые пару секунд), но обход дешёвый;
 * от спама одной строкой — минимальный интервал на сокет.
 */
const ROOMS_MIN_GAP_MS = 250;

function roomsInfo(ws, payload = {}) {
  const now = Date.now();
  if (now - (ws.lastRooms || 0) < ROOMS_MIN_GAP_MS) return;
  ws.lastRooms = now;
  const ids = Array.isArray(payload?.ids) ? payload.ids : [];
  const list = ids.slice(0, 32).map((raw) => {
    const key = normalizeRoomCode(raw);
    const room = rooms.get(key);
    return {
      id: key,
      count: room ? room.cats.size : 0,
      logins: room ? [...room.cats.values()].map((c) => c.login) : [],
    };
  });
  send(ws, "roomsinfo", list);
}

function onMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  const event = Array.isArray(msg) ? msg[0] : msg && msg.event;
  const payload = Array.isArray(msg) ? msg[1] : msg;
  if (event === "join" || event === "first") join(ws, payload || {});
  else if (event === "move") move(ws, payload || {});
  else if (event === "aim") aim(ws, payload || {});
  else if (event === "strike") strike(ws, payload || {});
  else if (event === "chat") chat(ws, payload ?? {});
  else if (event === "sprite") setSprite(ws, payload || {});
  else if (event === "dummy") dummyToggle(ws, payload || {});
  else if (event === "dummyMove") dummyMove(ws, payload || {});
  else if (event === "dummyGrab") dummyGrab(ws);
  else if (event === "dummyDrop") dummyDrop(ws);
  else if (event === "rab") rabToggle(ws, payload || {});
  else if (event === "rabHit") rabHit(ws, payload || {});
  else if (event === "block") block(ws, payload || {});
  else if (event === "armor") armor(ws, payload || {});
  else if (event === "freemove") freeMove(ws, payload || {});
  else if (event === "cellsync") cellsync(ws, payload || {});
  else if (event === "setmap") setMap(ws, payload || {});
  else if (event === "rooms") roomsInfo(ws, payload || {});
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, maxPlayers: MAX_PLAYERS }));
    return;
  }
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD,
  verifyClient(info) {
    const origin = info.origin || "";
    const ok = isAllowedOrigin(origin);
    if (!ok) console.warn("ws origin rejected:", origin || "(нет Origin)");
    return ok;
  },
});

/**
 * Heartbeat: обрыв без FIN (мобильная сеть, уход вкладки в сон) иначе держал бы
 * клетку и слот комнаты до таймаута nginx. Пинг раз в 30 с; если pong не пришёл
 * с прошлого пинга — terminate(), его close-обработчик вызовет leave() и освободит клетку.
 */
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
hb.unref();

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  console.log(`ws open ${req.socket.remoteAddress || "?"} origin=${req.headers.origin || "-"}`);
  ws.on("message", (raw) => onMessage(ws, raw));
  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`coop-field http://${HOST}:${PORT}/?room=demo`);
});

/** Периодический слив книги позиций: рестарт по kill не теряет последние шаги. */
const catFlushTimer = setInterval(() => flushCatBook(), 2000);
catFlushTimer.unref();

/** Остановка: дожимаем книгу позиций и карту (если расходится с диском) в файлы. */
function flushOnShutdown() {
  flushCatBook(true);
  try {
    const onDisk = fs.readFileSync(MAP_FILE, "utf8");
    if (onDisk !== JSON.stringify(testMap, null, 2)) saveTestMap();
  } catch {}
}
process.on("SIGTERM", () => {
  flushOnShutdown();
  process.exit(0);
});
process.on("SIGINT", () => {
  flushOnShutdown();
  process.exit(0);
});
