/**
 * Живые universes-параметры для UI (P3, спек §6A): какие уровни урона/брони
 * и периоды стрелы игроку предлагать. Ценности — публичный GET /cfg (P2),
 * подписи/юниверс/дефолты — зеркало ./../../cfg-registry.ts (импортируем,
 * не дублируем). Ответ кэшируется на вкладку: потребители (экран входа,
 * панель настроек) ходят одним fetch-ом.
 *
 * Мандат владелицы 2026-11-08: сюда же приезжает ЖИВАЯ кривая брони
 * (реестровый ключ combat.armorCurve, блок combat публичного GET /cfg —
 * игроки видят прогноз урона на HUD, ключ не приватный). Кривая проходит
 * валидацию armorCurveOrCanon: битая/отсутствующая — канон W3, сборка
 * безопасна при оффлайне.
 *
 * Формат GET /cfg (server/runtime-config.js через cfg-registry):
 *   { ok, v, atmo:{phaseMin,weatherMin},
 *     universes: { strikeDamage:{levels,default}, armor:{tenths,default},
 *                 arrowSpeed:{periods,default} },
 *     combat: { armorCurve: [[броня, урон%], …] } }
 * Любая битая часть молча падает в реестровые дефолты: UI не ломается, если
 * старый сервер не отдал universes/combat-блок.
 */
import { cfgDefaults } from "@/lib/cfg-registry";
import { armorCurveOrCanon, type ArmorCurve } from "@/lib/sim/armor-curve";
import { httpOrigin } from "./coop";

/** Universes в терминах UI: уровни урона/брони (целые), периоды стрелы, дефолты,
 *  живая кривая брони (для прогноза урона). */
export type Universes = {
  /** Разрешённые уровни урона (0–9). */
  damage: number[];
  /** Разрешённые уровни брони (0–9, десятые = tenths/10). */
  armor: number[];
  /** Разрешённые периоды оборота стрелы, сек. */
  arrowPeriods: number[];
  /** Живая кривая брони (мандат 2026-11-08): пары [броня, урон%]. */
  armorCurve: ArmorCurve;
  damageDefault: number;
  armorDefault: number;
  arrowDefault: number;
};

/** Реестровые дефолты (cfg-registry → cfgDefaults): fail-safe, когда /cfg недоступен. */
export function universesDefaults(): Universes {
  const def = cfgDefaults();
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const dmg = def.universes.strikeDamage ?? {};
  const arm = def.universes.armor ?? {};
  const arrow = def.universes.arrowSpeed ?? {};
  return {
    damage: (dmg.levels ?? [0]).map(num),
    armor: (arm.tenths ?? [0]).map((t) => Math.round(num(t) * 10)),
    arrowPeriods: (arrow.periods ?? []).map(num),
    armorCurve: armorCurveOrCanon(def.combat?.armorCurve),
    damageDefault: num(dmg.default),
    armorDefault: Math.round(num(arm.default) * 10),
    arrowDefault: num(arrow.default),
  };
}

let cache: Universes | null = null;
let inflight: Promise<Universes> | null = null;

function parseUniverses(raw: unknown): Universes {
  const def = universesDefaults();
  if (!raw || typeof raw !== "object") return def;
  const u = (raw as { universes?: Record<string, unknown> }).universes;
  if (!u || typeof u !== "object") return def;
  const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : Number.NaN);
  const list = (v: unknown): number[] =>
    Array.isArray(v) ? v.map(num).filter((x) => Number.isFinite(x)) : [];
  const strike = u.strikeDamage as { levels?: unknown; default?: unknown } | undefined;
  const armor = u.armor as { tenths?: unknown; default?: unknown } | undefined;
  const arrow = u.arrowSpeed as { periods?: unknown; default?: unknown } | undefined;
  // Кривая брони: блок combat того же ответа (мандат 2026-11-08) —
  // валидация общая (armorCurveOrCanon), битое молча = канон.
  const combatBlock = (raw as { combat?: { armorCurve?: unknown } }).combat;
  const strikeLevels = list(strike?.levels);
  const armorTenths = list(armor?.tenths);
  const arrowPeriods = list(arrow?.periods);
  const next: Universes = {
    damage: strikeLevels.length ? strikeLevels : def.damage,
    armor: armorTenths.length ? armorTenths.map((t) => Math.round(t * 10)) : def.armor,
    arrowPeriods: arrowPeriods.length ? arrowPeriods : def.arrowPeriods,
    armorCurve: armorCurveOrCanon(combatBlock?.armorCurve),
    damageDefault: Number.isFinite(num(strike?.default)) ? num(strike?.default) : def.damageDefault,
    armorDefault: Number.isFinite(num(armor?.default)) ? Math.round(num(armor?.default) * 10) : def.armorDefault,
    arrowDefault: Number.isFinite(num(arrow?.default)) ? num(arrow?.default) : def.arrowDefault,
  };
  // Дефолт обязан входит в разрешённый список — иначе снап сам себя зациклит.
  if (!next.damage.includes(next.damageDefault)) next.damageDefault = next.damage[0] ?? 0;
  if (!next.armor.includes(next.armorDefault)) next.armorDefault = next.armor[0] ?? 0;
  if (!next.arrowPeriods.some((p) => Math.abs(p - next.arrowDefault) < 0.05)) {
    next.arrowDefault = next.arrowPeriods[0] ?? 5;
  }
  return next;
}

/** Живые universes: разово fetch на вкладку, дальше кэш. Сбой → реестровые дефолты. */
export function loadUniverses(): Promise<Universes> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch(`${httpOrigin()}/cfg`, { credentials: "include" })
      .then((res) => res.json())
      .then((raw: unknown) => {
        cache = parseUniverses(raw);
        return cache;
      })
      .catch(() => {
        cache = universesDefaults();
        return cache;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/** Синхронный ответ «прямо сейчас»: кэш, либо реестровые дефолты (fetch ещё идёт). */
export function universesNow(): Universes {
  return cache ?? universesDefaults();
}

/**
 * Сохранённый выбор выпал из разрешённого списка → снап к дефолту (спек §6A:
 * сервер всё равно клэмпит; клиент не молча ломает загрузку профиля — просто снап).
 * Внутри списка значение сохраняется как есть.
 */
export function snapToAllowed(value: number, allowed: number[], def: number): number {
  if (allowed.includes(value)) return value;
  return def;
}

/** Период с допуском плавающей точки: «3,5» из списка узнаёт и 3.4999999. */
export function snapPeriodToAllowed(periodSec: number, u: Universes): number {
  if (u.arrowPeriods.some((p) => Math.abs(p - periodSec) < 0.05)) return periodSec;
  return u.arrowDefault;
}
