/**
 * Whitelist-реестр игроков-видимых параметров (P2, спек §6): панель — редактор
 * разрешённых ЗНАЧЕНИЙ, а не редактор констант движка. Формат WS-протокола,
 * события, авторизация, rate-limits и лимиты кадров сюда НЕ входят — это файл
 * данных: по каждому ключу — подпись, юниверс, дефолт, движковый кап,
 * apply-политика и видимость. Константы канона (ARMOR_CURVE, STRIKE_ZONES,
 * ATMO-клэмпы) остаются в protocol.js: реестр хранит только разрешённые
 * подмножества/числа ПОВЕРХ них. Публичного админ-мета (имён бэкапов и путей)
 * здесь нет — только значения и их метаданные.
 *
 * Зеркало клиенту: src/lib/cfg-registry.ts (данные те же, формул клэмпа на
 * клиенте нет) — паритет списков/дефолтов/подписей держит test:protocol-parity.
 */
import {
  STRIKE_ZONES, ATMO_PHASE_MS_DEF, ATMO_WEATHER_MS_DEF,
  ATMO_PHASE_MS_MIN, ATMO_PHASE_MS_MAX, ATMO_WEATHER_MS_MIN, ATMO_WEATHER_MS_MAX,
} from "./protocol.js";

/** Прибавка урона в горло за каждые 0,1 уровня — константа движка, зеркало
 * клиентской математики пресетов (settings.ts THROAT_DAMAGE_STEP = 3,67).
 * База горла — сама зона STRIKE_ZONES.throat.damage (42, канон W3). */
const DAMAGE_STEP = 3.67;

const range = (min, max, step = 1) => Object.freeze({ min, max, step });
const list = (arr) => Object.freeze([...arr]);
const deepFreeze = (o) => {
  for (const v of Object.values(o)) {
    if (v && typeof v === "object" && !Object.isFrozen(v)) deepFreeze(v);
  }
  return Object.freeze(o);
};
/** Минутные границы — производные от миллисекундных клэмпов protocol.js. */
const minutes = (ms) => Math.round(ms / 60_000);

/** Юниверс движка (капы): уровни урона 0..9, десятые брони 0..0,9,
 * периоды оборота стрелы — существующие пресеты экрана входа (1,8–5 сек). */
const DAMAGE_LEVELS_ALL = list([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
const TENTHS_ALL = list([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
const ARROW_PERIODS_ALL = list([1.8, 2.5, 3.5, 4, 4.5, 5]);

/**
 * Реестр: ключи — точечные пути «секция.поле». kind задаёт и валидатор, и имя
 * массива в значениях universes (levels / tenths / periods); range — атомарное
 * число с границами. values — юниверс разрешённых значений; engineCap —
 * движковый потолок: даже при всём желании админ не выходит за него (здесь кап
 * совпадает с юниверсом — вне его значений просто не существует).
 */
export const REGISTRY = deepFreeze({
  "atmo.phaseMin": deepFreeze({
    key: "atmo.phaseMin",
    label: "Длина части суток",
    description:
      "Сколько минут длится одна часть суток (утро/день/вечер/ночь) в НОВЫХ комнатах. Живую комнату крутит ползунок «Сутки» (кадр atmoset) — реестр задаёт только стартовые длины.",
    unit: "мин",
    kind: "range",
    values: range(minutes(ATMO_PHASE_MS_MIN), minutes(ATMO_PHASE_MS_MAX)),
    default: minutes(ATMO_PHASE_MS_DEF),
    engineCap: range(minutes(ATMO_PHASE_MS_MIN), minutes(ATMO_PHASE_MS_MAX)),
    applyPolicy: "new-room",
    applyHint: "Применимо к новым комнатам; уже открытая комната едет на своём цикле.",
    visibility: "public",
    scope: "global",
  }),
  "atmo.weatherMin": deepFreeze({
    key: "atmo.weatherMin",
    label: "Интервал смены погоды",
    description:
      "Раз в сколько минут погода в НОВОЙ комнате меняется сама. Живую комнату переносит тот же ползунок (кадр atmoset).",
    unit: "мин",
    kind: "range",
    values: range(minutes(ATMO_WEATHER_MS_MIN), minutes(ATMO_WEATHER_MS_MAX)),
    default: minutes(ATMO_WEATHER_MS_DEF),
    engineCap: range(minutes(ATMO_WEATHER_MS_MIN), minutes(ATMO_WEATHER_MS_MAX)),
    applyPolicy: "new-room",
    applyHint: "Применимо к новым комнатам; уже открытая комната едет на своём цикле.",
    visibility: "public",
    scope: "global",
  }),
  "universes.strikeDamage": deepFreeze({
    key: "universes.strikeDamage",
    label: "Удары: уровни урона",
    description:
      "Какие уровни урона (0,0–0,9) игрок может выбрать на экране входа. Сервер дополнительно ограничивает каждый входящий удар сверху формулой зон (горло: база зоны + 3,67 за уровень) по максимальному разрешённому уровню.",
    unit: "уровень (0,0–0,9)",
    kind: "levels",
    values: DAMAGE_LEVELS_ALL,
    default: 0,
    engineCap: DAMAGE_LEVELS_ALL,
    applyPolicy: "on-next-event",
    applyHint: "Действует на следующие удары: событие удара клэмпится по верхней границе.",
    visibility: "public",
    scope: "global",
  }),
  "universes.armor": deepFreeze({
    key: "universes.armor",
    label: "Броня: уровни защиты",
    description:
      "Какие десятые брони (0,0–0,9) игрок может выбрать. Входящее значение снапится к ближайшей разрешённой НИЖНЕЙ десятой; ниже наименьшей разрешённой — без брони.",
    unit: "уровень (0,0–0,9)",
    kind: "tenths",
    values: TENTHS_ALL,
    default: 0,
    engineCap: TENTHS_ALL,
    applyPolicy: "on-next-event",
    applyHint: "Действует на следующий кадр брони: значение снапится к разрешённому списку.",
    visibility: "public",
    scope: "global",
  }),
  "universes.arrowSpeed": deepFreeze({
    key: "universes.arrowSpeed",
    label: "Стрела: периоды оборота",
    description:
      "Какие периоды оборота стрелы (существующие пресеты 1,8–5 сек) игроку показывают на экране входа. Оборот стрелы — чисто клиентский: сервер только публикует список, серверного клэмпа нет и не надо.",
    unit: "сек",
    kind: "periods",
    values: ARROW_PERIODS_ALL,
    default: 5,
    engineCap: ARROW_PERIODS_ALL,
    applyPolicy: "new-session",
    applyHint: "Игрок увидит новый список в следующей сессии (экран входа), поле на ходу не меняется.",
    visibility: "public",
    scope: "global",
  }),
});

export const KEYS = Object.freeze(Object.keys(REGISTRY));
/** Легальные секции записи — производные от ключей реестра (литералов нет). */
const SECTIONS = Object.freeze(new Set(KEYS.map((k) => k.split(".")[0])));

/** Дефолты всех параметров в формате хранения (значения, не метаданные). */
export function defaultsFor() {
  const atmo = {};
  const universes = {};
  for (const def of Object.values(REGISTRY)) {
    const [sec, field] = def.key.split(".");
    if (def.kind === "range") atmo[field] = def.default;
    else universes[field] = { [def.kind]: [...def.values], default: def.default };
  }
  return { v: 1, atmo, universes };
}

/* ---------------- Валидация (whitelist: принять или отказать) ---------------- */

const tenth = (v) => Math.round(Number(v) * 10) / 10;
const asInt = (v) => Math.round(Number(v));

/** Диапазон: число зажимается в границы (гостей портала не роняем — поведение
 * прежней версии). Мусор (не число) — ошибка: админ должен видеть отказ. */
function sanitizeRange(def, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: "не число" };
  const { min, max } = def.values;
  return { value: Math.min(max, Math.max(min, asInt(n))) };
}

/** Список: массив обязан быть непустым подмножеством движкового юниверса,
 * дефолт — член списка. Остальное — ошибка, «доводить» ничего не будем. */
function sanitizeList(def, raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `ожидается объект { ${def.kind}: [...], default: N }` };
  }
  const arr = raw[def.kind];
  if (!Array.isArray(arr) || arr.length === 0) return { error: `список ${def.kind} пуст или не массив` };
  const canon = def.kind === "levels" ? asInt : tenth;
  const universe = new Set(def.values.map(canon));
  const seen = new Set();
  for (const item of arr) {
    if (!Number.isFinite(Number(item))) return { error: `значение не число: ${String(item)}` };
    const n = canon(item);
    if (!universe.has(n)) return { error: `значение вне движкового юниверса: ${String(item)}` };
    seen.add(n);
  }
  const dvRaw = raw.default;
  const dv = canon(dvRaw);
  if (!Number.isFinite(Number(dvRaw)) || !seen.has(dv)) {
    return { error: "дефолт вне разрешённого списка" };
  }
  return { value: { [def.kind]: [...seen].sort((a, b) => a - b), default: dv } };
}

/**
 * Прогнать патч {atmo?: {phaseMin, weatherMin}, universes?: {strikeDamage,
 * armor, arrowSpeed}} через реестр. Неизвестная секция/поле → error.unknown_keys
 * (с перечислением разрешённых), невалидное значение → error.invalid — всё или
 * ничего, частичного применения нет. base — слой под патчем (текущие значения
 * при POST /cfg, дефолты при импорте/восстановлении). v — штамп схемы, не параметр.
 */
export function sanitizeValues(patch, base = defaultsFor()) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { error: { reason: "not_object", allowed: [...KEYS] } };
  }
  const out = { v: 1, atmo: { ...base.atmo } };
  out.universes = {};
  for (const [field, stored] of Object.entries(base.universes)) {
    const def = REGISTRY["universes." + field];
    out.universes[field] = { [def.kind]: [...stored[def.kind]], default: stored.default };
  }
  const unknown = [];
  const invalid = [];
  for (const [sec, body] of Object.entries(patch)) {
    if (sec === "v") continue; // штамп схемы файла/экспорта
    if (!SECTIONS.has(sec)) {
      unknown.push(sec);
      continue;
    }
    if (body == null) continue;
    if (typeof body !== "object" || Array.isArray(body)) {
      invalid.push({ key: sec, error: "секция должна быть объектом" });
      continue;
    }
    for (const [field, raw] of Object.entries(body)) {
      const key = `${sec}.${field}`;
      const fieldDef = REGISTRY[key];
      if (!fieldDef) {
        unknown.push(key);
        continue;
      }
      if (raw === undefined) continue;
      const res =
        fieldDef.kind === "range"
          ? sanitizeRange(fieldDef, raw)
          : sanitizeList(fieldDef, raw);
      if (res.error) invalid.push({ key, error: res.error });
      else if (sec === "universes") out.universes[field] = res.value;
      else out.atmo[field] = res.value;
    }
  }
  if (unknown.length) {
    return { error: { reason: "unknown_keys", unknown, allowed: [...KEYS] } };
  }
  if (invalid.length) {
    return { error: { reason: "invalid", invalid, allowed: [...KEYS] } };
  }
  return { values: out };
}

/** Публичный блок universes: только разрешённые списки + дефолты, без меты. */
export function universesForPublic(values = defaultsFor()) {
  const u = values.universes;
  return {
    strikeDamage: { levels: [...u.strikeDamage.levels], default: u.strikeDamage.default },
    armor: { tenths: [...u.armor.tenths], default: u.armor.default },
    arrowSpeed: { periods: [...u.arrowSpeed.periods], default: u.arrowSpeed.default },
  };
}

/** Компактные метаданные реестра для админ-дашборда (подписи/типы/капы). */
export function mutationsForAdmin() {
  const out = {};
  for (const def of Object.values(REGISTRY)) out[def.key] = { ...def };
  return out;
}

/* ---------------- Движковые формулы клэмпов (только сервер) ---------------- */

/** База ростового масштаба урона: урон зоны уровня k = база зоны, умноженная
 * на рост урона горла ((42 + 3,67·k) / 42); горло — напрямую (42 + 3,67·k).
 * Формула — зеркало клиентской zoneDamageFor (settings.ts): что клиент
 * считает для разрешённого уровня, то сервер считает как потолок. */
const throatBase = () => STRIKE_ZONES.throat.damage;

/**
 * Верхняя граница урона удара в зону zoneId при уровне бьющего level.
 * combat.js зовёт её с максимальным РАЗРЕШЁННЫМ уровнем и клэмпит входящее
 * значение урона сверху: легальный клиент уровня ≤ max проходит без урезания.
 */
export function maxStrikeDamage(zoneId, level) {
  const zone = STRIKE_ZONES[zoneId];
  if (!zone) return 0;
  const lv = Math.max(0, asInt(level));
  const base = throatBase();
  const growth = base + DAMAGE_STEP * lv;
  if (zoneId === "throat") return Math.round(growth);
  return Math.round((zone.damage * growth) / base);
}

/**
 * Снап входящего значения брони к разрешённым десятым: берём НАИБОЛЬШУЮ
 * разрешённую десятую, не превышающую ВХОД (квантовать-вверх нельзя:
 * десятая выбирается сравнением с исходным числом, не с округлённым;
 * 1e-9 прощает только пыль float, не реальные 0,05), ниже наименьшей
 * разрешённой — 0 (без брони). allowed — текущий список из
 * runtime-значений universes.armor.tenths.
 */
export function snapArmorToUniverse(raw, allowed) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  const a = Math.min(0.9, Math.max(0, n));
  let best = 0;
  for (const t of Array.isArray(allowed) ? allowed : []) {
    const v = tenth(t);
    if (v <= a + 1e-9 && v > best) best = v;
  }
  return tenth(best);
}
