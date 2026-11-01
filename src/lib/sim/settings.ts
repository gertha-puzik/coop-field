// ============================================================
// Модель настроек симулятора боя и математика замедлений.
//
// Система углов: 0° = вправо, 90° = вниз, 180° = влево, 270° = вверх.
// Угол растёт ПО ЧАСОВОЙ стрелке (экранная система координат canvas).
// Диагонали: 45° = вправо-вниз, 135° = влево-вниз, 225° = влево-вверх, 315° = вправо-вверх.
// ============================================================

/** Окно стрелы, в котором движение в данном направлении происходит без замедления. */
export interface DirectionWindow {
  /** Начало окна, ° (окно идёт по часовой от start к end, через 0° при start > end). */
  start: number;
  /** Конец окна, °. */
  end: number;
}

/** Уровень замедления: действует для угла |Δ| <= max (°), замедление value (%). */
export interface SlowdownTier {
  max: number;
  value: number;
}

/** Полоса тела манекена: левая половина / правая / на всю ширину. */
export type ZoneSide = 'left' | 'right' | 'both';

/**
 * Зона попадания: горизонтальная полоса ТЕЛА манекена в пикселях его коробки,
 * приведённой к размеру 100×150 (0 px — верх спрайта, 150 — низ). Луч стрелы,
 * войдя в тело, попадает в зону той полосы, в которой он пересёк ближний край тела
 * (слева/справа — соответствующая половина, сверху/снизу — половина по точке входа).
 */
export interface StrikeZone {
  /** Стабильный идентификатор (для лога). */
  id: string;
  /** Название зоны (в логе и панели). */
  name: string;
  /** Цвет зоны (панель, всплывающий урон, маркер наведения). */
  color: string;
  /** Урон за удар, % энергии цели. */
  damage: number;
  /** Верх полосы, px тела (0..150). */
  py0: number;
  /** Низ полосы, px тела (0..150). */
  py1: number;
  /** Какая половина тела: слева / справа / обе. */
  side: ZoneSide;
}

export type WindowKey = '0' | '45' | '90' | '135' | '180' | '225' | '270' | '315';

/** Идентификатор спрайта персонажа. */
export type SpriteId = 'puhlyashik' | 'blestyashka' | 'puzatik' | 'razdora' | 'pohititel' | 'syrstyashka';

export interface SpriteMeta {
  id: SpriteId;
  name: string;
  src: string;
}

/** Доступные спрайты персонажа (выбор в панели «Персонажи»). */
export const SPRITES: SpriteMeta[] = [
  { id: 'puhlyashik', name: 'Пухляшик', src: '/sprites/puhlyashik.png' },
  { id: 'blestyashka', name: 'Блестяшка', src: '/sprites/blestyashka.png' },
  { id: 'puzatik', name: 'Пузатик', src: '/sprites/puzatik.png' },
  { id: 'razdora', name: 'Пламя Раздора', src: '/sprites/razdora.png' },
  { id: 'pohititel', name: 'Похититель Пламени', src: '/sprites/pohititel.png' },
  { id: 'syrstyashka', name: 'Сырстяшка', src: '/sprites/syrstyashka.png' },
];

/** Настройки отдельного персонажа-мишени (манекена) на поле. */
export interface DummyConfig {
  /** Стабильный идентификатор d1…d5 (энергия в боевом состоянии, переход управления). */
  id: string;
  /** Имя (в логе ударов и в панели). */
  name: string;
  /** Спрайт персонажа. */
  sprite: SpriteId;
  /** Клетка (колонка / ряд, с нуля). */
  col: number;
  row: number;
  /** Рост модельки, % от высоты клетки (60–100). */
  scale: number;
  /** Постоянный угол стрелы, ° (мишень в боевом режиме сразу и не следит за игроком). */
  angle: number;
  /** Добавлен на поле / убран. Убранная модель не занимает клетку. */
  present: boolean;
  /**
   * Рисовать модель на поле. По умолчанию выключено: клетка всё равно занята,
   * удар по ней проходит. Флаг локальный, по сети не уходит.
   */
  visible: boolean;
}

export interface SimSettings {
  field: {
    cols: number;
    rows: number;
    cellW: number;
    cellH: number;
    showGrid: boolean;
    gridColor: string;
    bgColor: string;
    bgColorAlt: string;
    checker: boolean;
  };
  character: {
    /** Выбранный спрайт. */
    sprite: SpriteId;
    /** Базовое время шага на одну клетку, мс (без замедления). */
    stepMs: number;
    /** Размер модельки, % от высоты клетки (60–100); рост от левого верхнего угла клетки. */
    spriteScale: number;
  };
  arrow: {
    battleMode: boolean;
    /** Период полного оборота при удержании J / L, секунд (задаёт скорость ручного вращения). */
    periodSec: number;
    /** Отступ основания стрелы от точки закрепления, px. */
    radius: number;
    /** Длина стрелы, px. */
    length: number;
    /** Толщина линии, px. */
    width: number;
    /** Размер наконечника, px. */
    tipSize: number;
    color: string;
    /** Смещение точки закрепления по вертикали относительно центра клетки, px (вверх = минус). */
    anchorOffsetY: number;
    showOrbit: boolean;
    /** Показывать дугу окна без замедления для последнего направления движения. */
    showWindowArc: boolean;
    /** Показывать точку закрепления стрелы и подсветку наведения; сама стрела всегда видна. */
    showRay: boolean;
  };
  slowdown: {
    windows: Record<WindowKey, DirectionWindow>;
    tiers: SlowdownTier[]; // ровно 3 уровня
    /** Замедление за пределами последнего уровня (спина, |Δ| > 135°), %. */
    maxSlowdown: number;
    showStepLabel: boolean;
    showSpeedBadge: boolean;
  };
  hud: {
    show: boolean;
  };
  /** Персонажи-мишени на поле (манекены): имя, клетка, рост, стрела, убрать/добавить. */
  dummies: DummyConfig[];
  /** За кем сейчас управление: 'main' — свой кот, иначе id манекена. */
  controlled: string;
  /** Удары и энергия: затраты, зоны попадания. */
  combat: {
    /** Стартовая энергия игрока, %. */
    energyStart: number;
    /** Трата энергии за удар при попадании в зону (промах бесплатен), %. */
    strikeCost: number;
    /** Отклик удара, мс: удар применяется через столько после нажатия;
     *  тот же интервал — между ударами при удержании/прожатиях клавиши удара. */
    strikeResponseMs: number;
    /** Автовосстановление энергии у всех, кто в боевом режиме (мишени — всегда). */
    regenEnabled: boolean;
    /** Сколько % энергии восстанавливается за один тик. */
    regenAmount: number;
    /** Интервал тика восстановления, секунд. */
    regenIntervalSec: number;
    /** Показывать лог «Бой» над полем, справа от чата. */
    showLog: boolean;
    /** Уровень урона игрока (выбранный пресет 0,0–0,9). Сам движок читает урон из зон. */
    damageLevel: number;
    /** Зоны попадания (фиксированный набор, значения настраиваются). */
    zones: StrikeZone[];
  };
  /** Внутренний маркер миграции: параметры стрелы нормализованы к размеру модельки 100%. */
  arrowNorm?: boolean;
  /** Внутренний маркер миграции: дефолты обновлены (спрайт Блестяшка, цвет #73a13a, мишень Пухляшик). */
  presetMigrated?: boolean;
  /** Внутренний маркер миграции: горло уже приведено к текущей базе урона 0,0. */
  throatBaseMigrated?: boolean;
}

export interface DirMeta {
  key: WindowKey;
  deg: number;
  dx: number;
  dy: number;
  label: string;
}

/** 8 направлений движения (экранная система углов). */
export const DIRECTIONS: DirMeta[] = [
  { key: '0', deg: 0, dx: 1, dy: 0, label: 'Вправо' },
  { key: '45', deg: 45, dx: 1, dy: 1, label: 'Вправо-вниз' },
  { key: '90', deg: 90, dx: 0, dy: 1, label: 'Вниз' },
  { key: '135', deg: 135, dx: -1, dy: 1, label: 'Влево-вниз' },
  { key: '180', deg: 180, dx: -1, dy: 0, label: 'Влево' },
  { key: '225', deg: 225, dx: -1, dy: -1, label: 'Влево-вверх' },
  { key: '270', deg: 270, dx: 0, dy: -1, label: 'Вверх' },
  { key: '315', deg: 315, dx: 1, dy: -1, label: 'Вправо-вверх' },
];

export function dirByDeg(deg: number): DirMeta {
  const w = wrap360(deg);
  return DIRECTIONS.find((d) => d.deg === w) ?? DIRECTIONS[0];
}

export const DEFAULT_SETTINGS: SimSettings = {
  field: {
    cols: 10,
    rows: 6,
    cellW: 100,
    cellH: 150,
    showGrid: true,
    gridColor: '#454c53',
    bgColor: '#2f343a',
    bgColorAlt: '#343a41',
    checker: false,
  },
  character: {
    sprite: 'blestyashka',
    stepMs: 120,
    spriteScale: 100,
  },
  arrow: {
    battleMode: true,
    periodSec: 4.8,
    radius: 0,
    length: 60,
    width: 6,
    tipSize: 12,
    color: '#73a13a',
    anchorOffsetY: -1,
    showOrbit: false,
    showWindowArc: false,
    showRay: false,
  },
  slowdown: {
    // Окна «без замедления» (калибровка по референсу): вправо — [313°..43°],
    // влево — [135°..220°], у диагоналей — узкие окна.
    windows: {
      '0': { start: 313, end: 43 },
      '45': { start: 45, end: 68 },
      '90': { start: 73, end: 103 },
      '135': { start: 112, end: 125 },
      '180': { start: 135, end: 220 },
      '225': { start: 228, end: 245 },
      '270': { start: 250, end: 290 },
      '315': { start: 290, end: 302 },
    },
    tiers: [
      { max: 65, value: 75 },
      { max: 110, value: 85 },
      { max: 145, value: 93 },
    ],
    maxSlowdown: 95,
    showStepLabel: false,
    showSpeedBadge: false,
  },
  hud: {
    show: false,
  },
  dummies: [
    { id: 'd1', name: 'Пухляшик', sprite: 'puhlyashik', col: 6, row: 3, scale: 100, angle: 0, present: true, visible: false },
    { id: 'd2', name: 'Пузатик', sprite: 'puzatik', col: 8, row: 3, scale: 100, angle: 0, present: true, visible: false },
    { id: 'd3', name: 'Пламя Раздора', sprite: 'razdora', col: 1, row: 1, scale: 100, angle: 0, present: true, visible: false },
    { id: 'd4', name: 'Похититель Пламени', sprite: 'pohititel', col: 3, row: 1, scale: 100, angle: 0, present: true, visible: false },
    { id: 'd5', name: 'Сырстяшка', sprite: 'syrstyashka', col: 4, row: 3, scale: 100, angle: 0, present: true, visible: false },
  ],
  controlled: 'main',
  combat: {
    energyStart: 100,
    strikeCost: 2,
    strikeResponseMs: 170,
    regenEnabled: true,
    regenAmount: 20,
    regenIntervalSec: 5,
    damageLevel: 0,
    showLog: true,
    // Полосы тела в px (0 — верх спрайта, 150 — низ). Стороны как на схеме:
    // хвост/спина/шея — правая, лапы/живот/горло — левая, морда — обе.
    // Урон строки совпадает со схемой; у Хвоста, Спины, Живота и Шеи он и раньше был таким.
    zones: [
      { id: 'tail',   name: 'Хвост', color: '#ff9f0a', damage: 2,  py0: 94, py1: 150, side: 'right' },
      { id: 'paws',   name: 'Лапы',  color: '#2dd4bf', damage: 6,  py0: 94, py1: 150, side: 'left' },
      { id: 'back',   name: 'Спина', color: '#4cd964', damage: 12, py0: 69, py1: 94,  side: 'right' },
      { id: 'muzzle', name: 'Морда', color: '#ffd60a', damage: 18, py0: 64, py1: 0,   side: 'both' },
      { id: 'belly',  name: 'Живот', color: '#ff6fa5', damage: 25, py0: 69, py1: 94,  side: 'left' },
      { id: 'neck',   name: 'Шея',   color: '#bf5af2', damage: 30, py0: 64, py1: 69,  side: 'right' },
      { id: 'throat', name: 'Горло', color: '#64d2ff', damage: 42, py0: 64, py1: 69,  side: 'left' },
    ],
  },
  // Свежий конфиг уже на текущей базе горла: повторная загрузка не переписывает строку.
  throatBaseMigrated: true,
};

// ---------------- Пресеты урона игрока ----------------

/** Урон в горло при уровне игрока 0,0 — как в дефолтной строке зоны «Горло». */
export const THROAT_BASE_DAMAGE = 42;
/** Прибавка урона в горло за каждый шаг уровня 0,1. */
export const THROAT_DAMAGE_STEP = 3.67;
/** Базовый урон по зонам при уровне 0,0 — точка отсчёта пропорций пресетов. */
export const BASE_ZONE_DAMAGE: Record<string, number> = Object.fromEntries(
  DEFAULT_SETTINGS.combat.zones.map((z) => [z.id, z.damage]),
);
/** Уровни пресетов: 0,0 … 0,9. */
export const DAMAGE_LEVELS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** Урон в горло для уровня k (0..9 → 0,0..0,9): база + 3,67% за каждые 0,1, округление до целых. */
export function throatDamageFor(level: number): number {
  return Math.round(THROAT_BASE_DAMAGE + THROAT_DAMAGE_STEP * level);
}

/** Урон зоны для пресета уровня k: горло — напрямую по формуле, остальные зоны
 *  масштабируются пропорционально своей базе (урону при 0,0). */
export function zoneDamageFor(level: number, id: string): number {
  if (id === 'throat') return throatDamageFor(level);
  const base = BASE_ZONE_DAMAGE[id] ?? 0;
  const scale = (THROAT_BASE_DAMAGE + THROAT_DAMAGE_STEP * level) / THROAT_BASE_DAMAGE;
  return Math.round(base * scale);
}

/** Метка пресета для кнопки: 0,0 … 0,9. */
export function damageLevelLabel(level: number): string {
  return (level / 10).toFixed(1).replace('.', ',');
}

// ---------------- Математика ----------------

export function wrap360(a: number): number {
  return ((a % 360) + 360) % 360;
}

export function wrap180(a: number): number {
  const x = wrap360(a);
  return x > 180 ? x - 360 : x;
}

/** Находится ли угол стрелы внутри окна (окно идёт по часовой от start к end). */
export function inWindow(angle: number, w: DirectionWindow): boolean {
  const a = wrap360(angle);
  const s = wrap360(w.start);
  const e = wrap360(w.end);
  if (s <= e) return a >= s && a <= e;
  return a >= s || a <= e;
}

/**
 * Замедление (в %) для прыжка в направлении moveDeg при текущем угле стрелы arrowDeg.
 * Логика:
 *  1) Боевой режим выключен → 0%.
 *  2) Стрела внутри окна направления → 0% (движение без замедления).
 *  3) Иначе — по уровням в зависимости от угла между направлением движения и стрелой.
 */
export function slowdownFor(moveDeg: number, arrowDeg: number, s: SimSettings): number {
  if (!s.arrow.battleMode) return 0;
  const mv = wrap360(moveDeg);
  const w = s.slowdown.windows[String(mv) as WindowKey];
  if (w && inWindow(arrowDeg, w)) return 0;
  const diff = Math.abs(wrap180(mv - wrap360(arrowDeg)));
  for (const t of s.slowdown.tiers) {
    if (diff <= t.max) return t.value;
  }
  return s.slowdown.maxSlowdown;
}

export interface RayBoxHit {
  /** Луч пересекает прямоугольник. */
  hit: boolean;
  /** Расстояние до точки входа, px (кратчайшее пересечение). */
  t: number;
  /** Через какой край луч вошёл в прямоугольник. */
  edge: 'left' | 'right' | 'top' | 'bottom';
  /** Точка входа в координатах тела: x 0..100, y 0..150 (y — как в зонах, px тела). */
  nx: number;
  ny: number;
  /** Точка входа в координатах канваса. */
  px: number;
  py: number;
}

/**
 * Пересечение луча (ax, ay) + t·(ux, uy) с прямоугольником (bx, by, bw, bh).
 * Возвращает точку входа и край; hit=false — луч прошёл мимо тела (это и есть промах).
 */
export function rayBox(
  ax: number,
  ay: number,
  ux: number,
  uy: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): RayBoxHit {
  const noHit: RayBoxHit = { hit: false, t: 0, edge: 'left', nx: 0, ny: 0, px: 0, py: 0 };
  let tmin = -Infinity;
  let tmax = Infinity;
  let edge: RayBoxHit['edge'] = 'left';
  if (Math.abs(ux) < 1e-9) {
    if (ax < bx || ax > bx + bw) return noHit;
  } else {
    let t1 = (bx - ax) / ux;
    let t2 = (bx + bw - ax) / ux;
    let e1: RayBoxHit['edge'] = 'left';
    let e2: RayBoxHit['edge'] = 'right';
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      [e1, e2] = [e2, e1];
    }
    if (t1 > tmin) {
      tmin = t1;
      edge = e1;
    }
    if (t2 < tmax) tmax = t2;
  }
  if (Math.abs(uy) < 1e-9) {
    if (ay < by || ay > by + bh) return noHit;
  } else {
    let t1 = (by - ay) / uy;
    let t2 = (by + bh - ay) / uy;
    let e1: RayBoxHit['edge'] = 'top';
    let e2: RayBoxHit['edge'] = 'bottom';
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      [e1, e2] = [e2, e1];
    }
    if (t1 > tmin) {
      tmin = t1;
      edge = e1;
    }
    if (t2 < tmax) tmax = t2;
  }
  if (tmax < tmin || tmin < 0) return noHit;
  const px = ax + ux * tmin;
  const py = ay + uy * tmin;
  return {
    hit: true,
    t: tmin,
    edge,
    nx: ((px - bx) / bw) * 100,
    ny: ((py - by) / bh) * 150,
    px,
    py,
  };
}

/** Полоса тела, в которую попал луч: первая зона с подходящей стороной и диапазоном px. */
export function resolveZonePixel(ny: number, side: 'left' | 'right', zones: StrikeZone[]): StrikeZone | null {
  return (
    zones.find(
      (z) =>
        (z.side === 'both' || z.side === side) &&
        ny >= Math.min(z.py0, z.py1) &&
        ny <= Math.max(z.py0, z.py1),
    ) ?? null
  );
}

/** Скорость в % (100 − замедление). */
export function speedFor(slowdown: number): number {
  return 100 - slowdown;
}

/** Время шага с учётом замедления: 40% замедления → время × 1/0.6. */
export function stepDuration(baseMs: number, slowdown: number): number {
  const k = 1 - slowdown / 100;
  return baseMs / Math.max(0.05, k);
}

/** Цвет уровня замедления (как на схеме): 0 зелёный, 40 жёлтый, 70 оранжевый, 90 красный. */
export function tierColor(slowdown: number): string {
  if (slowdown <= 0) return '#4cd964';
  if (slowdown <= 40) return '#ffd60a';
  if (slowdown <= 70) return '#ff9f0a';
  return '#ff453a';
}

/** Самая первая калибровка замедлений — чтобы отличать нетронутые сохранённые конфиги от изменённых вручную. */
const LEGACY_SLOWDOWN_V1: SimSettings['slowdown'] = {
  windows: {
    '0': { start: 315, end: 20 },
    '45': { start: 25, end: 65 },
    '90': { start: 70, end: 110 },
    '135': { start: 115, end: 155 },
    '180': { start: 140, end: 220 },
    '225': { start: 205, end: 245 },
    '270': { start: 250, end: 290 },
    '315': { start: 295, end: 335 },
  },
  tiers: [
    { max: 45, value: 40 },
    { max: 90, value: 70 },
    { max: 135, value: 90 },
  ],
  maxSlowdown: 90,
  showStepLabel: false,
  showSpeedBadge: false,
};

/**
 * Промежуточная калибровка (окна как в актуальных дефолтах, но уровни другие) —
 * успела сохраниться в localStorage между правками дефолтов, тоже заменяем на актуальную.
 */
const LEGACY_SLOWDOWN_V2: SimSettings['slowdown'] = {
  windows: { ...DEFAULT_SETTINGS.slowdown.windows },
  tiers: [
    { max: 45, value: 75 },
    { max: 90, value: 80 },
    { max: 135, value: 93 },
  ],
  maxSlowdown: 93,
  showStepLabel: false,
  showSpeedBadge: false,
};

/** Склейка массива манекенов с дефолтами; из старых сохранений мишени
 *  восстанавливаются из combat.target* (Пухляшик) и combat.target2* (Пузатик). */
function mergeDummies(rawD: unknown, rawC: any, d: DummyConfig[]): DummyConfig[] {
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const list: any[] = Array.isArray(rawD) ? rawD : [];
  const legacy = (i: number) => {
    if (rawC == null || typeof rawC !== 'object') return null;
    // старые поля: мишень 1 — targetName/targetCol/targetRow, мишень 2 — target2*
    if (i === 0 && typeof rawC.targetName === 'string' && rawC.targetName.trim()) {
      return { name: rawC.targetName, col: rawC.targetCol, row: rawC.targetRow };
    }
    if (i === 1 && typeof rawC.target2Name === 'string' && rawC.target2Name.trim()) {
      return { name: rawC.target2Name, col: rawC.target2Col, row: rawC.target2Row };
    }
    return null;
  };
  return d.map((dz, i) => {
    const r = list[i] ?? legacy(i) ?? {};
    const sprite = SPRITES.find((sp) => sp.id === r?.sprite)?.id ?? dz.sprite;
    return {
      id: dz.id,
      name: typeof r?.name === 'string' && r.name.trim() ? r.name : dz.name,
      sprite: sprite as SpriteId,
      col: num(r?.col, dz.col, 0, 39),
      row: num(r?.row, dz.row, 0, 39),
      scale: num(r?.scale, dz.scale, 60, 100),
      angle: num(r?.angle, dz.angle, 0, 359),
      present: typeof r?.present === 'boolean' ? r.present : dz.present,
      visible: typeof r?.visible === 'boolean' ? r.visible : dz.visible,
    };
  });
}

/** Совпадает ли сохранённый блок замедлений с эталонной калибровкой (по полям и окнам). */
function slowdownMatches(sd: unknown, ref: SimSettings['slowdown']): boolean {
  if (!sd || typeof sd !== 'object') return false;
  const sdw = sd as Record<string, any>;
  for (const key of Object.keys(ref.windows) as WindowKey[]) {
    const w = sdw.windows?.[key];
    const lw = ref.windows[key];
    if (!w || Number(w.start) !== lw.start || Number(w.end) !== lw.end) return false;
  }
  if (!Array.isArray(sdw.tiers) || sdw.tiers.length !== ref.tiers.length) return false;
  for (let i = 0; i < ref.tiers.length; i++) {
    if (Number(sdw.tiers[i]?.max) !== ref.tiers[i].max) return false;
    if (Number(sdw.tiers[i]?.value) !== ref.tiers[i].value) return false;
  }
  return Number(sdw.maxSlowdown) === ref.maxSlowdown;
}

/** Совпадают ли сохранённые замедления с одной из старых калибровок (тогда обновляем до новой). */
function slowdownIsLegacy(sd: unknown): boolean {
  return slowdownMatches(sd, LEGACY_SLOWDOWN_V1) || slowdownMatches(sd, LEGACY_SLOWDOWN_V2);
}

/** Склейка боевого блока с дефолтами (устойчиво к старым версиям без combat). */
function mergeCombat(rawC: any, d: SimSettings['combat']): SimSettings['combat'] {
  const num = (v: unknown, def: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const rawZones = rawC != null && typeof rawC === 'object' ? rawC.zones : undefined;
  const zones: StrikeZone[] =
    Array.isArray(rawZones) && rawZones.length === d.zones.length
      ? rawZones.map((z: any, i: number) => {
          const dz = d.zones[i];
          const side = z?.side;
          return {
            id: typeof z?.id === 'string' && z.id ? z.id : dz.id,
            name: typeof z?.name === 'string' && z.name ? z.name : dz.name,
            color: typeof z?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(z.color) ? z.color : dz.color,
            damage: num(z?.damage, dz.damage, 0, 100),
            py0: num(z?.py0, dz.py0, 0, 150),
            py1: num(z?.py1, dz.py1, 0, 150),
            side: side === 'left' || side === 'right' || side === 'both' ? side : dz.side,
          };
        })
      : d.zones.map((z) => ({ ...z }));
  return {
    energyStart: num(rawC?.energyStart, d.energyStart, 0, 100),
    strikeCost: num(rawC?.strikeCost, d.strikeCost, 0, 50),
    strikeResponseMs: num(rawC?.strikeResponseMs, d.strikeResponseMs, 30, 600),
    regenEnabled: typeof rawC?.regenEnabled === 'boolean' ? rawC.regenEnabled : d.regenEnabled,
    regenAmount: num(rawC?.regenAmount, d.regenAmount, 0, 100),
    regenIntervalSec: num(rawC?.regenIntervalSec, d.regenIntervalSec, 0.5, 600),
    showLog: typeof rawC?.showLog === 'boolean' ? rawC.showLog : d.showLog,
    damageLevel: num(rawC?.damageLevel, d.damageLevel, 0, 9),
    zones,
  };
}

/** Склейка сохранённых настроек с дефолтными (устойчиво к старым версиям). */
export function mergeSettings(raw: any): SimSettings {
  const d = DEFAULT_SETTINGS;
  const num = (v: unknown, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  // Если сохранённые замедления совпадают со старой калибровкой по умолчанию —
  // подставляем новую (пользователь их не менял). Если изменены вручную — оставляем как есть.
  const rawSlow: any = raw?.slowdown ?? {};
  const slowIsLegacy = slowdownIsLegacy(rawSlow);
  const out: SimSettings = {
    field: { ...d.field, ...(raw?.field ?? {}) },
    character: {
      ...d.character,
      ...(raw?.character ?? {}),
      // размер модельки ограничен диапазоном 60–100%
      spriteScale: Math.min(100, Math.max(60, num(raw?.character?.spriteScale, d.character.spriteScale))),
    },
    arrow: { ...d.arrow, ...(raw?.arrow ?? {}) },
    slowdown: {
      ...d.slowdown,
      ...rawSlow,
      windows: { ...d.slowdown.windows, ...(slowIsLegacy ? d.slowdown.windows : rawSlow.windows ?? {}) },
      tiers:
        !slowIsLegacy && Array.isArray(rawSlow.tiers) && rawSlow.tiers.length === 3
          ? rawSlow.tiers.map((t: any, i: number) => ({
                max: num(t?.max, d.slowdown.tiers[i].max),
                value: num(t?.value, d.slowdown.tiers[i].value),
              }),
            )
          : d.slowdown.tiers.map((t) => ({ ...t })),
      maxSlowdown: slowIsLegacy ? d.slowdown.maxSlowdown : num(rawSlow.maxSlowdown, d.slowdown.maxSlowdown),
    },
    hud: { ...d.hud, ...(raw?.hud ?? {}) },
    dummies: mergeDummies(raw?.dummies, raw?.combat, d.dummies),
    // управление не сохраняется между сессиями: после загрузки всегда играем своим котом
    controlled: 'main',
    combat: mergeCombat(raw?.combat, d.combat),
  };
  if (!SPRITES.some((sp) => sp.id === out.character.sprite)) {
    out.character.sprite = d.character.sprite;
  }
  // Одноразовая миграция: раньше параметры стрелы задавались в «абсолютных» px и не
  // масштабировались вместе с моделькой. Теперь они означают размер при модельке 100%
  // (и автоматически масштабируются ею), поэтому сохранённые значения один раз делим
  // на текущий масштаб — визуально стрела остаётся ровно той же, но начинает расти
  // вместе с персонажем.
  if (raw != null && raw.arrowNorm !== true) {
    const kk = Math.min(100, Math.max(60, out.character.spriteScale)) / 100;
    const norm = (v: number) => Math.round((v / kk) * 10) / 10;
    out.arrow.length = norm(out.arrow.length);
    out.arrow.tipSize = norm(out.arrow.tipSize);
    out.arrow.radius = norm(out.arrow.radius);
    out.arrow.width = norm(out.arrow.width);
  }
  out.arrowNorm = true;
  // Разовая миграция старых сохранений под новые дефолты: подменяем только те значения,
  // что не были изменены вручную (совпадают со старыми дефолтами), выбор пользователя не трогаем.
  if (raw != null && raw.presetMigrated !== true) {
    if (out.character.sprite === 'puhlyashik') out.character.sprite = 'blestyashka';
    if (out.arrow.color === '#219c4a') out.arrow.color = '#73a13a';
  }
  out.presetMigrated = true;
  // Разовая миграция старых сохранений без маркера: горло к текущей базе 0,0.
  // Уже сохранённые зоны (в том числе ручной урон) не затираем, если маркер стоит.
  if (raw != null && raw.throatBaseMigrated !== true) {
    out.combat.zones = out.combat.zones.map((z) =>
      z.id === 'throat' ? { ...z, damage: throatDamageFor(0) } : z,
    );
    out.combat.damageLevel = 0;
  }
  out.throatBaseMigrated = true;
  return out;
}

/** Поиск пути BFS по 8 направлениям; возвращает список клеток БЕЗ стартовой.
 *  blocked — непроходимая клетка (например, клетка другого игрока: сквозь него пройти нельзя). */
export function bfsPath(
  fromC: number,
  fromR: number,
  toC: number,
  toR: number,
  cols: number,
  rows: number,
  blocked?: { c: number; r: number }[] | null,
): { c: number; r: number }[] {
  if (fromC === toC && fromR === toR) return [];
  const blockedList = blocked ?? [];
  if (blockedList.some((b) => b.c === toC && b.r === toR)) return [];
  const isBlocked = (c: number, r: number) => blockedList.some((b) => b.c === c && b.r === r);
  const start = fromR * cols + fromC;
  const goal = toR * cols + toC;
  const prev = new Map<number, number>();
  const seen = new Uint8Array(cols * rows);
  seen[start] = 1;
  const queue: number[] = [start];
  const deltas = [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur === goal) break;
    const cr = Math.floor(cur / cols);
    const cc = cur % cols;
    for (const [dc, dr] of deltas) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (isBlocked(nc, nr)) continue;
      const ni = nr * cols + nc;
      if (seen[ni]) continue;
      seen[ni] = 1;
      prev.set(ni, cur);
      queue.push(ni);
    }
  }
  if (!prev.has(goal)) return [];
  const path: { c: number; r: number }[] = [];
  let cur = goal;
  while (cur !== start) {
    path.push({ c: cur % cols, r: Math.floor(cur / cols) });
    const p = prev.get(cur);
    if (p === undefined) break;
    cur = p;
  }
  return path.reverse();
}
