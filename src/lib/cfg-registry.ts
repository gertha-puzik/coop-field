// ============================================================
// ЗЕРКАЛО реестра игроков-видимых параметров (P2, спек §6).
//
// Данные дублем серверного server/cfg-registry.js (общего кода у сторон нет):
// подписи, юниверс разрешённых значений, дефолты, apply-политики. Паритет
// держит scripts/test-protocol-parity.mjs — списки/дефолты/подписи обязаны
// совпадать байт в байт. Формул клэмпов урона/брони здесь НЕТ: урон движок
// считает своим zoneDamageFor (settings.ts), клэмп — серверная обязанность.
//
// Назначение (фаза P3): единый источник для экрана входа и панели настроек —
// какие уровни урона/брони и периоды стрелы предложить игроку, дефолты и
// подписи к ним; сами ЦЕННОСТИ приходят из публичного GET /cfg (блок universes;
// кривая брони — блок combat, мандат владелицы 2026-11-08).
// ============================================================

import { ARMOR_CURVE } from "./sim/settings.ts";

/** Формат юниверса значений: непрерывный диапазон с шагом. */
export interface CfgRange {
  min: number;
  max: number;
  step: number;
}

/** Границы точек кривой брони (kind 'points', ключ combat.armorCurve):
 *  x — броня 0..0,9 с шагом 0,01, y — проходящий урон 5..60. */
export interface CfgPointsBounds {
  xMin: number;
  xMax: number;
  xStep: number;
  yMin: number;
  yMax: number;
}

/** Тип параметра: kind задаёт и валидатор, и имя списка в values-файле.
 *  bool — гейты atmoset (F2 §3.4): per-room override + ГЛОБАЛЬНЫЙ master-ключ
 *  atmo.playerControl (мандат владелицы 2026-11-08); юниверса значений нет.
 *  points — кривая брони (мандат владелицы 2026-11-08): values — юниверс
 *  ЧИСЛА точек 2..16, границы осей — points. */
export type CfgKind = 'range' | 'levels' | 'tenths' | 'periods' | 'bool' | 'points';
export type CfgApplyPolicy = 'new-room' | 'on-next-event' | 'new-session' | 'live-gate';

/** Метаданные одного параметра (зеркало серверного REGISTRY). */
export interface CfgFieldDef {
  key: string;
  label: string;
  description: string;
  unit: string;
  kind: CfgKind;
  values: CfgRange | number[] | null;
  /** Число (диапазоны/уровни), boolean (гейт atmoset) или канон W3-кривая
   *  (kind points:defaultValue кривой = дефолт). */
  default: number | boolean | number[][];
  engineCap: CfgRange | number[] | null;
  /** Границы своих значений ВНЕ пресетов юниверса — только у periods
   *  (оборота стрелы); у levels/tenths юниверс и есть полный диапазон. */
  custom?: { min: number; max: number };
  /** Границы точек — только у kind points (иначе поля нет). */
  points?: CfgPointsBounds;
  applyPolicy: CfgApplyPolicy;
  applyHint: string;
  visibility: 'public' | 'admin-only';
  scope: 'global' | 'beer' | 'elyria' | 'room';
}

/** Реестр: ключ — точечный путь «секция.поле». Движковые капы (engineCap)
 * совпадают с юниверсом: значений вне их не существует, ARMOR_CURVE и зоны
 * ударов — константы движка (protocol.ts) и админу не принадлежат. */
export const CFG_REGISTRY: Record<string, CfgFieldDef> = {
  'atmo.phaseMin': {
    key: 'atmo.phaseMin',
    label: 'Длина части суток',
    description:
      'Сколько минут длится одна часть суток (утро/день/вечер/ночь) в новых комнатах.',
    unit: 'мин',
    kind: 'range',
    values: { min: 1, max: 120, step: 1 },
    default: 7,
    engineCap: { min: 1, max: 120, step: 1 },
    applyPolicy: 'new-room',
    applyHint: 'Вступает в новых комнатах; уже идущие едут на своём цикле.',
    visibility: 'public',
    scope: 'global',
  },
  'atmo.weatherMin': {
    key: 'atmo.weatherMin',
    label: 'Интервал смены погоды',
    description:
      'Раз в сколько минут погода в новой комнате меняется сама.',
    unit: 'мин',
    kind: 'range',
    values: { min: 2, max: 240, step: 1 },
    default: 12,
    engineCap: { min: 2, max: 240, step: 1 },
    applyPolicy: 'new-room',
    applyHint: 'Вступает в новых комнатах; уже идущие едут на своём цикле.',
    visibility: 'public',
    scope: 'global',
  },
  'atmo.playerControl': {
    key: 'atmo.playerControl',
    label: 'Игроки крутят атмосферу — общий выключатель',
    description:
      'Разрешает игрокам во всех комнатах менять погоду и части суток. «Запрещено» выключает управление сразу везде; «разрешено» возвращает комнатам их настройки.',
    unit: 'вкл/выкл',
    kind: 'bool',
    values: null,
    default: true,
    engineCap: null,
    applyPolicy: 'live-gate',
    applyHint: 'Действует сразу; ход времени и погоды не перезапускается.',
    visibility: 'admin-only',
    scope: 'global',
  },
  'atmo.allowPlayerAtmosphereControl': {
    key: 'atmo.allowPlayerAtmosphereControl',
    label: 'Игроки крутят атмосферу',
    description:
      'Разрешает игрокам комнаты менять погоду и части суток. Без переопределения — разрешено.',
    unit: 'вкл/выкл',
    kind: 'bool',
    values: null,
    default: true,
    engineCap: null,
    applyPolicy: 'live-gate',
    applyHint: 'Действует сразу; ход времени и погоды не перезапускается.',
    visibility: 'admin-only',
    scope: 'room',
  },
  'universes.strikeDamage': {
    key: 'universes.strikeDamage',
    label: 'Удары: уровни урона',
    description:
      'Какие уровни урона игрок может выбрать на экране входа.',
    unit: 'уровень (0,0–0,9)',
    kind: 'levels',
    values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    default: 0,
    engineCap: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    applyPolicy: 'on-next-event',
    applyHint: 'Действует на следующие удары.',
    visibility: 'public',
    scope: 'global',
  },
  'universes.armor': {
    key: 'universes.armor',
    label: 'Броня: уровни защиты',
    description:
      'Какие уровни брони (0,0–0,9) игрок может выбрать.',
    unit: 'уровень (0,0–0,9)',
    kind: 'tenths',
    values: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
    default: 0,
    engineCap: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
    applyPolicy: 'on-next-event',
    applyHint: 'Действует на следующий кадр брони.',
    visibility: 'public',
    scope: 'global',
  },
  'universes.arrowSpeed': {
    key: 'universes.arrowSpeed',
    label: 'Стрела: периоды оборота',
    description:
      'Какие периоды оборота стрелы игрок видит на экране входа. Свои значения — от 0,5 до 15 сек с шагом 0,1.',
    unit: 'сек',
    kind: 'periods',
    values: [1.8, 2.5, 3.5, 4, 4.5, 5],
    // Свои значения (мандат владелицы 2026-11-08): оборот стрелы — чисто
    // клиентский, сервер публикует список; custom — границы для значений ВНЕ
    // пресетов (levels/tenths таких границ не имеют: их юнисы — полный диапазон).
    custom: { min: 0.5, max: 15 },
    default: 5,
    engineCap: { min: 0.5, max: 15, step: 0.1 },
    applyPolicy: 'new-session',
    applyHint: 'Игроки увидят в новой сессии.',
    visibility: 'public',
    scope: 'global',
  },
  // Мандат владелицы 2026-11-08: редактируемая кривая брони — единственный ключ
  // kind 'points'. defaultValue — побайтовый канон W3 (ARMOR_CURVE settings.ts
  // = server/protocol.js); дефолт и есть канон, замена — поверх него.
  'combat.armorCurve': {
    key: 'combat.armorCurve',
    label: 'Броня: кривая защиты',
    description:
      'Как броня (0,0–0,9) режет входящий урон: точки «броня → урон %», между ними — линейная интерполяция.',
    unit: 'точек',
    kind: 'points',
    values: { min: 2, max: 16, step: 1 },
    default: ARMOR_CURVE.map((p) => [p[0], p[1]]),
    engineCap: { min: 2, max: 16, step: 1 },
    points: { xMin: 0, xMax: 0.9, xStep: 0.01, yMin: 5, yMax: 60 },
    applyPolicy: 'on-next-event',
    applyHint: 'Действует на следующий удар.',
    visibility: 'public',
    scope: 'global',
  },
};

/** Ключи реестра в каноническом порядке. */
export const CFG_KEYS: readonly string[] = Object.keys(CFG_REGISTRY);

/** Дефолты всех параметров в формате публичного GET /cfg (v, atmo, universes, combat).
 *  F2: bool-ключ — в atmo (юниверсов нет); universes несут явный playerSelectable.
 *  Кривая брони (мандат владелицы 2026-11-08) — в combat, defaultValue = канон W3. */
export type CfgDefaultsSnapshot = {
  v: number;
  atmo: Record<string, number | boolean>;
  universes: Record<string, { levels?: number[]; tenths?: number[]; periods?: number[]; default: number; playerSelectable: boolean }>;
  combat: Record<string, number[][]>;
};

export function cfgDefaults(): CfgDefaultsSnapshot {
  const atmo: Record<string, number | boolean> = {};
  const universes: Record<string, { levels?: number[]; tenths?: number[]; periods?: number[]; default: number; playerSelectable: boolean }> = {};
  const combat: Record<string, number[][]> = {};
  for (const def of Object.values(CFG_REGISTRY)) {
    const [sec, field] = def.key.split('.');
    if (def.kind === 'range' || def.kind === 'bool') {
      // kind ∈ {range,bool} ⇒ default — число/бул; сужение для TS (как ниже для universes).
      atmo[field] = def.default as number | boolean;
    } else if (def.kind === 'points' && Array.isArray(def.default)) {
      combat[field] = def.default.map((p) => [...p]);
    } else if (Array.isArray(def.values)) {
      // kind ∈ {levels,tenths,periods} ⇒ default числовой; сужение для TS.
      universes[field] = { [def.kind]: [...def.values], default: def.default as number, playerSelectable: true };
    }
  }
  return { v: 1, atmo, universes, combat };
}
