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
// подписи к ним; сами ЦЕННОСТИ приходят из публичного GET /cfg (блок universes).
// ============================================================

/** Формат юниверса значений: непрерывный диапазон с шагом. */
export interface CfgRange {
  min: number;
  max: number;
  step: number;
}

/** Тип параметра: kind задаёт и валидатор, и имя списка в values-файле. */
export type CfgKind = 'range' | 'levels' | 'tenths' | 'periods';
export type CfgApplyPolicy = 'new-room' | 'on-next-event' | 'new-session';

/** Метаданные одного параметра (зеркало серверного REGISTRY). */
export interface CfgFieldDef {
  key: string;
  label: string;
  description: string;
  unit: string;
  kind: CfgKind;
  values: CfgRange | number[];
  default: number;
  engineCap: CfgRange | number[];
  applyPolicy: CfgApplyPolicy;
  applyHint: string;
  visibility: 'public' | 'admin-only';
  scope: 'global' | 'beer' | 'elyria';
}

/** Реестр: ключ — точечный путь «секция.поле». Движковые капы (engineCap)
 * совпадают с юниверсом: значений вне их не существует, ARMOR_CURVE и зоны
 * ударов — константы движка (protocol.ts) и админу не принадлежат. */
export const CFG_REGISTRY: Record<string, CfgFieldDef> = {
  'atmo.phaseMin': {
    key: 'atmo.phaseMin',
    label: 'Длина части суток',
    description:
      'Сколько минут длится одна часть суток (утро/день/вечер/ночь) в НОВЫХ комнатах. Живую комнату крутит ползунок «Сутки» (кадр atmoset) — реестр задаёт только стартовые длины.',
    unit: 'мин',
    kind: 'range',
    values: { min: 1, max: 120, step: 1 },
    default: 7,
    engineCap: { min: 1, max: 120, step: 1 },
    applyPolicy: 'new-room',
    applyHint: 'Применимо к новым комнатам; уже открытая комната едет на своём цикле.',
    visibility: 'public',
    scope: 'global',
  },
  'atmo.weatherMin': {
    key: 'atmo.weatherMin',
    label: 'Интервал смены погоды',
    description:
      'Раз в сколько минут погода в НОВОЙ комнате меняется сама. Живую комнату переносит тот же ползунок (кадр atmoset).',
    unit: 'мин',
    kind: 'range',
    values: { min: 2, max: 240, step: 1 },
    default: 12,
    engineCap: { min: 2, max: 240, step: 1 },
    applyPolicy: 'new-room',
    applyHint: 'Применимо к новым комнатам; уже открытая комната едет на своём цикле.',
    visibility: 'public',
    scope: 'global',
  },
  'universes.strikeDamage': {
    key: 'universes.strikeDamage',
    label: 'Удары: уровни урона',
    description:
      'Какие уровни урона (0,0–0,9) игрок может выбрать на экране входа. Сервер дополнительно ограничивает каждый входящий удар сверху формулой зон (горло: база зоны + 3,67 за уровень) по максимальному разрешённому уровню.',
    unit: 'уровень (0,0–0,9)',
    kind: 'levels',
    values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    default: 0,
    engineCap: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    applyPolicy: 'on-next-event',
    applyHint: 'Действует на следующие удары: событие удара клэмпится по верхней границе.',
    visibility: 'public',
    scope: 'global',
  },
  'universes.armor': {
    key: 'universes.armor',
    label: 'Броня: уровни защиты',
    description:
      'Какие десятые брони (0,0–0,9) игрок может выбрать. Входящее значение снапится к ближайшей разрешённой НИЖНЕЙ десятой; ниже наименьшей разрешённой — без брони.',
    unit: 'уровень (0,0–0,9)',
    kind: 'tenths',
    values: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
    default: 0,
    engineCap: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9],
    applyPolicy: 'on-next-event',
    applyHint: 'Действует на следующий кадр брони: значение снапится к разрешённому списку.',
    visibility: 'public',
    scope: 'global',
  },
  'universes.arrowSpeed': {
    key: 'universes.arrowSpeed',
    label: 'Стрела: периоды оборота',
    description:
      'Какие периоды оборота стрелы (существующие пресеты 1,8–5 сек) игроку показывают на экране входа. Оборот стрелы — чисто клиентский: сервер только публикует список, серверного клэмпа нет и не надо.',
    unit: 'сек',
    kind: 'periods',
    values: [1.8, 2.5, 3.5, 4, 4.5, 5],
    default: 5,
    engineCap: [1.8, 2.5, 3.5, 4, 4.5, 5],
    applyPolicy: 'new-session',
    applyHint: 'Игрок увидит новый список в следующей сессии (экран входа), поле на ходу не меняется.',
    visibility: 'public',
    scope: 'global',
  },
};

/** Ключи реестра в каноническом порядке. */
export const CFG_KEYS: readonly string[] = Object.keys(CFG_REGISTRY);

/** Дефолты всех параметров в формате публичного GET /cfg (v, atmo, universes). */
export function cfgDefaults(): { v: number; atmo: Record<string, number>; universes: Record<string, { levels?: number[]; tenths?: number[]; periods?: number[]; default: number }> } {
  const atmo: Record<string, number> = {};
  const universes: Record<string, { levels?: number[]; tenths?: number[]; periods?: number[]; default: number }> = {};
  for (const def of Object.values(CFG_REGISTRY)) {
    const [sec, field] = def.key.split('.');
    if (def.kind === 'range') {
      atmo[field] = def.default;
    } else if (Array.isArray(def.values)) {
      universes[field] = { [def.kind]: [...def.values], default: def.default };
    }
  }
  return { v: 1, atmo, universes };
}
