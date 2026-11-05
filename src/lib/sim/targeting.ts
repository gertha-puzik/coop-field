/**
 * Targeting: who stands where on the field, which targets are drawn, blocked
 * cells, and which neighbor the strike of (col,row) under an angle would hit.
 * Carved verbatim from the simulator.tsx module belt (W5a stage 1,
 * behavior-preserving).
 *
 * Consumers: simulator.tsx (rAF loop and the strike key handler) passes plain
 * settings + remotes + refs data in; nothing here touches React or the network
 * — pure functions over explicit arguments only.
 *
 * MYSTIC MIRROR: pickStrikeTarget mirrors server.js aimedNeighbor
 * (server.js:1816) — change only in sync, see ARCHITECTURE §4 (the server
 * decides the same «whom to cut» rule; parity tests land in W3).
 * The remote-draw helpers (rememberRemoteCell/stepRemoteDraws) intentionally
 * stay in simulator.tsx: they consume lib/net/move-book, and lib/sim must not
 * know the wire layer (ARCHITECTURE §1).
 */

import { wrap180, wrap360, type DummyConfig, type SimSettings, type SpriteId } from './settings';

/** Ссылка на персонажа на поле: манекен (мишень) или свой кот (id «main»). */
export interface CharRef {
  id: string;
  name: string;
  col: number;
  row: number;
  sprite: SpriteId;
  /** Рост модельки, % от высоты клетки. */
  scale: number;
}

/** Другие игроки комнаты. Локальные манекены убраны с поля: на нём только коты. */
export function dummiesOf(s: SimSettings, remotes: DummyConfig[]): DummyConfig[] {
  return remotes;
}

/** Энергии чужих котов копятся только по текущим обитателям комнаты:
 *  ключи ушедших игроков не оседают в localStorage навсегда. keepIds — ключи общих
 *  предметов комнаты (энергия мишени РАБ), которые не вычищаются. */
export function pruneRemoteEnergy(
  de: Record<string, number>,
  s: SimSettings,
  remotes: DummyConfig[],
  keepIds: string[] = [],
): Record<string, number> {
  const keep = new Set([...remotes.map((d) => d.id), ...keepIds]);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(de)) if (keep.has(k)) out[k] = v;
  return out;
}

/** Рисуется ли манекен. Скрытая мишень остаётся препятствием и целью удара.
 *  Тот, кем управляем, виден всегда. Чужие коты (id «p…») не прячутся:
 *  флаг видимости локальный и по сети не уходит. */
export function dummyIsDrawn(d: DummyConfig, controlled: string): boolean {
  if (d.id === controlled || d.id.startsWith('p')) return true;
  return d.visible;
}

/** То же для цели удара (свой кот, манекен или чужой id). */
export function strikeTargetDrawn(s: SimSettings, id: string, controlled: string): boolean {
  if (id === 'main' || id === controlled || id.startsWith('p')) return true;
  const d = s.dummies.find((x) => x.id === id);
  return d ? d.visible : true;
}

/** Все персонажи, кроме самого (selfId): манекены на поле + свой кот, когда управление
 *  передано манекену (mainPos — где кот стоит) + extras — общие предметы комнаты
 *  (мишень РАБ — боевая цель). Клетки этих персонажей непроходимы,
 *  в них же летят удары. */
export function othersOf(
  s: SimSettings,
  selfId: string,
  mainPos: { col: number; row: number } | null,
  remotes: DummyConfig[],
  extras: CharRef[] = [],
): CharRef[] {
  const list: CharRef[] = dummiesOf(s, remotes)
    .filter((d) => d.id !== selfId)
    .map((d) => ({ id: d.id, name: d.name, col: d.col, row: d.row, sprite: d.sprite, scale: d.scale }));
  for (const ex of extras) list.push(ex);
  if (selfId !== 'main' && mainPos) {
    list.push({
      id: 'main',
      name: 'Я',
      col: mainPos.col,
      row: mainPos.row,
      sprite: s.character.sprite,
      scale: s.character.spriteScale,
    });
  }
  return list;
}

/** Непроходимая ли клетка: клетки остальных персонажей и общих предметов —
 *  физические препятствия. */
export function isBlockedCell(
  s: SimSettings,
  selfId: string,
  mainPos: { col: number; row: number } | null,
  c: number,
  r: number,
  remotes: DummyConfig[],
  extras: CharRef[] = [],
): boolean {
  return othersOf(s, selfId, mainPos, remotes, extras).some((t) => t.col === c && t.row === r);
}

/** Кого заденет удар из клетки (col,row) под углом angle: единственный соседний персонаж,
 *  а если соседних несколько — тот, на который точнее указывает стрела. null — рядом никого.
 *  extras — боевые общие предметы (мишень РАБ). */
export function pickStrikeTarget(
  s: SimSettings,
  col: number,
  row: number,
  angle: number,
  selfId: string,
  mainPos: { col: number; row: number } | null,
  remotes: DummyConfig[],
  extras: CharRef[] = [],
): CharRef | null {
  let best: CharRef | null = null;
  let bestDiff = Infinity;
  for (const t of othersOf(s, selfId, mainPos, remotes, extras)) {
    const dx = t.col - col;
    const dy = t.row - row;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) continue;
    const phi = wrap360((Math.atan2(dy, dx) * 180) / Math.PI);
    const diff = Math.abs(wrap180(phi - wrap360(angle)));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = t;
    }
  }
  return best;
}

/** Отклик удара по умолчанию, мс: удар применяется через 170 мс после нажатия
 *  (удар «летит»); тот же интервал действует при удержании и прожатиях клавиши
 *  удара — быстрее одного удара в 170 мс не будет ни при каком спаме.
 *  Точное значение — настройка «Отклик удара» (combat.strikeResponseMs). */
/** [MIRROR] settings.ts:490 strikeResponseMs-дефолт; server.js STRIKE_CATCH_MS —
 *  менять только синхронно (ARCHITECTURE §4). */
export const STRIKE_RESPONSE_MS = 170;

/** Отклик удара, мс: настройка «Отклик удара» (170 мс по умолчанию). */
export function strikeResponseMs(s: SimSettings): number {
  const v = Number(s.combat.strikeResponseMs);
  return Math.max(30, Number.isFinite(v) && v > 0 ? v : STRIKE_RESPONSE_MS);
}
