// ============================================================
// Модель настроек симулятора боя и математика замедлений.
//
// Система углов: 0° = вправо, 90° = вниз, 180° = влево, 270° = вверх.
// Угол растёт ПО ЧАСОВОЙ стрелке (экранная система координат canvas).
// Диагонали: 45° = вправо-вниз, 135° = влево-вниз, 225° = влево-вверх, 315° = вправо-вверх.
// ============================================================

/** Надпись об авторах: футер страницы входа и страницы поля. */
export const GAME_CREDITS = 'Абноукетвар разработан Пухляшиком и Сырь, идейно вдохновлён Суперняшкой Блестяшкой';

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

/**
 * Идентификатор спрайта персонажа. ДО менеджера спрайтов был литеральным
 * union 31 базового id (+ 'rab' — мишень); каталог стал динамическим
 * (GET /sprites/catalog + админский менеджер загружает новые скины,
 * server/sprites.js), серверные id новых — translit-slugs произвольных имён,
 * поэтому тип расширён до строки осознанно. Все runtime-проверки строгие:
 * валидатор сервера (манифест каталога) и валидатор join-пакета на клиенте.
 * Базовые id перечислены массивом SPRITES ниже (каталог сида).
 */
export type SpriteId = string;

export interface SpriteMeta {
  id: SpriteId;
  name: string;
  src: string;
  /**
   * Категория каталога (админский менеджер спрайтов, server/sprites.js):
   * свободная строка, у записей статичного базового набора поля нет
   * (undefined) — интерфейс только расширен, существующие свойства не менялись.
   */
  category?: string;
}

/** Доступные спрайты персонажа (экран выбора перед полем). */
export const SPRITES: SpriteMeta[] = [
  { id: 'puhlyashik', name: 'Пухляшик', src: '/sprites/puhlyashik.png' },
  { id: 'puhlyashshshshshshshsh', name: 'Пухляшшшшшшшш', src: '/sprites/puhlyashshshshshshshsh.png' },
  { id: 'blestyashka', name: 'Блестяшка', src: '/sprites/blestyashka.png' },
  { id: 'puzatik', name: 'Пузатик', src: '/sprites/puzatik.png' },
  { id: 'razdora', name: 'Пламя Раздора', src: '/sprites/razdora.png' },
  { id: 'pohititel', name: 'Похититель Пламени', src: '/sprites/pohititel.png' },
  { id: 'gromoryov', name: 'Громорёв', src: '/sprites/gromoryov.png' },
  { id: 'gremuchnik', name: 'Гремучник', src: '/sprites/gremuchnik.png' },
  { id: 'syrstyashka', name: 'Сырстяшка', src: '/sprites/syrstyashka.png' },
  { id: 'ryzhiy', name: 'Сырь', src: '/sprites/ryzhiy.png' },
  { id: 'trehcvetny', name: 'Негрик', src: '/sprites/trehcvetny.png' },
  { id: 'negr', name: 'Негрик 2', src: '/sprites/negr.png' },
  { id: 'chis', name: 'Чис', src: '/sprites/chis.png' },
  { id: 'lera', name: 'Лера', src: '/sprites/lera.png' },
  { id: 'anya1', name: 'Аня', src: '/sprites/anya1.png' },
  { id: 'anya2', name: 'Аня 2', src: '/sprites/anya2.png' },
  { id: 'serebristyy', name: 'ВП', src: '/sprites/serebristyy.png' },
  { id: 'evr', name: 'Эвр', src: '/sprites/evr.png' },
  { id: 'drel', name: 'Дрель', src: '/sprites/drel.png' },
  { id: 'maslina', name: 'Маслина', src: '/sprites/maslina.png' },
  { id: 'buran', name: 'Буран', src: '/sprites/buran.png' },
  { id: 'sumrak', name: 'Сумрак', src: '/sprites/sumrak.png' },
  { id: 'izya', name: 'Изя', src: '/sprites/izya.png' },
  { id: 'kameshechek', name: 'Камешечек', src: '/sprites/kameshechek.png' },
  { id: 'klubochek', name: 'Клубочек', src: '/sprites/klubochek.png' },
  { id: 'podushka', name: 'Подушечка', src: '/sprites/podushka.png' },
  { id: 'plyushik', name: 'Плюшик', src: '/sprites/plyushik.png' },
  { id: 'rvanitse', name: 'Рванитсе', src: '/sprites/rvanitse.png' },
  { id: 'puhlyashik-kit', name: 'Пухляшик', src: '/sprites/puhlyashik-kit.png' },
  { id: 'blestyashka-kit', name: 'Блестяшка', src: '/sprites/blestyashka-kit.png' },
  { id: 'chistolapik-kit', name: 'Чистолапик', src: '/sprites/chistolapik-kit.png' },
];

/**
 * Персонаж («общее имя») — группа спрайтов в выборе скина. У одного игрока могут
 * быть разные персонажи; все спрайты персонажа собраны в одном месте, внутри
 * группы их листают стрелками карусели. Скин на поле — по-прежнему конкретный
 * SpriteId, группы влияют только на порядок выбора.
 */
export interface SpriteGroup {
  id: string;
  /** Общее имя персонажа (заголовок колонки в карусели). */
  name: string;
  /** Спрайты персонажа в порядке листания. */
  spriteIds: SpriteId[];
}

/** Персонажи выбора скина: общее имя → спрайты (листаются внутри колонки).
 *  Набор «Малышочки» — отдельно (см. MALYSHOCHKI_SET): он показывается своим
 *  разделом под общей каруселью, а не колонкой среди привычных скинов. */
export const SPRITE_GROUPS: SpriteGroup[] = [
  { id: 'puzik', name: 'Пузик', spriteIds: ['puhlyashik', 'puhlyashshshshshshshsh', 'puzatik', 'razdora'] },
  { id: 'ryasha', name: 'Ряща', spriteIds: ['blestyashka', 'syrstyashka', 'pohititel', 'gromoryov', 'gremuchnik'] },
  { id: 'syr', name: 'Сырь', spriteIds: ['ryzhiy'] },
  { id: 'vp', name: 'ВП', spriteIds: ['serebristyy'] },
  { id: 'negrik', name: 'Негрик', spriteIds: ['trehcvetny', 'negr'] },
  { id: 'chis', name: 'Чис', spriteIds: ['chis'] },
  { id: 'lera', name: 'Лера', spriteIds: ['lera'] },
  { id: 'anya', name: 'Аня', spriteIds: ['anya1', 'anya2'] },
  { id: 'evr', name: 'Эвр', spriteIds: ['evr'] },
  { id: 'sumrak', name: 'Сумрак', spriteIds: ['sumrak'] },
  { id: 'maslina', name: 'Маслина', spriteIds: ['maslina'] },
  { id: 'drel', name: 'Дрель', spriteIds: ['drel'] },
  { id: 'izya', name: 'Изя', spriteIds: ['izya'] },
  { id: 'buran', name: 'Буран', spriteIds: ['buran'] },
];

/** Набор скинов №2 «Малышочки» — отдельный раздел выбора: маленькие зверьки
 *  (готовые пиксель-спрайты автора), не персонажи общей карусели. Клубочек,
 *  Подушечка и Плюшик остались в пуле спрайтов (совместимость), но из набора
 *  убраны — их место заняли готовые малыши. Рисуются на поле как обычные скины. */
export const MALYSHOCHKI_SET: SpriteGroup = {
  id: 'malyshochki',
  name: 'Малышочки',
  spriteIds: ['kameshechek', 'rvanitse', 'puhlyashik-kit', 'blestyashka-kit', 'chistolapik-kit'],
};

/** Все id спрайтов, покрытые группами (контроль полноты на этапе сборки не нужен —
 *  но карусель и подсказки строятся ровно по этому списку). */
export function spriteGroupOf(id: SpriteId): SpriteGroup | undefined {
  return SPRITE_GROUPS.find((g) => g.spriteIds.includes(id)) ??
    (MALYSHOCHKI_SET.spriteIds.includes(id) ? MALYSHOCHKI_SET : undefined);
}

/**
 * Мишень «РАБ»: боевая цель комнаты, не персонаж. В выбор котов не входит,
 * включается тумблером «Включить мишень» (раздел «Поле»); находится в боевом
 * режиме (по ней проходят удары), является физическим препятствием — сквозь
 * неё нельзя ходить. Спрайт один у всех мишеней.
 */
export const RAB_SPRITE: SpriteMeta = {
  id: 'rab',
  name: 'РАБ',
  src: '/sprites/rab.png',
};

/** Манекен «ПОЧУХАТЬ»: перетаскиваемый предмет комнаты, не персонаж, вне боя.
 *  Препятствие на поле; скин выбирается в настройках по имени из списка персонажей. */
export const DUMMY_NAME = 'ПОЧУХАТЬ';

/** Спрайт манекена по умолчанию (до выбора в настройках). */
export const DUMMY_DEFAULT_SPRITE: SpriteId = 'puhlyashik';

/* ---------- атмосфера комнаты ---------- */

/** Время суток комнаты. Общее для всех игроков (состояние комнаты, событие «atmo»),
 *  меняет цветовую атмосферу поля: утро — тёплый свет, день — нейтральный,
 *  вечер — оранжево-розовый закат, ночь — тёмно-синие сумерки. */
export type DayPart = 'morning' | 'day' | 'evening' | 'night';

export const DAYPARTS: readonly DayPart[] = ['morning', 'day', 'evening', 'night'];

/** Название времени суток для интерфейса. */
export const DAYPART_LABEL: Record<DayPart, string> = {
  morning: 'Утро',
  day: 'День',
  evening: 'Вечер',
  night: 'Ночь',
};

/** Погода комнаты. Общая для всех игроков (состояние комнаты, событие «atmo»):
 *  солнечно — ясно и чуть ярче, пасмурно — серее и тени облаков, дождь — косые
 *  капли, густые тени и притушенные цвета. */
export type WeatherKind = 'sun' | 'cloud' | 'rain';

export const WEATHERS: readonly WeatherKind[] = ['sun', 'cloud', 'rain'];

/** Название погоды для интерфейса. */
export const WEATHER_LABEL: Record<WeatherKind, string> = {
  sun: 'Солнечно',
  cloud: 'Пасмурно',
  rain: 'Дождь',
};

/* ---------- часы цикла суток ---------- */

/**
 * Непрерывный прогресс суток (0..4: 0 — утро, 1 — день, 2 — вечер, 3 — ночь)
 * по якорю комнаты: cs — момент начала цикла (Date.now сервера), phaseMs —
 * длительность одной части суток. Чистая функция: часы цикла живут на сервере,
 * клиент считает позицию по своим часам — расхождение в секунды даёт долю
 * процента части суток, на картинке это незаметно.
 */
export function dayProgressAt(cs: number, phaseMs: number, now: number): number {
  const cyc = ((((now - cs) / (phaseMs * 4)) % 1) + 1) % 1;
  return cyc * 4;
}

/** Часть суток для непрерывного прогресса (0..4, корректно и для отрицательных). */
export function dayPartOfProgress(p: number): DayPart {
  return DAYPARTS[((Math.floor(p) % 4) + 4) % 4];
}

/**
 * Начало цикла, при котором «сейчас» — середина заданной части суток: так работают
 * кнопки «утро/день/вечер/ночь» (перемотка цикла) и стартовый якорь без сети.
 */
export function cycleStartFor(dayPart: DayPart, phaseMs: number, now: number): number {
  const idx = Math.max(0, DAYPARTS.indexOf(dayPart));
  return now - (idx + 0.5) * phaseMs;
}

/** Все спрайты, которые нужно предзагрузить для поля: персонажи (в том числе как
 *  скины манекена) + мишень РАБ. */
export const FIELD_SPRITES: SpriteMeta[] = [...SPRITES, RAB_SPRITE];

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
    /** Скорость свободной ходьбы в мирном режиме («тест»), px мира в секунду. */
    peaceSpeed: number;
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
  /** Атмосфера: темп автоматического цикла суток и погоды. В комнате значения
   *  общие (их держит сервер и рассылает всем), локальные — только стартовые и
   *  для поля без сети. */
  atmo: {
    /** Длительность одной части суток (утро/день/вечер/ночь), минут. */
    phaseMin: number;
    /** Интервал смены погоды, минут. */
    weatherMin: number;
  };
  /** Манекены на поле убраны: массив всегда пуст, оставлен ради совместимости типа и старых сохранений. */
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
    /** Уровень брони игрока (пресет 0,0–0,9): режет получаемый урон по кривой замеров.
     *  Значение уходит на сервер, и он же применяет его к входящим ударам. */
    armorLevel: number;
    /** Зоны попадания (фиксированный набор, значения настраиваются). */
    zones: StrikeZone[];
  };
  /** Внутренний маркер миграции: параметры стрелы нормализованы к размеру модельки 100%. */
  arrowNorm?: boolean;
  /** Внутренний маркер миграции: дефолты обновлены (спрайт Блестяшка, цвет #73a13a, мишень Пухляшик). */
  presetMigrated?: boolean;
  /** Внутренний маркер миграции: горло уже приведено к текущей базе урона 0,0. */
  throatBaseMigrated?: boolean;
  /**
   * Внутренний маркер миграции: пиксельные полосы зон уже сверены со старой таблицей.
   * После записи повторная загрузка не возвращает прежние границы.
   */
  strikeBandsMigrated?: boolean;
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
    // Мирная ходьба по траве «теста»: прежний зашитый темп PEACE_SPEED_PX.
    peaceSpeed: 320,
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
    // Окна «без замедления» — калибровка владельца (его скрин, правка 11.2025):
    // вправо-вниз 48–63, вниз 68–110, влево-вверх 227–245; остальные — прежние.
    windows: {
      '0': { start: 310, end: 35 },
      '45': { start: 48, end: 63 },
      '90': { start: 68, end: 110 },
      '135': { start: 110, end: 130 },
      '180': { start: 130, end: 220 },
      '225': { start: 227, end: 245 },
      '270': { start: 245, end: 290 },
      '315': { start: 290, end: 310 },
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
  atmo: {
    // По умолчанию часть суток длится 7 минут (полный цикл — 28 минут),
    // погода меняется раз в 12 минут.
    phaseMin: 7,
    weatherMin: 12,
  },
  dummies: [],
  controlled: 'main',
  combat: {
    energyStart: 100,
    strikeCost: 2,
    strikeResponseMs: 170,
    regenEnabled: true,
    regenAmount: 20,
    regenIntervalSec: 5,
    damageLevel: 0,
    armorLevel: 0,
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
  // Свежий конфиг уже на текущей базе горла и на текущих полосах:
  // повторная загрузка не переписывает строки.
  throatBaseMigrated: true,
  strikeBandsMigrated: true,
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

// ---------------- Границы настроек, сверенные с протоколом комнаты ----------------

/** Границы «Отклика удара», мс: сервер зажимает flightMs в 0..600
 *  (STRIKE_CATCH_MAX_MS в src/lib/net/protocol.ts); нижняя граница 30 — чуть выше
 *  серверного кулдауна удара 25 мс, чтобы легитимный удар не отбрасывался. */
export const STRIKE_RESPONSE_MIN_MS = 30;
export const STRIKE_RESPONSE_MAX_MS = 600;

/** Границы настройки «длительность части суток», мин: сервер зажимает atmoset.pl в 1–120. */
export const ATMO_PHASE_MINUTES_MIN = 1;
export const ATMO_PHASE_MINUTES_MAX = 120;

/** Границы настройки «интервал смены погоды», мин: сервер зажимает atmoset.wl в 2–240. */
export const ATMO_WEATHER_MINUTES_MIN = 2;
export const ATMO_WEATHER_MINUTES_MAX = 240;

// ---------------- Броня игрока ----------------

/**
 * Замеры владельца: броня → урон по игроку, % (референс-удар, при броне 0,0 он даёт 40).
 * 0,0 → 40; 0,1 → 38,67; 0,12 → 37,64; 0,2 → 34,62; 0,35 → 31,62; 0,66 → 26,55; 0,78 → 20,93.
 * Между точками — линейная интерполяция, после 0,78 — экстраполяция по наклону
 * последнего отрезка (0,9 ≈ 15,31), вне диапазона 0–0,9 — зажим.
 */
export const ARMOR_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0.0, 40.0],
  [0.1, 38.67],
  [0.12, 37.64],
  [0.2, 34.62],
  [0.35, 31.62],
  [0.66, 26.55],
  [0.78, 20.93],
];

/** Множитель получаемого урона при броне a (0–0,9): урон(броня) / урон(0,0).
 *  Броня 0,0 урон не меняет, 0,8 пропускает половину, 0,9 — около 38%. */
export function armorMultiplier(armor: number): number {
  const a = Number.isFinite(armor) ? Math.min(0.9, Math.max(0, armor)) : 0;
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

/** Множитель получаемого урона для пресета уровня k (0..9 → 0,0..0,9). */
export function armorLevelMultiplier(level: number): number {
  return armorMultiplier(level / 10);
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
 * Промежуточная калибровка (успела сохраниться в localStorage между правками
 * дефолтов) — тоже заменяем на актуальную.
 */
const LEGACY_SLOWDOWN_V2: SimSettings['slowdown'] = {
  windows: {
    // Дефолтные окна до перехода на симметричные — заморожены, чтобы старые
    // сохранения продолжали опознаваться после смены дефолта.
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
    { max: 45, value: 75 },
    { max: 90, value: 80 },
    { max: 135, value: 93 },
  ],
  maxSlowdown: 93,
  showStepLabel: false,
  showSpeedBadge: false,
};

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

/** Окна дефолта до перехода на симметричные: асимметричны, диагонали 135/225/315
 *  не содержат собственных углов. */
const LEGACY_WINDOWS_V3: Record<WindowKey, DirectionWindow> = {
  '0': { start: 313, end: 43 },
  '45': { start: 45, end: 68 },
  '90': { start: 73, end: 103 },
  '135': { start: 112, end: 125 },
  '180': { start: 135, end: 220 },
  '225': { start: 228, end: 245 },
  '270': { start: 250, end: 290 },
  '315': { start: 290, end: 302 },
};

/** Ручная калибровка из панели (правилась владельцем): асимметрична, 135 и 315
 *  не входят в свои окна. Сейчас снова является дефолтом; запись заморожена,
 *  чтобы старые сохранения продолжали опознаваться. */
const LEGACY_WINDOWS_V4: Record<WindowKey, DirectionWindow> = {
  '0': { start: 310, end: 35 },
  '45': { start: 35, end: 53 },
  '90': { start: 53, end: 110 },
  '135': { start: 110, end: 130 },
  '180': { start: 130, end: 220 },
  '225': { start: 220, end: 245 },
  '270': { start: 245, end: 290 },
  '315': { start: 290, end: 310 },
};

/** Симметричные окна (кардиналы ±40°, диагонали ±20°) — дефолт на время, пока
 *  владельцем не была возвращена ручная калибровка. Сохранения с ними заменяются
 *  на актуальные. */
const LEGACY_WINDOWS_V5: Record<WindowKey, DirectionWindow> = {
  '0': { start: 320, end: 40 },
  '45': { start: 25, end: 65 },
  '90': { start: 70, end: 110 },
  '135': { start: 115, end: 155 },
  '180': { start: 140, end: 220 },
  '225': { start: 205, end: 245 },
  '270': { start: 250, end: 290 },
  '315': { start: 295, end: 335 },
};

/** Дефолтные окна до правки калибровки владельцем (скрин): сдвинуты вправо-вниз,
 *  вниз и влево-вверх. */
const LEGACY_WINDOWS_V6: Record<WindowKey, DirectionWindow> = {
  '0': { start: 310, end: 35 },
  '45': { start: 35, end: 53 },
  '90': { start: 53, end: 110 },
  '135': { start: 110, end: 130 },
  '180': { start: 130, end: 220 },
  '225': { start: 220, end: 245 },
  '270': { start: 245, end: 290 },
  '315': { start: 290, end: 310 },
};

/** Совпадают ли ТОЛЬКО окна сохранённого блока с эталонными (уровни не смотрим). */
function windowsMatch(sd: unknown, ref: Record<WindowKey, DirectionWindow>): boolean {
  if (!sd || typeof sd !== 'object') return false;
  const sdw = sd as Record<string, any>;
  for (const key of Object.keys(ref) as WindowKey[]) {
    const w = sdw.windows?.[key];
    const lw = ref[key];
    if (!w || Number(w.start) !== lw.start || Number(w.end) !== lw.end) return false;
  }
  return true;
}

/**
 * Какая калибровка сохранена: 'full' — старый блок целиком (окна + уровни + потолок),
 * 'windows' — совпали только окна (уровни могли быть изменены вручную — их не трогаем).
 */
function legacySlowdownKind(sd: unknown): 'full' | 'windows' | false {
  if (slowdownMatches(sd, LEGACY_SLOWDOWN_V1) || slowdownMatches(sd, LEGACY_SLOWDOWN_V2)) return 'full';
  if (
    windowsMatch(sd, LEGACY_WINDOWS_V3) ||
    windowsMatch(sd, LEGACY_WINDOWS_V4) ||
    windowsMatch(sd, LEGACY_WINDOWS_V5) ||
    windowsMatch(sd, LEGACY_WINDOWS_V6)
  ) {
    return 'windows';
  }
  return false;
}

/**
 * Полосы и базовый урон до коммита 1070273.
 * Голова 0–55, горло/шея 55–72, живот/спина 72–106, лапы/хвост 106–150.
 * Урон в этой таблице менялся только у Лап (5 → 6), Морды (20 → 18) и Горла (38 → 42).
 */
const LEGACY_STRIKE_BANDS: Record<string, { py0: number; py1: number; damage?: number }> = {
  tail: { py0: 106, py1: 150 },
  paws: { py0: 106, py1: 150, damage: 5 },
  back: { py0: 72, py1: 106 },
  muzzle: { py0: 0, py1: 55, damage: 20 },
  belly: { py0: 72, py1: 106 },
  neck: { py0: 55, py1: 72 },
  throat: { py0: 55, py1: 72, damage: 38 },
};

/** Та же полоса, что у старого дефолта, в любом порядке концов. */
function samePixelBand(py0: number, py1: number, ref: { py0: number; py1: number }): boolean {
  return (py0 === ref.py0 && py1 === ref.py1) || (py0 === ref.py1 && py1 === ref.py0);
}

/**
 * Подменяет пиксели зоны, если они всё ещё старый дефолт. Ручной диапазон остаётся.
 * Урон Лапы/Морды/Горла двигаем только вместе с такой полосой и только со старого
 * базового числа на пресете 0,0 — выбранный пресет и ручной урон не затираем.
 * Сторону не трогаем.
 */
function migrateLegacyStrikeBands(combat: SimSettings['combat']): SimSettings['combat'] {
  const freshById = new Map(DEFAULT_SETTINGS.combat.zones.map((z) => [z.id, z]));
  const zones = combat.zones.map((z) => {
    const legacy = LEGACY_STRIKE_BANDS[z.id];
    const fresh = freshById.get(z.id);
    if (!legacy || !fresh || !samePixelBand(z.py0, z.py1, legacy)) return z;
    const damage =
      combat.damageLevel === 0 && legacy.damage != null && z.damage === legacy.damage ? fresh.damage : z.damage;
    if (z.py0 === fresh.py0 && z.py1 === fresh.py1 && z.damage === damage) return z;
    return { ...z, py0: fresh.py0, py1: fresh.py1, damage };
  });
  return { ...combat, zones };
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
    strikeResponseMs: num(rawC?.strikeResponseMs, d.strikeResponseMs, STRIKE_RESPONSE_MIN_MS, STRIKE_RESPONSE_MAX_MS),
    regenEnabled: typeof rawC?.regenEnabled === 'boolean' ? rawC.regenEnabled : d.regenEnabled,
    regenAmount: num(rawC?.regenAmount, d.regenAmount, 0, 100),
    regenIntervalSec: num(rawC?.regenIntervalSec, d.regenIntervalSec, 0.5, 600),
    showLog: typeof rawC?.showLog === 'boolean' ? rawC.showLog : d.showLog,
    damageLevel: num(rawC?.damageLevel, d.damageLevel, 0, 9),
    armorLevel: num(rawC?.armorLevel, d.armorLevel, 0, 9),
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
  // Если сохранённые замедления совпадают со старой калибровкой (целиком или только
  // окнами) — подставляем новые симметричные окна (пользователь их не менял осмысленно).
  // Иной ручной выбор остаётся как есть.
  const rawSlow: any = raw?.slowdown ?? {};
  const slowLegacy = legacySlowdownKind(rawSlow);
  const slowIsLegacy = slowLegacy !== false;
  const out: SimSettings = {
    field: { ...d.field, ...(raw?.field ?? {}) },
    character: {
      ...d.character,
      ...(raw?.character ?? {}),
      // размер модельки ограничен диапазоном 60–100%
      spriteScale: Math.min(100, Math.max(60, num(raw?.character?.spriteScale, d.character.spriteScale))),
      // скорость мирной ходьбы: 40–800 px/с (медленный шаг — лёгкий спринт)
      peaceSpeed: Math.min(800, Math.max(40, num(raw?.character?.peaceSpeed, d.character.peaceSpeed))),
    },
    arrow: { ...d.arrow, ...(raw?.arrow ?? {}) },
    slowdown: {
      ...d.slowdown,
      ...rawSlow,
      windows: { ...d.slowdown.windows, ...(slowIsLegacy ? d.slowdown.windows : rawSlow.windows ?? {}) },
      tiers:
        slowLegacy !== 'full' && Array.isArray(rawSlow.tiers) && rawSlow.tiers.length === 3
          ? rawSlow.tiers.map((t: any, i: number) => ({
                max: num(t?.max, d.slowdown.tiers[i].max),
                value: num(t?.value, d.slowdown.tiers[i].value),
              }),
            )
          : d.slowdown.tiers.map((t) => ({ ...t })),
      maxSlowdown:
        slowLegacy === 'full' ? d.slowdown.maxSlowdown : num(rawSlow.maxSlowdown, d.slowdown.maxSlowdown),
    },
    hud: { ...d.hud, ...(raw?.hud ?? {}) },
    // Темп цикла атмосферы: часть суток 1–120 минут, погода 2–240 минут.
    atmo: {
      phaseMin: Math.min(ATMO_PHASE_MINUTES_MAX, Math.max(ATMO_PHASE_MINUTES_MIN, Math.round(num(raw?.atmo?.phaseMin, d.atmo.phaseMin)))),
      weatherMin: Math.min(ATMO_WEATHER_MINUTES_MAX, Math.max(ATMO_WEATHER_MINUTES_MIN, Math.round(num(raw?.atmo?.weatherMin, d.atmo.weatherMin)))),
    },
    // манекены убраны с поля: старые сохранения не восстанавливаем, массив всегда пуст
    dummies: [],
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
  // Сохранённые полосы раньше специально не затирались, поэтому у того, кто уже
  // открывал поле, схема остаётся на 0–55 / 55–72 / 72–106 / 106–150. Если границы
  // совпали с той таблицей — ставим текущие. Чужие числа не трогаем. Маркер уходит
  // в localStorage вместе с новыми py, и следующая загрузка их не откатывает.
  if (raw != null && raw.strikeBandsMigrated !== true) {
    out.combat = migrateLegacyStrikeBands(out.combat);
  }
  out.strikeBandsMigrated = true;
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
