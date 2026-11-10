/**
 * Канон протокола комнаты coop-field (волна W3): имена событий и зеркалируемые
 * константы в ОДНОМ месте. server.js импортирует отсюда и не держит дубликатов
 * литералов; клиентская зеркал-копия — src/lib/net/protocol.ts (общего кода у
 * процессов нет). Совпадение сторон проверяет scripts/test-protocol-parity.mjs
 * (CI, node>=22.6), а совпадение с док-таблицами AGENTS.md —
 * scripts/check-protocol-sync.mjs (CI).
 *
 * Правила файла:
 *  - менять значения/имена можно только здесь (и в src/lib/net/protocol.ts);
 *  - серверные обработчики не должны заводить локальных копий — только import;
 *  - имена событий с пробелами («update cat») существуют как значения реестра:
 *    в коде используй EV.UPDATE_CAT, в док-таблицах — «update cat».
 */

/* ---------- имена событий ---------- */

/** Клиент → сервер, 23 события. Порядок — как в таблице AGENTS.md. */
export const CLIENT_EVENTS = Object.freeze([
  "join",
  "move",
  "aim",
  "strike",
  "chat",
  "sprite",
  "dummy",
  "dummyMove",
  "dummyGrab",
  "dummyDrop",
  "rab",
  "rabHit",
  "block",
  "space",
  "atmo",
  "atmoset",
  "armor",
  "freemove",
  "cellsync",
  "jump",
  "setmap",
  "rooms",
  "auth",
]);

/** Сервер → клиент, 23 события. Порядок — как в таблице AGENTS.md. */
export const SERVER_EVENTS = Object.freeze([
  "you",
  "field",
  "chatlog",
  "move",
  "update cat",
  "refuse",
  "info",
  "noplace",
  "fight",
  "chat",
  "map",
  "dummyState",
  "dummyMove",
  "dummyGrab",
  "dummyDrop",
  "rabState",
  "rabHit",
  "block",
  "space",
  "atmo",
  "freemove",
  "roomsinfo",
  "whoami",
]);

/**
 * Все 36 уникальных имён протокола в одном словаре для кода:
 * страницы диспатчера/рассылки берут отсюда, строковые литералы не дублируются.
 * «move»/«chat»/«space» и ещё 7 имён ходят в обе стороны — ключ один.
 */
export const EV = Object.freeze({
  // только клиент → сервер
  JOIN: "join",
  AIM: "aim",
  STRIKE: "strike",
  SPRITE: "sprite",
  DUMMY: "dummy",
  RAB: "rab",
  ATMOSET: "atmoset",
  ARMOR: "armor",
  CELLSYNC: "cellsync",
  JUMP: "jump",
  SETMAP: "setmap",
  ROOMS: "rooms",
  AUTH: "auth",
  // только сервер → клиент
  YOU: "you",
  FIELD: "field",
  CHATLOG: "chatlog",
  UPDATE_CAT: "update cat",
  REFUSE: "refuse",
  INFO: "info",
  NOPLACE: "noplace",
  FIGHT: "fight",
  MAP: "map",
  DUMMY_STATE: "dummyState",
  RAB_STATE: "rabState",
  ROOMSINFO: "roomsinfo",
  WHOAMI: "whoami",
  // обе стороны
  MOVE: "move",
  CHAT: "chat",
  DUMMY_MOVE: "dummyMove",
  DUMMY_GRAB: "dummyGrab",
  DUMMY_DROP: "dummyDrop",
  RAB_HIT: "rabHit",
  BLOCK: "block",
  SPACE: "space",
  ATMO: "atmo",
  FREEMOVE: "freemove",
});

/* ---------- комнаты и темпы ---------- */

/** Потолок комнаты. Клеток на поле 60, но в одну комнату пускаем не больше этого. */
export const MAX_PLAYERS = 30;

/**
 * Кулдаун шага на сервере. Ходы, пришедшие раньше, не теряются — встают
 * в очередь (глубиной MOVE_QUEUE_MAX) и применяются в момент снятия кулдауна.
 */
export const MOVE_COOLDOWN_MS = 80;

/** Глубина очереди шагов: залипшая клавиша не должна превращаться в длинный буфер. */
export const MOVE_QUEUE_MAX = 3;

/** Кулдаун на повторный join: самое дорогое событие (снимок field всей комнате). */
export const JOIN_COOLDOWN_MS = 1000;

/**
 * Короткий предохранитель от пачки aim подряд: пакет уходит сразу, если с
 * прошлой рассылки прошло больше этого; плотнее — остаётся последний угол.
 * Не сглаживание картинки (его делает клиент), только отсечка всплеска.
 */
export const AIM_MIN_GAP_MS = 20;

/* ---------- бой ---------- */

/**
 * Окно «полёта» удара, мс (default flightMs): применение откладывается на этот
 * срок, блок цели перепроверяется в момент касания. Клиент может прислать свой
 * flightMs — он зажимается в 0..STRIKE_CATCH_MAX_MS.
 * Клиентское зеркало: DEFAULT_SETTINGS.combat.strikeResponseMs (settings.ts).
 */
export const STRIKE_CATCH_MS = 170;
export const STRIKE_CATCH_MAX_MS = 600;

/**
 * Зоны abnocw (id → подпись и база урона при уровне 0). Поля damage и
 * pawsDamage в strike принимаются и игнорируются: сервер считает урон
 * отсюда × profile.sp.damageLevel бьющего (потолок — реестр). weapon пустой.
 */
export const STRIKE_ZONES = Object.freeze({
  tail: Object.freeze({ part: "Хвост", damage: 2 }),
  paws: Object.freeze({ part: "Лапы", damage: 6 }),
  back: Object.freeze({ part: "Спина", damage: 12 }),
  muzzle: Object.freeze({ part: "Морда", damage: 18 }),
  belly: Object.freeze({ part: "Живот", damage: 25 }),
  neck: Object.freeze({ part: "Шея", damage: 30 }),
  throat: Object.freeze({ part: "Горло", damage: 42 }),
});

/**
 * Замеры владельца: броня → урон по игроку, % (референс при броне 0,0 даёт 40).
 * Между точками — линейная интерполяция, после 0,78 — экстраполяция по наклону
 * последнего отрезка (0,9 ≈ 15,31). Побайтовое зеркало — ARMOR_CURVE в
 * src/lib/sim/settings.ts.
 */
export const ARMOR_CURVE = Object.freeze([
  Object.freeze([0.0, 40.0]),
  Object.freeze([0.1, 38.67]),
  Object.freeze([0.12, 37.64]),
  Object.freeze([0.2, 34.62]),
  Object.freeze([0.35, 31.62]),
  Object.freeze([0.66, 26.55]),
  Object.freeze([0.78, 20.93]),
]);

/* ---------- чат ---------- */

/** Одно сообщение комнате: длиннее обрезается, чаще этого интервала — отказ. */
export const CHAT_MAX_LEN = 200;
export const CHAT_COOLDOWN_MS = 450;
/** История комнаты (уходит новичку событием chatlog). */
export const CHAT_HISTORY = 40;

/* ---------- предметы комнаты ---------- */

/**
 * Манекен «ПОЧУХАТЬ»: позиция в клеточных долях (x — по ширине, y — по высоте,
 * 0 — левый верх спрайта) и спрайт до первой смены. Клиентский рендер-дефолт
 * (simulator.tsx DUMMY_DEFAULT) держит те же x/y.
 */
export const DUMMY_DEFAULT = Object.freeze({ x: 7, y: 2, sprite: "puhlyashik" });

/**
 * Клетка боевой мишени «РАБ». ВАЖНО: серверная проверка занятости сравнивает
 * RAB_CELL с (x-1, y-1), т.е. по коду это 0-based col/row, численно совпадающий
 * с клиентским RAB_POS {col: 4, row: 2} (simulator.tsx). Комментарий «1-based»
 * в старой документации был неверен; позиция по сети не рассылается.
 */
export const RAB_CELL = Object.freeze({ x: 4, y: 2 });

/* ---------- локация «тест»: редактор и рельеф ---------- */

/** id покрытий земли пака (тайлы 16 px): наземный декор, ходьбе не мешает.
 *  Полный список с подписями — GROUND_COVER_OPTS в src/lib/sim/test-map.ts. */
export const GROUND_COVER_IDS = Object.freeze([
  "grass-1",
  "grass-2",
  "flower-1",
  "flower-2",
  "flower-3",
  "flower-4",
  "slab-1",
  "slab-2",
  "slab-3",
  "slab-4",
  "floor-1",
  "floor-2",
  "floor-3",
]);

/** Предел высоты рельефа (уровней над базовой землёй): 0..20 (шаг 0.1).
 *  Клиентское зеркало — TERRAIN_MAX_LEVEL и elevStepOk/elevJumpOk в
 *  src/lib/sim/test-map.ts. Шаг берёт перепад ≤ ELEV_STEP_MAX; прыжок —
 *  по доле заряда (JUMP_CHARGE_*), вверх не выше JUMP_MAX_UP. */
export const TERRAIN_MAX_LEVEL = 20;
/** Перепад, который берётся шагом без прыжка (вверх и вниз). */
export const ELEV_STEP_MAX = 1;
/** Доля шкалы прыжка: половина берёт перепад 2, полная — перепад 3 и спуск 4+. */
export const JUMP_CHARGE_HALF = 0.5;
export const JUMP_CHARGE_FULL = 1;
/** Выше этого вверх не запрыгнуть. Вниз — до JUMP_MAX_DROP полным зарядом. */
export const JUMP_MAX_UP = 3;

/**
 * Пределы конфига локации (sanitizeTestMap, v1|2). Клиентское зеркало —
 * TEST_MAP_LIMITS в src/lib/sim/test-map.ts: редактор не предложит конфиг,
 * который сервер отвергнет. nameMax — длина имени зоны и seed.
 */
export const TEST_MAP_LIMITS = Object.freeze({
  colsMin: 6,
  colsMax: 60,
  rowsMin: 3,
  rowsMax: 40,
  zonesMax: 48,
  objectsMax: 2000,
  spawnsMax: 64,
  nameMax: 24,
});

/* ---------- атмосфера ---------- */

/** Части суток и погода: строки на проводе (atmo.dp / atmo / поле dnd в settings.ts). */
export const ATMO_PHASE_LIST = Object.freeze(["morning", "day", "evening", "night"]);
export const ATMO_WEATHER_LIST = Object.freeze(["sun", "cloud", "rain"]);

/** Темпы по умолчанию: часть суток — 7 минут (полный цикл — 28), погода — 12 минут. */
export const ATMO_PHASE_MS_DEF = 7 * 60_000;
export const ATMO_WEATHER_MS_DEF = 12 * 60_000;

/** Границы темпов клиента (atmoset {pl, wl}, минуты): часть суток 1–120, погода 2–240. */
export const ATMO_PHASE_MS_MIN = 60_000;
export const ATMO_PHASE_MS_MAX = 120 * 60_000;
export const ATMO_WEATHER_MS_MIN = 2 * 60_000;
export const ATMO_WEATHER_MS_MAX = 240 * 60_000;

/* ---------- прыжок через обрыв ---------- */

/** Кулдаун прыжка: рывок через обрыв заметно дороже шага, спамить им нельзя. */
export const JUMP_COOLDOWN_MS = 450;
/** Дальность прыжка в клетках по прямой: 1..JUMP_MAX_CELLS (заряд выбирает клиент). */
export const JUMP_MAX_CELLS = 3;
/** Прыжок — строго вдоль одного из 8 направлений (0°/45°/…/315°). */
export const JUMP_DIRECTIONS = 8;
/** Максимальный перепад вниз. Равен TERRAIN_MAX_LEVEL; вверх режет JUMP_MAX_UP. */
export const JUMP_MAX_DROP = TERRAIN_MAX_LEVEL;
