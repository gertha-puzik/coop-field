/**
 * Combat log + side-column layout model of the battlefield UI. Carved verbatim
 * from the simulator.tsx module belt (W5a stage 1, behavior-preserving).
 *
 * Two concerns share this module (same as the original belt section):
 *   — the persisted column widths (chat left, fight log right) with their
 *     localStorage key and clamps (the drag separators live in simulator.tsx);
 *   — the fight log: sequential «who => whom (zone) xN [dmg%]» entries with
 *     merge-on-repeat, plus the persisted combat state (energies + log).
 *
 * Consumers: simulator.tsx (useState/useEffect + network fight handler + JSX
 * of the log column and entry rendering in fight-log.tsx via plain props).
 */

import { DEFAULT_SETTINGS } from './settings';

/** Отдельное хранилище боевого состояния (энергия + лог ударов). */
export const COMBAT_KEY = 'catwar-battle-sim-combat-v1';
/** Ширины боковых колонок (чат слева, лог ударов справа) — их тянет сам игрок. */
export const LAYOUT_KEY = 'catwar-battle-sim-layout-v1';
/** Пределы растяжения колонок, px: узкие неудобны, широкие съедают поле. */
export const CHAT_W = { min: 210, max: 560, def: 300 };
export const LOG_W = { min: 170, max: 460, def: 230 };

export type Layout = { chatW: number; logW: number };

export const clampLayout = (l: Layout): Layout => ({
  chatW: Math.max(CHAT_W.min, Math.min(CHAT_W.max, Math.round(l.chatW))),
  logW: Math.max(LOG_W.min, Math.min(LOG_W.max, Math.round(l.logW))),
});

export const loadLayout = (): Layout => {
  if (typeof window === 'undefined') return { chatW: CHAT_W.def, logW: LOG_W.def };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { chatW: CHAT_W.def, logW: LOG_W.def };
    const p = JSON.parse(raw) as Partial<Layout>;
    return clampLayout({
      chatW: Number(p.chatW) || CHAT_W.def,
      logW: Number(p.logW) || LOG_W.def,
    });
  } catch {
    return { chatW: CHAT_W.def, logW: LOG_W.def };
  }
};

export const saveLayout = (l: Layout) => {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(clampLayout(l)));
  } catch {}
};

/** Максимум строк в боевом логе (лог теперь последовательный, старые строки вытесняются). */
export const LOG_LIMIT = 100;

/** Строка лога ударов: «Кто => Кого (зона) xN [урон%]» — пишется последовательно, свежая сверху.
 *  Свой кот подписывается «Я». Для промахов имя мишени не пишется (target = ''). */
export interface CombatLogEntry {
  target: string;
  zoneId: string;
  zoneLabel: string;
  count: number;
  /** Полученный целью урон за 1 удар, % энергии. Сервер присылает его уже
   *  после блока и брони — это ровно то, что цель потеряла этим ударом.
   *  Нет числа — промах или строка из старого сохранения. */
  dmg?: number;
  /** Кто бил. Пустое значение в старых сохранениях — свой кот. */
  actor?: string;
  /** Оружие, если сервер его прислал. Пусто — удара лапой без когтей. */
  weapon?: string;
}

export function logActor(entry: CombatLogEntry): string {
  return entry.actor || 'Я';
}

export function mergeLog(prev: CombatLogEntry[], entry: CombatLogEntry): CombatLogEntry[] {
  // Промахи в лог не пишем: строк «мимо» больше нет (вместе с надписью над котом).
  if (entry.zoneId === 'miss') return prev;
  const [top, ...rest] = prev;
  const same =
    !!top &&
    top.target === entry.target &&
    top.zoneId === entry.zoneId &&
    logActor(top) === logActor(entry) &&
    (top.weapon || '') === (entry.weapon || '');
  // Урон за удар в серии обновляем до последнего значения: броня или пресет
  // бьющего могли измениться между ударами, свежее число точнее.
  if (same && top)
    return [{ ...top, count: top.count + 1, dmg: entry.dmg ?? top.dmg }, ...rest].slice(0, LOG_LIMIT);
  return [entry, ...prev].slice(0, LOG_LIMIT);
}

/** Урон в строке лога: целые — без хвоста, дробные — до 2 знаков (67, 19, 18,55). */
function formatDmg(dmg: number | undefined): string {
  if (dmg === undefined || !Number.isFinite(dmg)) return '';
  return String(Math.round(dmg * 100) / 100);
}

export function formatLogLine(entry: CombatLogEntry): string {
  const actor = logActor(entry);
  const weapon = entry.weapon ? `, ${entry.weapon}` : '';
  const dmg = formatDmg(entry.dmg);
  const dmgTxt = dmg === '' ? '' : ` [${dmg}%]`;
  return `${actor} => ${entry.target} (${entry.zoneLabel}${weapon}) x${entry.count}${dmgTxt}`;
}

/** Боевое состояние: энергии персонажей и лог ударов (живёт отдельно от настроек). */
export interface CombatState {
  /** Энергия своего кота (персонаж «main»). */
  playerEnergy: number;
  /** Энергия манекенов по их id (d1…d5); отсутствующий ключ = полная энергия. */
  dummyEnergy: Record<string, number>;
  log: CombatLogEntry[];
}

export function defaultCombat(energyStart: number): CombatState {
  return { playerEnergy: energyStart, dummyEnergy: {}, log: [] };
}

export function loadCombat(energyStart: number): CombatState {
  try {
    const raw = localStorage.getItem(COMBAT_KEY);
    if (!raw) return defaultCombat(energyStart);
    const p = JSON.parse(raw) as Partial<CombatState> & { targetEnergy?: unknown; target2Energy?: unknown };
    const clamp = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(energyStart, Math.max(0, n)) : energyStart;
    };
    const dummyEnergy: Record<string, number> = {};
    for (const d of DEFAULT_SETTINGS.dummies) {
      // старые сохранения: энергия мишени 1 — targetEnergy, мишени 2 — target2Energy
      const legacy = d.id === 'd1' ? p.targetEnergy : d.id === 'd2' ? p.target2Energy : undefined;
      dummyEnergy[d.id] = clamp(p.dummyEnergy?.[d.id] ?? legacy);
    }
    return {
      playerEnergy: clamp(p.playerEnergy),
      dummyEnergy,
      log: Array.isArray(p.log)
        ? p.log
            .filter((l) => !!l && typeof l.target === 'string' && typeof l.zoneId === 'string')
            .slice(0, LOG_LIMIT)
            .map((l) => ({
              target: l.target,
              zoneId: l.zoneId,
              zoneLabel: typeof l.zoneLabel === 'string' ? l.zoneLabel : l.zoneId,
              count: Number(l.count) > 0 ? Math.floor(Number(l.count)) : 1,
              dmg:
                l.dmg == null || !Number.isFinite(Number(l.dmg)) ? undefined : Number(l.dmg),
              actor: typeof l.actor === 'string' && l.actor ? l.actor : 'Я',
              weapon: typeof l.weapon === 'string' ? l.weapon : '',
            }))
        : [],
    };
  } catch {
    return defaultCombat(energyStart);
  }
}
