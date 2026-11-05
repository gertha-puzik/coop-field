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
import path from "node:path";
import {
  ADMIN_PASS, DATA_DIR, TEST_ROOM,
  OBJECT_SCALE_MIN, OBJECT_SCALE_MAX, TREE_SPRITE_IDS, ROCK_SPRITE_IDS,
} from "./config.js";
import { EV, GROUND_COVER_IDS, TERRAIN_MAX_LEVEL, TEST_MAP_LIMITS } from "./protocol.js";
import {
  decodePaintPng, paintPxMask, paintCellCoverageMask,
  buildIsland, buildCells, obstacleBlockedCells, obstacleBodiesOf,
  pointInPolygon, nearestTestCell, testWalkable,
} from "./world.js";
import { send, broadcast, fieldPayload, rooms } from "./room.js";
import { rememberCat } from "./persist.js";

const MAP_FILE = path.join(DATA_DIR, "test-map.json");

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
function rebuildTestGeometry() {
  TEST_WIDTH = testMap.cols;
  TEST_HEIGHT = testMap.rows;
  TEST_PAINT = testMap.paint ? decodePaintPng(testMap.paint) : null;
  if (testMap.paint && !TEST_PAINT) console.warn("paint decode failed — форма локации по зонам");
  TEST_ISLAND = buildIsland(testMap);
  TEST_CELLS = buildCells(testMap, TEST_ISLAND);
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
  if (!Array.isArray(raw.zones) || raw.zones.length === 0) return { error: 'список зон пуст' };
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
                  : o.kind === 'battle'
                    ? 'battle'
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
      let mir;
      if (kind === 'stone' || kind === 'tree') {
        const sn = Number(o.s);
        s = Number.isFinite(sn) ? Math.min(OBJECT_SCALE_MAX, Math.max(OBJECT_SCALE_MIN, Math.round(sn * 100) / 100)) : undefined;
        const rn = Math.round(Number(o.rot));
        rot = Number.isFinite(rn) ? ((rn % 360) + 360) % 360 : undefined;
        spr = kind === 'tree' ? (TREE_SPRITE_IDS.has(o.spr) ? o.spr : 'tree-1') : ROCK_SPRITE_IDS.has(o.spr) ? o.spr : 'rock-1';
        mir = o.mir === 1 ? 1 : undefined;
      }
      if (kind === 'ground') {
        cv = GROUND_COVER_IDS.includes(String(o.cv)) ? String(o.cv) : 'flower-1';
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
        ...(kind === 'stone' || kind === 'tree' ? { x, y, s, rot, spr, mir } : {}),
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
  if (!zones.some((z) => z.kind === 'cells') && !(paint && objects.some((o) => o.kind === 'battle'))) {
    return { error: 'нужна хотя бы одна зона с клетками — иначе бой не работает' };
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
    elev = {};
    for (const [key, val] of Object.entries(raw.elev)) {
      const m = /^(\d+),(\d+)$/.exec(key);
      if (!m) continue;
      const c = Number(m[1]);
      const r = Number(m[2]);
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const lv = Math.round(Number(val));
      if (!Number.isFinite(lv) || lv <= 0) continue;
      elev[key] = Math.min(TERRAIN_MAX_LEVEL, lv);
    }
    if (Object.keys(elev).length === 0) elev = undefined;
  }
  return {
    map: {
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
const SETMAP_MIN_GAP_MS = 10000;

function setMap(ws, payload = {}) {
  const now = Date.now();
  // Троттлинг на ЛЮБОЙ setmap-кадр, верный пароль тому не исключение: кадр
  // запускает тяжёлую работу (PNG-декод, пересборку всей геометрии, запись
  // с бэкапами), так что защита нужна не только от перебора пароля. Счётчик
  // живёт на сокете (по аналогии с lastJoin); отброшенный кадр окно
  // не продлевает — окно отсчитывается от последнего пропущенного кадра.
  if (now - (ws.lastSetmap || 0) < SETMAP_MIN_GAP_MS) {
    send(ws, EV.INFO, 'Редактор: слишком часто.');
    return;
  }
  ws.lastSetmap = now;
  if (String(payload?.pass || '') !== ADMIN_PASS) {
    send(ws, EV.INFO, 'Редактор: неверный пароль.');
    return;
  }
  const r = sanitizeTestMap(payload?.map);
  if (!r.map) {
    send(ws, EV.INFO, `Редактор: ${r.error}.`);
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
    send(ws, EV.INFO, `Редактор: локация применилась, но записать её на диск не удалось — ${e?.message || e}. После рестарта сервера она потеряется.`);
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
    for (const w of room.sockets.keys()) send(w, EV.MAP, testMap);
    broadcast(room, EV.FIELD, fieldPayload(room));
  }
  console.log(`map set: ${testMap.cols}x${testMap.rows}, zones=${testMap.zones.length}, objects=${(testMap.objects || []).length}, spawns=${(testMap.spawns || []).length}`);
}

export {
  MAP_FILE, rebuildTestGeometry, defaultTestMap, sanitizeTestMap, saveTestMap, setMap, loadTestMap,
  writeFileAtomic,
};
