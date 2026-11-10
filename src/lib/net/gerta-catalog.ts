/**
 * Справочник Герты — типизированные метаданные, не ручная копия текста.
 * Значения констант читаются из protocol.ts (зеркало сервера). Пути файлов —
 * реальные модули репозитория; scripts/test-handbook.mjs проверяет, что они есть.
 */
import {
  AIM_MIN_GAP_MS,
  ATMO_PHASE_MS_DEF,
  ATMO_WEATHER_MS_DEF,
  CHAT_COOLDOWN_MS,
  CHAT_HISTORY,
  CHAT_MAX_LEN,
  JOIN_COOLDOWN_MS,
  JUMP_COOLDOWN_MS,
  JUMP_MAX_CELLS,
  MAX_PLAYERS,
  MOVE_COOLDOWN_MS,
  MOVE_QUEUE_MAX,
  STRIKE_CATCH_MS,
  STRIKE_CATCH_MAX_MS,
  TEST_MAP_LIMITS,
} from "./protocol.ts";

export type CatalogMode = "all" | "beer" | "elision" | "hunger";
export type SyncKind = "client" | "room" | "server" | "protocol";
export type ApplyKind = "now" | "new-room" | "restart" | "never";

export type ConstantCard = {
  id: string;
  name: string;
  title: string;
  file: string;
  mode: CatalogMode;
  value: string;
  unit?: string;
  range?: string;
  editable: boolean;
  sync: SyncKind;
  apply: ApplyKind;
  note: string;
};

export type MechanicCard = {
  id: string;
  title: string;
  does: string;
  mode: CatalogMode;
  files: string[];
  functions: string[];
  params: string[];
  breaks: string;
  deps: string[];
};

const min = (ms: number) => String(Math.round(ms / 60_000));

/**
 * Compile-time вариант сайта (P3, спек §2A): карточки Элизии (размеры карты,
 * мирная ходьба, редактор) держим литералами в elyria-ветке тернарника —
 * сборка grotto их не содержит вовсе, ни в UI, ни в бандле.
 */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === "elyria";

const CONSTANT_CARDS_BASE: readonly ConstantCard[] = [
  {
    id: "max-players",
    name: "MAX_PLAYERS",
    title: "Сколько котов в одной комнате",
    file: "server/protocol.js",
    mode: "all",
    value: String(MAX_PLAYERS),
    unit: "котов",
    range: "зашито",
    editable: false,
    sync: "protocol",
    apply: "never",
    note: "Инвариант комнаты. Менять только зеркально в двух реестрах протокола.",
  },
  {
    id: "move-cd",
    name: "MOVE_COOLDOWN_MS",
    title: "Пауза между шагами",
    file: "server/protocol.js",
    mode: "all",
    value: String(MOVE_COOLDOWN_MS),
    unit: "мс",
    range: "зашито",
    editable: false,
    sync: "protocol",
    apply: "never",
    note: "Очередь шагов и предикт клиента завязаны на это число. Не выносить в админку.",
  },
  {
    id: "move-q",
    name: "MOVE_QUEUE_MAX",
    title: "Глубина очереди шагов",
    file: "server/protocol.js",
    mode: "all",
    value: String(MOVE_QUEUE_MAX),
    unit: "шагов",
    editable: false,
    sync: "protocol",
    apply: "never",
    note: "Залипшая клавиша не должна копить бесконечный буфер.",
  },
  {
    id: "join-cd",
    name: "JOIN_COOLDOWN_MS",
    title: "Пауза между входами в комнату",
    file: "server/protocol.js",
    mode: "all",
    value: String(JOIN_COOLDOWN_MS),
    unit: "мс",
    editable: false,
    sync: "protocol",
    apply: "never",
    note: "Join самый дорогой: снимок поля всей комнате.",
  },
  {
    id: "aim-gap",
    name: "AIM_MIN_GAP_MS",
    title: "Как часто шлётся угол прицела",
    file: "server/protocol.js",
    mode: "all",
    value: String(AIM_MIN_GAP_MS),
    unit: "мс",
    editable: false,
    sync: "protocol",
    apply: "never",
    note: "Не сглаживание картинки — отсечка пачки aim.",
  },
  {
    id: "strike-ms",
    name: "STRIKE_CATCH_MS",
    title: "Полёт удара по умолчанию",
    file: "server/protocol.js",
    mode: "all",
    value: String(STRIKE_CATCH_MS),
    unit: "мс",
    range: `0–${STRIKE_CATCH_MAX_MS}`,
    editable: false,
    sync: "protocol",
    apply: "never",
    note: "Клиент может прислать свой flightMs; сервер зажимает в 0…600.",
  },
  {
    id: "chat-len",
    name: "CHAT_MAX_LEN",
    title: "Длина сообщения чата",
    file: "server/protocol.js",
    mode: "all",
    value: String(CHAT_MAX_LEN),
    unit: "символов",
    editable: false,
    sync: "protocol",
    apply: "never",
    note: "После выреза невидимых и bidi. Чаще CHAT_COOLDOWN_MS — отказ.",
  },
  {
    id: "chat-cd",
    name: "CHAT_COOLDOWN_MS",
    title: "Пауза чата",
    file: "server/protocol.js",
    mode: "all",
    value: String(CHAT_COOLDOWN_MS),
    unit: "мс",
    editable: false,
    sync: "protocol",
    apply: "never",
    note: `История новичку — ${CHAT_HISTORY} сообщений.`,
  },
  {
    id: "jump-cd",
    name: "JUMP_COOLDOWN_MS",
    title: "Пауза прыжка",
    file: "server/protocol.js",
    // Прыжки — общая боевая механика всех клеточных комнат (гроты и Элизия):
    // сервер считает кулдаун одинаково (server/movement.js).
    mode: "all",
    value: String(JUMP_COOLDOWN_MS),
    unit: "мс",
    editable: false,
    sync: "protocol",
    apply: "never",
    note: `Дальность 1–${JUMP_MAX_CELLS} клетки, 8 направлений.`,
  },
  {
    id: "atmo-phase",
    name: "ATMO_PHASE_MS_DEF / atmoset.pl",
    title: "Длина части суток",
    file: "server/atmo.js",
    mode: "all",
    value: min(ATMO_PHASE_MS_DEF),
    unit: "мин",
    range: "1–120",
    editable: true,
    sync: "room",
    apply: "now",
    note: "Уже крутится любым игроком событием atmoset. Новые комнаты берут серверный default, если задан в runtime-config.",
  },
  {
    id: "atmo-weather",
    name: "ATMO_WEATHER_MS_DEF / atmoset.wl",
    title: "Как часто меняется погода",
    file: "server/atmo.js",
    mode: "all",
    value: min(ATMO_WEATHER_MS_DEF),
    unit: "мин",
    range: "2–240",
    editable: true,
    sync: "room",
    apply: "now",
    note: "Тоже atmoset. Солнце / облака / дождь выбираются сами, когда срок вышел.",
  },
  {
    id: "armor-curve",
    name: "ARMOR_CURVE",
    title: "Кривая брони",
    file: "src/lib/sim/settings.ts",
    mode: "all",
    value: "замеры владелиц",
    editable: false,
    sync: "protocol",
    apply: "never",
    note: "Не трогать из админки. Зеркало server/protocol.js, паритет в CI.",
  },
  {
    id: "pass-min",
    name: "PASS_MIN",
    title: "Минимальная длина пароля",
    file: "server/accounts.js",
    mode: "all",
    value: "8",
    unit: "символов",
    editable: false,
    sync: "server",
    apply: "never",
    note: "Регистрация аккаунта для входа в локацию.",
  },
];

/**
 * Каталог констант варианта (P3, спек §2A): карточки «Ширина/Высота Элизии»
 * добавляются только в elyria-сборке — литералы живут в тернарнике, сборка
 * grotto мёртвую ветку не содержит.
 */
export const CONSTANT_CARDS: readonly ConstantCard[] = IS_ELYRIA
  ? [
      ...CONSTANT_CARDS_BASE,
      {
        id: "map-cols",
        name: "TEST_MAP_LIMITS.cols",
        title: "Ширина Элизии",
        file: "src/lib/sim/test-map.ts",
        mode: "elision",
        value: `${TEST_MAP_LIMITS.colsMin}–${TEST_MAP_LIMITS.colsMax}`,
        unit: "клеток",
        editable: true,
        sync: "server",
        apply: "now",
        note: "Правка — редактор локации и setmap. Не второй редактор.",
      },
      {
        id: "map-rows",
        name: "TEST_MAP_LIMITS.rows",
        title: "Высота Элизии",
        file: "src/lib/sim/test-map.ts",
        mode: "elision",
        value: `${TEST_MAP_LIMITS.rowsMin}–${TEST_MAP_LIMITS.rowsMax}`,
        unit: "клеток",
        editable: true,
        sync: "server",
        apply: "now",
        note: "Сервер отвергнет конфиг за этими границами.",
      },
    ]
  : CONSTANT_CARDS_BASE;

const MECHANIC_CARDS_BASE: readonly MechanicCard[] = [
  {
    id: "join",
    title: "Вход в комнату",
    does: "Ставит кота в свободную клетку и присылает снимок поля. В закрытых комнатах без аккаунта сервер отказывает.",
    mode: "all",
    files: ["server/room.js", "src/lib/net/coop.ts", "src/components/sim/entry-screen.tsx"],
    functions: ["join", "requiresAccount", "createCoopClient"],
    params: ["room", "login", "sprite", "size"],
    breaks: "Два кота в одной клетке; тишина вместо you/refuse; гость в test.",
    deps: ["server/modes.js", "server/accounts.js", "server/persist.js"],
  },
  {
    id: "auth",
    title: "Аккаунт и сессия",
    does: "Регистрация, вход, выход. Пароль считается scrypt. Сессия — HttpOnly-cookie: токен клиенту не виден и в URL не ездит.",
    mode: "all",
    files: ["server/auth.js", "server/accounts.js", "src/lib/net/auth.ts", "src/components/sim/auth-panel.tsx"],
    functions: ["createAccount", "handleAuthFrame", "handshake", "applyWhoami"],
    params: ["login", "pass", "token", "action"],
    breaks: "Доверить join.login вместо сессии; JWT в localStorage как источник правды.",
    deps: ["server/protocol.js EV.AUTH/WHOAMI"],
  },
  {
    id: "step",
    title: "Шаг по клетке",
    does: "WASD (и русская раскладка) шлёт ход. Сервер — хозяин клетки: эхо или refuse с кодом.",
    mode: "all",
    files: ["server/movement.js", "src/lib/net/move-book.ts", "src/lib/sim/keys.ts"],
    functions: ["move", "queueMove", "applyOwnMoveAck", "rejectOwnMove"],
    params: ["x", "y"],
    breaks: "Молчание на ход — кот телепортируется. Два кота в клетке.",
    deps: ["MOVE_COOLDOWN_MS", "move-book.ts ≤1 предикт"],
  },
  {
    id: "strike",
    title: "Удар",
    does: "Прицел и зоны (хвост…горло). Сервер режет урон бронёй цели и шлёт fight после полёта.",
    mode: "all",
    files: ["server/combat.js", "src/lib/sim/targeting.ts", "src/lib/sim/settings.ts"],
    functions: ["strike", "aimedNeighbor", "pickStrikeTarget", "armorMultiplier"],
    params: ["target", "zone", "angle", "damage", "flightMs"],
    breaks: "Разъехавшаяся ARMOR_CURVE клиента и сервера; удар без соседа.",
    deps: ["protocol STRIKE_ZONES", "блок на К"],
  },
  {
    id: "jump",
    title: "Прыжок",
    does: "Прыжок на 1–3 клетки в 8 направлениях. Сервер пускает только на свободную проходимую клетку и держит кулдаун.",
    mode: "all",
    files: ["server/movement.js", "src/components/sim/simulator.tsx"],
    functions: ["jump", "jumpFill"],
    params: ["x", "y"],
    breaks: "Прыжок на занятую клетку; спам прыжками без кулдауна.",
    deps: ["JUMP_COOLDOWN_MS", "JUMP_MAX_CELLS"],
  },
  {
    id: "atmo",
    title: "Сутки и погода",
    does: "Общие на комнату. Клиенты едут своими часами от якоря. Сервер шлёт якорь при смене.",
    mode: "all",
    files: ["server/atmo.js", "src/lib/sim/atmosphere.ts", "server/runtime-config.js"],
    functions: ["atmo", "atmoset", "atmoAnchor", "atmoState"],
    params: ["dp", "w", "pl", "wl"],
    breaks: "Каждый клиент со своим циклом без якоря; смена длины без рассылки.",
    deps: ["runtime-config.js для дефолта новых комнат"],
  },
];

/**
 * Боевые карточки — только grotto (A1): Элизия не знает ни манекена, ни
 * каркаса голода; литералы сидят в мёртвой ветке IS_ELYRIA-тернарника и
 * умирают на сборке elyria (канон свёртки — site.ts, спек §2A).
 */
const GROTTO_MECHANIC_CARDS: readonly MechanicCard[] = IS_ELYRIA
  ? []
  : [
      {
        id: "dummy-rab",
        title: "Манекен и мишень РАБ",
        does: "Только боевые комнаты гротов. В закрытых мирах сервер отказывает.",
        mode: "beer",
        files: ["server/dummy-rab.js"],
        functions: ["dummyToggle", "rabToggle", "dummyGrab"],
        params: ["on", "sprite", "x", "y"],
        breaks: "Включить манекен там, где сервер отказывает; два держателя grab.",
        deps: ["grid-комнаты грот/demo"],
      },
      {
        id: "hunger-idle",
        title: "Каркас Голодных игр",
        does: "Комната и страница есть. Раунд в состоянии idle. Правил победы нет — не выдуманы.",
        mode: "hunger",
        files: ["server/hunger.js", "src/app/hunger/page.tsx"],
        functions: ["hungerState"],
        params: ["round", "phase"],
        breaks: "Придумать правила без владелиц.",
        deps: ["server/modes.js id=hunger"],
      },
    ];

/**
 * Механики Элизии (мирная ходьба, редактор) — только в elyria-сборке:
 * литералы в тернарнике, grotto-бандл мёртвую ветку не содержит (P3, §2A).
 */
export const MECHANIC_CARDS: readonly MechanicCard[] = IS_ELYRIA
  ? [
      ...MECHANIC_CARDS_BASE,
      {
        id: "elision-walk",
        title: "Мирная ходьба Элизии",
        does: "Пока кот не в бою — доли клетки (freemove). В бой — cellsync на проходимую клетку.",
        mode: "elision",
        files: ["server/movement.js", "src/lib/sim/test-field.ts", "server/world.js"],
        functions: ["freeMove", "cellsync", "testWalkable", "pointInPolygon"],
        params: ["x", "y", "fx", "fy"],
        breaks: "Ходьба сквозь остров; cellsync на чужую клетку без кольца поиска.",
        deps: ["test-map", "persist test-cats.json"],
      },
      {
        id: "editor",
        title: "Редактор локации",
        does: "Кисть, зоны, спавны, высоты. Сохранение — setmap, только role=admin.",
        mode: "elision",
        files: ["src/components/sim/simulator/editor-ops.ts", "server/testmap.js", "src/lib/sim/test-map.ts"],
        functions: ["setMap", "sanitizeTestMap", "buildEditorOps"],
        params: ["map"],
        breaks: "Карта за лимитами; запись без бэкапа; клиентский «пароль вкладок» как защита.",
        deps: ["роль admin", "backups/"],
      },
    ]
  : [...MECHANIC_CARDS_BASE, ...GROTTO_MECHANIC_CARDS];

export const HANDBOOK_FILES: readonly string[] = [
  ...new Set([
    ...CONSTANT_CARDS.map((c) => c.file),
    ...MECHANIC_CARDS.flatMap((m) => m.files),
  ]),
];
