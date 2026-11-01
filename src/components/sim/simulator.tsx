'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CharacterPicker, type CharacterChoice } from './character-picker';
import { SettingsPanel } from './settings-panel';
import type { DirectionWindow, DummyConfig, SlowdownTier, SimSettings, SpriteId, StrikeZone, WindowKey } from '@/lib/sim/settings';
import { catToDummy, createCoopClient, nameFromUrl, roomFromUrl, type CoopChatMessage, type CoopFight } from '@/lib/net/coop';
import {
  advanceRemoteDraw,
  applyOwnMoveAck,
  enqueueRemoteCell,
  rejectOwnMove,
  seedRemoteDraw,
  type RemoteDraw,
} from '@/lib/net/move-book';
import { FightLog } from './fight-log';
import { RoomChat } from './room-chat';
import { createRemoteAim, noteRemoteAim, stepRemoteAim, type RemoteAim } from '@/lib/sim/remote-aim';
import { keyAction } from '@/lib/sim/keys';
import {
  DEFAULT_SETTINGS,
  DIRECTIONS,
  SPRITES,
  bfsPath,
  dirByDeg,
  inWindow,
  mergeSettings,
  rayBox,
  resolveZonePixel,
  slowdownFor,
  speedFor,
  stepDuration,
  tierColor,
  wrap180,
  wrap360,
} from '@/lib/sim/settings';

const STORAGE_KEY = 'catwar-battle-sim-v4';
/** Отдельное хранилище боевого состояния (энергия + лог ударов). */
const COMBAT_KEY = 'catwar-battle-sim-combat-v1';

/**
 * Доля ширины/высоты спрайта, к которой закреплена стрела.
 * Откалибровано по референсу: центр клетки (со смещением −1px) при клетке 100×150
 * и размере модельки 94%: 50 / 87.73 = 75 / 131.6 ≈ 0.5699.
 * Благодаря привязке к спрайту точка закрепления «растёт» вместе с персонажем.
 */
const ARROW_ANCHOR_F = 0.5699;

/** Цвет «потраченной» части стрелы (заполняется по мере расхода энергии). */
const SPENT_COLOR = '#e5484d';

/** Отклик удара по умолчанию, мс: удар применяется через 170 мс после нажатия
 *  (удар «летит»); тот же интервал действует при удержании и прожатиях клавиши
 *  удара — быстрее одного удара в 170 мс не будет ни при каком спаме.
 *  Точное значение — настройка «Отклик удара» (combat.strikeResponseMs). */
const STRIKE_RESPONSE_MS = 170;

/** Максимум строк в боевом логе (лог теперь последовательный, старые строки вытесняются). */
const LOG_LIMIT = 100;

/** Строка лога ударов: «Кто => Кого (зона) xN» — пишется последовательно, свежая сверху.
 *  Свой кот подписывается «Я». Для промахов имя мишени не пишется (target = ''). */
interface CombatLogEntry {
  target: string;
  zoneId: string;
  zoneLabel: string;
  count: number;
  /** Кто бил. Пустое значение в старых сохранениях — свой кот. */
  actor?: string;
  /** Оружие, если сервер его прислал. Пусто — удара лапой без когтей. */
  weapon?: string;
}

function logActor(entry: CombatLogEntry): string {
  return entry.actor || 'Я';
}

function mergeLog(prev: CombatLogEntry[], entry: CombatLogEntry): CombatLogEntry[] {
  const [top, ...rest] = prev;
  const same =
    !!top &&
    top.target === entry.target &&
    top.zoneId === entry.zoneId &&
    logActor(top) === logActor(entry) &&
    (top.weapon || '') === (entry.weapon || '');
  if (same && top) return [{ ...top, count: top.count + 1 }, ...rest].slice(0, LOG_LIMIT);
  return [entry, ...prev].slice(0, LOG_LIMIT);
}

function formatLogLine(entry: CombatLogEntry): string {
  const actor = logActor(entry);
  if (entry.zoneId === 'miss') return `${actor} => мимо x${entry.count}`;
  const weapon = entry.weapon ? `, ${entry.weapon}` : '';
  return `${actor} => ${entry.target} (${entry.zoneLabel}${weapon}) x${entry.count}`;
}

/** Боевое состояние: энергии персонажей и лог ударов (живёт отдельно от настроек). */
interface CombatState {
  /** Энергия своего кота (персонаж «main»). */
  playerEnergy: number;
  /** Энергия манекенов по их id (d1…d5); отсутствующий ключ = полная энергия. */
  dummyEnergy: Record<string, number>;
  log: CombatLogEntry[];
}

function defaultCombat(energyStart: number): CombatState {
  return { playerEnergy: energyStart, dummyEnergy: {}, log: [] };
}

function loadCombat(energyStart: number): CombatState {
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
              actor: typeof l.actor === 'string' && l.actor ? l.actor : 'Я',
              weapon: typeof l.weapon === 'string' ? l.weapon : '',
            }))
        : [],
    };
  } catch {
    return defaultCombat(energyStart);
  }
}

interface FloatLabel {
  x: number;
  y: number;
  born: number;
  text: string;
  color: string;
}

interface Step {
  dir: number;
  sd: number;
  start: number;
  dur: number;
}

interface Engine {
  angle: number;
  col: number;
  row: number;
  step: Step | null;
  path: { c: number; r: number }[];
  held: number[];
  /** Ручное вращение стрелы: -1 — против часовой (J), 1 — по часовой (L), 0 — стоит. */
  rot: -1 | 0 | 1;
  /** Якорь вращения: угол и время старта удержания J/L — угол считается по абсолютному
   *  времени, поэтому пропущенные кадры не дают ни отставания, ни дёрганья стрелы. */
  rotBase: number;
  rotBaseT: number;
  rotPeriod: number;
  rotActive: -1 | 0 | 1;
  /** Накопитель тиков регенерации энергии, мс. */
  regenAcc: number;
  /** performance.now() последнего прожатия удара (не чаще, чем раз в отклик удара). */
  lastStrike: number;
  /** Клавиша удара (I) удерживается — удары повторяются с интервалом отклика. */
  strikeHeld: boolean;
  /** performance.now() следующего автоматического удара при удержании I. */
  nextHoldStrike: number;
  labels: FloatLabel[];
  hover: { c: number; r: number } | null;
  lastSpeed: number;
  lastDir: number | null;
}

function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

/** Габариты спрайта персонажа/мишени в клетке (col,row): привязан к левому верхнему углу клетки.
 *  scalePct — рост модельки в % от высоты клетки (свой кот — s.character.spriteScale,
 *  манекен — свой DummyConfig.scale). */
function spriteBoxOf(s: SimSettings, aspect: number, col: number, row: number, scalePct: number) {
  const k = scalePct / 100;
  const h = (s.field.cellH - 10) * k;
  const w = h * aspect;
  return { x: col * s.field.cellW, y: row * s.field.cellH, w, h, k };
}

/** Точка закрепления стрелы: сидит на одной и той же доле (ARROW_ANCHOR_F) ширины/высоты модельки. */
function anchorOf(s: SimSettings, aspect: number, col: number, row: number, scalePct: number) {
  const b = spriteBoxOf(s, aspect, col, row, scalePct);
  return {
    ax: b.x + b.w * ARROW_ANCHOR_F,
    ay: b.y + b.h * ARROW_ANCHOR_F + s.arrow.anchorOffsetY,
    k: b.k,
  };
}

/** Точка закрепления по координатам спрайта в px — для перетаскиваемого манекена,
 *  который на время drag'а оторван от своей клетки. */
function anchorAtPx(s: SimSettings, aspect: number, x: number, y: number, scalePct: number) {
  const b = spriteBoxOf(s, aspect, 0, 0, scalePct);
  return {
    ax: x + b.w * ARROW_ANCHOR_F,
    ay: y + b.h * ARROW_ANCHOR_F + s.arrow.anchorOffsetY,
    k: b.k,
  };
}

/** Какая половина тела поражена при входе луча через данный край прямоугольника. */
function entrySide(hit: { edge: 'left' | 'right' | 'top' | 'bottom'; nx: number }): 'left' | 'right' {
  if (hit.edge === 'left') return 'left';
  if (hit.edge === 'right') return 'right';
  return hit.nx < 50 ? 'left' : 'right';
}

/** Ссылка на персонажа на поле: манекен (мишень) или свой кот (id «main»). */
interface CharRef {
  id: string;
  name: string;
  col: number;
  row: number;
  sprite: SpriteId;
  /** Рост модельки, % от высоты клетки. */
  scale: number;
}

/** Живые соседи с сервера: если кто-то ещё в комнате — рисуем их, иначе локальные манекены. */
let liveRemotes: DummyConfig[] = [];
/**
 * Плавный угол чужой стрелы. d.angle в liveRemotes — последний сетевой угол,
 * а на кадре рисуем display: догоняем его по короткой дуге.
 * Свою стрелу сюда не кладём.
 * Клетка чужого кота на сервере лежит в d.col/d.row (препятствие и цель удара).
 * На экране — remoteDraw: за кадр не больше одного шага, пачка update не склеивается.
 */
const remoteAim = new Map<string, RemoteAim>();
const remoteDraw = new Map<string, RemoteDraw>();

function rememberRemoteCell(id: string, col: number, row: number) {
  const vis = remoteDraw.get(id);
  if (!vis) {
    remoteDraw.set(id, seedRemoteDraw({ col, row }));
    return;
  }
  enqueueRemoteCell(vis, { col, row });
}

function stepRemoteDraws() {
  for (const d of liveRemotes) {
    let vis = remoteDraw.get(d.id);
    if (!vis) {
      vis = seedRemoteDraw({ col: d.col, row: d.row });
      remoteDraw.set(d.id, vis);
      continue;
    }
    advanceRemoteDraw(vis);
  }
}

/** Манекены, добавленные на поле (или другие игроки комнаты). */
function dummiesOf(s: SimSettings): DummyConfig[] {
  if (liveRemotes.length > 0) return liveRemotes;
  return s.dummies.filter((d) => d.present);
}

/** Рисуется ли манекен. Скрытая мишень остаётся препятствием и целью удара.
 *  Тот, кем управляем, виден всегда. Чужие коты (id «p…») не прячутся:
 *  флаг видимости локальный и по сети не уходит. */
function dummyIsDrawn(d: DummyConfig, controlled: string): boolean {
  if (d.id === controlled || d.id.startsWith('p')) return true;
  return d.visible;
}

/** То же для цели удара (свой кот, манекен или чужой id). */
function strikeTargetDrawn(s: SimSettings, id: string, controlled: string): boolean {
  if (id === 'main' || id === controlled || id.startsWith('p')) return true;
  const d = s.dummies.find((x) => x.id === id);
  return d ? d.visible : true;
}

/** Все персонажи, кроме самого (selfId): манекены на поле + свой кот, когда управление
 *  передано манекену (mainPos — где кот стоит). Клетки этих персонажей непроходимы,
 *  в них же летят удары. */
function othersOf(
  s: SimSettings,
  selfId: string,
  mainPos: { col: number; row: number } | null,
): CharRef[] {
  const list: CharRef[] = dummiesOf(s)
    .filter((d) => d.id !== selfId)
    .map((d) => ({ id: d.id, name: d.name, col: d.col, row: d.row, sprite: d.sprite, scale: d.scale }));
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

/** Непроходимая ли клетка: клетки остальных персонажей — физические препятствия. */
function isBlockedCell(
  s: SimSettings,
  selfId: string,
  mainPos: { col: number; row: number } | null,
  c: number,
  r: number,
): boolean {
  return othersOf(s, selfId, mainPos).some((t) => t.col === c && t.row === r);
}

/** Кого заденет удар из клетки (col,row) под углом angle: единственный соседний персонаж,
 *  а если соседних несколько — тот, на который точнее указывает стрела. null — рядом никого. */
function pickStrikeTarget(
  s: SimSettings,
  col: number,
  row: number,
  angle: number,
  selfId: string,
  mainPos: { col: number; row: number } | null,
): CharRef | null {
  let best: CharRef | null = null;
  let bestDiff = Infinity;
  for (const t of othersOf(s, selfId, mainPos)) {
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

/** Отклик удара, мс: настройка «Отклик удара» (170 мс по умолчанию). */
function strikeResponseMs(s: SimSettings): number {
  const v = Number(s.combat.strikeResponseMs);
  return Math.max(30, Number.isFinite(v) && v > 0 ? v : STRIKE_RESPONSE_MS);
}

export default function Simulator() {
  const [settings, setSettings] = useState<SimSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  /** Пока false — экран выбора, сокет не открыт и поле не рисуется. */
  const [entered, setEntered] = useState(false);
  const enteredRef = useRef(false);
  const pendingJoinRef = useRef<{ room: string; login: string; sprite: SpriteId } | null>(null);
  const [combat, setCombat] = useState<CombatState>(() => defaultCombat(100));
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  const combatRef = useRef(combat);
  useEffect(() => {
    combatRef.current = combat;
  }, [combat]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  /** Рамка поля: по ней канвас вписывается в оставшееся место, без внутреннего скролла. */
  const fieldFrameRef = useRef<HTMLDivElement | null>(null);
  const [fieldFit, setFieldFit] = useState<{ w: number; h: number } | null>(null);
  const spritesRef = useRef<Partial<Record<SpriteId, HTMLImageElement>>>({});
  /** Белые силуэты спрайтов: тонкая обводка своего кота. */
  const whiteSpritesRef = useRef<Partial<Record<SpriteId, HTMLCanvasElement>>>({});
  const netRef = useRef<ReturnType<typeof createCoopClient> | null>(null);
  const meIdRef = useRef<number | null>(null);
  /**
   * Своя клетка на сервере и шаги, которые уже нарисовали, но ещё не подтвердили.
   * Кот шагает сразу, не дожидаясь RTT. Отказ («клетка занята» / «край поля»)
   * возвращает его на последнюю подтверждённую клетку.
   */
  const netMovesRef = useRef<{
    server: { col: number; row: number } | null;
    pending: { col: number; row: number }[];
  }>({ server: null, pending: [] });
  /** Спрайт, который не удалось декодировать: кота всё равно рисуем заглушкой. */
  const brokenSpritesRef = useRef<Set<SpriteId>>(new Set());
  /**
   * Последний угол, уже ушедший в комнату. Пока стрела крутится или ползунок едет,
   * шлём aim примерно каждые 32 мс, если угол вообще изменился (порога в 2° нет).
   * На 60 Гц это каждый второй кадр (~33 мс, около 30/с), а не каждый третий:
   * порог 45 мс попадал только в кадр на 50 мс и давал ступеньку 3.75°.
   * Отпускание клавиши (force) уходит сразу. Пропущенный внутри окна угол
   * не теряется: его забирает короткий хвост, без setState.
   */
  const aimSyncRef = useRef<{
    deg: number | null;
    at: number;
    pending: number | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ deg: null, at: 0, pending: null, timer: null });
  const publishAimRef = useRef<(angle: number, force: boolean) => void>(() => {});
  publishAimRef.current = (angle: number, force: boolean) => {
    const net = netRef.current;
    if (!net?.ready || settingsRef.current.controlled !== 'main') return;
    const deg = Math.round(wrap360(angle) * 10) / 10;
    const sync = aimSyncRef.current;
    const now = performance.now();
    const changed = sync.deg == null || Math.abs(wrap180(deg - sync.deg)) >= 0.05;
    if (!changed) {
      sync.pending = null;
      if (sync.timer) {
        clearTimeout(sync.timer);
        sync.timer = null;
      }
      return;
    }
    const AIM_EMIT_MS = 32;
    const due = sync.at === 0 || now - sync.at >= AIM_EMIT_MS;
    if (force || due) {
      if (sync.timer) {
        clearTimeout(sync.timer);
        sync.timer = null;
      }
      sync.pending = null;
      sync.deg = deg;
      sync.at = now;
      net.emit('aim', { deg });
      return;
    }
    sync.pending = deg;
    if (sync.timer) return;
    const wait = Math.max(0, AIM_EMIT_MS - (now - sync.at));
    sync.timer = setTimeout(() => {
      sync.timer = null;
      const latest = sync.pending;
      sync.pending = null;
      const netNow = netRef.current;
      if (latest == null || !netNow?.ready || settingsRef.current.controlled !== 'main') return;
      if (sync.deg != null && Math.abs(wrap180(latest - sync.deg)) < 0.05) return;
      sync.deg = latest;
      sync.at = performance.now();
      netNow.emit('aim', { deg: latest });
    }, wait);
  };
  const [roomCode, setRoomCode] = useState('demo');
  const [playerName, setPlayerName] = useState('');
  const [netStatus, setNetStatus] = useState('подключение…');
  const [peerCount, setPeerCount] = useState(1);
  const [netReady, setNetReady] = useState(false);
  const [meId, setMeId] = useState<number | null>(null);
  const [chatLines, setChatLines] = useState<CoopChatMessage[]>([]);
  const startStepRef = useRef<((dir: number) => void) | null>(null);
  const doStrikeRef = useRef<(() => void) | null>(null);
  /** Где стоит свой кот, пока управление передано манекену (null — кот под управлением). */
  const mainSavedRef = useRef<{ col: number; row: number; angle: number } | null>(null);
  /** Перетаскивание манекена зажатой ЛКМ: кто тащится (id манекена), захват курсора
   *  и текущий px спрайта. */
  const dragRef = useRef<{
    key: string;
    grabDX: number;
    grabDY: number;
    x: number;
    y: number;
    w: number;
    h: number;
    lastX: number;
    lastY: number;
    lastT: number;
    moved: boolean;
  } | null>(null);
  /** «Желе»: амплитуда дрожи каждого манекена (0..1) — растёт от тряски мышью при
   *  перетаскивании, дальше качается и гаснет сама. */
  const jellyRef = useRef<Record<string, number>>({});
  /** После перетаскивания один клик подавляется — чтобы не строился маршрут. */
  const skipClickRef = useRef(false);
  const engineRef = useRef<Engine>({
    angle: 0,
    col: 4,
    row: 2,
    step: null,
    path: [],
    held: [],
    rot: 0,
    rotBase: 0,
    rotBaseT: 0,
    rotPeriod: 0,
    rotActive: 0,
    regenAcc: 0,
    lastStrike: 0,
    strikeHeld: false,
    nextHoldStrike: 0,
    labels: [],
    hover: null,
    lastSpeed: 100,
    lastDir: null,
  });

  /* ---------- загрузка / сохранение настроек ---------- */

  useEffect(() => {
    let s = DEFAULT_SETTINGS;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      // разовая загрузка сохранённого конфига после монтирования (SSR-безопасно)
      if (raw) s = mergeSettings(JSON.parse(raw));
    } catch {
      /* игнорируем повреждённый конфиг */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(s);
    setCombat(loadCombat(s.combat.energyStart));
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* хранилище может быть недоступно */
    }
  }, [settings, loaded]);

  /** Строка удара из комнаты пишется в тот же боевой лог. Урон цели тоже живёт здесь, не только у бьющего. */
  const applyNetFight = useCallback((fight: CoopFight) => {
    const me = meIdRef.current;
    const actor = fight.attackerId === me ? 'Я' : fight.attacker || 'Кот';
    const targetName = fight.targetId === me ? 'Я' : fight.name || 'кот';
    const zoneId = fight.zone || 'hit';
    const zoneLabel = fight.part || zoneId;
    const weapon = typeof fight.weapon === 'string' ? fight.weapon : '';
    const damage = Number(fight.damage);
    const dmg = Number.isFinite(damage) ? Math.max(0, damage) : 0;
    setCombat((prev) => {
      const es = Math.max(1, settingsRef.current.combat.energyStart);
      let playerEnergy = prev.playerEnergy;
      const de = { ...prev.dummyEnergy };
      if (fight.attackerId === me) {
        playerEnergy = Math.max(0, playerEnergy - settingsRef.current.combat.strikeCost);
      }
      if (dmg > 0 && fight.targetId != null) {
        if (fight.targetId === me) playerEnergy = Math.max(0, playerEnergy - dmg);
        else {
          const key = `p${fight.targetId}`;
          de[key] = Math.max(0, (de[key] ?? es) - dmg);
        }
      }
      const entry: CombatLogEntry = {
        target: targetName,
        zoneId,
        zoneLabel,
        count: 1,
        actor,
        weapon,
      };
      return { playerEnergy, dummyEnergy: de, log: mergeLog(prev.log, entry) };
    });
    const e = engineRef.current;
    const s = settingsRef.current;
    const zone = s.combat.zones.find((z) => z.id === zoneId);
    const victim =
      fight.targetId === me
        ? { col: e.col, row: e.row }
        : liveRemotes.find((d) => d.id === `p${fight.targetId}`);
    if (!victim) return;
    e.labels.push({
      x: victim.col * s.field.cellW + s.field.cellW / 2,
      y: victim.row * s.field.cellH + s.field.cellH / 2 - s.field.cellH * 0.35,
      born: performance.now(),
      text: dmg > 0 ? `${zoneLabel} -${dmg}%` : zoneLabel,
      color: zone?.color || '#ffd60a',
    });
  }, []);

  useEffect(() => {
    if (!loaded || !entered) return;
    const room = roomFromUrl();
    const pending = pendingJoinRef.current;
    const login = (pending?.login || nameFromUrl() || '').trim();
    if (!login) return;
    setRoomCode(room);
    setPlayerName(login);
    const share = (nextRoom: string, nextName: string) => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.set('room', nextRoom || 'demo');
        if (nextName) url.searchParams.set('name', nextName);
        else url.searchParams.delete('name');
        history.replaceState(null, '', url);
      } catch {
        /* ignore */
      }
    };
    const client = createCoopClient({
      onOpen: () => setNetStatus('соединение есть, заходим…'),
      onYou: (cat) => {
        meIdRef.current = cat.id;
        setMeId(cat.id);
        setNetReady(true);
        const e = engineRef.current;
        const col = typeof cat.x === 'number' ? Math.max(0, cat.x - 1) : e.col;
        const row = typeof cat.y === 'number' ? Math.max(0, cat.y - 1) : e.row;
        e.col = col;
        e.row = row;
        netMovesRef.current = { server: { col, row }, pending: [] };
        setNetStatus(`Вы — ${cat.login || 'кот'} (#${cat.id})`);
        if (cat.login) setPlayerName(cat.login);
      },
      onField: (field) => {
        const cats = field.cats || [];
        const others = cats.filter((c) => c.id !== meIdRef.current);
        liveRemotes = others.map(catToDummy);
        remoteAim.clear();
        remoteDraw.clear();
        for (const d of liveRemotes) remoteDraw.set(d.id, seedRemoteDraw({ col: d.col, row: d.row }));
        const seenAt = performance.now();
        for (const d of liveRemotes) remoteAim.set(d.id, createRemoteAim(d.angle, seenAt));
        setPeerCount(cats.length || 1);
        if (field.room) setRoomCode(field.room);
        if (field.width && field.height) {
          setSettings((s) => ({
            ...s,
            field: { ...s.field, cols: field.width!, rows: field.height! },
          }));
        }
        const me = cats.find((c) => c.id === meIdRef.current);
        if (me && netMovesRef.current.pending.length === 0) {
          const col = Math.max(0, me.x - 1);
          const row = Math.max(0, me.y - 1);
          engineRef.current.col = col;
          engineRef.current.row = row;
          netMovesRef.current.server = { col, row };
        }
        setNetStatus(`Вы в комнате ${field.room || room} · ${cats.length} на поле`);
      },
      onCat: (cat) => {
        if (cat.x === 0 && cat.y === 0) {
          remoteAim.delete(`p${cat.id}`);
          remoteDraw.delete(`p${cat.id}`);
          liveRemotes = liveRemotes.filter((d) => d.id !== `p${cat.id}`);
          setPeerCount(1 + liveRemotes.length);
          return;
        }
        if (cat.id === meIdRef.current) {
          if (typeof cat.x === 'number' && typeof cat.y === 'number') {
            const col = Math.max(0, cat.x - 1);
            const row = Math.max(0, cat.y - 1);
            const verdict = applyOwnMoveAck(netMovesRef.current, { col, row }, {
              col: engineRef.current.col,
              row: engineRef.current.row,
            });
            if (verdict.type === 'reject') {
              // Сервер поставил другую клетку — догоняем его и забываем неподтверждённые шаги.
              engineRef.current.col = verdict.cell.col;
              engineRef.current.row = verdict.cell.row;
              engineRef.current.path = [];
              engineRef.current.step = null;
            } else if (verdict.type === 'place') {
              engineRef.current.col = verdict.cell.col;
              engineRef.current.row = verdict.cell.row;
            }
          }
          const path = engineRef.current.path;
          if (path.length > 0 && path[0].c === engineRef.current.col && path[0].r === engineRef.current.row) {
            path.shift();
          }
          return;
        }
        const prev = liveRemotes.find((d) => d.id === `p${cat.id}`);
        const dummy = catToDummy({
          id: cat.id,
          login: cat.login || prev?.name,
          sprite: cat.sprite || prev?.sprite,
          x: typeof cat.x === 'number' ? cat.x : (prev?.col ?? 0) + 1,
          y: typeof cat.y === 'number' ? cat.y : (prev?.row ?? 0) + 1,
          deg: cat.deg ?? prev?.angle,
        });
        // Сетевой угол пишем в тот же объект, без setState. На кадре рисуем
        // не его, а сглаженный display. Клетка сервера — в col/row сразу,
        // картинка догоняет её по одной за кадр (remoteDraw).
        const seenAt = performance.now();
        remoteAim.set(dummy.id, noteRemoteAim(remoteAim.get(dummy.id), dummy.angle, seenAt, !prev));
        if (prev) {
          const moved = prev.col !== dummy.col || prev.row !== dummy.row;
          prev.col = dummy.col;
          prev.row = dummy.row;
          prev.angle = dummy.angle;
          prev.name = dummy.name;
          prev.sprite = dummy.sprite;
          if (moved) rememberRemoteCell(prev.id, dummy.col, dummy.row);
          return;
        }
        rememberRemoteCell(dummy.id, dummy.col, dummy.row);
        liveRemotes = [...liveRemotes, dummy];
        setPeerCount(1 + liveRemotes.length);
      },
      onFight: (fight) => applyNetFight(fight),
      onChat: (message) => {
        setChatLines((prev) => {
          if (prev.some((line) => line.seq === message.seq)) return prev;
          return [...prev, message].slice(-80);
        });
      },
      onChatLog: (messages) => setChatLines(messages.slice(-80)),
      onInfo: (text) => {
        setNetStatus(text);
        if (!text.includes('Клетка занята') && !text.includes('Край поля')) return;
        const cell = rejectOwnMove(netMovesRef.current);
        if (cell) {
          engineRef.current.col = cell.col;
          engineRef.current.row = cell.row;
        }
        engineRef.current.path = [];
        engineRef.current.step = null;
      },
      onNoplace: (payload) =>
        setNetStatus(payload?.reason || 'Комната полная (макс. 30). Смените ?room='),
      onClose: () => {
        setNetReady(false);
        setNetStatus('Сокет закрыт. Обновите страницу.');
      },
    });
    setChatLines([]);
    setNetReady(false);
    setMeId(null);
    netRef.current = client;
    client.connect({
      room,
      login,
      sprite: pending?.sprite || settingsRef.current.character.sprite,
    });
    share(room, login);
    return () => {
      liveRemotes = [];
      remoteAim.clear();
      remoteDraw.clear();
      netMovesRef.current = { server: null, pending: [] };
      const sync = aimSyncRef.current;
      if (sync.timer) clearTimeout(sync.timer);
      sync.timer = null;
      sync.pending = null;
      client.close();
      netRef.current = null;
    };
  }, [loaded, entered, applyNetFight]);

  /** Скин своего кота уходит в комнату сразу, без повторного входа. */
  useEffect(() => {
    if (!loaded || !netReady) return;
    netRef.current?.emit('sprite', { sprite: settings.character.sprite });
  }, [loaded, netReady, settings.character.sprite]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(COMBAT_KEY, JSON.stringify(combat));
    } catch {
      /* хранилище может быть недоступно */
    }
  }, [combat, loaded]);

  /* ---------- спрайты ---------- */

  useEffect(() => {
    let cancelled = false;
    for (const sp of SPRITES) {
      const img = new Image();
      const store = () => {
        if (cancelled || spritesRef.current[sp.id]) return;
        spritesRef.current[sp.id] = img;
        // светлый силуэт того же спрайта: тонкая обводка своего кота
        const wc = document.createElement('canvas');
        wc.width = img.naturalWidth;
        wc.height = img.naturalHeight;
        const wctx = wc.getContext('2d');
        if (wctx) {
          wctx.drawImage(img, 0, 0);
          wctx.globalCompositeOperation = 'source-in';
          wctx.fillStyle = '#f4f4f5';
          wctx.fillRect(0, 0, wc.width, wc.height);
        }
        whiteSpritesRef.current[sp.id] = wc;
      };
      // Обработчик до src: у уже лежащего в кэше PNG load бывает синхронным,
      // и назначенный после src onload его не видит — кот остаётся без картинки.
      img.onload = store;
      img.onerror = () => {
        if (!cancelled) brokenSpritesRef.current.add(sp.id);
      };
      img.src = sp.src;
      if (img.complete && img.naturalWidth > 0) store();
    }
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- геометрия ---------- */

  // При изменении размеров поля — клэмп позиции и очистка вышедших за поле маршрутов
  useEffect(() => {
    const e = engineRef.current;
    const s = settingsRef.current;
    e.col = Math.max(0, Math.min(e.col, s.field.cols - 1));
    e.row = Math.max(0, Math.min(e.row, s.field.rows - 1));
    if (mainSavedRef.current) {
      mainSavedRef.current.col = Math.max(0, Math.min(mainSavedRef.current.col, s.field.cols - 1));
      mainSavedRef.current.row = Math.max(0, Math.min(mainSavedRef.current.row, s.field.rows - 1));
    }
    e.path = e.path.filter((p) => p.c < s.field.cols && p.r < s.field.rows);
  }, [settings.field.cols, settings.field.rows, settings.field.cellW, settings.field.cellH]);

  /* ---------- игровой цикл ---------- */

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let prev = performance.now();

    const update = (now: number, dt: number) => {
      stepRemoteDraws();
      const s = settingsRef.current;
      const e = engineRef.current;
      const cx = (c: number) => c * s.field.cellW + s.field.cellW / 2;
      const cy = (r: number) => r * s.field.cellH + s.field.cellH / 2;

      const beginStep = (dirDeg: number, tc: number, tr: number) => {
        const sd = slowdownFor(dirDeg, e.angle, s);
        const dur = stepDuration(s.character.stepMs, sd);
        // мгновенное перемещение: персонаж сразу оказывается в целевой клетке,
        // длительность шага работает как кулдаун до следующего прыжка
        e.col = tc;
        e.row = tr;
        e.step = { dir: dirDeg, sd, start: now, dur };
        e.lastDir = dirDeg;
        e.lastSpeed = speedFor(sd);
        if (s.slowdown.showStepLabel) {
          e.labels.push({
            x: cx(tc),
            y: cy(tr) - s.field.cellH * 0.75,
            born: now,
            text: `${speedFor(sd)}%`,
            color: tierColor(sd),
          });
        }
      };

      // старт шага из обработчика клавиш: первое нажатие срабатывает сразу, но новый
      // шаг начинается только после завершения кулдауна предыдущего — правила замедления
      // действуют всегда, и спам кнопок не может их «пересилить»
      const requestStep = (dirDeg: number, tc: number, tr: number) => {
        if (netRef.current?.ready && s.controlled === 'main') {
          const book = netMovesRef.current;
          // Пока сервер не назвал клетку, шаг не рисуем: иначе «you» вернёт кота на спавн.
          if (!book.server) return 'wait';
          const dd = dirByDeg(dirDeg);
          const deg = Math.round(wrap360(e.angle) * 10) / 10;
          netRef.current.emit('move', { x: dd.dx, y: dd.dy, deg });
          const sync = aimSyncRef.current;
          if (sync.timer) {
            clearTimeout(sync.timer);
            sync.timer = null;
          }
          sync.pending = null;
          sync.deg = deg;
          sync.at = performance.now();
          // Клетка на экране меняется сразу. Сервер остаётся источником правды:
          // подтверждение снимет шаг с очереди, отказ вернёт на book.server.
          book.pending.push({ col: tc, row: tr });
          beginStep(dirDeg, tc, tr);
          return 'net';
        }
        beginStep(dirDeg, tc, tr);
        return 'local';
      };

      startStepRef.current = (dir: number) => {
        if (e.step) return; // предыдущий шаг ещё в кулдауне — спам не ускоряет движение
        const self = s.controlled;
        const mp = self === 'main' ? null : mainSavedRef.current;
        const d = dirByDeg(dir);
        const tc = e.col + d.dx;
        const tr = e.row + d.dy;
        // клетки остальных персонажей — физические препятствия: шагнуть в них нельзя
        if (isBlockedCell(s, self, mp, tc, tr)) return;
        if (tc >= 0 && tc < s.field.cols && tr >= 0 && tr < s.field.rows) requestStep(d.deg, tc, tr);
      };

      // ручное вращение стрелы: J — против часовой, L — по часовой.
      // Угол считается от «якоря» по абсолютному времени кадра, а не суммой приращений:
      // затянутые/пропущенные кадры (перерисовки, сборка мусора) больше не тормозят
      // и не дёргают стрелу — она всегда стоит ровно на своём угле.
      if (e.rot !== 0) {
        if (e.rotActive !== e.rot || e.rotPeriod !== s.arrow.periodSec) {
          e.rotActive = e.rot;
          e.rotPeriod = s.arrow.periodSec;
          e.rotBase = e.angle;
          e.rotBaseT = now;
        }
        if (s.arrow.battleMode) {
          e.angle = wrap360(
            e.rotBase + e.rot * ((now - e.rotBaseT) / 1000) * (360 / Math.max(0.1, s.arrow.periodSec)),
          );
          publishAimRef.current(e.angle, false);
        } else {
          e.rotActive = 0; // в мирном режиме вращение недоступно
        }
      } else if (e.rotActive !== 0) {
        e.rotActive = 0;
        publishAimRef.current(e.angle, true);
      }

      // старт шага при удержании клавиш движения / маршрут по клику: следующий шаг
      // начинается сразу после кулдауна предыдущего, то есть удержание движется
      // с интервалом stepMs (120 мс по умолчанию), растянутым замедлением
      if (!e.step) {
        const self = s.controlled;
        const mp = self === 'main' ? null : mainSavedRef.current;
        if (e.held.length > 0) {
          const d = dirByDeg(e.held[e.held.length - 1]);
          const tc = e.col + d.dx;
          const tr = e.row + d.dy;
          if (!isBlockedCell(s, self, mp, tc, tr) && tc >= 0 && tc < s.field.cols && tr >= 0 && tr < s.field.rows)
            requestStep(d.deg, tc, tr);
        } else if (e.path.length > 0) {
          const nx = e.path[0];
          const d = DIRECTIONS.find((q) => q.dx === Math.sign(nx.c - e.col) && q.dy === Math.sign(nx.r - e.row));
          if (d && nx.c === e.col + d.dx && nx.r === e.row + d.dy && !isBlockedCell(s, self, mp, nx.c, nx.r)) {
            const mode = requestStep(d.deg, nx.c, nx.r);
            if (mode === 'local' || mode === 'net') e.path.shift();
          } else {
            e.path = [];
          }
        }
      }

      // удержание клавиши удара (I): удары повторяются с интервалом отклика удара
      if (e.strikeHeld && now >= e.nextHoldStrike) {
        e.nextHoldStrike = now + strikeResponseMs(s);
        doStrikeRef.current?.();
      }

      // кулдаун шага (время прыжка с учётом замедления)
      if (e.step && now - e.step.start >= e.step.dur) e.step = null;

      // регенерация энергии: у всех, кто в боевом режиме (свой кот — когда включён
      // боережим, манекены — в нём всегда), энергия восстанавливается сама раз в интервал
      if (s.combat.regenEnabled && s.combat.regenAmount > 0) {
        const iv = Math.max(0.5, s.combat.regenIntervalSec) * 1000;
        e.regenAcc += dt;
        let ticks = 0;
        while (e.regenAcc >= iv && ticks < 12) {
          e.regenAcc -= iv;
          ticks += 1;
        }
        if (e.regenAcc > iv * 12) e.regenAcc = 0; // защита от бесконечного накопления
        if (ticks > 0) {
          const es = Math.max(1, s.combat.energyStart);
          const amt = s.combat.regenAmount * ticks;
          setCombat((prev) => {
            const pe = s.arrow.battleMode ? Math.min(es, prev.playerEnergy + amt) : prev.playerEnergy;
            const de = { ...prev.dummyEnergy };
            let changed = pe !== prev.playerEnergy;
            for (const d of s.dummies) {
              if (!d.present) continue;
              const cur = de[d.id] ?? es;
              const nv = Math.min(es, cur + amt);
              if (nv !== cur) {
                de[d.id] = nv;
                changed = true;
              }
            }
            for (const d of liveRemotes) {
              const cur = de[d.id] ?? es;
              const nv = Math.min(es, cur + amt);
              if (nv !== cur) {
                de[d.id] = nv;
                changed = true;
              }
            }
            return changed ? { ...prev, playerEnergy: pe, dummyEnergy: de } : prev;
          });
        }
      }

      e.labels = e.labels.filter((l) => now - l.born < 900);

      // Чужие стрелы догоняют последний сетевой угол каждый кадр. Свою не трогаем.
      if (liveRemotes.length > 0) {
        for (const d of liveRemotes) {
          const aim = remoteAim.get(d.id);
          if (aim) stepRemoteAim(aim, now, dt);
        }
      }

      // «желе» манекенов: дрожь гаснет со временем (у тащимого — медленнее, он «в руке»)
      const dg = dragRef.current;
      for (const jk of Object.keys(jellyRef.current)) {
        const cur = jellyRef.current[jk] ?? 0;
        if (cur <= 0.001) {
          jellyRef.current[jk] = 0;
          continue;
        }
        const tau = dg && dg.key === jk ? 420 : 200;
        jellyRef.current[jk] = cur * Math.exp(-dt / tau);
      }
    };

    // Тело стрелы: хвост (зелёная часть = остаток энергии, красная — потраченная,
    // растёт от наконечника, как на референсе) + наконечник; точка закрепления —
    // опциональна (прячется настройкой, сама стрела видна всегда).
    const drawArrowBody = (
      s: SimSettings,
      k: number,
      ax: number,
      ay: number,
      angleDeg: number,
      energyFrac = 1,
      showAnchor = true,
    ) => {
      const ctx2 = ctx;
      const a = (angleDeg * Math.PI) / 180;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const r1 = s.arrow.radius * k;
      const r2 = r1 + s.arrow.length * k;
      const tipLen = Math.min(s.arrow.tipSize * k, s.arrow.length * k * 0.5);
      const halfW = Math.max(2.5 * k, tipLen * 0.55);
      const shaftEnd = r2 - tipLen;
      const frac = Math.max(0, Math.min(1, energyFrac));

      ctx2.save();
      // хвост стрелы (полностью цветом стрелы)
      ctx2.beginPath();
      ctx2.moveTo(ax + ca * r1, ay + sa * r1);
      ctx2.lineTo(ax + ca * shaftEnd, ay + sa * shaftEnd);
      ctx2.lineCap = 'round';
      ctx2.lineWidth = s.arrow.width * k;
      ctx2.strokeStyle = s.arrow.color;
      ctx2.stroke();
      // красная полоска потраченной энергии — от границы к наконечнику
      if (frac < 1 && shaftEnd > r1) {
        const split = r1 + (shaftEnd - r1) * frac;
        ctx2.lineCap = 'butt';
        ctx2.beginPath();
        ctx2.moveTo(ax + ca * split, ay + sa * split);
        ctx2.lineTo(ax + ca * shaftEnd, ay + sa * shaftEnd);
        ctx2.strokeStyle = SPENT_COLOR;
        ctx2.stroke();
      }
      // наконечник
      ctx2.beginPath();
      ctx2.moveTo(ax + ca * r2, ay + sa * r2);
      ctx2.lineTo(ax + ca * (r2 - tipLen) - sa * halfW, ay + sa * (r2 - tipLen) + ca * halfW);
      ctx2.lineTo(ax + ca * (r2 - tipLen) + sa * halfW, ay + sa * (r2 - tipLen) - ca * halfW);
      ctx2.closePath();
      ctx2.fillStyle = s.arrow.color;
      ctx2.fill();
      // точка закрепления (масштабируется вместе с моделькой); прячется настройкой,
      // но стрела — линия с наконечником — рисуется в любом случае
      if (showAnchor) {
        ctx2.beginPath();
        ctx2.arc(ax, ay, 4 * k, 0, Math.PI * 2);
        ctx2.fillStyle = s.arrow.color;
        ctx2.fill();
        ctx2.beginPath();
        ctx2.arc(ax, ay, 1.7 * k, 0, Math.PI * 2);
        ctx2.fillStyle = 'rgba(255,255,255,0.9)';
        ctx2.fill();
      }
      ctx2.restore();
    };

    /** Стрела того, кем сейчас управляем: сидит на его спрайте с его ростом,
     *  следует за перетаскиванием и показывает остаток ЕГО энергии. */
    const drawArrow = (s: SimSettings, e: Engine) => {
      const ctx2 = ctx;
      const selfId = s.controlled;
      const cfg = selfId === 'main' ? null : (s.dummies.find((d) => d.id === selfId) ?? null);
      const spriteId: SpriteId = cfg ? cfg.sprite : s.character.sprite;
      const scalePct = cfg ? cfg.scale : s.character.spriteScale;
      const sprA = spritesRef.current[spriteId] ?? Object.values(spritesRef.current)[0] ?? null;
      const dg = dragRef.current;
      // при перетаскивании управляемого манекена стрела следует за курсором
      const px = dg && dg.key === selfId ? dg.x : e.col * s.field.cellW;
      const py = dg && dg.key === selfId ? dg.y : e.row * s.field.cellH;
      const { ax, ay, k } = anchorAtPx(s, sprA ? sprA.width / sprA.height : 2 / 3, px, py, scalePct);
      const r2 = s.arrow.radius * k + s.arrow.length * k;

      if (s.arrow.showOrbit) {
        ctx2.save();
        ctx2.setLineDash([4, 7]);
        ctx2.beginPath();
        ctx2.arc(ax, ay, r2, 0, Math.PI * 2);
        ctx2.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx2.lineWidth = 1;
        ctx2.stroke();
        ctx2.restore();
      }

      // дуга окна без замедления для последнего направления
      if (s.arrow.showWindowArc && e.lastDir !== null && s.arrow.battleMode) {
        const w: DirectionWindow | undefined =
          s.slowdown.windows[String(wrap360(e.lastDir)) as WindowKey];
        if (w) {
          const R = r2 + 8 * k;
          const a0 = (wrap360(w.start) * Math.PI) / 180;
          const a1 = (wrap360(w.end) * Math.PI) / 180;
          ctx2.save();
          ctx2.beginPath();
          ctx2.arc(ax, ay, R, a0, a1, false);
          ctx2.strokeStyle = 'rgba(78, 205, 110, 0.4)';
          ctx2.lineWidth = 5 * k;
          ctx2.stroke();
          // засечки границ окна
          for (const bb of [a0, a1]) {
            ctx2.beginPath();
            ctx2.moveTo(ax + Math.cos(bb) * (R - 7 * k), ay + Math.sin(bb) * (R - 7 * k));
            ctx2.lineTo(ax + Math.cos(bb) * (R + 7 * k), ay + Math.sin(bb) * (R + 7 * k));
            ctx2.strokeStyle = 'rgba(78, 205, 110, 0.7)';
            ctx2.lineWidth = 2 * k;
            ctx2.stroke();
          }
          ctx2.restore();
        }
      }

      // зелёная доля стрелы = остаток энергии управляемого персонажа (100% = полностью
      // зелёная); точка закрепления видна только когда включена настройка «Луч стрелы»
      const es = Math.max(1, s.combat.energyStart);
      const frac =
        (selfId === 'main' ? combatRef.current.playerEnergy : (combatRef.current.dummyEnergy[selfId] ?? es)) / es;
      drawArrowBody(s, k, ax, ay, e.angle, frac, s.arrow.showRay);
    };

    const drawHud = (s: SimSettings, e: Engine) => {
      const ctx2 = ctx;
      const W = s.field.cols * s.field.cellW;
      const pw = 186;
      const ph = 208;
      const px = W - pw - 12;
      const py = 12;
      ctx2.save();
      rr(ctx2, px, py, pw, ph, 10);
      ctx2.fillStyle = 'rgba(10,12,15,0.82)';
      ctx2.fill();
      ctx2.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx2.lineWidth = 1;
      ctx2.stroke();

      ctx2.textAlign = 'center';
      ctx2.textBaseline = 'middle';
      if (s.arrow.battleMode) {
        ctx2.font = 'bold 13px Inter, system-ui, sans-serif';
        ctx2.fillStyle = '#f4f4f5';
        ctx2.fillText(`Стрела: ${Math.round(wrap360(e.angle))}°`, px + pw / 2, py + 18);
      } else {
        ctx2.font = 'bold 13px Inter, system-ui, sans-serif';
        ctx2.fillStyle = '#a1a1aa';
        ctx2.fillText('Мирный режим', px + pw / 2, py + 18);
      }

      const ccx = px + pw / 2;
      const ccy = py + 88;
      const rad = 40;
      ctx2.beginPath();
      ctx2.arc(ccx, ccy, rad, 0, Math.PI * 2);
      ctx2.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx2.stroke();
      ctx2.beginPath();
      ctx2.arc(ccx, ccy, 2.5, 0, Math.PI * 2);
      ctx2.fillStyle = 'rgba(255,255,255,0.6)';
      ctx2.fill();

      // текущее направление стрелы
      const aa = (e.angle * Math.PI) / 180;
      ctx2.beginPath();
      ctx2.moveTo(ccx + Math.cos(aa) * 6, ccy + Math.sin(aa) * 6);
      ctx2.lineTo(ccx + Math.cos(aa) * 26, ccy + Math.sin(aa) * 26);
      ctx2.strokeStyle = s.arrow.color;
      ctx2.lineWidth = 3;
      ctx2.stroke();

      // 8 направлений с текущим замедлением
      for (const d of DIRECTIONS) {
        const sd = slowdownFor(d.deg, e.angle, s);
        const col = tierColor(sd);
        const da = (d.deg * Math.PI) / 180;
        const c1 = Math.cos(da);
        const s1 = Math.sin(da);
        ctx2.beginPath();
        ctx2.moveTo(ccx + c1 * (rad - 26), ccy + s1 * (rad - 26));
        ctx2.lineTo(ccx + c1 * (rad - 8), ccy + s1 * (rad - 8));
        ctx2.strokeStyle = col;
        ctx2.lineWidth = 3;
        ctx2.stroke();
        ctx2.font = 'bold 10px Inter, system-ui, sans-serif';
        ctx2.fillStyle = col;
        ctx2.fillText(`${sd}`, ccx + c1 * (rad + 16), ccy + s1 * (rad + 16));
      }

      ctx2.font = '9px Inter, system-ui, sans-serif';
      ctx2.fillStyle = '#71717a';
      ctx2.fillText('замедление, %', ccx, py + ph - 48);

      ctx2.font = '10.5px Inter, system-ui, sans-serif';
      ctx2.fillStyle = '#d4d4d8';
      ctx2.fillText(`Клетка: ${e.col + 1}, ${e.row + 1}`, px + pw / 2, py + ph - 34);
      ctx2.fillStyle = '#71717a';
      ctx2.fillText(
        `Вращение: ${Math.round(360 / Math.max(0.1, s.arrow.periodSec))}°/с · Шаг: ${Math.round(s.character.stepMs)}мс`,
        px + pw / 2,
        py + ph - 18,
      );
      ctx2.restore();
    };

    const draw = (now: number) => {
      const s = settingsRef.current;
      const e = engineRef.current;
      const W = s.field.cols * s.field.cellW;
      const H = s.field.rows * s.field.cellH;
      if (cv.width !== W || cv.height !== H) {
        cv.width = W;
        cv.height = H;
      }

      // фон
      ctx.fillStyle = s.field.bgColor;
      ctx.fillRect(0, 0, W, H);
      if (s.field.checker) {
        ctx.fillStyle = s.field.bgColorAlt;
        for (let r = 0; r < s.field.rows; r++) {
          for (let c = 0; c < s.field.cols; c++) {
            if ((c + r) % 2 === 0) ctx.fillRect(c * s.field.cellW, r * s.field.cellH, s.field.cellW, s.field.cellH);
          }
        }
      }
      if (s.field.showGrid) {
        ctx.strokeStyle = s.field.gridColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let c = 0; c <= s.field.cols; c++) {
          ctx.moveTo(c * s.field.cellW + 0.5, 0);
          ctx.lineTo(c * s.field.cellW + 0.5, H);
        }
        for (let r = 0; r <= s.field.rows; r++) {
          ctx.moveTo(0, r * s.field.cellH + 0.5);
          ctx.lineTo(W, r * s.field.cellH + 0.5);
        }
        ctx.stroke();
      }

      // подсветка клетки под курсором
      if (e.hover) {
        const hx = e.hover.c * s.field.cellW;
        const hy = e.hover.r * s.field.cellH;
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(hx, hy, s.field.cellW, s.field.cellH);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(hx + 1, hy + 1, s.field.cellW - 2, s.field.cellH - 2);
      }

      // маршрут по клику
      if (e.path.length > 0) {
        const cx = (c: number) => c * s.field.cellW + s.field.cellW / 2;
        const cy = (r: number) => r * s.field.cellH + s.field.cellH / 2;
        for (const p of e.path) {
          ctx.beginPath();
          ctx.arc(cx(p.c), cy(p.r), 4.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(78,205,110,0.45)';
          ctx.fill();
        }
        const lastP = e.path[e.path.length - 1];
        ctx.strokeStyle = 'rgba(78,205,110,0.8)';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 2;
        ctx.strokeRect(lastP.c * s.field.cellW + 3, lastP.r * s.field.cellH + 3, s.field.cellW - 6, s.field.cellH - 6);
        ctx.setLineDash([]);
      }

      // Персонажи на поле: манекены (мишени) и свой кот. Клетки персонажей — физические
      // препятствия и цели ударов. Перетаскиваемый манекен рисуется по курсорной позиции,
      // управляемый — по клетке движка, остальные — по настройкам; при тряске мышью
      // манекен качается «желе» вокруг своего нижнего центра
      const drag = dragRef.current;
      const posOfChar = (id: string, col: number, row: number): { x: number; y: number } => {
        if (drag && drag.key === id) return { x: drag.x, y: drag.y };
        if (id === s.controlled) return { x: e.col * s.field.cellW, y: e.row * s.field.cellH };
        const vis = id.startsWith('p') ? remoteDraw.get(id) : undefined;
        if (vis) return { x: vis.col * s.field.cellW, y: vis.row * s.field.cellH };
        return { x: col * s.field.cellW, y: row * s.field.cellH };
      };
      const dummies = dummiesOf(s).filter(
        (d) => d.col >= 0 && d.col < s.field.cols && d.row >= 0 && d.row < s.field.rows,
      );
      const drawChar = (
        sprC: HTMLImageElement,
        pos: { x: number; y: number },
        scalePct: number,
        jellyKey: string | null,
        selected = false,
        whiteC: HTMLCanvasElement | null = null,
        active = false,
      ) => {
        const th = (s.field.cellH - 10) * (scalePct / 100);
        const twd = th * (sprC.width / sprC.height);
        // тень под ногами — следует за нижним краем спрайта
        ctx.beginPath();
        ctx.ellipse(pos.x + twd / 2, pos.y + th - 4, twd * 0.34, 5.5, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        ctx.fill();
        // подсветка модели, выбранной в панели (не той, за которую играют):
        // слегка увеличенный светлый силуэт за спрайтом
        const glow = (gx: number, gy: number) => {
          if (!selected || active || !whiteC) return;
          const g = 6; // насколько подсветка шире модельки, px
          ctx.save();
          ctx.globalAlpha = 0.55;
          ctx.drawImage(whiteC, gx - g, gy - g, twd + g * 2, th + g * 2);
          ctx.restore();
        };
        // тонкая обводка того, кем управляем: светлый силуэт со сдвигом 1.5 px
        // по контуру спрайта, без растушёвки. Чужих и манекенов не обводим.
        const contour = (gx: number, gy: number) => {
          if (!active || !whiteC) return;
          const o = 1.5;
          ctx.save();
          ctx.globalAlpha = 0.9;
          const shifts: Array<[number, number]> = [
            [o, 0],
            [-o, 0],
            [0, o],
            [0, -o],
            [o, o],
            [o, -o],
            [-o, o],
            [-o, -o],
          ];
          for (const [ox, oy] of shifts) ctx.drawImage(whiteC, gx + ox, gy + oy, twd, th);
          ctx.restore();
        };
        // «желе»: сплющивание-растяжение (объём сохраняется) с лёгким поворотом
        const amp = jellyKey ? (jellyRef.current[jellyKey] ?? 0) : 0;
        if (amp > 0.01) {
          const wob = Math.sin(now * 0.045);
          ctx.save();
          ctx.translate(pos.x + twd / 2, pos.y + th);
          ctx.rotate(amp * 0.08 * Math.cos(now * 0.045));
          ctx.scale(1 + amp * 0.22 * wob, 1 - amp * 0.22 * wob);
          glow(-twd / 2, -th);
          contour(-twd / 2, -th);
          ctx.drawImage(sprC, -twd / 2, -th, twd, th);
          ctx.restore();
        } else {
          glow(pos.x, pos.y);
          contour(pos.x, pos.y);
          ctx.drawImage(sprC, pos.x, pos.y, twd, th);
        }
      };

      // манекены-мишени (каждый со своим спрайтом и ростом). Скрытая мишень не рисуется.
      for (const d of dummies) {
        if (!dummyIsDrawn(d, s.controlled)) continue;
        const sprT = brokenSpritesRef.current.has(d.sprite) ? null : (spritesRef.current[d.sprite] ?? null);
        const tp = posOfChar(d.id, d.col, d.row);
        if (sprT) {
          drawChar(
            sprT,
            tp,
            d.scale,
            d.id,
            false,
            whiteSpritesRef.current[d.sprite] ?? null,
            d.id === s.controlled,
          );
        } else if (d.id.startsWith('p')) {
          // PNG ещё не пришёл или битый — кот всё равно стоит на клетке, не пропадает.
          ctx.beginPath();
          ctx.arc(tp.x + s.field.cellW / 2, tp.y + s.field.cellH * 0.55, 18, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fill();
        } else {
          continue;
        }
        if (liveRemotes.length > 0) {
          const th = (s.field.cellH - 10) * (d.scale / 100);
          const nameX = sprT ? tp.x + (sprT.width / sprT.height) * th * 0.5 : tp.x + s.field.cellW / 2;
          ctx.font = 'bold 12px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillText(d.name, nameX + 1, tp.y - 16);
          ctx.fillStyle = '#f4f4f5';
          ctx.fillText(d.name, nameX, tp.y - 17);
        }
      }

      // свой кот: под управлением — по клетке движка, иначе стоит там, где его оставили
      const spr = spritesRef.current[s.character.sprite] ?? Object.values(spritesRef.current)[0] ?? null;
      const selfId = s.controlled;
      const mainPos = selfId === 'main' ? { col: e.col, row: e.row } : mainSavedRef.current;
      const cellX = (mainPos ? mainPos.col : e.col) * s.field.cellW;
      const cellY = (mainPos ? mainPos.row : e.row) * s.field.cellH;
      const cxp = cellX + s.field.cellW / 2;
      const cyp = cellY + s.field.cellH / 2;
      if (spr && mainPos) {
        drawChar(
          spr,
          { x: cellX, y: cellY },
          s.character.spriteScale,
          null,
          false,
          whiteSpritesRef.current[s.character.sprite] ?? null,
          selfId === 'main',
        );
      } else if (!spr) {
        ctx.beginPath();
        ctx.arc(cxp, cyp, 18, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.fill();
      }

      // параметры управляемого персонажа (спрайт/рост — для стрелы, маркера и бейджа скорости)
      const cfgSelf = selfId === 'main' ? null : (s.dummies.find((d) => d.id === selfId) ?? null);
      const scaleSelf = cfgSelf ? cfgSelf.scale : s.character.spriteScale;

      // Манекены постоянно в боевом режиме: их стрелы видны сразу, направлены по своей
      // настройке и НЕ следят за подходящим игроком; красная полоска — потраченная
      // энергия. Стрелу управляемого персонажа рисует drawArrow; настройка «Луч стрелы»
      // прячет только точку закрепления (кружок у основания) и подсветку наведения
      const es0 = Math.max(1, s.combat.energyStart);
      for (const d of dummies) {
        if (d.id === selfId) continue; // за этого манекена играем — его стрела живая
        if (!dummyIsDrawn(d, selfId)) continue;
        const sprT = brokenSpritesRef.current.has(d.sprite) ? null : (spritesRef.current[d.sprite] ?? null);
        if (!sprT && !d.id.startsWith('p')) continue;
        const tpA = posOfChar(d.id, d.col, d.row);
        const ta = anchorAtPx(s, sprT ? sprT.width / sprT.height : 2 / 3, tpA.x, tpA.y, d.scale);
        const tFrac = (combatRef.current.dummyEnergy[d.id] ?? es0) / es0;
        const shown = liveRemotes.length > 0 ? (remoteAim.get(d.id)?.display ?? d.angle) : d.angle;
        drawArrowBody(s, ta.k, ta.ax, ta.ay, shown, tFrac, s.arrow.showRay);
      }

      // стрела своего кота, пока им не управляем: стоит с тем углом, что был оставлен
      if (selfId !== 'main' && mainSavedRef.current && s.arrow.battleMode) {
        const ms = mainSavedRef.current;
        const sprM = spritesRef.current[s.character.sprite] ?? null;
        if (sprM) {
          const ma = anchorOf(s, sprM.width / sprM.height, ms.col, ms.row, s.character.spriteScale);
          const mFrac = combatRef.current.playerEnergy / es0;
          drawArrowBody(s, ma.k, ma.ax, ma.ay, ms.angle, mFrac, s.arrow.showRay);
        }
      }

      if (s.arrow.battleMode) {
        drawArrow(s, e);
      }

      // живой маркер наведения: точка, где луч стрелы входит в тело цели,
      // подсвечена цветом зоны, которая сработает при ударе с текущим углом
      // (только для прямой стойки: с диагонали зону задаёт правило окон)
      if (s.arrow.battleMode && s.arrow.showRay) {
        const mpAim = selfId === 'main' ? null : mainSavedRef.current;
        const tm = pickStrikeTarget(s, e.col, e.row, e.angle, selfId, mpAim);
        const diagM = !!tm && Math.abs(tm.col - e.col) === 1 && Math.abs(tm.row - e.row) === 1;
        const sprTm = tm ? (spritesRef.current[tm.sprite] ?? null) : null;
        const sprSelf = spritesRef.current[cfgSelf ? cfgSelf.sprite : s.character.sprite] ?? null;
        if (tm && !diagM && sprSelf && sprTm && strikeTargetDrawn(s, tm.id, selfId)) {
          const am = anchorOf(s, sprSelf.width / sprSelf.height, e.col, e.row, scaleSelf);
          const bmp = posOfChar(tm.id, tm.col, tm.row);
          const bm = spriteBoxOf(s, sprTm.width / sprTm.height, tm.col, tm.row, tm.scale);
          bm.x = bmp.x;
          bm.y = bmp.y;
          const radm = (e.angle * Math.PI) / 180;
          const hm = rayBox(am.ax, am.ay, Math.cos(radm), Math.sin(radm), bm.x, bm.y, bm.w, bm.h);
          const zm = hm.hit ? resolveZonePixel(hm.ny, entrySide(hm), s.combat.zones) : null;
          if (zm) {
            ctx.beginPath();
            ctx.arc(hm.px, hm.py, 6.5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255,255,255,0.55)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(hm.px, hm.py, 4.5, 0, Math.PI * 2);
            ctx.strokeStyle = zm.color;
            ctx.lineWidth = 2.5;
            ctx.stroke();
          }
        }
      }

      // панельки энергии под персонажами (в боевом режиме): x/y — левый верхний угол спрайта в px
      const drawEnergyBadge = (x: number, y: number, sprImg: HTMLImageElement | null, pct: number, scalePct: number) => {
        const h = (s.field.cellH - 10) * (scalePct / 100);
        const w = h * (sprImg ? sprImg.width / sprImg.height : 2 / 3);
        const bx = x + w / 2;
        const by = y + h + 2;
        const text = `${pct}%`;
        ctx.font = 'bold 13px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(text).width + 12;
        rr(ctx, bx - tw / 2, by, tw, 18, 5);
        ctx.fillStyle = 'rgba(8,10,12,0.72)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = '#f4f4f5';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, bx, by + 9.5);
      };
      // панельки энергии: у видимого манекена всегда, у своего кота — в боережиме.
      // Скрытая мишень без панельки, чтобы клетка выглядела пустой.
      for (const d of dummies) {
        if (!dummyIsDrawn(d, selfId)) continue;
        const tpE = posOfChar(d.id, d.col, d.row);
        drawEnergyBadge(
          tpE.x,
          tpE.y,
          spritesRef.current[d.sprite] ?? null,
          Math.round(Math.min(combatRef.current.dummyEnergy[d.id] ?? es0, es0)),
          d.scale,
        );
      }
      if (s.arrow.battleMode && mainPos && spr) {
        drawEnergyBadge(
          cellX,
          cellY,
          spr,
          Math.round(Math.min(combatRef.current.playerEnergy, es0)),
          s.character.spriteScale,
        );
      }

      // бейдж скорости под тем, кем управляем (в бою сдвинут ниже панельки энергии)
      if (s.slowdown.showSpeedBadge) {
        const text = `${Math.round(e.lastSpeed)}%`;
        ctx.font = 'bold 13px Inter, system-ui, sans-serif';
        const tw = ctx.measureText(text).width + 12;
        const scx = e.col * s.field.cellW + s.field.cellW / 2;
        const scellY = e.row * s.field.cellH;
        const scyp = scellY + s.field.cellH / 2;
        const bx = scx - tw / 2;
        const by = s.arrow.battleMode ? scellY + (s.field.cellH - 10) * (scaleSelf / 100) + 22 : scyp + s.field.cellH * 0.48;
        rr(ctx, bx, by, tw, 18, 4);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();
        ctx.fillStyle = tierColor(100 - e.lastSpeed);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, scx, by + 9.5);
      }

      // всплывающие метки
      for (const l of e.labels) {
        const age = (now - l.born) / 900;
        ctx.globalAlpha = 1 - age;
        ctx.font = 'bold 16px Inter, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillText(l.text, l.x + 1, l.y - 36 * age + 1);
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, l.x, l.y - 36 * age);
        ctx.globalAlpha = 1;
      }

      if (s.hud.show) drawHud(s, e);
    };

    // Отладочный доступ к состоянию движка — только в dev-сборке (автотесты);
    // в продакшене недоступен и на игру не влияет.
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as Record<string, unknown>).__simState = () => {
        const st = engineRef.current;
        const dg = dragRef.current;
        const ms = mainSavedRef.current;
        return {
          col: st.col,
          row: st.row,
          angle: Math.round(wrap360(st.angle)),
          stepping: !!st.step,
          stepDur: st.step ? Math.round(st.step.dur) : 0,
          stepLeft: st.step ? Math.max(0, Math.round(st.step.dur - (performance.now() - st.step.start))) : 0,
          held: [...st.held],
          controlled: settingsRef.current.controlled,
          main: ms ? { col: ms.col, row: ms.row, angle: Math.round(wrap360(ms.angle)) } : null,
          drag: dg ? { key: dg.key, x: Math.round(dg.x), y: Math.round(dg.y), moved: dg.moved } : null,
          jelly: Object.fromEntries(
            Object.entries(jellyRef.current).map(([k2, v]) => [k2, Math.round((v ?? 0) * 100) / 100]),
          ),
          dummies: dummiesOf(settingsRef.current).map((d) => {
            const vis = remoteDraw.get(d.id);
            return {
              id: d.id,
              col: d.col,
              row: d.row,
              drawCol: vis?.col ?? d.col,
              drawRow: vis?.row ?? d.row,
              queued: vis?.queue.length ?? 0,
            };
          }),
        };
      };
    }

    const loop = (now: number) => {
      const dt = Math.min(50, now - prev);
      prev = now;
      update(now, dt);
      draw(now);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [entered]);

  /* ---------- ручной угол стрелы ---------- */

  // Живой угол читается панелью через геттер и обновляется внутри изолированного
  // компонента LiveAngle: периодические обновления не перерисовывают остальную
  // панель и родителя, из-за чего раньше стрела двигалась рвано.
  const getEngineAngle = useCallback(() => engineRef.current.angle, []);

  const setEngineAngle = useCallback((v: number, force = false) => {
    const angle = wrap360(v);
    engineRef.current.angle = angle;
    // Пока ползунок едет — тот же ритм, что у J/L. Отпускание и ввод числа — сразу.
    publishAimRef.current(angle, force);
  }, []);

  /* ---------- клавиатура ---------- */

  useEffect(() => {
    const isForm = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      return !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    };
    const down = (ev: KeyboardEvent) => {
      if (!enteredRef.current) return;
      if (isForm(ev.target)) return;
      const action = keyAction(ev);
      const t = ev.target as HTMLElement | null;
      if (t && t.tagName === 'BUTTON' && (action?.type === 'chat' || ev.code === 'Space' || ev.key === ' ')) t.blur();
      // автоповтор ОС игнорируем: каждое физическое нажатие — ровно одно срабатывание;
      // темп движения ограничен только замедлением (спам не превышает скорость шага)
      if (ev.repeat) return;
      if (!action) return;
      if (action.type === 'rot') {
        ev.preventDefault();
        engineRef.current.rot = action.sign;
        return;
      }
      if (action.type === 'chat') {
        if (t?.tagName === 'BODY' || t?.tagName === 'CANVAS') {
          ev.preventDefault();
          document.getElementById('roomChatInput')?.focus();
        }
        return;
      }
      if (action.type === 'battle') {
        setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: !p.arrow.battleMode } }));
        return;
      }
      if (action.type === 'strike') {
        ev.preventDefault();
        const e = engineRef.current;
        e.strikeHeld = true;
        e.nextHoldStrike = performance.now() + strikeResponseMs(settingsRef.current);
        doStrikeRef.current?.();
        return;
      }
      ev.preventDefault();
      const e = engineRef.current;
      if (!e.held.includes(action.dir)) {
        e.held.push(action.dir);
        e.path = [];
      }
      // одиночное нажатие: шаг сразу, если предыдущий завершён, — быстрее,
      // чем разрешает замедление, двигаться нельзя
      startStepRef.current?.(action.dir);
    };
    const up = (ev: KeyboardEvent) => {
      const e = engineRef.current;
      const action = keyAction(ev);
      if (!action) return;
      if (action.type === 'rot') {
        if (action.sign === -1 && e.rot === -1) e.rot = 0;
        if (action.sign === 1 && e.rot === 1) e.rot = 0;
      } else if (action.type === 'strike') {
        e.strikeHeld = false;
      } else if (action.type === 'move') {
        e.held = e.held.filter((d) => d !== action.dir);
      }
    };
    const blur = () => {
      engineRef.current.held = [];
      engineRef.current.rot = 0;
      engineRef.current.strikeHeld = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  /* ---------- мышь ---------- */

  const canvasPoint = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    const mx = ((ev.clientX - rect.left) * cv.width) / rect.width;
    const my = ((ev.clientY - rect.top) * cv.height) / rect.height;
    return { mx, my };
  };

  /** Манекен, чей спрайт накрыт точкой (mx,my) канваса (с небольшим запасом в 4px).
   *  Управляемый манекен проверяется по его фактической клетке (движок), остальные — по настройкам. */
  const hitTargetAt = (s: SimSettings, mx: number, my: number): DummyConfig | null => {
    const e = engineRef.current;
    for (const d of dummiesOf(s)) {
      if (!dummyIsDrawn(d, s.controlled)) continue;
      const sprT = spritesRef.current[d.sprite] ?? null;
      const pos =
        d.id === s.controlled
          ? { x: e.col * s.field.cellW, y: e.row * s.field.cellH }
          : { x: d.col * s.field.cellW, y: d.row * s.field.cellH };
      const b = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, 0, 0, d.scale);
      if (mx >= pos.x - 4 && mx <= pos.x + b.w + 4 && my >= pos.y - 4 && my <= pos.y + b.h + 4) return d;
    }
    return null;
  };

  const onMove = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const s = settingsRef.current;
    const { mx, my } = canvasPoint(ev);
    const e = engineRef.current;
    const dg = dragRef.current;
    if (dg) {
      // перетаскивание: спрайт следует за курсором в пределах поля,
      // скорость мыши раскачивает «желе» — быстрое дрожание качает манекен
      const nowT = performance.now();
      const dtm = Math.max(1, nowT - dg.lastT);
      const speed = Math.hypot(mx - dg.lastX, my - dg.lastY) / dtm; // px/мс
      jellyRef.current[dg.key] = Math.max(jellyRef.current[dg.key] ?? 0, Math.min(1, speed / 2.2));
      dg.x = Math.min(Math.max(mx - dg.grabDX, 0), s.field.cols * s.field.cellW - dg.w);
      dg.y = Math.min(Math.max(my - dg.grabDY, 0), s.field.rows * s.field.cellH - dg.h);
      if (Math.abs(mx - dg.lastX) > 2 || Math.abs(my - dg.lastY) > 2) dg.moved = true;
      dg.lastX = mx;
      dg.lastY = my;
      dg.lastT = nowT;
      return;
    }
    const c = Math.floor(mx / s.field.cellW);
    const r = Math.floor(my / s.field.cellH);
    if (c >= 0 && c < s.field.cols && r >= 0 && r < s.field.rows) e.hover = { c, r };
    else e.hover = null;
    // курсор-рука над манекеном — намёк, что его можно перетащить;
    // над активной (управляемой) моделью обычный курсор — её тащить нельзя
    const cv = canvasRef.current;
    const hov = hitTargetAt(s, mx, my);
    if (cv) cv.style.cursor = hov && hov.id !== s.controlled ? 'grab' : '';
  };

  const onLeave = () => {
    engineRef.current.hover = null;
    const cv = canvasRef.current;
    if (cv && !dragRef.current) cv.style.cursor = '';
  };

  /** Захват манекена: зажатая ЛКМ на его спрайте начинает перетаскивание. */
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (ev.button !== 0) return;
    const s = settingsRef.current;
    const { mx, my } = canvasPoint(ev);
    const t = hitTargetAt(s, mx, my);
    if (!t) return;
    if (liveRemotes.length > 0) return; // чужих игроков не таскаем
    if (t.id === s.controlled) return; // активную (управляемую) модель перетаскивать нельзя
    const sprT = spritesRef.current[t.sprite] ?? null;
    const pos = { x: t.col * s.field.cellW, y: t.row * s.field.cellH };
    const b = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, 0, 0, t.scale);
    dragRef.current = {
      key: t.id,
      grabDX: mx - pos.x,
      grabDY: my - pos.y,
      x: pos.x,
      y: pos.y,
      w: b.w,
      h: b.h,
      lastX: mx,
      lastY: my,
      lastT: performance.now(),
      moved: false,
    };
    // захват указателя: move/up продолжают приходить даже за пределами канваса
    ev.currentTarget.setPointerCapture(ev.pointerId);
    ev.currentTarget.style.cursor = 'grabbing';
    ev.preventDefault();
  };

  /** Завершение перетаскивания: манекен ставится в клетку под его центром; если она
   *  занята другим персонажем — берётся ближайшая свободная. */
  const dropTarget = () => {
    const dg = dragRef.current;
    if (!dg) return;
    dragRef.current = null;
    skipClickRef.current = dg.moved;
    const cv = canvasRef.current;
    if (cv) cv.style.cursor = '';
    const s = settingsRef.current;
    let c = Math.floor((dg.x + dg.w / 2) / s.field.cellW);
    let r = Math.floor((dg.y + dg.h / 2) / s.field.cellH);
    c = Math.min(Math.max(c, 0), s.field.cols - 1);
    r = Math.min(Math.max(r, 0), s.field.rows - 1);
    const e = engineRef.current;
    const mp = s.controlled === 'main' ? null : mainSavedRef.current;
    // занято любым персонажем, кроме перетаскиваемого: управляемый (движок),
    // свой кот (когда стоит сам) и остальные манекены
    const occupied = (cc: number, cr: number) => {
      if (dg.key !== s.controlled && e.col === cc && e.row === cr) return true;
      if (s.controlled !== 'main' && mp && mp.col === cc && mp.row === cr) return true;
      return dummiesOf(s).some((d) => d.id !== dg.key && d.col === cc && d.row === cr);
    };
    if (occupied(c, r)) {
      search: for (let rad = 1; rad <= 4; rad++) {
        for (let drr = -rad; drr <= rad; drr++) {
          for (let dcc = -rad; dcc <= rad; dcc++) {
            if (Math.max(Math.abs(dcc), Math.abs(drr)) !== rad) continue;
            const cc = c + dcc;
            const cr = r + drr;
            if (cc < 0 || cc >= s.field.cols || cr < 0 || cr >= s.field.rows) continue;
            if (!occupied(cc, cr)) {
              c = cc;
              r = cr;
              break search;
            }
          }
        }
      }
    }
    const cur = s.dummies.find((d) => d.id === dg.key);
    if (!cur || (cur.col === c && cur.row === r)) return; // позиция не изменилась
    patchDummy(dg.key, { col: c, row: r });
  };

  const onUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* захват мог уже сняться */
    }
    dropTarget();
  };

  const onClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    // клик сразу после перетаскивания маршрут не строит
    if (skipClickRef.current) {
      skipClickRef.current = false;
      return;
    }
    const s = settingsRef.current;
    const { mx, my } = canvasPoint(ev);
    const c = Math.floor(mx / s.field.cellW);
    const r = Math.floor(my / s.field.cellH);
    if (c < 0 || c >= s.field.cols || r < 0 || r >= s.field.rows) return;
    const e = engineRef.current;
    // клетки персонажей непроходимы — маршрут через/на них не строится
    const mp = s.controlled === 'main' ? null : mainSavedRef.current;
    e.path = bfsPath(
      e.col,
      e.row,
      c,
      r,
      s.field.cols,
      s.field.rows,
      othersOf(s, s.controlled, mp).map((t) => ({ c: t.col, r: t.row })),
    );
  };

  /* ---------- удар (клавиша I) ---------- */

  /** Отложенные удары «в полёте» (закрываются при размонтировании компонента). */
  const pendingStrikesRef = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const id of pendingStrikesRef.current) window.clearTimeout(id);
      pendingStrikesRef.current = [];
    },
    [],
  );

  /** Применение результата удара: вызывается через отклик удара (170 мс по умолчанию)
   *  после нажатия, со снятым в момент нажатия снимком стойки и угла стрелы. */
  const landStrike = useCallback((snap: { angle: number; col: number; row: number }) => {
    const s = settingsRef.current;
    const e = engineRef.current;
    const now = performance.now();
    const cellCX = (cc: number) => cc * s.field.cellW + s.field.cellW / 2;
    const cellCY = (cr: number) => cr * s.field.cellH + s.field.cellH / 2;
    const selfId = s.controlled;
    const mp = selfId === 'main' ? null : mainSavedRef.current;

    /** Кого задел удар: единственный соседний персонаж, а если соседних несколько —
     *  тот, на который точнее наведена стрела. null — рядом никого. */
    const t = pickStrikeTarget(s, snap.col, snap.row, snap.angle, selfId, mp);
    /** Поражённый персонаж (для списания его энергии; null — попадания не было). */
    let struck: CharRef | null = null;
    /** Урон по цели этим ударом (null — попадания не было). */
    let hitDamage: number | null = null;
    let entry: CombatLogEntry;

    /** Всплывающая надпись «зона -урон%» над поражённым (вылетает вверх и тает). */
    const pushDamageLabel = (z: StrikeZone, tc: number, tr: number) => {
      e.labels.push({
        x: cellCX(tc),
        y: cellCY(tr) - s.field.cellH * 0.35,
        born: now,
        text: `${z.name} -${z.damage}%`,
        color: z.color,
      });
    };
    /** Красная надпись «мимо» над атакующим. */
    const pushMissLabel = () => {
      e.labels.push({
        x: cellCX(snap.col),
        y: cellCY(snap.row) - s.field.cellH * 0.35,
        born: now,
        text: 'мимо',
        color: '#ff453a',
      });
    };

    if (!t) {
      // рядом никого — удар в пустоту, «мимо», имя в лог не пишется
      entry = { target: '', zoneId: 'miss', zoneLabel: 'мимо', count: 1, actor: 'Я' };
    } else {
      const tCol = t.col;
      const tRow = t.row;
      const dx = tCol - snap.col;
      const dy = tRow - snap.row;
      const diagonal = Math.abs(dx) === 1 && Math.abs(dy) === 1;
      if (diagonal) {
        // Удар с диагонали: зона задаётся стойкой относительно цели, а стрела обязана
        // стоять в окне замедления направления на цель:
        //  слева-сверху (стрела вправо-вниз, окно 45°) и справа-сверху (влево-вниз, 135°) — Морда,
        //  слева-снизу (стрела вправо-вверх, 315°) — Лапы, справа-снизу (влево-вверх, 225°) — Хвост.
        // Вне окна направления — промах, из полос тела с диагонали ничего не берётся.
        const phi = wrap360((Math.atan2(dy, dx) * 180) / Math.PI);
        const forcedId = phi === 45 || phi === 135 ? 'muzzle' : phi === 225 ? 'tail' : 'paws';
        const win = s.slowdown.windows[String(phi) as WindowKey];
        const z = win && inWindow(snap.angle, win) ? s.combat.zones.find((zz) => zz.id === forcedId) : undefined;
        if (z) {
          hitDamage = z.damage;
          struck = t;
          entry = { target: t.name, zoneId: z.id, zoneLabel: z.name, count: 1, actor: 'Я' };
        } else {
          entry = { target: '', zoneId: 'miss', zoneLabel: 'мимо', count: 1, actor: 'Я' };
        }
      } else {
        // Прямая стойка: зона — полоса тела, в которую входит луч стрелы.
        // Луч идёт из точки закрепления стрелы под её углом; промах — луч не задел тело.
        const sprT = spritesRef.current[t.sprite] ?? null;
        const sprSelf = spritesRef.current[selfId === 'main' ? s.character.sprite : (s.dummies.find((d) => d.id === selfId)?.sprite ?? s.character.sprite)] ?? null;
        const scaleSelf = selfId === 'main' ? s.character.spriteScale : (s.dummies.find((d) => d.id === selfId)?.scale ?? s.character.spriteScale);
        const a = anchorOf(s, sprSelf ? sprSelf.width / sprSelf.height : 2 / 3, snap.col, snap.row, scaleSelf);
        const box = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, tCol, tRow, t.scale);
        const rad = (snap.angle * Math.PI) / 180;
        const hit = rayBox(a.ax, a.ay, Math.cos(rad), Math.sin(rad), box.x, box.y, box.w, box.h);
        const z = hit.hit ? resolveZonePixel(hit.ny, entrySide(hit), s.combat.zones) : null;
        if (z) {
          hitDamage = z.damage;
          struck = t;
          entry = { target: t.name, zoneId: z.id, zoneLabel: z.name, count: 1, actor: 'Я' };
        } else {
          // луч прошёл мимо тела — «мимо», имя цели не пишется
          entry = { target: '', zoneId: 'miss', zoneLabel: 'мимо', count: 1, actor: 'Я' };
        }
      }
    }

    // Попадание по живому соседу уходит на сервер. Строку лога и урон принесёт fight,
    // иначе удар останется только в состоянии бьющего.
    if (
      hitDamage !== null &&
      struck &&
      selfId === 'main' &&
      struck.id.startsWith('p') &&
      netRef.current?.ready
    ) {
      const target = Number(struck.id.slice(1));
      if (Number.isInteger(target)) {
        netRef.current.emit('strike', { target, zone: entry.zoneId, angle: snap.angle });
        return;
      }
    }

    if (hitDamage !== null && struck) {
      const z = s.combat.zones.find((zz) => zz.id === entry.zoneId);
      if (z) pushDamageLabel(z, struck.col, struck.row);
    } else {
      pushMissLabel();
    }

    // энергия и лог обновляются функционально от последнего состояния,
    // чтобы не затирать параллельные изменения (например, тик регенерации)
    setCombat((prev) => {
      const es = Math.max(1, s.combat.energyStart);
      let playerEnergy = prev.playerEnergy;
      const de = { ...prev.dummyEnergy };
      // энергия тратится только при попадании в зону удара — промах бесплатен;
      // платит тот, кем управляем (свой кот — playerEnergy, манекен — своя энергия)
      if (hitDamage !== null) {
        if (selfId === 'main') playerEnergy = Math.max(0, playerEnergy - s.combat.strikeCost);
        else de[selfId] = Math.max(0, (de[selfId] ?? es) - s.combat.strikeCost);
      }
      // урон списывается с энергии того, в кого пришёлся удар
      if (hitDamage !== null && struck) {
        if (struck.id === 'main') playerEnergy = Math.max(0, playerEnergy - hitDamage);
        else de[struck.id] = Math.max(0, (de[struck.id] ?? es) - hitDamage);
      }
      // лог пишется последовательно: каждый удар — новая строка наверх; счётчик растёт
      // только когда удар совпал с самой верхней строкой (тот же бьющий, цель и зона)
      return { playerEnergy, dummyEnergy: de, log: mergeLog(prev.log, entry) };
    });
  }, []);

  const doStrike = useCallback(() => {
    const s = settingsRef.current;
    const e = engineRef.current;
    if (!s.arrow.battleMode) return;
    // удар не проходит, пока стрела вращается (J/L) — сначала нужно остановить стрелу
    if (e.rot !== 0 || e.rotActive !== 0) return;
    const now = performance.now();
    const resp = strikeResponseMs(s);
    // удары не чаще, чем раз в отклик (170 мс по умолчанию): ни спам, ни удержание
    // клавиши удара не дают больше одного удара в этот интервал
    if (now - e.lastStrike < resp) return;
    // энергии не хватает — удар просто не начинается (без всплывающих подсказок);
    // платит тот, кем управляем
    const esNow = Math.max(1, s.combat.energyStart);
    const myEnergy =
      s.controlled === 'main'
        ? combatRef.current.playerEnergy
        : (combatRef.current.dummyEnergy[s.controlled] ?? esNow);
    if (myEnergy < s.combat.strikeCost) return;
    e.lastStrike = now;
    // удар «выпадает» с откликом resp: стойка и угол фиксируются в момент нажатия
    const snap = { angle: e.angle, col: e.col, row: e.row };
    const id = window.setTimeout(() => landStrike(snap), resp);
    pendingStrikesRef.current.push(id);
  }, [landStrike]);

  useEffect(() => {
    doStrikeRef.current = doStrike;
  }, [doStrike]);

  /* ---------- патчи настроек ---------- */

  const patchField = useCallback(
    (p: Partial<SimSettings['field']>) => setSettings((s) => ({ ...s, field: { ...s.field, ...p } })),
    [],
  );
  const patchCharacter = useCallback(
    (p: Partial<SimSettings['character']>) => setSettings((s) => ({ ...s, character: { ...s.character, ...p } })),
    [],
  );
  const patchArrow = useCallback(
    (p: Partial<SimSettings['arrow']>) => setSettings((s) => ({ ...s, arrow: { ...s.arrow, ...p } })),
    [],
  );
  const patchSlowdown = useCallback(
    (p: Partial<SimSettings['slowdown']>) => setSettings((s) => ({ ...s, slowdown: { ...s.slowdown, ...p } })),
    [],
  );
  const patchWindow = useCallback(
    (key: WindowKey, p: Partial<DirectionWindow>) =>
      setSettings((s) => ({
        ...s,
        slowdown: { ...s.slowdown, windows: { ...s.slowdown.windows, [key]: { ...s.slowdown.windows[key], ...p } } },
      })),
    [],
  );
  const patchTier = useCallback(
    (i: number, p: Partial<SlowdownTier>) =>
      setSettings((s) => {
        const tiers = s.slowdown.tiers.map((t, idx) => (idx === i ? { ...t, ...p } : { ...t }));
        return { ...s, slowdown: { ...s.slowdown, tiers } };
      }),
    [],
  );
  const patchHud = useCallback(
    (p: Partial<SimSettings['hud']>) => setSettings((s) => ({ ...s, hud: { ...s.hud, ...p } })),
    [],
  );
  const patchCombat = useCallback(
    (p: Partial<SimSettings['combat']>) => setSettings((s) => ({ ...s, combat: { ...s.combat, ...p } })),
    [],
  );
  const patchZone = useCallback(
    (i: number, p: Partial<StrikeZone>) =>
      setSettings((s) => {
        const zones = s.combat.zones.map((z, idx) => (idx === i ? { ...z, ...p } : { ...z }));
        return { ...s, combat: { ...s.combat, zones } };
      }),
    [],
  );
  /** Правка одного манекена; если им сейчас управляем — клетка/угол применяются и к движку. */
  const patchDummy = useCallback((id: string, p: Partial<DummyConfig>) => {
    const cur = settingsRef.current.controlled;
    if (cur === id) {
      if (p.angle !== undefined) engineRef.current.angle = wrap360(p.angle);
      if (p.col !== undefined) engineRef.current.col = p.col;
      if (p.row !== undefined) engineRef.current.row = p.row;
    }
    setSettings((s) => ({ ...s, dummies: s.dummies.map((d) => (d.id === id ? { ...d, ...p } : d)) }));
  }, []);

  const onResetAll = useCallback(() => {
    setSettings(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
    setCombat(defaultCombat(DEFAULT_SETTINGS.combat.energyStart));
    mainSavedRef.current = null;
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(COMBAT_KEY);
    } catch {
      /* ничего */
    }
  }, []);

  /** Сброс боевого состояния: энергии на старт, лог очищен (настройки не трогаем). */
  const onResetCombat = useCallback(() => {
    const es = settingsRef.current.combat.energyStart;
    const fresh = defaultCombat(es);
    setCombat(fresh);
    try {
      localStorage.setItem(COMBAT_KEY, JSON.stringify(fresh));
    } catch {
      /* ничего */
    }
  }, []);

  const onExport = useCallback(() => JSON.stringify(settingsRef.current, null, 2), []);

  const onImport = useCallback((json: string): string | null => {
    try {
      const parsed = mergeSettings(JSON.parse(json));
      setSettings(parsed);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'не удалось разобрать JSON';
    }
  }, []);

  const goCenter = useCallback(() => {
    if (netRef.current?.ready) return;
    const s = settingsRef.current;
    const e = engineRef.current;
    e.step = null;
    e.path = [];
    e.col = Math.floor(s.field.cols / 2);
    e.row = Math.floor(s.field.rows / 2);
  }, []);

  const sendChat = useCallback((text: string) => {
    const net = netRef.current;
    if (!net?.ready) return false;
    net.emit('chat', { text });
    return true;
  }, []);

  /** Подтверждение экрана выбора: только после этого открываем сокет и поле. */
  const enterField = useCallback((choice: CharacterChoice) => {
    const login = choice.name.trim().slice(0, 24);
    if (!login) return;
    const sprite = SPRITES.some((sp) => sp.id === choice.sprite) ? choice.sprite : settingsRef.current.character.sprite;
    const scale = Math.min(100, Math.max(60, Math.round(choice.scale)));
    const room = roomFromUrl();
    pendingJoinRef.current = { room, login, sprite };
    enteredRef.current = true;
    setSettings((s) => ({
      ...s,
      controlled: 'main',
      character: { ...s.character, sprite, spriteScale: scale },
    }));
    setPlayerName(login);
    setRoomCode(room);
    setEntered(true);
  }, []);

  const fieldW = settings.field.cols * settings.field.cellW;
  const fieldH = settings.field.rows * settings.field.cellH;

  // Канвас рисуется в пикселях клеток (10×100 на 6×150). На широком экране
  // CSS-размер вписывается в рамку целиком — и по ширине, и по высоте.
  // На узком высота следует за шириной, а страница прокручивается вместе с полем.
  useLayoutEffect(() => {
    const frame = fieldFrameRef.current;
    if (!frame) return;
    const mq = window.matchMedia('(min-width: 64rem)');
    const fit = () => {
      const cs = getComputedStyle(frame);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const availW = Math.max(0, frame.clientWidth - padX);
      const availH = Math.max(0, frame.clientHeight - padY);
      let w = Math.min(availW, fieldW);
      let h = fieldH * (w / Math.max(1, fieldW));
      if (mq.matches && availH > 0 && h > availH) {
        h = Math.min(availH, fieldH);
        w = fieldW * (h / Math.max(1, fieldH));
      }
      const nextW = Math.max(1, Math.floor(w));
      const nextH = Math.max(1, Math.floor(h));
      setFieldFit((prev) =>
        prev && Math.abs(prev.w - nextW) <= 1 && Math.abs(prev.h - nextH) <= 1 ? prev : { w: nextW, h: nextH },
      );
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(frame);
    mq.addEventListener('change', fit);
    return () => {
      ro.disconnect();
      mq.removeEventListener('change', fit);
    };
  }, [fieldW, fieldH, entered]);

  if (!entered) {
    return (
      <div className="h-dvh bg-[#14161a] text-zinc-100">
        {loaded ? (
          <CharacterPicker
            initialSprite={settings.character.sprite}
            initialName={nameFromUrl().slice(0, 24)}
            initialScale={settings.character.spriteScale}
            onConfirm={enterField}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[#14161a] text-zinc-100">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-zinc-800 bg-[#191c21] px-4 py-2.5">
        <div>
          <h1 className="text-base font-bold leading-tight">Общее поле</h1>
          <p className="text-[11px] text-zinc-500">
            {settings.field.cols}×{settings.field.rows} · комната {roomCode} · {peerCount} на поле
          </p>
        </div>
        <form
          className="flex flex-wrap items-center gap-2 text-[11px]"
          onSubmit={(ev) => {
            ev.preventDefault();
            const url = new URL(window.location.href);
            url.searchParams.set('room', roomCode || 'demo');
            if (playerName) url.searchParams.set('name', playerName);
            else url.searchParams.delete('name');
            window.location.assign(url.pathname + url.search);
          }}
        >
          <label className="flex items-center gap-1 text-zinc-400">
            комната
            <input
              className="h-7 w-24 rounded border border-zinc-700 bg-zinc-900 px-1.5 text-zinc-100"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value)}
            />
          </label>
          <label className="flex items-center gap-1 text-zinc-400">
            имя
            <input
              className="h-7 w-28 rounded border border-zinc-700 bg-zinc-900 px-1.5 text-zinc-100"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
            />
          </label>
          <Button size="sm" variant="outline" className="h-7 text-[11px]" type="submit">
            Войти
          </Button>
          <span className="max-w-[280px] truncate text-zinc-400">{netStatus}</span>
        </form>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {settings.controlled !== 'main' ? (
            <span className="rounded-md border border-amber-700/60 bg-amber-950/40 px-2 py-1 text-[11px] font-medium text-amber-200">
              Вы играете: {settings.dummies.find((d) => d.id === settings.controlled)?.name ?? settings.controlled}
            </span>
          ) : null}
          <Button
            size="sm"
            variant={settings.arrow.battleMode ? 'default' : 'outline'}
            className={
              settings.arrow.battleMode
                ? 'h-8 bg-emerald-600 text-xs text-white hover:bg-emerald-500'
                : 'h-8 text-xs'
            }
            onClick={() => patchArrow({ battleMode: !settings.arrow.battleMode })}
          >
            Боевой режим: {settings.arrow.battleMode ? 'ВКЛ' : 'ВЫКЛ'} (B)
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={goCenter}>
            В центр
          </Button>
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:flex-row lg:overflow-hidden lg:p-4">
        <section className="flex w-full min-w-0 shrink-0 flex-col gap-2 lg:h-full lg:min-h-0 lg:w-auto lg:flex-1 lg:shrink">
          <div className="flex shrink-0 flex-col gap-2 md:flex-row md:items-stretch">
            <div className="min-w-0 md:flex-1">
              <RoomChat lines={chatLines} meId={meId} canSend={netReady} onSend={sendChat} />
            </div>
            {settings.arrow.battleMode && settings.combat.showLog ? (
              <div className="flex min-h-0 min-w-0 flex-col overflow-hidden md:w-80 md:shrink-0">
                <FightLog lines={combat.log.map(formatLogLine)} />
              </div>
            ) : null}
          </div>
          <div className="relative w-full min-w-0 shrink-0 lg:min-h-0 lg:flex-1">
            <div
              ref={fieldFrameRef}
              role="region"
              aria-label="Игровое поле"
              className="overflow-hidden rounded-xl border border-zinc-800 bg-[#20242a] p-3 lg:absolute lg:inset-0"
            >
              <canvas
                ref={canvasRef}
                className="mx-auto block max-w-full cursor-crosshair rounded-lg"
                style={
                  fieldFit
                    ? { width: fieldFit.w, height: fieldFit.h }
                    : { width: '100%', maxWidth: fieldW, aspectRatio: `${fieldW} / ${fieldH}` }
                }
                onPointerMove={onMove}
                onPointerDown={onPointerDown}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={onLeave}
                onClick={onClick}
              />
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-zinc-500">
            <span>W A S D — шаг (те же клавиши на русской: ц ф ы в; зажатие — раз в 120 мс с учётом замедления; спам быстрее не сделает)</span>
            <span>Q E Z X — диагонали</span>
            <span>ЛКМ — маршрут · манекен — тянуть</span>
            <span>B — бой</span>
            <span>Enter — чат</span>
            <span>I — удар</span>
            <span>J — стрела против часовой</span>
            <span>L — по часовой</span>
            <span className="ml-auto">
              Скорость = 100% − замедление · замедление фиксируется в момент прыжка
            </span>
          </div>
        </section>

        <aside className="w-full shrink-0 lg:min-h-0 lg:w-[400px] lg:overflow-y-auto lg:pr-1">
          <SettingsPanel
            settings={settings}
            patchField={patchField}
            patchCharacter={patchCharacter}
            patchArrow={patchArrow}
            patchSlowdown={patchSlowdown}
            patchWindow={patchWindow}
            patchTier={patchTier}
            patchHud={patchHud}
            patchCombat={patchCombat}
            patchZone={patchZone}
            onResetCombat={onResetCombat}
            onResetAll={onResetAll}
            onExport={onExport}
            onImport={onImport}
            getAngle={getEngineAngle}
            onManualAngle={setEngineAngle}
          />
        </aside>
      </main>
    </div>
  );
}
