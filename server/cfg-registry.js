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
 * F2 §3.4 (мандат владелицы 2026-11-08): 6-й ключ atmo.allowPlayerAtmosphereControl —
 * per-room boolean-гейт живых atmoset/atmo-кадров игроков. Юниверса значений у него
 * НЕТ (bool, strict true/false); глобальный слой его НЕ принимает (scope: "room") —
 * отсутствие per-room override = true (текущий геймплей сохраняется без миграции).
 *
 * 7-й ключ atmo.playerControl — ГЛОБАЛЬНЫЙ master-гейт тех же кадров (мандат
 * владелицы 2026-11-08 «Игроки крутят атмосферу — сделай чтоб можно было
 * выключать»: её решение, расширяющее модель поверх §3.4). Семантика master-слоя:
 * effective = глобальный && (per-room override ?? true): глобальное ВЫКЛ глушит
 * atmoset/atmo-кадры игроков ВО ВСЕХ комнатах даже при per-room ВКЛ; глобальное
 * ВКЛ возвращает per-room модели текущее поведение (комнату решает 6-й ключ).
 * Live-значение гейт читает через runtime-config (тот же паттерн, что у
 * combat.js: combatCaps на каждом событии).
 *
 * F2 §4 (частичное снятие заморозки B2): у universes-ключей выбор игрока хранится
 * ЯВНО — playerSelectable (boolean) отдельно от allowedValues (список kind) и
 * defaultValue (default). Старые тела без playerSelectable интерпретируются по
 * прежней косвенной семантике (список длиннее одного значения = выбор разрешён);
 * миграция на чтении выводит флаг из списка, значения и списки не теряются.
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
  // 7-й ключ (мандат владелицы 2026-11-08): ГЛОБАЛЬНЫЙ master-гейт atmoset/atmo
  // игроков. Семантика: effective = глобальный && (per-room override ?? true) —
  // глобальное ВЫКЛ глушит игроков во всех комнатах (даже при per-room ВКЛ),
  // глобальное ВКЛ возвращает per-room модели текущее поведение. Bool-ключ
  // глобального слоя: значения true/false, снапшот панели несёт его как 1/0.
  "atmo.playerControl": deepFreeze({
    key: "atmo.playerControl",
    label: "Игроки крутят атмосферу — общий выключатель",
    description:
      "Разрешает игрокам во всех комнатах перематывать части суток и менять погоду (кнопки панели и слайдер «Сутки»). «Запрещено» выключает управление сразу везде — настройки отдельных комнат это не переопределяют. «Разрешено» возвращает комнатам их собственные настройки.",
    unit: "вкл/выкл",
    kind: "bool",
    values: null,
    default: true,
    engineCap: null,
    applyPolicy: "live-gate",
    applyHint: "Действует сразу на все комнаты: при «запрещено» сервер молча отбрасывает смену суток/погоды от игроков; ход времени и погоды не перезапускается.",
    visibility: "admin-only",
    scope: "global",
  }),
  // F2 §3.4: per-room boolean-гейт atmoset. Юниверса значений нет (bool);  values/
  // engineCap — null (реестровые юниверсы к bool неприменимы). Глобальный слой
  // ключ НЕ принимает (scope: "room" отсекается в sanitizeValues) — поэтому
  // «нет override» всегда означает true, и существующий геймплей не меняется
  // без явного решения админа по конкретной комнате.
  "atmo.allowPlayerAtmosphereControl": deepFreeze({
    key: "atmo.allowPlayerAtmosphereControl",
    label: "Игроки крутят атмосферу",
    description:
      "Разрешает игрокам комнаты перематывать части суток и погоду (кнопки панели и слайдер «Сутки» — кадры atmo/atmoset). Тонкая настройка отдельной комнаты: без переопределения — разрешено, как сейчас. Общий выключатель на все комнаты сразу — ключ «Игроки крутят атмосферу — общий выключатель» выше в этой секции.",
    unit: "вкл/выкл",
    kind: "bool",
    values: null,
    default: true,
    engineCap: null,
    applyPolicy: "live-gate",
    applyHint: "Действует сразу на живую комнату: при «выкл» сервер молча отбрасывает кадры atmo/atmoset игроков; якорь суток/погоды не перезапускается.",
    visibility: "admin-only",
    scope: "room",
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

/** Дефолты всех параметров в формате хранения (значения, не метаданные).
 *  F2 §3.4: bool-ключи живут в atmo (единственное значение true/false);
 *  F2 §4: universes-поля несут ЯВНЫЙ playerSelectable: true (полный движковый
 *  юниверс = выбор разрешён), чтобы миграция старых списков была выводимой. */
export function defaultsFor() {
  const atmo = {};
  const universes = {};
  for (const def of Object.values(REGISTRY)) {
    const [sec, field] = def.key.split(".");
    if (def.kind === "range" || def.kind === "bool") atmo[field] = def.default;
    else if (def.kind === "levels" || def.kind === "tenths" || def.kind === "periods") {
      universes[field] = { [def.kind]: [...def.values], default: def.default, playerSelectable: true };
    }
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
 * дефолт — член списка. Остальное — ошибка, «доводить» ничего не будем.
 *
 * F2 §4 — хранение ТРЁХ понятий раздельно (PlayerParameterConfig):
 *   allowedValues — массив kind (кураторский список, НЕ режется при выключении
 *     выбора), defaultValue — default (обязан входить в финальный список),
 *     playerSelectable — boolean (строго true/false, строка/число → ошибка).
 * Правила миграции §4.3 (только на чтении, файл не переписываем):
 *   - в хранилище нет playerSelectable → флаг выводим из списка: >1 значения =
 *     true, {default}-only = false (прежняя косвенная семантика дословно);
 *   - новое тело БЕЗ playerSelectable — прежний контракт: флаг выводится из
 *     НОВОГО списка (off = список из одного дефолта);
 *   - тело ТОЛЬКО с playerSelectable (список/дефолт не тронуты) — флип флага
 *     поверх сохранённых allowedValues/defaultValue: кураторский список живёт
 *     на сервере и восстанавливается после reload (фикс «off-then-on»). */
const deriveSelectable = (arr) => arr.length > 1;

function sanitizeList(def, raw, stored) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: `ожидается объект { ${def.kind}: [...], default: N, playerSelectable: true|false }` };
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
  const selectableRaw = raw.playerSelectable;
  // Список материализуем ДО деривации: seen — Set (.size, не .length).
  const list = [...seen].sort((a, b) => a - b);
  const playerSelectable =
    selectableRaw === undefined
      ? /* старое тело: косвенная семантика на месте */ deriveSelectable(list)
      : typeof selectableRaw === "boolean"
        ? selectableRaw
        : null;
  if (playerSelectable === null) {
    return { error: "playerSelectable — строго true/false" };
  }
  return { value: { [def.kind]: list, default: dv, playerSelectable } };
}

/** Флаг-only патч (§4): список/дефолт не тронуты — кураторские allowedValues/
 *  default наследуются от stored, меняется только playerSelectable. */
function sanitizeSelectableOnly(def, raw, stored) {
  if (typeof raw.playerSelectable !== "boolean") {
    return { error: "playerSelectable — строго true/false" };
  }
  const prev = stored?.[def.kind] ?? [];
  const baseList = Array.isArray(prev) && prev.length ? [...new Set(prev.map((v) => canonOf(def, v)))].sort((a, b) => a - b) : [];
  if (!baseList.length) return { error: `список ${def.kind} пуст или не массив` };
  const dv = canonOf(def, stored.default);
  if (!baseList.includes(dv)) return { error: "дефолт вне разрешённого списка" };
  return { value: { [def.kind]: baseList, default: dv, playerSelectable: raw.playerSelectable } };
}

const canonOf = (def, v) => (def.kind === "levels" ? asInt : tenth)(v);

/** Bool-ключ (F2 §3.4, юниверса значений нет): строго true/false. */
function sanitizeBool(def, raw) {
  if (typeof raw !== "boolean") return { error: "значение — строго true/false" };
  return { value: raw };
}

/**
 * Прогнать патч {atmo?: {...}, universes?: {...}} через реестр. Неизвестная
 * секция/поле → error.unknown_keys (с перечислением разрешённых), невалидное
 * значение → error.invalid — всё или ничего, частичного применения нет.
 * base — слой под патчем (текущие значения при POST /cfg, дефолты при
 * импорте/восстановлении). v — штамп схемы, не параметр.
 *
 * F2 §3.4 opts.room=true принимает scope:"room"-ключи (вызывает per-room
 * слой); без него room-ключи считаются неизвестными для ГЛОБАЛЬНОГО слоя —
 * глобальный файл их не хранит и POST /cfg их отвергает.
 * F2 §4: universes-поля читаются/пишутся тройкой allowedValues/defaultValue/
 * playerSelectable; отсутствие флага в хранилище мигрируется выводом из
 * списка (read-time, файл не переписывается до первого admin-POST — прежний
 * контракт дословно).
 */
export function sanitizeValues(patch, base = defaultsFor(), opts = {}) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { error: { reason: "not_object", allowed: [...KEYS] } };
  }
  // База atmo копируется МИНУС room-scoped ключи (глобальный файл их не
  // хранит); per-room слой (opts.room) видит полный набор.
  const out = { v: 1, atmo: {} };
  for (const [field, val] of Object.entries(base.atmo)) {
    const def = REGISTRY["atmo." + field];
    if (def && def.scope === "room" && !opts.room) continue;
    out.atmo[field] = val;
  }
  out.universes = {};
  for (const [field, stored] of Object.entries(base.universes)) {
    const def = REGISTRY["universes." + field];
    // §4.3: нет явного флага в хранилище — выводим из списка (>1 значения = true)
    const playerSelectable =
      typeof stored.playerSelectable === "boolean"
        ? stored.playerSelectable
        : deriveSelectable(stored[def.kind] ?? []);
    out.universes[field] = { [def.kind]: [...stored[def.kind]], default: stored.default, playerSelectable };
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
      if (fieldDef.scope === "room" && !opts.room) {
        unknown.push(key);
        continue;
      }
      if (raw === undefined) continue;
      if (fieldDef.kind === "bool") {
        const res = sanitizeBool(fieldDef, raw);
        if (res.error) invalid.push({ key, error: res.error });
        else out.atmo[field] = res.value;
        continue;
      }
      if (fieldDef.kind === "range") {
        const res = sanitizeRange(fieldDef, raw);
        if (res.error) invalid.push({ key, error: res.error });
        else out.atmo[field] = res.value;
        continue;
      }
      // Списочные: полный патч {kind + default (+ флаг)} либо флаг-only поверх
      // сохранённых allowedValues/defaultValue (фикс «off-then-on», §4).
      const stored = out.universes[field];
      const res =
        raw && typeof raw === "object" && !Array.isArray(raw) &&
        raw[fieldDef.kind] === undefined && raw.default === undefined &&
        raw.playerSelectable !== undefined
          ? sanitizeSelectableOnly(fieldDef, raw, stored)
          : sanitizeList(fieldDef, raw, stored);
      if (res.error) invalid.push({ key, error: res.error });
      else out.universes[field] = res.value;
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

/** Публичный блок universes: только разрешённые списки + дефолты + ЯВНЫЙ флаг
 * playerSelectable, без меты. F2 §4: playerView=true (публичный GET /cfg для
 * игроков) при playerSelectable=false отдаёт только defaultValue — «игроку
 * доступен дефолт» реализуется в самом wire-формате, кривой клиент показать
 * выбор не может; playerView=false (admin-дашборд, export) отдаёт полный
 * кураторский список — иначе выключение выбора стёрло бы его навсегда. */
export function universesForPublic(values = defaultsFor(), { playerView = true } = {}) {
  const pick = (field, kind) => {
    const stored = values.universes[field];
    const playerSelectable =
      typeof stored.playerSelectable === "boolean" ? stored.playerSelectable : deriveSelectable(stored[kind] ?? []);
    const list = playerView && playerSelectable === false ? [stored.default] : [...stored[kind]];
    return { [kind]: list, default: stored.default, playerSelectable };
  };
  return {
    strikeDamage: pick("strikeDamage", "levels"),
    armor: pick("armor", "tenths"),
    arrowSpeed: pick("arrowSpeed", "periods"),
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
