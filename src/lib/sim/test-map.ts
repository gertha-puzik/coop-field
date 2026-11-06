/**
 * Конфигурация локации комнаты «тест» — то, что правит редактор локации.
 *
 * Мир задаётся размером в клетках и списком зон двух видов:
 *  - «cells» — зона с клетками: в боевом режиме ходьба строго по клеткам,
 *    на земле рисуется доска с сеткой;
 *  - «green» — зелёная зона: только мирный режим (свободная ходьба по якорям),
 *    чистая трава с цветами, сетки нет.
 *
 * Из зон (с отступом margin) клиент и сервер строят одинаковую нарисованную
 * кромку локации, поэтому конфиг обязан проходить строгую проверку
 * (sanitizeTestMap) на обеих сторонах — порт проверки для server.js держится
 * рядом с портом геометрии.
 */

export type TestMapZoneKind = 'cells' | 'green';

/** Объект локации. Камень и дерево — физические препятствия: через них нельзя
 *  пройти ни в мирном режиме, ни в боевом. Земля — наземный спрайт-декор
 *  (проталина на траве), покрытие — наземная плитка (цветы/каменная плитка/пол):
 *  ходьбе не мешают. Заход — клетка входа в боевую зону: стоит на траве рядом
 *  с боевыми клетками, стрелка указывает, куда игрока перенесёт шаг в бою.
 *  Спрайты рисуются от точки опоры вверх (земля/покрытие/заход — по всей клетке). */
export type TestMapObjectKind = 'stone' | 'tree' | 'dirt' | 'entry' | 'ground' | 'battle';

/** Направление клетки захода: куда игрока перенесёт шаг с неё в боевом режиме
 *  (та клетка и есть «последующая» — от неё рисуется градиент на заходе). */
export type TestMapEntryDir = 'left' | 'right' | 'up' | 'down';

/** Сдвиг клетки-назначения для направления захода (0-based клетки). */
export function entryDirDelta(dir: TestMapEntryDir): { dx: number; dy: number } {
  return dir === 'left' ? { dx: -1, dy: 0 } : dir === 'right' ? { dx: 1, dy: 0 } : dir === 'up' ? { dx: 0, dy: -1 } : { dx: 0, dy: 1 };
}

/** Положение спрайта внутри его клетки: по центру (как раньше) или сдвинут к
 *  левому/правому краю, верху или низу — декоративная точность расстановки.
 *  Сдвиг — четверть клетки; коллизии (клетка-препятствие) не зависят от него. */
export type TestMapObjectPos = 'center' | 'left' | 'right' | 'top' | 'bottom';

/** Сдвиг точки опоры спрайта внутри клетки (доли клетки) для каждого положения. */
const TEST_OBJECT_POS_OFFSET: Record<TestMapObjectPos, { dx: number; dy: number }> = {
  center: { dx: 0, dy: 0 },
  left: { dx: -0.25, dy: 0 },
  right: { dx: 0.25, dy: 0 },
  top: { dx: 0, dy: -0.25 },
  bottom: { dx: 0, dy: 0.25 },
};

/** Сдвиг спрайта объекта внутри клетки (доли клетки): положение выбирается
 *  в редакторе при постановке; у старых конфигов без pos — центр. */
export function objectPosOffset(o: TestMapObject): { dx: number; dy: number } {
  return TEST_OBJECT_POS_OFFSET[o.pos ?? 'center'] ?? TEST_OBJECT_POS_OFFSET.center;
}

/** Препятствие это или наземный декор: землю и покрытие в проверки проходимости не берём. */
export function isObstacleKind(kind: TestMapObjectKind): boolean {
  return kind === 'stone' || kind === 'tree';
}

/* ---------- варианты спрайтов препятствий и покрытий ---------- */

/** Деревья пака (нарезаны из TX Plant.png): три вида на выбор в редакторе. */
export const TREE_SPRITE_OPTS = [
  { id: 'tree-1', label: 'Дерево 1' },
  { id: 'tree-2', label: 'Дерево 2' },
  { id: 'tree-3', label: 'Дерево 3' },
] as const;

/** Камни пака (TX Props.png): валун, ряд булышков по возрастанию и плоские камни-ступени. */
export const ROCK_SPRITE_OPTS = [
  { id: 'rock-1', label: 'Валун' },
  { id: 'rock-2', label: 'Булышка' },
  { id: 'rock-3', label: 'Маленький' },
  { id: 'rock-4', label: 'Малый' },
  { id: 'rock-5', label: 'Малый 2' },
  { id: 'rock-6', label: 'Средний' },
  { id: 'rock-7', label: 'Крупный' },
  { id: 'rock-8', label: 'Ступень' },
  { id: 'rock-9', label: 'Ступень 2' },
  { id: 'rock-10', label: 'Ступени' },
] as const;

/** Покрытия земли (тайлы 16 px пака, рисуются паттерном по клетке). */
export const GROUND_COVER_OPTS = [
  { id: 'grass-1', label: 'Трава 1' },
  { id: 'grass-2', label: 'Трава 2' },
  { id: 'flower-1', label: 'Цветы 1' },
  { id: 'flower-2', label: 'Цветы 2' },
  { id: 'flower-3', label: 'Цветы 3' },
  { id: 'flower-4', label: 'Цветы 4' },
  { id: 'slab-1', label: 'Плитка 1' },
  { id: 'slab-2', label: 'Плитка 2' },
  { id: 'slab-3', label: 'Плитка 3' },
  { id: 'slab-4', label: 'Плитка 4' },
  { id: 'floor-1', label: 'Пол 1' },
  { id: 'floor-2', label: 'Пол 2' },
  { id: 'floor-3', label: 'Пол 3' },
] as const;

export type TreeSpr = (typeof TREE_SPRITE_OPTS)[number]['id'];
export type RockSpr = (typeof ROCK_SPRITE_OPTS)[number]['id'];
export type GroundCover = (typeof GROUND_COVER_OPTS)[number]['id'];

const TREE_SPRITE_IDS = new Set<string>(TREE_SPRITE_OPTS.map((t) => t.id));
const ROCK_SPRITE_IDS = new Set<string>(ROCK_SPRITE_OPTS.map((t) => t.id));
const GROUND_COVER_IDS = new Set<string>(GROUND_COVER_OPTS.map((t) => t.id));

/** Спрайт объекта: заданный в конфиге или дефолт по виду (старые конфиги без spr). */
export function objectSprite(o: Pick<TestMapObject, 'kind' | 'spr'>): TreeSpr | RockSpr {
  if (o.kind === 'tree') return TREE_SPRITE_IDS.has(o.spr ?? '') ? (o.spr as TreeSpr) : 'tree-1';
  return ROCK_SPRITE_IDS.has(o.spr ?? '') ? (o.spr as RockSpr) : 'rock-1';
}

/** Покрытие клетки: заданное в конфиге или дефолт (цветы 1). */
export function groundCoverOf(o: Pick<TestMapObject, 'cv'>): GroundCover {
  return GROUND_COVER_IDS.has(o.cv ?? '') ? (o.cv as GroundCover) : 'flower-1';
}

/** Пределы масштаба и поворота объектов в редакторе. */
export const OBJECT_SCALE_MIN = 0.4;
export const OBJECT_SCALE_MAX = 3.5;
export const OBJECT_ROT_STEP = 15;

/** Масштаб объекта (старые конфиги без s — 1). */
export function objectScale(o: Pick<TestMapObject, 's'>): number {
  return typeof o.s === 'number' && Number.isFinite(o.s) ? o.s : 1;
}

/** Поворот объекта в градусах (старые конфиги без rot — 0). */
export function objectRotDeg(o: Pick<TestMapObject, 'rot'>): number {
  return typeof o.rot === 'number' && Number.isFinite(o.rot) ? o.rot : 0;
}

/** Отзеркален ли спрайт объекта по горизонтали (конфиги без mir — нет). */
export function objectMir(o: Pick<TestMapObject, 'mir'>): 0 | 1 {
  return o.mir === 1 ? 1 : 0;
}

/** Точка опоры объекта в клеточных долях мира: свободная (x, y) у новых конфигов;
 *  старые (только c/r/pos) — по центру клетки с её сдвигом, низ клетки — опора. */
export function objectBase(o: TestMapObject): { x: number; y: number } {
  if (typeof o.x === 'number' && typeof o.y === 'number') return { x: o.x, y: o.y };
  const po = objectPosOffset(o);
  return { x: o.c + 0.5 + po.dx, y: o.r + 1 + po.dy };
}

/** Размеры спрайтов пака в px (нативные, после нарезки): [ширина, высота]. */
export const OBJECT_DIMS: Record<string, [number, number]> = {
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

/**
 * Физическое тело препятствия у земли в px мира (до масштаба): [полуширина, высота
 * вверх от точки опоры]. У дерева — ствол (крона не мешает ходить под ней в бою
 * не будет, а в мирном режиме проход за кроной читается), у камня — подошва
 * пропорционально спрайту. Тело «обтекаемое»: проверяется эллипсом, повёрнутым
 * вместе с объектом (см. testPeaceObjectsFree / buildCells на сервере).
 */
export function obstacleBodyPx(o: Pick<TestMapObject, 'kind' | 'spr'>): { hw: number; h: number } {
  if (o.kind === 'tree') return { hw: 14, h: 16 };
  const dims = OBJECT_DIMS[objectSprite(o)] ?? [57, 42];
  return { hw: dims[0] * 0.38, h: dims[1] * 0.32 };
}

/** Объект локации: см. описание TestMapObjectKind выше. */
export type TestMapObject = {
  id: string;
  kind: TestMapObjectKind;
  /** 0-based клетка: у земли/покрытия/захода — клетка, которую объект занимает
   *  целиком; у камня/дерева — клетка точки опоры (для совместимости и списков). */
  c: number;
  r: number;
  /** Свободная точка опоры (доли клетки, низ спрайта) — у камня/дерева вместо
   *  привязки к клетке: ставится где угодно. У старых конфигов нет — тогда
   *  позиция считается из c/r/pos. */
  x?: number;
  y?: number;
  /** Масштаб спрайта (0.4–3.5, 1 — натуральный) и поворот в градусах (0–359). */
  s?: number;
  rot?: number;
  /** Вариант спрайта: дерево (tree-1..3) или камень (rock-1..10). */
  spr?: string;
  /** Отзеркален ли спрайт по горизонтали (1 — да). Картинка — тело препятствия
   *  симметрично, физика не меняется. */
  mir?: number;
  /** Вариант покрытия земли (только для kind «ground»). */
  cv?: string;
  /** Положение спрайта внутри клетки (по умолчанию — центр; legacy, новые
   *  объекты ставятся свободно и поле не используют). */
  pos?: TestMapObjectPos;
  /** Направление захода (только для kind «entry»): куда перенесёт шаг в бою. */
  dir?: TestMapEntryDir;
};

export type TestMapZone = {
  id: string;
  name: string;
  kind: TestMapZoneKind;
  /** 0-based координаты, включительно: зона занимает клетки c0..c1 × r0..r1. */
  c0: number;
  r0: number;
  c1: number;
  r1: number;
};

/** Клетка спавна — точка появления игроков. Живёт отдельным списком (не в
 *  objects), чтобы не спорить с декором за клетку: спавн можно ставить поверх
 *  проталин/покрытий. На поле клетка ничем не отличается от соседних — маркер
 *  виден только в редакторе. */
export type TestMapSpawn = { c: number; r: number };

/** Предел высоты рельефа (уровней над базовой землёй). 0 — обычная земля,
 *  3 — самый высокий уступ. ЛЮБОЙ перепад уровней между соседними клетками —
 *  стенка: шагом не проходится, только прыжком (заряд пробела определяет
 *  максимальный перепад). Значения хранятся разреженно: ключ «c,r» (0-based) →
 *  уровень 1..3; отсутствие клетки и явный 0 — одно и то же (обычная земля). */
export const TERRAIN_MAX_LEVEL = 3;

/* ---------- пиксельная отрисовка локации (кисть редактора) ---------- */

/** Закрашенная кистью локация: PNG (base64, без data:-префикса) размером с мир
 *  в пикселях (cols*cellW x rows*cellH). Непрозрачные пиксели — земля: её видит
 *  игрок и по ней ходит в мирном режиме; прозрачные — пустота за кромкой.
 *  Когда paint задан, он — единственный источник формы локации и её внешнего
 *  вида: зоны остаются только списком боевых областей, проталины и покрытия
 *  «запекаются» в картинку при первом сохранении из редактора. */
export type PaintedGround = string;

/** Предел размера paint (base64-символов): мир максимум 60x40 клеток —
 *  9000x4000 px, PNG пиксель-арта весит десятки килобайт, запас — на плотную
 *  заливку мелкой кистью. */
export const PAINT_MAX_BASE64 = 3_500_000;

/** PNG-магия в base64 (первые байты 89 50 4E 47 0D 0A 1A 0A). */
export const PAINT_PNG_PREFIX = 'iVBORw0KGgo';

/** Быстрая проверка формата paint без декодирования: строка, размер, base64,
 *  PNG-магия. Полная проверка размеров/декодирование — на сторонах с Image/zlib. */
export function paintFormatError(paint: unknown): string | null {
  if (typeof paint !== 'string' || paint.length === 0) return 'рисунок локации не распознан';
  if (paint.length > PAINT_MAX_BASE64) return 'рисунок локации слишком велик';
  if (!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(paint)) {
    return 'рисунок локации не base64';
  }
  if (!paint.startsWith(PAINT_PNG_PREFIX)) return 'рисунок локации не PNG';
  return null;
}

/** Есть ли у конфига пиксельная отрисовка (непустая строка). */
export function mapHasPaint(map: Pick<TestMap, 'paint'>): boolean {
  return typeof map.paint === 'string' && map.paint.length > 0;
}

/** Уровень клетки из карты высот (0-based координаты; нет клетки — 0). */
export function mapElevOf(map: Pick<TestMap, 'elev'>, c: number, r: number): number {
  const v = map.elev?.[`${c},${r}`];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(TERRAIN_MAX_LEVEL, Math.max(0, Math.round(v))) : 0;
}

export type TestMap = {
  /** Версия конфига: 1 — клетки везде, 2 — деление поля на траву и боевые клетки.
   *  Старый файл с v1 сервер поднимает до дефолта v2 при загрузке (миграция). */
  v: number;
  cols: number;
  rows: number;
  /** Насколько (в долях клетки) нарисованная кромка отступает от зон. */
  margin: number;
  /** Сид дрожи кромки и декора — одинаковая картинка у всех игроков. */
  seed: string;
  zones: TestMapZone[];
  /** Физические препятствия: камни и деревья (появились позже зон — поэтому
   *  необязательное поле; старые конфиги без него читаются как «пусто»). */
  objects?: TestMapObject[];
  /** Клетки спавна (точки появления игроков): новый игрок появляется на
   *  случайной свободной из них. Необязательное поле — старые конфиги без
   *  него читаются как «пусто», спавн тогда работает по-старому (первая
   *  свободная клетка травы). */
  spawns?: TestMapSpawn[];
  /** Карта высот рельефа (необязательное поле — старые конфиги без него
   *  читаются как «везде 0»): ключ «c,r» (0-based) → уровень 1..TERRAIN_MAX_LEVEL.
   *  Разреженная: клетки без записи — базовая земля. Редактор меняет кистями
   *  «Насыпать/Срыть/Ровно», сервер хранит и раздаёт вместе с конфигом. */
  elev?: Record<string, number>;
  /** Пиксельная отрисовка локации (необязательное поле — конфиги до кисти живут
   *  по-старому): PNG base64 размером с мир в пикселях, непрозрачность — земля.
   *  Задан — форма локации и её вид берутся из рисунка (см. PaintedGround). */
  paint?: PaintedGround;
};

/** Пределы редактора: мир, число зон и число объектов. Лимит объектов крупный:
 *  проталины земли ставят протяжкой, и их на локации бывает много. */
export const TEST_MAP_LIMITS = {
  colsMin: 6,
  colsMax: 60,
  rowsMin: 3,
  rowsMax: 40,
  zonesMax: 48,
  objectsMax: 2000,
  spawnsMax: 64,
  nameMax: 24,
} as const;

/** Локация «тест» по умолчанию — трава с двумя зелёными зонами и боевым полигоном
 *  посередине: новичок спавнится на траве (мирный режим), бой включается сам на
 *  жёлтых боевых клетках. Редактором локация меняется и живёт на сервере. */
export const TEST_MAP_DEFAULT: TestMap = {
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
};

let uidSeq = 0;

/** Уникальный id зоны (в пределах сессии — больше от него ничего не требуется). */
export function newZoneId(): string {
  uidSeq += 1;
  return `z${Date.now().toString(36)}-${uidSeq.toString(36)}`;
}

/** Уникальный id препятствия (камень/дерево). */
export function newObjectId(): string {
  uidSeq += 1;
  return `o${Date.now().toString(36)}-${uidSeq.toString(36)}`;
}

function asInt(v: unknown): number | null {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}

/**
 * Зоны обязаны срастаться в один островок: у контура объединения в каждой вершине
 * ровно два граничных ребра только если зоны перекрываются или касаются сторонами.
 * Диагональное касание или разрыв дают развилку/второй остров — контур соберётся
 * неверно, поэтому такая конфигурация отклоняется с понятной ошибкой.
 */
export function testMapConnectivityError(zones: TestMapZone[]): string | null {
  const cells = new Set<string>();
  for (const z of zones) {
    for (let r = z.r0; r <= z.r1; r++) {
      for (let c = z.c0; c <= z.c1; c++) cells.add(`${c},${r}`);
    }
  }
  if (cells.size === 0) return 'Локация пуста — нужна хотя бы одна зона.';
  const start = cells.keys().next().value as string;
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const [c, r] = queue.pop()!.split(',').map(Number);
    for (const [dc, dr] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const k = `${c + dc},${r + dr}`;
      if (cells.has(k) && !seen.has(k)) {
        seen.add(k);
        queue.push(k);
      }
    }
  }
  if (seen.size !== cells.size) {
    return 'Зоны должны соединяться в одну локацию (касаться сторонами, не углами).';
  }
  return null;
}

/**
 * Строгая проверка конфига (клиент перед отправкой и сервер перед сохранением).
 * Возвращает нормализованный конфиг или понятную ошибку — второе сообщение идёт
 * в интерфейс редактора без изменений.
 */
export function sanitizeTestMap(raw: unknown): { map?: TestMap; error?: string } {
  if (!raw || typeof raw !== 'object') return { error: 'конфиг не распознан' };
  const src = raw as Partial<TestMap> & { v?: unknown };
  // v1 — legacy-раскладка «клетки везде» (сервер мигрирует её к дефолту v2),
  // v2 — текущая: трава (мир) + боевые клетки. Другие версии не знаем.
  if (src.v !== 1 && src.v !== 2) return { error: 'неизвестная версия конфига' };
  const cols = asInt(src.cols);
  const rows = asInt(src.rows);
  if (cols === null || rows === null) return { error: 'размер мира не распознан' };
  if (cols < TEST_MAP_LIMITS.colsMin || cols > TEST_MAP_LIMITS.colsMax) {
    return { error: `ширина мира должна быть ${TEST_MAP_LIMITS.colsMin}–${TEST_MAP_LIMITS.colsMax}` };
  }
  if (rows < TEST_MAP_LIMITS.rowsMin || rows > TEST_MAP_LIMITS.rowsMax) {
    return { error: `высота мира должна быть ${TEST_MAP_LIMITS.rowsMin}–${TEST_MAP_LIMITS.rowsMax}` };
  }
  if (!Array.isArray(src.zones) || src.zones.length === 0) return { error: 'список зон пуст' };
  if (src.zones.length > TEST_MAP_LIMITS.zonesMax) {
    return { error: `зон не больше ${TEST_MAP_LIMITS.zonesMax}` };
  }
  // Препятствия необязательны: старые конфиги без поля objects читаются как «пусто».
  let objects: TestMapObject[] = [];
  if (src.objects != null) {
    if (!Array.isArray(src.objects)) return { error: 'список препятствий не распознан' };
    if (src.objects.length > TEST_MAP_LIMITS.objectsMax) {
      return { error: `объектов не больше ${TEST_MAP_LIMITS.objectsMax}` };
    }
    const taken = new Set<string>();
    for (let i = 0; i < src.objects.length; i++) {
      const o = src.objects[i] as Partial<TestMapObject>;
      const kind =
        o.kind === 'stone'
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
                    : null;
      if (!kind) return { error: `объект №${i + 1}: неизвестный тип` };
      // Свободная точка опоры камня/дерева: дробные x/y; у старых конфигов её нет —
      // считаем из клетки и положения в ней (миграция при первом же сохранении).
      let x = 0;
      let y = 0;
      if (kind === 'stone' || kind === 'tree') {
        const fx = Number(o.x);
        const fy = Number(o.y);
        if (Number.isFinite(fx) && Number.isFinite(fy)) {
          x = Math.min(cols + 0.5, Math.max(-0.5, Math.round(fx * 100) / 100));
          y = Math.min(rows + 1.5, Math.max(-0.5, Math.round(fy * 100) / 100));
        } else {
          const c0 = asInt(o.c) ?? 0;
          const r0 = asInt(o.r) ?? 0;
          const po = TEST_OBJECT_POS_OFFSET[o.pos ?? 'center'] ?? TEST_OBJECT_POS_OFFSET.center;
          x = Math.min(cols + 0.5, Math.max(-0.5, Math.round((c0 + 0.5 + po.dx) * 100) / 100));
          y = Math.min(rows + 1.5, Math.max(-0.5, Math.round((r0 + 1 + po.dy) * 100) / 100));
        }
      }
      const c = asInt(o.c ?? Math.floor(x));
      const r = asInt(o.r ?? Math.floor(y));
      if (c === null || r === null || c < 0 || r < 0 || c >= cols || r >= rows) {
        return { error: `препятствие №${i + 1}: вне границ мира` };
      }
      // Положение спрайта в клетке необязательное: нет — центр (как в старых конфигах).
      const pos: TestMapObjectPos =
        o.pos === 'left' || o.pos === 'right' || o.pos === 'top' || o.pos === 'bottom' ? o.pos : 'center';
      // Направление захода обязательно и только для заходов.
      let dir: TestMapEntryDir | undefined;
      if (kind === 'entry') {
        if (o.dir !== 'left' && o.dir !== 'right' && o.dir !== 'up' && o.dir !== 'down') {
          return { error: `заход №${i + 1}: не задано направление шага` };
        }
        dir = o.dir;
      }
      // Масштаб, поворот и вариант спрайта — только у препятствий.
      let s: number | undefined;
      let rot: number | undefined;
      let spr: string | undefined;
      let cv: string | undefined;
      let mir: 0 | 1 | undefined;
      if (kind === 'stone' || kind === 'tree') {
        const sn = Number(o.s);
        s = Number.isFinite(sn)
          ? Math.min(OBJECT_SCALE_MAX, Math.max(OBJECT_SCALE_MIN, Math.round(sn * 100) / 100))
          : undefined;
        const rn = Math.round(Number(o.rot));
        rot = Number.isFinite(rn) ? ((rn % 360) + 360) % 360 : undefined;
        const raw = typeof o.spr === 'string' ? o.spr : '';
        spr = kind === 'tree' ? (TREE_SPRITE_IDS.has(raw) ? raw : 'tree-1') : ROCK_SPRITE_IDS.has(raw) ? raw : 'rock-1';
        mir = o.mir === 1 ? 1 : undefined;
      }
      if (kind === 'ground') {
        cv = GROUND_COVER_IDS.has(String(o.cv)) ? String(o.cv) : 'flower-1';
      }
      // Земля/покрытие/заход/боевая клетка — по клетке на объект; камень и дерево
      // стоят свободно и на клетку не «схлопываются».
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
  // Пиксельная отрисовка: необязательное поле, строгий формат (PNG base64).
  // Содержимое здесь не декодируется: у клиента Image, у сервера zlib — свои
  // проверки размеров и альфы; формат отсекает мусор до записи в конфиг.
  let paint: PaintedGround | undefined;
  if (src.paint != null) {
    const perr = paintFormatError(src.paint);
    if (perr) return { error: perr };
    paint = src.paint;
  }
  // С рисунком проталины и покрытия не нужны: они «запечены» в пиксели кистью.
  if (paint != null) objects = objects.filter((o) => o.kind !== 'dirt' && o.kind !== 'ground');
  const zones: TestMapZone[] = [];
  for (let i = 0; i < src.zones.length; i++) {
    const z = src.zones[i] as Partial<TestMapZone>;
    const kind = z.kind === 'green' ? 'green' : z.kind === 'cells' ? 'cells' : null;
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
    const name = String(z.name ?? '').trim().slice(0, TEST_MAP_LIMITS.nameMax) || (kind === 'cells' ? 'Клетки' : 'Зелёная зона');
    zones.push({ id: `z${i + 1}`, name, kind, c0, r0, c1, r1 });
  }
  if (!zones.some((z) => z.kind === 'cells') && !(paint != null && objects.some((o) => o.kind === 'battle'))) {
    return { error: 'нужна хотя бы одна зона с клетками — иначе бой не работает' };
  }
  // Клетки захода: только на траве, и по направлению шага обязана быть боевая
  // клетка — иначе заход не ведёт в бой (проверка тут, потому что зоны уже дочитаны).
  const battleAt = (c: number, r: number): boolean =>
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
    const d = entryDirDelta(o.dir);
    if (!battleAt(o.c + d.dx, o.r + d.dy)) {
      return { error: `заход на клетке ${o.c}×${o.r}: по направлению шага должна быть боевая клетка` };
    }
  }
  // С рисунком зоны не обязаны срастаться: форма локации — из пикселей, зоны —
  // просто списки боевых областей (могут стоять островами).
  if (paint == null) {
    const conn = testMapConnectivityError(zones);
    if (conn) return { error: conn };
  }
  // Клетки спавна: необязательный список (старые конфиги без него — «пусто»).
  // Ставятся только на траве (зелёной зоне) и не на боевых клетках: новичок
  // появляется в мирном режиме. Дубликаты схлопываются, порядок сохраняется.
  let spawns: TestMapSpawn[] = [];
  if (src.spawns != null) {
    if (!Array.isArray(src.spawns)) return { error: 'список клеток спавна не распознан' };
    if (src.spawns.length > TEST_MAP_LIMITS.spawnsMax) {
      return { error: `клеток спавна не больше ${TEST_MAP_LIMITS.spawnsMax}` };
    }
    const seenSp = new Set<string>();
    for (let i = 0; i < src.spawns.length; i++) {
      const s = src.spawns[i] as Partial<TestMapSpawn>;
      const c = asInt(s.c);
      const r = asInt(s.r);
      if (c === null || r === null) return { error: `спавн №${i + 1}: координаты не распознаны` };
      if (c < 0 || r < 0 || c >= cols || r >= rows) {
        return { error: `спавн №${i + 1}: вне границ мира` };
      }
      const onGreen = zones.some((z) => z.kind === 'green' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1);
      const onBattle =
        zones.some((z) => z.kind === 'cells' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1) ||
        objects.some((o) => o.kind === 'battle' && o.c === c && o.r === r);
      // С рисунком спавн ставится на любое место не на боевых клетках (проверку
      // закраски ведёт редактор — у него есть декодированный рисунок); без
      // рисунка — по-старому, только в зелёной зоне.
      if ((paint != null && onBattle) || (paint == null && (!onGreen || onBattle))) {
        return { error: `спавн №${i + 1}: клетка спавна ставится на траве (зелёной зоне), не на боевых клетках` };
      }
      const key = `${c},${r}`;
      if (seenSp.has(key)) continue;
      seenSp.add(key);
      spawns.push({ c, r });
    }
  }
  // Карта высот рельефа: необязательный разреженный словарь «c,r» → уровень 1..3.
  // Нули, мусор и клетки вне мира выбрасываются; целые уровни зажимаются в предел.
  let elev: Record<string, number> | undefined;
  if (src.elev != null) {
    if (typeof src.elev !== 'object' || Array.isArray(src.elev)) return { error: 'карта высот не распознана' };
    const raw = src.elev as Record<string, unknown>;
    const clean: Record<string, number> = {};
    for (const [key, val] of Object.entries(raw)) {
      const m = /^(\d+),(\d+)$/.exec(key);
      if (!m) continue;
      const c = Number(m[1]);
      const r = Number(m[2]);
      if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
      const lv = Math.round(Number(val));
      if (!Number.isFinite(lv) || lv <= 0) continue;
      clean[key] = Math.min(TERRAIN_MAX_LEVEL, lv);
    }
    if (Object.keys(clean).length > 0) elev = clean;
  }
  return {
    map: {
      v: src.v,
      cols,
      rows,
      margin: 0.5,
      seed: typeof src.seed === 'string' && src.seed.trim() ? src.seed.trim().slice(0, 24) : 'test',
      zones,
      objects,
      spawns,
      ...(elev ? { elev } : {}),
      ...(paint ? { paint } : {}),
    },
  };
}
