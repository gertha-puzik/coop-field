/**
 * Реестр протокола комнаты coop-field — клиентская сторона (волна W3).
 *
 * Общего кода у клиента и сервера нет: серверный канон живёт в server/protocol.js,
 * этот файл — идентичное зеркало для TS-стороны. Совпадение проверяет
 * scripts/test-protocol-parity.mjs (CI): имена событий, кривая брони, зоны удара,
 * лимиты редактора/чата/atmoset/jump. Значения, чей настоящий владелец на клиенте —
 * модули sim (settings.ts / test-map.ts), здесь не дублируются, а выводятся
 * из них перэкспортом; часть констант (куулдауны сервера) — зеркала без
 * клиентского потребителя, они держатся паритет-тестом для будущих потребителей.
 *
 * Слои: протокол лежит в lib/net и может читать lib/sim (DAYPARTS, DEFAULT_SETTINGS,
 * TEST_MAP_LIMITS), но не знает про компоненты (гейт check-architecture).
 * ВАЖНО: импорты относительно (../sim/...) — файл поднимается тестами через
 * node --experimental-strip-types, где алиас "@/" не резолвится.
 */

import {
  ARMOR_CURVE,
  ATMO_PHASE_MINUTES_MAX,
  ATMO_PHASE_MINUTES_MIN,
  ATMO_WEATHER_MINUTES_MAX,
  ATMO_WEATHER_MINUTES_MIN,
  DAYPARTS,
  DEFAULT_SETTINGS,
  STRIKE_RESPONSE_MAX_MS,
  WEATHERS,
  type DayPart,
  type WeatherKind,
// NOTE (W3): import extensions are REQUIRED here — this module is also loaded
// by scripts/protocol-parity-probe.mts via node --experimental-strip-types,
// which does not resolve extensionless specifiers. Allowed by tsconfig's
// allowImportingTsExtensions (noEmit build); bundlers resolve explicit files.
} from "../sim/settings.ts";
import {
  ELEV_STEP_MAX,
  GROUND_COVER_OPTS,
  JUMP_CHARGE_FULL,
  JUMP_CHARGE_HALF,
  JUMP_MAX_UP,
  TEST_MAP_LIMITS,
  TERRAIN_MAX_LEVEL,
  type TestMap,
} from "../sim/test-map.ts";

/* ---------- имена событий ---------- */

/** Клиент → сервер, 23 события. Порядок — как в таблице AGENTS.md. */
export const CLIENT_TO_SERVER = [
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
] as const;

/** Сервер → клиент, 24 события. Порядок — как в таблице AGENTS.md. */
export const SERVER_TO_CLIENT = [
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
  "locations",
] as const;

export type ClientEventName = (typeof CLIENT_TO_SERVER)[number];
export type ServerEventName = (typeof SERVER_TO_CLIENT)[number];

/** Все 37 уникальных имён протокола одним словарём для кода (диспетчер coop.ts).
 *  «move»/«chat» и ещё 8 имён ходят в обе стороны — ключ один. Имя с пробелом —
 *  только как значение: в коде пишем EV.UPDATE_CAT, на проводе — "update cat". */
export const EV = {
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
  LOCATIONS: "locations",
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
} as const;

/* ---------- типы payload (перенесены из coop.ts; там остаются только транспортные) ---------- */

/** Атмосфера комнаты: время суток + погода. Общая для всех игроков; хранится на
 *  сервере, меняется событиями «atmo» (перемотка) и «atmoset» (длительности),
 *  новичкам уходит в снапшоте field. */
export type CoopAtmo = { dp: DayPart; w: WeatherKind };

/** Якорь атмосферы — серверные часы непрерывного цикла суток и погоды. Клиент
 *  считает позицию суток сам по своим часам (dayProgressAt), погода живёт
 *  дискретно: w — текущая, ws — момент её начала, wl — интервал смены.
 *  t — момент снимка (серверные Date.now()); cs — начало текущего цикла суток;
 *  pl — длительность одной части суток; dp — часть суток на момент t (для
 *  логов и старых клиентов). */
export type CoopAtmoAnchor = CoopAtmo & {
  t: number;
  cs: number;
  pl: number;
  wl: number;
  ws: number;
};

export type CoopCat = {
  id: number;
  login?: string;
  color?: string;
  sprite?: string;
  x: number;
  y: number;
  deg?: number;
  size?: number;
  /** Кот держит блок (удержание К): любые удары по нему проводятся в «Лапы». */
  blocking?: boolean;
  /** Кот держит пробел (присед-желе): 1 — рисуем приплющивание/выстрел. */
  sq?: number;
  /** Комната «тест»: 1 — кот в свободной ходьбе (fx/fy — позиция в клеточных долях),
   *  0/нет — кот ходит по клеткам. */
  fm?: number;
  fx?: number;
  fy?: number;
};

/** Боевой лог комнаты. name / part / weapon / isAttacking — как в журнале удара. */
export type CoopFight = {
  attackerId: number;
  attacker: string;
  targetId: number;
  name: string;
  part: string;
  zone: string;
  weapon?: string;
  damage?: number;
  /** true только на сокете бьющего. Зритель смотрит на attacker и name. */
  isAttacking?: boolean;
};

export type CoopNoplace = {
  room?: string;
  reason?: string;
};

/** Позиция общего предмета комнаты (манекен «ПОЧУХАТЬ») в клеточных долях (0 — левый верх спрайта). */
export type CoopDummyPos = { x: number; y: number };

/** Состояние манекена комнаты: включён/выключен, координаты, спрайт и кто его тащит. */
export type CoopDummyState = CoopDummyPos & { on: boolean; sprite: string; grab?: string | null };

/** Состояние боевой мишени «РАБ»: включена/выключена (позиция фиксирована). */
export type CoopRabState = { on: boolean };

/** Чужой удар по мишени РАБ: зона/название полосы и урон для всплывающей подписи и качания «желе». */
export type CoopRabHit = { zone: string; part: string; damage: number };

/** Строка чата комнаты. id — кот, который написал. seq уникален в комнате. */
export type CoopChatMessage = {
  seq: number;
  id: number;
  login: string;
  color?: string;
  text: string;
  ts: number;
};

/** Структурированный отказ сервера: код вместо разбора русского текста info. */
export type CoopRefuse = {
  code?: string;
  text?: string;
};

/** Состав одной комнаты для выбора: сколько игроков и кто именно. */
export type CoopRoomInfo = { id: string; count: number; logins: string[] };

/** Персонаж аккаунта (не гость): имя на поле, скин, рост. */
export type CoopCharacter = {
  id: string;
  name: string;
  sprite?: string;
  size?: number;
};

/** Ответ на auth / снимок сессии. token — только владельцу сокета. */
export type CoopWhoami = {
  ok: boolean;
  role?: "guest" | "registered" | "admin";
  login?: string;
  accountId?: string;
  token?: string;
  characters?: CoopCharacter[];
  activeCharacterId?: string;
  reason?: string;
};

export function isCoopWhoami(v: unknown): v is CoopWhoami {
  if (!isObj(v)) return false;
  return typeof v.ok === "boolean";
}

/* ---------- guard-валидаторы основных payload событий ---------- */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** publicCat с провода: обязательны числовые id и клетка (x/y). Пропускает и
 *  маркер выхода {id, x:0, y:0} — он валидный «кот» для этих полей. */
export function isCoopCat(v: unknown): v is CoopCat {
  if (!isObj(v)) return false;
  const num = (x: unknown) => Number.isFinite(Number(x));
  return Number.isInteger(Number(v.id)) && num(v.x) && num(v.y);
}

/** fight с провода: адресаты и имена лога обязательны, остальное опционально. */
export function isCoopFight(v: unknown): v is CoopFight {
  if (!isObj(v)) return false;
  const str = (x: unknown) => typeof x === "string";
  return Number.isInteger(Number(v.attackerId)) && Number.isInteger(Number(v.targetId)) && str(v.attacker) && str(v.name) && str(v.part) && str(v.zone);
}

/** noplace {room, reason}: объект с необязательными строками. */
export function isCoopNoplace(v: unknown): v is CoopNoplace {
  if (!isObj(v)) return false;
  return (
    (v.room === undefined || typeof v.room === "string") &&
    (v.reason === undefined || typeof v.reason === "string")
  );
}

/* ---------- константы канона ---------- */

/** Конфиг локации (map / field.map) — тип общий с редактором. */
export type { TestMap };

/** Лимиты редактора локации — единственный источник на клиенте: server/protocol.js
 *  держит то же самое (паритет в CI). Сервер отвергает конфиг за этими границами. */
export { ELEV_STEP_MAX, JUMP_CHARGE_FULL, JUMP_CHARGE_HALF, JUMP_MAX_UP, TEST_MAP_LIMITS, TERRAIN_MAX_LEVEL };

/** id покрытий земли пака (12): выводим из полной модели редатора, а не дублируем. */
export const GROUND_COVER_IDS: readonly string[] = GROUND_COVER_OPTS.map((o) => o.id);

/** Кривая брони — единственный источник на клиенте: settings.ts (замеры владельца).
 *  Побайтовое зеркало на сервере: ARMOR_CURVE в server/protocol.js (паритет в CI). */
export { ARMOR_CURVE };

/** Отклик удара по умолчанию (flightMs), мс: сервер берёт 170, если strike без числа.
 *  Источник на клиенте — настройка по умолчанию «Отклик удара» (settings.ts). */
export const STRIKE_CATCH_MS: number = DEFAULT_SETTINGS.combat.strikeResponseMs;
/** Верхняя граница окна полёта удара на проводе; источник — граница настройки. */
export const STRIKE_CATCH_MAX_MS: number = STRIKE_RESPONSE_MAX_MS;

/** Зоны удара id → {part, damage} — вывод из модели зон клиента (id/name/damage
 *  равны серверной таблице STRIKE_ZONES в server/protocol.js; паритет в CI). */
export const STRIKE_ZONES: Readonly<Record<string, { part: string; damage: number }>> = Object.freeze(
  Object.fromEntries(DEFAULT_SETTINGS.combat.zones.map((z) => [z.id, { part: z.name, damage: z.damage }])),
);

/** Части суток и погода на проводе (atmo.dp / atmo.w): источник — settings.ts. */
export const ATMO_PHASE_LIST: readonly DayPart[] = DAYPARTS;
export const ATMO_WEATHER_LIST: readonly WeatherKind[] = WEATHERS;

/** Темпы атмосферы по умолчанию, мс: часть суток — DEFAULT_SETTINGS.atmo.phaseMin минут,
 *  погода — weatherMin минут (7 и 12 — то же, что у нового состояния комнаты сервера). */
export const ATMO_PHASE_MS_DEF: number = DEFAULT_SETTINGS.atmo.phaseMin * 60_000;
export const ATMO_WEATHER_MS_DEF: number = DEFAULT_SETTINGS.atmo.weatherMin * 60_000;

/** Границы atmoset {pl, wl} в мс: сервер зажимает часть суток 1–120 мин, погоду 2–240.
 *  Источник границы — настройки клиента (те же числа уходит на сервер с ползунков). */
export const ATMO_PHASE_MS_MIN: number = ATMO_PHASE_MINUTES_MIN * 60_000;
export const ATMO_PHASE_MS_MAX: number = ATMO_PHASE_MINUTES_MAX * 60_000;
export const ATMO_WEATHER_MS_MIN: number = ATMO_WEATHER_MINUTES_MIN * 60_000;
export const ATMO_WEATHER_MS_MAX: number = ATMO_WEATHER_MINUTES_MAX * 60_000;

/* ---------- зеркала серверных лимитов (потребителя на клиенте пока нет —
   держатся паритет-тестом test:protocol-parity; серверный канон —
   server/protocol.js). Менять синхронно с ним нельзя: правка расходится с
   CI-проверкой и роняет паритет-тест. ---------- */

/** Потолок комнаты, котов. */
export const MAX_PLAYERS = 30;
/** Кулдаун шага на сервере, мс (очередь глубиной MOVE_QUEUE_MAX). */
export const MOVE_COOLDOWN_MS = 80;
export const MOVE_QUEUE_MAX = 3;
/** Кулдаун повторного join, мс. */
export const JOIN_COOLDOWN_MS = 1000;
/** Минимальный промежуток рассылки aim, мс. */
export const AIM_MIN_GAP_MS = 20;
/** Лимиты чата: длина после sanitize, кулдаун, размер истории. */
export const CHAT_MAX_LEN = 200;
export const CHAT_COOLDOWN_MS = 450;
export const CHAT_HISTORY = 40;
/** Дефолтная клетка манекена (cell-доли; спрайт дефолта — правка сервера). */
export const DUMMY_DEFAULT = { x: 7, y: 2 } as const;
/** Клетка мишени РАБ: численно равна серверной RAB_CELL {x:4, y:2}. */
export const RAB_CELL = { x: 4, y: 2 } as const;
/** Кулдаун прыжка, мс. */
export const JUMP_COOLDOWN_MS = 450;
/** Дальность прыжка: 1..3 клетки, строго вдоль 8 направлений. */
export const JUMP_MAX_CELLS = 3;
export const JUMP_DIRECTIONS = 8;
/** Максимальный перепад вниз (равен TERRAIN_MAX_LEVEL). Вверх — JUMP_MAX_UP. */
export const JUMP_MAX_DROP = TERRAIN_MAX_LEVEL;
