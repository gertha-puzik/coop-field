'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Button } from '@/components/ui/button';
import { EntryScreen } from './entry-screen';
import { RoomPicker, type RoomRow } from './room-picker';
import { SettingsPanel } from './settings-panel';
import type { DirectionWindow, DummyConfig, SlowdownTier, SimSettings, SpriteId, StrikeZone, WindowKey } from '@/lib/sim/settings';
import { ROOMS, catToDummy, createCoopClient, nameFromUrl, roomFromUrl, roomTitle, type CoopChatMessage, type CoopDummyPos, type CoopFight, type CoopRoomInfo } from '@/lib/net/coop';
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
import { ThemeBackdrop } from './theme-backdrop';
import { applyTheme, FIELD_PRESETS, fieldPaletteOf, loadTheme, THEMES, type ThemeId } from '@/lib/sim/theme';
import { createRemoteAim, noteRemoteAim, stepRemoteAim, type RemoteAim } from '@/lib/sim/remote-aim';
import { keyAction } from '@/lib/sim/keys';
import {
  currentTestMap,
  drawTestDecorItem,
  drawTestObject,
  hashStr,
  nearestPeaceAnchor,
  nearestWalkableCell,
  peaceAnchorPoints,
  peaceDepthScale,
  peaceRoute,
  peaceStepNeighbor,
  pointInPolygon,
  setTestMap,
  testClippedCells,
  testFieldGeometry,
  testNonWalkableCells,
  testObjectAt,
  testObjects,
  testWalkableCell,
} from '@/lib/sim/test-field';
import {
  newObjectId,
  newZoneId,
  sanitizeTestMap,
  TEST_MAP_DEFAULT,
  TEST_MAP_LIMITS,
  testMapConnectivityError,
  type TestMap,
  type TestMapObject,
  type TestMapZone,
  type TestMapZoneKind,
} from '@/lib/sim/test-map';
import {
  DEFAULT_SETTINGS,
  DIRECTIONS,
  DUMMY_DEFAULT_SPRITE,
  DUMMY_NAME,
  FIELD_SPRITES,
  RAB_SPRITE,
  SPRITES,
  bfsPath,
  damageLevelLabel,
  dirByDeg,
  GAME_CREDITS,
  inWindow,
  mergeSettings,
  rayBox,
  resolveZonePixel,
  slowdownFor,
  speedFor,
  stepDuration,
  throatDamageFor,
  tierColor,
  wrap180,
  wrap360,
} from '@/lib/sim/settings';

const STORAGE_KEY = 'catwar-battle-sim-v4';

/** «4,8 сек» — подпись скорости стрелы для панели СП в шапке. */
const fmtSec = (v: number) => `${v.toFixed(1).replace('.', ',')} сек`;
/** Отдельное хранилище боевого состояния (энергия + лог ударов). */
const COMBAT_KEY = 'catwar-battle-sim-combat-v1';
/** Ширины боковых колонок (чат слева, лог ударов справа) — их тянет сам игрок. */
const LAYOUT_KEY = 'catwar-battle-sim-layout-v1';
/** Пределы растяжения колонок, px: узкие неудобны, широкие съедают поле. */
const CHAT_W = { min: 210, max: 560, def: 300 };
const LOG_W = { min: 170, max: 460, def: 230 };
/** Поле может растягиваться сверх клеточного размера, чтобы занять весь кадр.
 *  Дальше 2× картинка начинает заметно мылить даже с dpr-рендером. */
const FIELD_MAX_UPSCALE = 2;
/** Пауза на новые шаги после отката предикта (чуть выше серверного кулдауна 80мс):
 *  мгновенный перешаг после отката уходил в серверный кулдаун и терялся. */
const NET_ROLLBACK_LOCK_MS = 90;
/** Темп достройки чужого шага: не быстрее одной клетки в это время.
 *  Пачка кадров после лага не превращается в спринт через всё поле. */
const REMOTE_STEP_MS = 60;
/** Дальше этого отставания чужого кота не анимируем — сразу ставим в клетку сервера. */
const REMOTE_BACKLOG_MAX = 4;
/** Темп рассылки свободной позиции в «тесте» (~12 кадров/с). */
const FREE_EMIT_MS = 80;
/** Плавность камеры: за ~420 мс камера догоняет игрока на 63% дистанции —
 *  в несколько раз плавнее прежнего (130 мс), кот больше не «дёргает» камеру. */
const CAMERA_TAU_MS = 420;
/** Длительность полушага мирного режима (полклетки по оси), мс: и клик, и клавиши
 *  идут с одной и той же скоростью — якорь к якорю. */
const PEACE_STEP_MS = 210;
/** Дальность притяжения клика к якорной точке, px (шаг решётки — 50×75 px). */
const PEACE_SNAP_PX = 46;
/** Зум камеры мирного режима «теста»: поле приближается — «по-домашнему» вид сверху,
 *  как в Don't Starve Together. В бою возвращается 1. */
const PEACE_ZOOM = 1.5;
/** Наклон земли мирного режима: вертикаль грунта сжата до этой доли, спрайты остаются
 *  вертикальными билбордами — та самая псевдо-глубина Don't Starve / Transformice Adventures. */
const PEACE_TILT = 0.8;
/** Плавность перехода зума и наклона между мирным и боевым видом, мс. */
const CAMZOOM_TAU_MS = 350;

/** Ключ localStorage: пароль редактора локации (вводится один раз). */
const EDITOR_PASS_KEY = 'catwar-editor-pass';

/** Инструмент редактора локации: зона с клетками, зелёная зона, ластик или
 *  физическое препятствие (камень/дерево ставятся кликом по клетке). */
type EditorTool = 'cells' | 'green' | 'erase' | 'stone' | 'tree';

/** Черновик локации в редакторе: рисуется на поле сразу (WYSIWYG), живёт до закрытия. */
type EditorDraft = {
  zones: TestMapZone[];
  /** Препятствия черновика (камни/деревья) — едут в конфиг вместе с зонами. */
  objects: TestMapObject[];
  cols: number;
  rows: number;
  tool: EditorTool;
  /** Тянущийся прямоугольник в клетках (не нормализован — углы в любом порядке). */
  drag: { c0: number; r0: number; c1: number; r1: number; erase: boolean } | null;
  undo: { zones: TestMapZone[]; objects: TestMapObject[]; cols: number; rows: number }[];
  /** Отмеченные зоны для объединения (инструмент «Объединить»). */
  sel: string[];
  dirty: boolean;
};

/**
 * Доля ширины/высоты спрайта, к которой закреплена стрела.
 * Откалибровано по референсу: центр клетки (со смещением −1px) при клетке 100×150
 * и размере модельки 94%: 50 / 87.73 = 75 / 131.6 ≈ 0.5699.
 * Благодаря привязке к спрайту точка закрепления «растёт» вместе с персонажем.
 */
const ARROW_ANCHOR_F = 0.5699;

/** Цвет «потраченной» части стрелы (заполняется по мере расхода энергии). */
const SPENT_COLOR = '#e5484d';

/** Насколько темнее хвоста наконечник стрелы (множитель яркости цвета). */
const ARROW_TIP_SHADE = 0.55;

/** Идентификатор манекена «ПОЧУХАТЬ» — предмета комнаты, не персонажа. */
const DUMMY_ID = 'pochuhat';
/** Рост манекена, % от высоты клетки (как у котов по умолчанию). */
const DUMMY_SCALE = 100;
/** Темп рассылки позиции манекена при перетаскивании, мс (~25 кадров/с). */
const DUMMY_EMIT_MS = 40;
/** Дефолтная клетка манекена (левый верх спрайта, клеточные доли) — совпадает с серверной. */
const DUMMY_DEFAULT = { x: 7, y: 2 };
/** Идентификатор боевой мишени «РАБ» — предмета комнаты в боевом режиме. */
const RAB_ID = 'rab';
/** Рост мишени РАБ, % от высоты клетки. */
const RAB_SCALE = 100;
/** Клетка мишени РАБ (0-based): фиксирована, совпадает с серверной RAB_CELL. */
const RAB_POS = { col: 4, row: 2 };
/** Округление клеточных долей до сотых — точность перетаскивания хватает, пакет короче. */
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Затемнение hex-цвета (#rgb / #rrggbb) множителем f — для наконечника стрелы. */
function shadeHex(hex: string, f: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const n = parseInt(h, 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r}, ${g}, ${b})`;
}

/** Отклик удара по умолчанию, мс: удар применяется через 170 мс после нажатия
 *  (удар «летит»); тот же интервал действует при удержании и прожатиях клавиши
 *  удара — быстрее одного удара в 170 мс не будет ни при каком спаме.
 *  Точное значение — настройка «Отклик удара» (combat.strikeResponseMs). */
const STRIKE_RESPONSE_MS = 170;

type Layout = { chatW: number; logW: number };

const clampLayout = (l: Layout): Layout => ({
  chatW: Math.max(CHAT_W.min, Math.min(CHAT_W.max, Math.round(l.chatW))),
  logW: Math.max(LOG_W.min, Math.min(LOG_W.max, Math.round(l.logW))),
});

const loadLayout = (): Layout => {
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

const saveLayout = (l: Layout) => {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(clampLayout(l)));
  } catch {}
};

/**
 * Вертикальный разделитель между колонками: тянется мышью, меняя ширину
 * соседней панели. Сам ничего не хранит — отдаёт дельту dx родителю.
 */
function ColResize({ onDrag, onEnd }: { onDrag: (dx: number) => void; onEnd: () => void }) {
  const last = useRef(0);
  const dragging = useRef(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Потяните, чтобы изменить ширину панели"
      title="Потяните, чтобы изменить ширину"
      onPointerDown={(ev) => {
        ev.preventDefault();
        ev.currentTarget.setPointerCapture(ev.pointerId);
        last.current = ev.clientX;
        dragging.current = true;
      }}
      onPointerMove={(ev) => {
        if (!dragging.current || !(ev.buttons & 1)) return;
        onDrag(ev.clientX - last.current);
        last.current = ev.clientX;
      }}
      onPointerUp={(ev) => {
        if (!dragging.current) return;
        dragging.current = false;
        try {
          ev.currentTarget.releasePointerCapture(ev.pointerId);
        } catch {}
        onEnd();
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onEnd();
      }}
      className="hidden w-1.5 shrink-0 cursor-col-resize touch-none rounded bg-[var(--sim-divider)] transition-colors hover:bg-[var(--sim-accent-soft)] active:bg-[var(--sim-accent-soft)] lg:block"
    />
  );
}

/** Максимум строк в боевом логе (лог теперь последовательный, старые строки вытесняются). */
const LOG_LIMIT = 100;

/** Строка лога ударов: «Кто => Кого (зона) xN [урон%]» — пишется последовательно, свежая сверху.
 *  Свой кот подписывается «Я». Для промахов имя мишени не пишется (target = ''). */
interface CombatLogEntry {
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

function logActor(entry: CombatLogEntry): string {
  return entry.actor || 'Я';
}

function mergeLog(prev: CombatLogEntry[], entry: CombatLogEntry): CombatLogEntry[] {
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

function formatLogLine(entry: CombatLogEntry): string {
  const actor = logActor(entry);
  const weapon = entry.weapon ? `, ${entry.weapon}` : '';
  const dmg = formatDmg(entry.dmg);
  const dmgTxt = dmg === '' ? '' : ` [${dmg}%]`;
  return `${actor} => ${entry.target} (${entry.zoneLabel}${weapon}) x${entry.count}${dmgTxt}`;
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
  /** Блок (удержание К): удары по игроку уходят в «Лапы», сам он не двигается,
   *  не бьёт и не крутит стрелу. Исключение — хвост: удар в хвост блок не ловит.
   *  Значок замка видит только сам игрок. */
  blocking: boolean;
  labels: FloatLabel[];
  hover: { c: number; r: number } | null;
  lastSpeed: number;
  lastDir: number | null;
  /** performance.now(), до которого новые шаги подавлены после отката предикта. */
  moveLockUntil: number;
  /** Комната «тест», мирный режим: свободная позиция в клеточных долях мира
   *  (левый верх спрайта). В бою совпадает с col/row. */
  fx: number;
  fy: number;
  /** Мирный режим: оставшиеся якоря маршрута (в свободных долях, под центр спрайта). */
  proute: { x: number; y: number }[];
  /** Мирный режим: текущий прыжок по якорю — { start, dur } как кулдаун; само
   *  перемещение мгновенное (кот уже стоит на целевой точке). null — стоит на месте. */
  phop: { start: number; dur: number } | null;
  /** Мирный режим: якорь под курсором (клеточные доли мира) — для подсветки и курсора. */
  hoverA: { x: number; y: number } | null;
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

/** Полгабарита своей модельки в клеточных долях: перевод якорной точки мира
 *  (центр и середины сторон клетки) в свободную позицию (левый верх спрайта)
 *  и обратно, чтобы центр модельки вставал точно на якорь. */
function peaceHalfBox(s: SimSettings, img: HTMLImageElement | undefined) {
  const aspect = img && img.height > 0 ? img.width / img.height : 2 / 3;
  const b = spriteBoxOf(s, aspect, 0, 0, s.character.spriteScale);
  return { dx: b.w / 2 / s.field.cellW, dy: b.h / 2 / s.field.cellH };
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

/**
 * Живые соседи с сервера и их отрисовка. Состояние живёт в refs внутри компонента
 * (liveRemotesRef, remoteAimRef, remoteDrawRef), а не в модульных переменных:
 * два экземпляра Simulator не должны делить состояние, а cleanup одного
 * не должен обнулять поле другого.
 */

function rememberRemoteCell(map: Map<string, RemoteDraw>, id: string, col: number, row: number) {
  const vis = map.get(id);
  if (!vis) {
    map.set(id, seedRemoteDraw({ col, row }));
    return;
  }
  enqueueRemoteCell(vis, { col, row });
}

function stepRemoteDraws(remotes: DummyConfig[], map: Map<string, RemoteDraw>, now: number) {
  for (const d of remotes) {
    let vis = map.get(d.id);
    if (!vis) {
      vis = seedRemoteDraw({ col: d.col, row: d.row });
      map.set(d.id, vis);
      continue;
    }
    if (vis.queue.length > REMOTE_BACKLOG_MAX) {
      // Кот отстал на несколько шагов (лаг вкладки/сети): не прогоняем его
      // спринтом через занятые клетки, а сразу ставим в последнюю клетку сервера.
      const last = vis.queue[vis.queue.length - 1];
      vis.col = last.col;
      vis.row = last.row;
      vis.queue = [];
      continue;
    }
    if (now - vis.lastStepAt >= REMOTE_STEP_MS) {
      advanceRemoteDraw(vis);
      vis.lastStepAt = now;
    }
  }
}

/** Другие игроки комнаты. Локальные манекены убраны с поля: на нём только коты. */
function dummiesOf(s: SimSettings, remotes: DummyConfig[]): DummyConfig[] {
  return remotes;
}

/** Энергии чужих котов копятся только по текущим обитателям комнаты:
 *  ключи ушедших игроков не оседают в localStorage навсегда. keepIds — ключи общих
 *  предметов комнаты (энергия мишени РАБ), которые не вычищаются. */
function pruneRemoteEnergy(
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
 *  передано манекену (mainPos — где кот стоит) + extras — общие предметы комнаты
 *  (мишень РАБ — боевая цель). Клетки этих персонажей непроходимы,
 *  в них же летят удары. */
function othersOf(
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
function isBlockedCell(
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
function pickStrikeTarget(
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

/** Отклик удара, мс: настройка «Отклик удара» (170 мс по умолчанию). */
function strikeResponseMs(s: SimSettings): number {
  const v = Number(s.combat.strikeResponseMs);
  return Math.max(30, Number.isFinite(v) && v > 0 ? v : STRIKE_RESPONSE_MS);
}

export default function Simulator() {
  const [settings, setSettings] = useState<SimSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  /** Экран: вход (кот + скрытые параметры + выбор комнаты) → поле. */
  const [stage, setStage] = useState<'entry' | 'field'>('entry');
  /** Сеть поднята с самого входа: сокет слушает состав комнат, join уходит
   *  только по выбору комнаты. Смена entry↔field сокет не пересоздаёт. */
  const [netStarted, setNetStarted] = useState(true);
  /** Клавиатура поля активна только на stage «field» (см. обработчики keydown). */
  const enteredRef = useRef(false);
  const pendingJoinRef = useRef<{ room: string; login: string; sprite: SpriteId; scale: number } | null>(null);
  /** Состав комнат для выбора (roomsinfo). null — данных ещё не было. */
  const [roomsRows, setRoomsRows] = useState<CoopRoomInfo[] | null>(null);
  /** roomsinfo не приходит дольше 5 с (старый сервер без протокола) — предупреждение в карточках. */
  const [roomsStale, setRoomsStale] = useState(false);
  /** Модалка «Перейти в другую комнату» поверх поля. */
  const [switchOpen, setSwitchOpen] = useState(false);
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
  /** Ширины чата и лога ударов; меняются перетаскиванием разделителей и запоминаются. */
  const [layout, setLayout] = useState<Layout>(() => ({ chatW: CHAT_W.def, logW: LOG_W.def }));
  const layoutRef = useRef(layout);
  useEffect(() => {
    layoutRef.current = layout;
  }, [layout]);
  useEffect(() => {
    const saved = loadLayout();
    setLayout(saved);
    layoutRef.current = saved;
  }, []);
  /** Панель настроек теперь выдвижная: не отдаёт поле постоянной колонке. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Формат поля комнаты: «test» — лужайка/переход/закуток с камерой и свободной ходьбой. */
  const [fieldFormat, setFieldFormat] = useState<'grid' | 'test'>('grid');
  const fieldFormatRef = useRef<'grid' | 'test'>('grid');
  /** Плавная камера «теста»: центр взгляда в px мира; init — встать на игрока без анимации. */
  const camRef = useRef({ x: 0, y: 0, init: false });
  /** Зум/наклон/глубина камеры «теста»: z — зум, sq — сжатие земли по вертикали,
   *  dp — сила перспективы (масштаб спрайтов по глубине: 0 — бой, 1 — мирный режим). */
  const camFxRef = useRef({ z: 1, sq: 1, dp: 0 });
  /** Редактор локации: открыт/закрыт (ref — для игрового цикла и обработчиков мыши). */
  const [editorOpen, setEditorOpen] = useState(false);
  const editorOpenRef = useRef(false);
  useEffect(() => {
    editorOpenRef.current = editorOpen;
  }, [editorOpen]);
  /** Черновик редактора и его зеркальный снапшот для панели (перерисовка по React). */
  const editorRef = useRef<EditorDraft | null>(null);
  const [editorView, setEditorView] = useState<EditorDraft | null>(null);
  /** Пароль редактора: хранится в localStorage, подставляется при открытии. */
  const [editorPass, setEditorPass] = useState('');
  /** Строка состояния редактора: ошибка проверки / «Сохраняем…» / «Сохранено». */
  const [editorMsg, setEditorMsg] = useState<string | null>(null);
  /** Последняя локация, подтверждённая сервером: к ней откатывается поле и черновик. */
  const savedMapRef = useRef<TestMap>(TEST_MAP_DEFAULT);
  /** Темп рассылки freemove и флаг «сейчас идём» (для финального стоп-пакета). */
  const freeSyncRef = useRef({ at: 0, moving: false });
  /** Чужие коты в свободной ходьбе (комната «тест»): экранная позиция и цель доведения. */
  const remoteFreeRef = useRef(new Map<string, { x: number; y: number; tx: number; ty: number }>());
  /** Тема оформления: ночь / светлая / пивная. Цвета — CSS-переменные (globals.css). */
  const [theme, setTheme] = useState<ThemeId>('night');
  useEffect(() => {
    setTheme(loadTheme());
  }, []);
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
  /** Живые соседи с сервера: если кто-то ещё в комнате — рисуем их, иначе локальные
   *  манекены. Всё в refs, не в модуле: два экземпляра Simulator не делят состояние. */
  const liveRemotesRef = useRef<DummyConfig[]>([]);
  /** Плавный угол чужой стрелы: d.angle — последний сетевой угол, на кадре рисуем display. */
  const remoteAimRef = useRef(new Map<string, RemoteAim>());
  /** Экранная дорисовка чужих клеток: за кадр не больше одного шага. */
  const remoteDrawRef = useRef(new Map<string, RemoteDraw>());
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
  // Присвоение — в эффекте, а не в теле рендера: мутация ref во время render —
  // антипаттерн React (конкурентный режим рендерит компонент повторно).
  useEffect(() => {
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
  });
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [netStatus, setNetStatus] = useState('подключение…');
  const [peerCount, setPeerCount] = useState(1);
  const [netReady, setNetReady] = useState(false);
  const [meId, setMeId] = useState<number | null>(null);
  /** Манекен «ПОЧУХАТЬ» включён в комнате (истина приходит с сервера, не из localStorage). */
  const [dummyOn, setDummyOn] = useState(false);
  /** Боевая мишень «РАБ» включена в комнате. */
  const [rabOn, setRabOn] = useState(false);
  /** Выбранный скин манекена (ушёл на сервер при включении, живёт в состоянии комнаты). */
  const [dummySprite, setDummySprite] = useState<SpriteId>(DUMMY_DEFAULT_SPRITE);
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
  /** Позиция манекена в клеточных долях (левый верх спрайта); null — выключен. */
  const dummyPosRef = useRef<CoopDummyPos | null>(null);
  /** Манекен включён — зеркало для игрового цикла: state в замыкание кадра не попадает. */
  const dummyOnRef = useRef(false);
  /** Скин манекена — зеркало для кадра. */
  const dummySpriteRef = useRef<SpriteId>(DUMMY_DEFAULT_SPRITE);
  /** Кто сейчас тащит манекен (login) — курсор с именем видят все; null — никто. */
  const dummyGrabRef = useRef<string | null>(null);
  /** performance.now() последнего сетевого сдвига манекена — для скорости «желе». */
  const dummySeenRef = useRef(0);
  /** Темп рассылки dummyMove при перетаскивании. */
  const dummySyncRef = useRef<{ at: number }>({ at: 0 });
  /** Мишень РАБ включена — зеркало для игрового цикла. */
  const rabOnRef = useRef(false);
  /** Кто из чужих котов держит блок (их числовые id): любой удар по такому — в «Лапы»,
   *  кроме удара в хвост — хвост блок не ловит. */
  const remoteBlockRef = useRef<Set<number>>(new Set());
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
    /** Блок (удержание К): двигаться, бить и крутить стрелу нельзя; виден только самому. */
    blocking: false,
    labels: [],
    hover: null,
    lastSpeed: 100,
    lastDir: null,
    /** performance.now(), до которого новые шаги подавлены: пауза после отката
     *  предикта, чтобы перешаг не уходил в серверный кулдаун и не терялся. */
    moveLockUntil: 0,
    fx: 4,
    fy: 2,
    proute: [],
    phop: null,
    hoverA: null,
  });

  /** Применить состояние манекена из комнаты: зеркала для кадра + React-состояние. */
  const applyDummy = useCallback((on: boolean, pos: CoopDummyPos | null, sprite?: SpriteId) => {
    dummyOnRef.current = on;
    dummyPosRef.current = on ? pos : null;
    setDummyOn(on);
    if (sprite) {
      dummySpriteRef.current = sprite;
      setDummySprite(sprite);
    }
  }, []);

  /** Применить состояние мишени РАБ из комнаты. */
  const applyRab = useCallback((on: boolean) => {
    rabOnRef.current = on;
    setRabOn(on);
  }, []);

  /** Клетки общих предметов комнаты (0-based): и РАБ, и ПОЧУХАТЬ непроходимы.
   *  Для ударов нужен только РАБ (манекен вне боя), поэтому раздельно. */
  const rabExtra = useCallback((): CharRef[] =>
    rabOnRef.current
      ? [{ id: RAB_ID, name: RAB_SPRITE.name, col: RAB_POS.col, row: RAB_POS.row, sprite: RAB_SPRITE.id, scale: RAB_SCALE }]
      : [],
    [],
  );
  const objectExtras = useCallback((): CharRef[] => {
    const out = rabExtra();
    if (dummyOnRef.current && dummyPosRef.current) {
      out.push({
        id: DUMMY_ID,
        name: DUMMY_NAME,
        col: Math.round(dummyPosRef.current.x),
        row: Math.round(dummyPosRef.current.y),
        sprite: dummySpriteRef.current,
        scale: DUMMY_SCALE,
      });
    }
    return out;
  }, [rabExtra]);

  /** Тумблер «Включить манекен»: локально optimistic, сервер рассылёт dummyState всей комнате. */
  const toggleDummy = useCallback(
    (on: boolean) => {
      const net = netRef.current;
      if (!net?.ready) return;
      applyDummy(on, on ? (dummyPosRef.current ?? { ...DUMMY_DEFAULT }) : null);
      net.emit('dummy', { on, sprite: dummySpriteRef.current });
    },
    [applyDummy],
  );

  /** Смена скина манекена в настройках: уходит в комнату, dummyState вернёт авторитетное состояние. */
  const changeDummySprite = useCallback((sprite: SpriteId) => {
    dummySpriteRef.current = sprite;
    setDummySprite(sprite);
    const net = netRef.current;
    if (net?.ready && dummyOnRef.current) net.emit('dummy', { on: true, sprite });
  }, []);

  /** Тумблер «Включить мишень» (РАБ): локально optimistic, сервер рассылёт rabState всей комнате. */
  const toggleRab = useCallback(
    (on: boolean) => {
      const net = netRef.current;
      if (!net?.ready) return;
      applyRab(on);
      net.emit('rab', { on });
    },
    [applyRab],
  );

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
      const de = pruneRemoteEnergy(prev.dummyEnergy, settingsRef.current, liveRemotesRef.current, rabOnRef.current ? [RAB_ID] : []);
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
        // fight.damage — урон уже после блока и брони цели: ровно то,
        // сколько энергии цель потеряла этим ударом.
        dmg,
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
        : liveRemotesRef.current.find((d) => d.id === `p${fight.targetId}`);
    if (!victim) return;
    e.labels.push({
      x: victim.col * s.field.cellW + s.field.cellW / 2,
      y: victim.row * s.field.cellH + s.field.cellH / 2 - s.field.cellH * 0.35,
      born: performance.now(),
      text: dmg > 0 ? `${zoneLabel} -${dmg}%` : zoneLabel,
      color: zone?.color || '#ffd60a',
    });
  }, []);

  /** Какие комнаты спрашивать у сервера: три грота + комната из ссылки, если она чужая. */
  const wantedRoomIds = useCallback((): string[] => {
    const ids: string[] = ROOMS.map((r) => r.id);
    const urlRoom = roomFromUrl();
    if (urlRoom && urlRoom !== 'demo' && !ids.includes(urlRoom)) ids.push(urlRoom);
    return ids;
  }, []);

  /* ---------- редактор локации «теста» ---------- */

  /** Применение конфига локации (с сервера или черновика редактора): setTestMap
   *  сбрасывает кэши — картинка и проверки ходьбы сразу считают новую локацию. */
  const applyTestMap = useCallback((map: TestMap) => {
    setTestMap(map);
    savedMapRef.current = map;
    const d = editorRef.current;
    if (d) {
      // Свой только что сохранённый конфиг возвращается рассылкой «map»:
      // черновик совпал с сохранённой локацией — метка «не сохранено» гаснет.
      const same =
        d.cols === map.cols &&
        d.rows === map.rows &&
        JSON.stringify(d.zones.map((z) => [z.name, z.kind, z.c0, z.r0, z.c1, z.r1])) ===
          JSON.stringify(map.zones.map((z) => [z.name, z.kind, z.c0, z.r0, z.c1, z.r1])) &&
        JSON.stringify(d.objects.map((o) => [o.kind, o.c, o.r])) ===
          JSON.stringify((map.objects ?? []).map((o) => [o.kind, o.c, o.r]));
      if (same) {
        d.dirty = false;
        d.zones = map.zones.map((z) => ({ ...z }));
        d.objects = (map.objects ?? []).map((o) => ({ ...o }));
        setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
        return;
      }
    }
    if (d && !d.dirty) {
      d.zones = map.zones.map((z) => ({ ...z }));
      d.objects = (map.objects ?? []).map((o) => ({ ...o }));
      d.cols = map.cols;
      d.rows = map.rows;
      setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
    }
  }, []);

  const syncEditorView = () => {
    const d = editorRef.current;
    if (!d) return;
    setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
  };

  const draftMap = (d: EditorDraft): TestMap => ({
    v: 1,
    cols: d.cols,
    rows: d.rows,
    margin: savedMapRef.current.margin,
    seed: savedMapRef.current.seed,
    zones: d.zones.map((z) => ({ ...z })),
    objects: d.objects.map((o) => ({ ...o })),
  });

  /** Черновик сразу рисуется на поле (WYSIWYG): setTestMap пересобирает кэши. */
  const applyDraftPreview = () => {
    const d = editorRef.current;
    if (d) setTestMap(draftMap(d));
  };

  const pushEditorUndo = () => {
    const d = editorRef.current;
    if (!d) return;
    d.undo.push({ zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), cols: d.cols, rows: d.rows });
    if (d.undo.length > 40) d.undo.shift();
  };

  const openEditor = () => {
    const m = savedMapRef.current;
    const draft: EditorDraft = {
      zones: m.zones.map((z) => ({ ...z })),
      objects: (m.objects ?? []).map((o) => ({ ...o })),
      cols: m.cols,
      rows: m.rows,
      tool: 'cells',
      drag: null,
      undo: [],
      sel: [],
      dirty: false,
    };
    editorRef.current = draft;
    setEditorView({ ...draft, zones: draft.zones.map((z) => ({ ...z })), objects: draft.objects.map((o) => ({ ...o })), undo: [] });
    setEditorMsg(null);
    try {
      setEditorPass(localStorage.getItem(EDITOR_PASS_KEY) || '');
    } catch {
      /* приватный режим — пароль вводится вручную */
    }
    setEditorOpen(true);
    // Режим редактирования выключает мирную ходьбу: маршруты и прыжки гасим.
    const e = engineRef.current;
    e.proute = [];
    e.phop = null;
    e.path = [];
    e.hover = null;
    e.hoverA = null;
    camRef.current.init = false;
  };

  const closeEditor = () => {
    editorRef.current = null;
    setEditorOpen(false);
    setEditorView(null);
    setEditorMsg(null);
    // Черновик без записи: поле возвращается к сохранённой сервером локации.
    setTestMap(savedMapRef.current);
    camRef.current.init = false;
  };

  const setEditorTool = (tool: EditorTool) => {
    const d = editorRef.current;
    if (!d) return;
    d.tool = tool;
    syncEditorView();
  };

  /** Смена размера мира: зоны и препятствия, вылезшие за новый край, обрезаются/удаляются. */
  const resizeEditorWorld = (cols: number, rows: number) => {
    const d = editorRef.current;
    if (!d) return;
    const nc = Math.min(TEST_MAP_LIMITS.colsMax, Math.max(TEST_MAP_LIMITS.colsMin, cols));
    const nr = Math.min(TEST_MAP_LIMITS.rowsMax, Math.max(TEST_MAP_LIMITS.rowsMin, rows));
    if (nc === d.cols && nr === d.rows) return;
    pushEditorUndo();
    d.cols = nc;
    d.rows = nr;
    const kept: TestMapZone[] = [];
    for (const z of d.zones) {
      const c1 = Math.min(z.c1, nc - 1);
      const r1 = Math.min(z.r1, nr - 1);
      if (z.c0 <= c1 && z.r0 <= r1) kept.push({ ...z, c1, r1 });
    }
    d.zones = kept;
    d.objects = d.objects.filter((o) => o.c < nc && o.r < nr);
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  /** Вычитание прямоугольника из зоны: остаток распадается максимум на 4 полосы. */
  const subtractFromZone = (
    z: TestMapZone,
    cut: { c0: number; r0: number; c1: number; r1: number },
  ): TestMapZone[] => {
    const c0 = Math.max(z.c0, cut.c0);
    const r0 = Math.max(z.r0, cut.r0);
    const c1 = Math.min(z.c1, cut.c1);
    const r1 = Math.min(z.r1, cut.r1);
    if (c0 > c1 || r0 > r1) return [z];
    const pieces: TestMapZone[] = [];
    if (z.r0 < r0) pieces.push({ ...z, id: newZoneId(), r0: z.r0, r1: r0 - 1 });
    if (z.r1 > r1) pieces.push({ ...z, id: newZoneId(), r0: r1 + 1, r1: z.r1 });
    if (z.c0 < c0) pieces.push({ ...z, id: newZoneId(), c0: z.c0, c1: c0 - 1, r0, r1 });
    if (z.c1 > c1) pieces.push({ ...z, id: newZoneId(), c0: c1 + 1, c1: z.c1, r0, r1 });
    return pieces;
  };

  /** Завершение рисунка: прямоугольник становится зоной (или стирает зоны ластиком). */
  const commitEditorDrag = () => {
    const d = editorRef.current;
    if (!d || !d.drag) return;
    const drag = d.drag;
    d.drag = null;
    const c0 = Math.min(drag.c0, drag.c1);
    const c1 = Math.max(drag.c0, drag.c1);
    const r0 = Math.min(drag.r0, drag.r1);
    const r1 = Math.max(drag.r0, drag.r1);
    if (c1 < c0 || r1 < r0) {
      syncEditorView();
      return;
    }
    pushEditorUndo();
    if (drag.erase || d.tool === 'erase') {
      d.zones = d.zones.flatMap((z) => subtractFromZone(z, { c0, r0, c1, r1 }));
      // ластик снимает и препятствия внутри стёртого прямоугольника
      d.objects = d.objects.filter((o) => !(o.c >= c0 && o.c <= c1 && o.r >= r0 && o.r <= r1));
    } else {
      const kind: TestMapZoneKind = d.tool === 'green' ? 'green' : 'cells';
      const n = d.zones.filter((z) => z.kind === kind).length + 1;
      d.zones = [
        ...d.zones,
        {
          id: newZoneId(),
          name: kind === 'cells' ? `Клетки ${n}` : `Зелёная зона ${n}`,
          kind,
          c0,
          r0,
          c1,
          r1,
        },
      ];
    }
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  const deleteEditorZone = (id: string) => {
    const d = editorRef.current;
    if (!d) return;
    pushEditorUndo();
    d.zones = d.zones.filter((z) => z.id !== id);
    d.sel = d.sel.filter((s) => s !== id);
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  /** Отметка зоны для объединения (галка в списке зон). */
  const toggleEditorSel = (id: string) => {
    const d = editorRef.current;
    if (!d) return;
    d.sel = d.sel.includes(id) ? d.sel.filter((s) => s !== id) : [...d.sel, id];
    syncEditorView();
  };

  /** Объединение отмеченных зон в одну: общий охватывающий прямоугольник, тип и
   *  имя — от первой отмеченной в списке. Зоны — прямоугольники, поэтому союз
   *  двух угловатых областей — это всегда их охват (клетки между ними входят). */
  const mergeEditorZones = () => {
    const d = editorRef.current;
    if (!d) return;
    const chosen = d.zones.filter((z) => d.sel.includes(z.id));
    if (chosen.length < 2) return;
    pushEditorUndo();
    const first = chosen[0];
    const merged: TestMapZone = {
      id: newZoneId(),
      name: first.name,
      kind: first.kind,
      c0: Math.min(...chosen.map((z) => z.c0)),
      r0: Math.min(...chosen.map((z) => z.r0)),
      c1: Math.max(...chosen.map((z) => z.c1)),
      r1: Math.max(...chosen.map((z) => z.r1)),
    };
    d.zones = [...d.zones.filter((z) => !d.sel.includes(z.id)), merged];
    d.sel = [];
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  /** Постановка/снятие препятствия кликом (инструменты «Камень» и «Дерево»). */
  const toggleEditorObject = (tool: 'stone' | 'tree', c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    const idx = d.objects.findIndex((o) => o.c === c && o.r === r);
    if (idx < 0 && d.objects.length >= TEST_MAP_LIMITS.objectsMax) {
      setEditorMsg(`Препятствий не больше ${TEST_MAP_LIMITS.objectsMax}.`);
      return false;
    }
    pushEditorUndo();
    if (idx >= 0) d.objects.splice(idx, 1);
    else d.objects.push({ id: newObjectId(), kind: tool, c, r });
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  const renameEditorZone = (id: string, name: string) => {
    const d = editorRef.current;
    if (!d) return;
    const z = d.zones.find((zz) => zz.id === id);
    if (!z) return;
    z.name = name.slice(0, TEST_MAP_LIMITS.nameMax);
    d.dirty = true;
    syncEditorView();
  };

  const undoEditor = () => {
    const d = editorRef.current;
    if (!d || d.undo.length === 0) return;
    const back = d.undo.pop()!;
    d.zones = back.zones.map((z) => ({ ...z }));
    d.objects = back.objects.map((o) => ({ ...o }));
    d.cols = back.cols;
    d.rows = back.rows;
    d.sel = d.sel.filter((id) => d.zones.some((z) => z.id === id));
    applyDraftPreview();
    syncEditorView();
  };

  const resetEditor = () => {
    const d = editorRef.current;
    if (!d) return;
    pushEditorUndo();
    const m = savedMapRef.current;
    d.zones = m.zones.map((z) => ({ ...z }));
    d.objects = (m.objects ?? []).map((o) => ({ ...o }));
    d.cols = m.cols;
    d.rows = m.rows;
    d.sel = [];
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  /** Предварительная проверка черновика — те же правила, что у сервера. */
  const editorDraftError = (): string | null => {
    const d = editorRef.current;
    if (!d) return null;
    if (d.zones.length === 0) return 'Нужна хотя бы одна зона.';
    if (!d.zones.some((z) => z.kind === 'cells')) return 'Нужна хотя бы одна зона с клетками.';
    if (d.objects.length > TEST_MAP_LIMITS.objectsMax) return `Препятствий не больше ${TEST_MAP_LIMITS.objectsMax}.`;
    return testMapConnectivityError(d.zones);
  };

  const saveEditorMap = () => {
    const d = editorRef.current;
    const net = netRef.current;
    if (!d || !net) return;
    if (!net.ready) {
      setEditorMsg('Нет связи с сервером.');
      return;
    }
    const err = editorDraftError();
    if (err) {
      setEditorMsg(err);
      return;
    }
    try {
      localStorage.setItem(EDITOR_PASS_KEY, editorPass);
    } catch {
      /* приватный режим — просто не запоминаем */
    }
    net.emit('setmap', { pass: editorPass, map: draftMap(d) });
    setEditorMsg('Сохраняем…');
  };

  useEffect(() => {
    if (!loaded || !netStarted) return;
    const pending = pendingJoinRef.current;
    const login = (pending?.login || nameFromUrl() || '').trim();
    // Сокет нужен уже на экране входа: он слушает состав комнат (roomsinfo),
    // пока игрок печатает имя. Вход без имени не делаем — join уйдёт из
    // pickRoom(), где имя берётся из pendingJoinRef (его кладёт joinFromEntry).
    if (login) setPlayerName(login);
    const client = createCoopClient({
      onOpen: () => {
        setNetStatus('соединение есть');
        // Состав комнат для выбора/модалки: спрашиваем сразу после соединения —
        // дальше экран выбора опрашивает сам по своему интервалу.
        client.requestRooms(wantedRoomIds());
      },
      onRooms: (list) => {
        setRoomsRows(list);
        setRoomsStale(false);
      },
      onYou: (cat) => {
        meIdRef.current = cat.id;
        setMeId(cat.id);
        setNetReady(true);
        const e = engineRef.current;
        const col = typeof cat.x === 'number' ? Math.max(0, cat.x - 1) : e.col;
        const row = typeof cat.y === 'number' ? Math.max(0, cat.y - 1) : e.row;
        e.col = col;
        e.row = row;
        // В «тесте» свободная позиция стартует с клетки сервера (после reconnect тоже).
        e.fx = col;
        e.fy = row;
        netMovesRef.current = { server: { col, row }, pending: [] };
        setNetStatus(`Вы — ${cat.login || 'кот'} (#${cat.id})`);
        if (cat.login) setPlayerName(cat.login);
        // После переподключения сервер завёл нового кота без блока: сообщаем стойку заново,
        // иначе удерживаемый К после обрыва перестал бы ловить удары в «Лапы».
        if (e.blocking) netRef.current?.emit('block', { on: true });
        // Броня — тоже: новый кот на сервере без брони, и входящий урон шёл бы целиком.
        netRef.current?.emit('armor', { armor: settingsRef.current.combat.armorLevel / 10 });
      },
      onField: (field) => {
        const cats = field.cats || [];
        const others = cats.filter((c) => c.id !== meIdRef.current);
        // Формат поля комнаты: «test» — лужайка/переход/закуток (камера, свободная ходьба).
        const fmt = field.format === 'test' ? 'test' : 'grid';
        if (fmt !== fieldFormatRef.current) {
          fieldFormatRef.current = fmt;
          setFieldFormat(fmt);
          // Ушли из «теста» (переход в другой комнате) — редактор закрывается сам.
          if (fmt !== 'test' && editorOpenRef.current) closeEditor();
        }
        // Конфиг локации «теста»: применяется до любой отрисовки — setTestMap
        // сбрасывает кэши, и поле рисуется уже по новому конфигу.
        if (field.map) {
          const checkedMap = sanitizeTestMap(field.map).map;
          if (checkedMap) applyTestMap(checkedMap);
        }
        camRef.current.init = false;
        remoteFreeRef.current.clear();
        liveRemotesRef.current = others.map(catToDummy);
        // Кто из чужих котов идёт свободно (fm=1) — сеем плавную доведённую позицию.
        for (const c of others) {
          if (c.fm === 1 && Number.isFinite(c.fx) && Number.isFinite(c.fy)) {
            remoteFreeRef.current.set(`p${c.id}`, { x: c.fx!, y: c.fy!, tx: c.fx!, ty: c.fy! });
          }
        }
        // В «тесте» игрок появляется сразу в боевом режиме (клавиша B выключает).
        if (fmt === 'test' && !settingsRef.current.arrow.battleMode) {
          setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: true } }));
        }
        // Кто из чужих котов держит блок — из снапшота комнаты (после обрыва тоже).
        remoteBlockRef.current = new Set(cats.filter((c) => c.blocking && c.id !== meIdRef.current).map((c) => c.id));
        remoteAimRef.current.clear();
        remoteDrawRef.current.clear();
        for (const d of liveRemotesRef.current) remoteDrawRef.current.set(d.id, seedRemoteDraw({ col: d.col, row: d.row }));
        const seenAt = performance.now();
        for (const d of liveRemotesRef.current) remoteAimRef.current.set(d.id, createRemoteAim(d.angle, seenAt));
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
          engineRef.current.fx = col;
          engineRef.current.fy = row;
          netMovesRef.current.server = { col, row };
        }
        setNetStatus(`Вы в комнате ${roomTitle(field.room || 'demo')} · ${cats.length} на поле`);
        // Манекен и мишень — состояние комнаты: onField приходит при входе и после каждого переподключения.
        const fd = field.dummy;
        if (fd && fd.on && Number.isFinite(fd.x) && Number.isFinite(fd.y)) {
          const spr = SPRITES.find((sp) => sp.id === fd.sprite)?.id;
          applyDummy(true, { x: fd.x, y: fd.y }, spr);
          dummyGrabRef.current = fd.grab || null;
        } else {
          applyDummy(false, null);
          dummyGrabRef.current = null;
        }
        applyRab(!!field.rab?.on);
      },
      onMap: (map) => {
        // Кто-то сохранил локацию в редакторе (и мы сами — сервер шлёт map и автору).
        applyTestMap(map);
        setEditorMsg('Локация обновлена.');
      },
      onCat: (cat) => {
        if (cat.x === 0 && cat.y === 0) {
          remoteAimRef.current.delete(`p${cat.id}`);
          remoteDrawRef.current.delete(`p${cat.id}`);
          remoteBlockRef.current.delete(cat.id);
          liveRemotesRef.current = liveRemotesRef.current.filter((d) => d.id !== `p${cat.id}`);
          setPeerCount(1 + liveRemotesRef.current.length);
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
              // Короткая пауза на новый шаг: мгновенный перешаг после отката
              // уходил в серверный кулдаун и терялся — снова откат и телепорт.
              engineRef.current.moveLockUntil = performance.now() + NET_ROLLBACK_LOCK_MS;
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
        // Блок чужого кота приходит и с move-пакетами (publicCat несёт blocking).
        if (cat.blocking === true) remoteBlockRef.current.add(cat.id);
        else if (cat.blocking === false) remoteBlockRef.current.delete(cat.id);
        const prev = liveRemotesRef.current.find((d) => d.id === `p${cat.id}`);
        const dummy = catToDummy({
          id: cat.id,
          login: cat.login || prev?.name,
          sprite: cat.sprite || prev?.sprite,
          x: typeof cat.x === 'number' ? cat.x : (prev?.col ?? 0) + 1,
          y: typeof cat.y === 'number' ? cat.y : (prev?.row ?? 0) + 1,
          deg: cat.deg ?? prev?.angle,
        });
        // «Тест»: чужой кот в свободной ходьбе — позиция едет в карту плавного
        // доведения, клетка сервера обновляется без анимации шага.
        if (cat.fm === 1 && Number.isFinite(cat.fx) && Number.isFinite(cat.fy)) {
          const fr = remoteFreeRef.current.get(dummy.id);
          if (fr) {
            fr.tx = cat.fx!;
            fr.ty = cat.fy!;
          } else {
            remoteFreeRef.current.set(dummy.id, { x: cat.fx!, y: cat.fy!, tx: cat.fx!, ty: cat.fy! });
          }
          if (prev) {
            prev.col = dummy.col;
            prev.row = dummy.row;
            prev.name = dummy.name;
            prev.sprite = dummy.sprite;
            prev.angle = dummy.angle;
          }
          const visF = remoteDrawRef.current.get(dummy.id);
          if (visF) {
            visF.col = dummy.col;
            visF.row = dummy.row;
            visF.queue = [];
          }
          return;
        }
        remoteFreeRef.current.delete(dummy.id);
        // Сетевой угол пишем в тот же объект, без setState. На кадре рисуем
        // не его, а сглаженный display. Клетка сервера — в col/row сразу,
        // картинка догоняет её по одной за кадр (remoteDrawRef.current).
        const seenAt = performance.now();
        remoteAimRef.current.set(dummy.id, noteRemoteAim(remoteAimRef.current.get(dummy.id), dummy.angle, seenAt, !prev));
        if (prev) {
          const moved = prev.col !== dummy.col || prev.row !== dummy.row;
          prev.col = dummy.col;
          prev.row = dummy.row;
          prev.angle = dummy.angle;
          prev.name = dummy.name;
          prev.sprite = dummy.sprite;
          // Рост обновляем только когда он реально пришёл в пакете (иначе сбросили бы
          // выбранный при спавне размер до дефолта).
          if (typeof cat.size === 'number' && Number.isFinite(Number(cat.size))) prev.scale = dummy.scale;
          if (moved) rememberRemoteCell(remoteDrawRef.current, prev.id, dummy.col, dummy.row);
          return;
        }
        rememberRemoteCell(remoteDrawRef.current, dummy.id, dummy.col, dummy.row);
        liveRemotesRef.current = [...liveRemotesRef.current, dummy];
        setPeerCount(1 + liveRemotesRef.current.length);
      },
      onBlock: (info) => {
        // Стойка блока чужого кота: нужна бьющему, чтобы проводить удары в «Лапы»
        // (кроме хвоста — удар в хвост блок не ловит).
        if (info.id === meIdRef.current) return;
        if (info.on) remoteBlockRef.current.add(info.id);
        else remoteBlockRef.current.delete(info.id);
      },
      onFreeMove: (m) => {
        // Чужой кот идёт свободно («тест», мирный режим): обновляем цель доведения
        // и логическую клетку — по ней работают удары и препятствия.
        const key = `p${m.id}`;
        const fr = remoteFreeRef.current.get(key);
        if (fr) {
          fr.tx = m.x;
          fr.ty = m.y;
        } else {
          remoteFreeRef.current.set(key, { x: m.x, y: m.y, tx: m.x, ty: m.y });
        }
        if (m.cx != null && m.cy != null) {
          const prev = liveRemotesRef.current.find((d) => d.id === key);
          if (prev) {
            prev.col = m.cx - 1;
            prev.row = m.cy - 1;
          }
          const vis = remoteDrawRef.current.get(key);
          if (vis) {
            vis.col = m.cx - 1;
            vis.row = m.cy - 1;
            vis.queue = [];
          }
        }
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
        // Совместимость со старым сервером без refuse-кодов: откат предикта по тексту.
        if (!text.includes('Клетка занята') && !text.includes('Край поля') && !text.includes('Слишком быстро')) return;
        const cell = rejectOwnMove(netMovesRef.current);
        if (cell) {
          engineRef.current.col = cell.col;
          engineRef.current.row = cell.row;
        }
        engineRef.current.path = [];
        engineRef.current.step = null;
        engineRef.current.moveLockUntil = performance.now() + NET_ROLLBACK_LOCK_MS;
      },
      onRefuse: (refuse) => {
        if (refuse?.text) setNetStatus(refuse.text);
        // Основной путь — код отказа: редактура русских текстов на сервере
        // больше не ломает откат предикта.
        if (refuse?.code !== 'cell_busy' && refuse?.code !== 'edge' && refuse?.code !== 'cooldown') return;
        const cell = rejectOwnMove(netMovesRef.current);
        if (cell) {
          engineRef.current.col = cell.col;
          engineRef.current.row = cell.row;
        }
        engineRef.current.path = [];
        engineRef.current.step = null;
        engineRef.current.moveLockUntil = performance.now() + NET_ROLLBACK_LOCK_MS;
      },
      onNoplace: (payload) =>
        setNetStatus(payload?.reason || 'Комната полная (макс. 30). Смените ?room='),
      onDummyState: (state) => {
        // Авторитет сервера: подтверждает optimistic-тумблер и синхронизирует остальных.
        const spr = SPRITES.find((sp) => sp.id === state.sprite)?.id;
        applyDummy(state.on, state.on ? { x: state.x, y: state.y } : null, spr);
        dummyGrabRef.current = state.on ? state.grab || null : null;
      },
      onDummyMove: (pos) => {
        // Чужой тащит манекен: позиция на кадр, скорость сдвига раскачивает «желе».
        const prev = dummyPosRef.current;
        const nowMs = performance.now();
        if (prev) {
          const s0 = settingsRef.current;
          const dist = Math.hypot((pos.x - prev.x) * s0.field.cellW, (pos.y - prev.y) * s0.field.cellH);
          const speed = dist / Math.max(1, nowMs - dummySeenRef.current);
          jellyRef.current[DUMMY_ID] = Math.max(jellyRef.current[DUMMY_ID] ?? 0, Math.min(1, speed / 2.2));
        }
        dummySeenRef.current = nowMs;
        dummyPosRef.current = { x: pos.x, y: pos.y };
      },
      onDummyGrab: (info) => {
        // Обозначение «кто тащит»: курсор с именем игрока над манекеном.
        dummyGrabRef.current = info.login;
      },
      onDummyDrop: () => {
        dummyGrabRef.current = null;
      },
      onRabState: (state) => {
        // Авторитет сервера: подтверждает optimistic-тумблер мишени РАБ.
        applyRab(state.on);
      },
      onRabHit: (info) => {
        // Чужой удар по РАБу — та же анимация, что видит бьющий: качание «желе»
        // и всплывающий урон над мишенью. Свой удар анимируется локально в момент
        // попадания (эхо сервером не возвращается), так что задвоения нет.
        const s = settingsRef.current;
        const e = engineRef.current;
        const zone = s.combat.zones.find((z) => z.id === info.zone);
        const dmg = Math.max(0, Math.round(Number(info.damage) || 0));
        e.labels.push({
          x: RAB_POS.col * s.field.cellW + s.field.cellW / 2,
          y: RAB_POS.row * s.field.cellH + s.field.cellH / 2 - s.field.cellH * 0.35,
          born: performance.now(),
          text: `${info.part || info.zone || 'удар'} -${dmg}%`,
          color: zone?.color || '#ffd60a',
        });
        jellyRef.current[RAB_ID] = 1;
      },
      onClose: (info) => {
        setNetReady(false);
        // При обрыве клиент сам переподключается с backoff и повторным join:
        // движение в это время заблокировано (requestStep), состояние вернут you/field.
        if (info?.retrying) {
          setNetStatus(`Связь потеряна — переподключаемся (попытка ${info.attempt})…`);
        } else {
          setNetStatus('Сокет закрыт. Обновите страницу.');
        }
      },
    });
    setChatLines([]);
    setNetReady(false);
    setMeId(null);
    netRef.current = client;
    // Слушающий режим: без room — join не шлём, ждём выбора комнаты (pickRoom).
    client.connect({
      login,
      sprite: pending?.sprite || settingsRef.current.character.sprite,
    });
    return () => {
      liveRemotesRef.current = [];
      remoteAimRef.current.clear();
      remoteDrawRef.current.clear();
      remoteFreeRef.current.clear();
      fieldFormatRef.current = 'grid';
      setFieldFormat('grid');
      camRef.current.init = false;
      netMovesRef.current = { server: null, pending: [] };
      applyDummy(false, null);
      dummySeenRef.current = 0;
      dummySyncRef.current.at = 0;
      dummyGrabRef.current = null;
      applyRab(false);
      const sync = aimSyncRef.current;
      if (sync.timer) clearTimeout(sync.timer);
      sync.timer = null;
      sync.pending = null;
      client.close();
      netRef.current = null;
    };
  }, [loaded, netStarted, applyNetFight, wantedRoomIds]);

  /** Обновление ?room=/&name= в адресной строке после выбора/смены комнаты: ссылкой
   *  можно вернуться прямо в тот же грот (и имя подставится в пикер персонажа). */
  const shareUrl = useCallback((nextRoom: string, nextName: string) => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('room', nextRoom || 'demo');
      if (nextName) url.searchParams.set('name', nextName);
      else url.searchParams.delete('name');
      history.replaceState(null, '', url);
    } catch {
      /* ignore */
    }
  }, []);

  /**
   * Зайти в выбранный грот: первый вход с экрана выбора или переход из модалки.
   * Сокет уже открыт — join уходит в ту же связь, сервер сам выведет кота из прежней
   * комнаты (комната увидит исчезновение) и заведёт в новую. Состояние комнаты
   * (соседи, манекен, мишень, чат) придёт заново с you/field.
   */
  const pickRoom = useCallback(
    (roomId: string) => {
      const net = netRef.current;
      if (!net) return;
      const pending = pendingJoinRef.current;
      const login = (pending?.login || playerName || nameFromUrl() || '').trim().slice(0, 24);
      const sprite = pending?.sprite || settingsRef.current.character.sprite;
      // Рост модельки, выбранный при спавне: едет в join (size), чтобы комнату
      // видели все с этим ростом, а не только сам игрок.
      const scale = Math.min(100, Math.max(60, Math.round(pending?.scale ?? settingsRef.current.character.spriteScale)));
      pendingJoinRef.current = { room: roomId, login, sprite, scale };
      setChatLines([]);
      setRoomsStale(false);
      setSwitchOpen(false);
      setRoomCode(roomId);
      setPlayerName(login);
      setNetReady(false);
      setNetStatus(`Заходим в ${roomTitle(roomId)}…`);
      shareUrl(roomId, login);
      if (!enteredRef.current) {
        enteredRef.current = true;
        setStage('field');
      }
      net.joinRoom({ room: roomId, login, sprite, size: scale });
    },
    [playerName, shareUrl],
  );

  /** Пока открыт экран входа или модалка смены комнаты — опрашиваем состав гротов.
   *  Сервер отвечает roomsinfo; если дольше 5 с ответа нет — помечаем «данные недоступны». */
  useEffect(() => {
    if (!netStarted || (stage !== 'entry' && !switchOpen)) return;
    setRoomsStale(false);
    const ask = () => netRef.current?.requestRooms(wantedRoomIds());
    ask();
    const iv = setInterval(ask, 2500);
    const staleT = setTimeout(() => setRoomsStale(true), 5000);
    return () => {
      clearInterval(iv);
      clearTimeout(staleT);
    };
  }, [netStarted, stage, switchOpen, wantedRoomIds]);

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
    for (const sp of FIELD_SPRITES) {
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
    e.fx = Math.max(0, Math.min(e.fx, s.field.cols - 1));
    e.fy = Math.max(0, Math.min(e.fy, s.field.rows - 1));
    if (mainSavedRef.current) {
      mainSavedRef.current.col = Math.max(0, Math.min(mainSavedRef.current.col, s.field.cols - 1));
      mainSavedRef.current.row = Math.max(0, Math.min(mainSavedRef.current.row, s.field.rows - 1));
    }
    e.path = e.path.filter((p) => p.c < s.field.cols && p.r < s.field.rows);
  }, [settings.field.cols, settings.field.rows, settings.field.cellW, settings.field.cellH]);

  /**
   * Комната «тест»: переход мирная ходьба ↔ боевой режим.
   *  В бой — щёлкаем на ближайшую проходимую клетку, синхронизируем сервер (cellsync)
   *  и предикт; в мирный — свободная позиция стартует с текущей клетки.
   */
  useEffect(() => {
    if (fieldFormat !== 'test') return;
    const e = engineRef.current;
    const net = netRef.current;
    e.proute = [];
    e.phop = null;
    e.hoverA = null;
    if (settings.arrow.battleMode) {
      const cell = nearestWalkableCell(e.fx, e.fy);
      e.col = cell.c;
      e.row = cell.r;
      e.fx = cell.c;
      e.fy = cell.r;
      e.step = null;
      e.path = [];
      netMovesRef.current = { server: { col: cell.c, row: cell.r }, pending: [] };
      net?.emit('cellsync', { x: cell.c + 1, y: cell.r + 1 });
    } else {
      e.fx = e.col;
      e.fy = e.row;
      e.step = null;
      e.path = [];
      freeSyncRef.current.moving = false;
      net?.emit('freemove', { x: round2(e.fx), y: round2(e.fy), stop: true });
    }
  }, [fieldFormat, settings.arrow.battleMode]);

  /* ---------- игровой цикл ---------- */

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let prev = performance.now();

    // Флаги редактора обновляются каждый кадр: update и draw видят одно и то же.
    const editorState = () => ({
      on: editorOpenRef.current && editorRef.current !== null,
      draft: editorRef.current,
    });

    const update = (now: number, dt: number) => {
      stepRemoteDraws(liveRemotesRef.current, remoteDrawRef.current, now);
      const s = settingsRef.current;
      const e = engineRef.current;
      // Комната «тест» и мирный режим: свободная ходьба по всей локации вместо клеток.
      // В редакторе ходьба останавливается: кот стоит на месте, мышь рисует зоны.
      const testMode = fieldFormatRef.current === 'test';
      const editorOn = editorState().on;
      const peaceWalk = testMode && !s.arrow.battleMode && s.controlled === 'main' && !editorOn;
      // Блок (удержание К): двигаться, крутить стрелу и бить нельзя. Гасим всё,
      // что могло прийти, пока блок держится (маршрут по клику, удержания).
      if (e.blocking) {
        e.held = [];
        e.path = [];
        e.proute = [];
        e.phop = null;
        e.rot = 0;
        e.strikeHeld = false;
        e.step = null;
      }
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
        if (s.controlled === 'main') {
          const net = netRef.current;
          // В комнате без связи шагов нет: локальное движение превратило бы кота
          // в «зомби», которого никто, кроме нас, не видит.
          if (!net?.ready) return 'blocked';
          const book = netMovesRef.current;
          // Пока сервер не назвал клетку, шаг не рисуем: иначе «you» вернёт кота на спавн.
          if (!book.server) return 'wait';
          // Один неподтверждённый шаг: следующий не отправляем и не рисуем, пока
          // сервер не подтвердил предыдущий. Иначе при гонке за клетку предикт
          // разъезжался с сервером на клетку, и отказ возвращал кота «куда-то
          // рядом» — выглядело как вытеснение его другим игроком.
          if (book.pending.length > 0) return 'wait';
          const dd = dirByDeg(dirDeg);
          const deg = Math.round(wrap360(e.angle) * 10) / 10;
          net.emit('move', { x: dd.dx, y: dd.dy, deg });
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
        if (peaceWalk) return; // в мирном «тесте» движения свободные, шаги по клеткам отключены
        if (e.step) return; // предыдущий шаг ещё в кулдауне — спам не ускоряет движение
        if (performance.now() < e.moveLockUntil) return; // только что был откат — даём серверу догнать
        const self = s.controlled;
        const mp = self === 'main' ? null : mainSavedRef.current;
        const d = dirByDeg(dir);
        const tc = e.col + d.dx;
        const tr = e.row + d.dy;
        // клетки остальных персонажей — физические препятствия: шагнуть в них нельзя;
        // в «тесте» дополнительно — только внутри зон клеточной ходьбы
        if (isBlockedCell(s, self, mp, tc, tr, liveRemotesRef.current, objectExtras())) return;
        const inField = tc >= 0 && tc < s.field.cols && tr >= 0 && tr < s.field.rows;
        if (inField && (!testMode || testWalkableCell(tc, tr))) requestStep(d.deg, tc, tr);
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
      // с интервалом stepMs (120 мс по умолчанию), растянутым замедлением.
      // В мирном «тесте» вместо этого — свободная ходьба (ниже).
      if (!peaceWalk && !e.step) {
        const self = s.controlled;
        const mp = self === 'main' ? null : mainSavedRef.current;
        if (e.held.length > 0) {
          const d = dirByDeg(e.held[e.held.length - 1]);
          const tc = e.col + d.dx;
          const tr = e.row + d.dy;
          if (
            !isBlockedCell(s, self, mp, tc, tr, liveRemotesRef.current, objectExtras()) &&
            tc >= 0 &&
            tc < s.field.cols &&
            tr >= 0 &&
            tr < s.field.rows &&
            (!testMode || testWalkableCell(tc, tr))
          )
            requestStep(d.deg, tc, tr);
        } else if (e.path.length > 0) {
          const nx = e.path[0];
          const d = DIRECTIONS.find((q) => q.dx === Math.sign(nx.c - e.col) && q.dy === Math.sign(nx.r - e.row));
          if (
            d &&
            nx.c === e.col + d.dx &&
            nx.r === e.row + d.dy &&
            !isBlockedCell(s, self, mp, nx.c, nx.r, liveRemotesRef.current, objectExtras()) &&
            (!testMode || testWalkableCell(nx.c, nx.r))
          ) {
            const mode = requestStep(d.deg, nx.c, nx.r);
            if (mode === 'local' || mode === 'net') e.path.shift();
          } else {
            e.path = [];
          }
        }
      }

      // «Тест», мирный режим: прыжки по якорным точкам — центр, середины сторон
      // и углы клеток. Один прыжок переносит ровно на одну соседнюю точку (как шаг
      // в бою — мгновенно, а длительность работает кулдауном), клик строит маршрут
      // по соседним якорям (BFS), зажатые клавиши дают по прыжку за раз. Остановиться
      // можно на любом якоре — приземление строго в точку.
      if (peaceWalk) {
        const net = netRef.current;
        const cellW = s.field.cellW;
        const cellH = s.field.cellH;
        const hb = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        const hopReady = !e.phop || now - e.phop.start >= e.phop.dur;
        // маршрута нет, но клавиши зажаты — один прыжок к соседнему якорю в направлении
        if (hopReady && e.proute.length === 0 && e.held.length > 0) {
          const here = nearestPeaceAnchor(e.fx + hb.dx, e.fy + hb.dy, cellW, cellH, 1e9);
          const nb = here ? peaceStepNeighbor(here.i, e.held[e.held.length - 1], cellW, cellH) : null;
          if (nb !== null) {
            const p = peaceAnchorPoints()[nb];
            e.proute.push({ x: p.x - hb.dx, y: p.y - hb.dy });
          }
        }
        // прыжки по маршруту: один прыжок — одна точка, приземление строго в якорь
        if (hopReady && e.proute.length > 0) {
          const seg = e.proute[0];
          const dx = seg.x - e.fx;
          const dy = seg.y - e.fy;
          if (dx !== 0 || dy !== 0) {
            const maxAxis = Math.max(Math.abs(dx), Math.abs(dy));
            const dur = Math.max(1, (maxAxis / 0.5) * PEACE_STEP_MS);
            const deg = wrap360((Math.atan2(dy * cellH, dx * cellW) * 180) / Math.PI);
            e.lastDir = (Math.round(deg / 45) * 45) % 360;
            e.fx = seg.x;
            e.fy = seg.y;
            e.phop = { start: now, dur };
            freeSyncRef.current.moving = true;
            if (net?.ready && now - freeSyncRef.current.at >= FREE_EMIT_MS) {
              freeSyncRef.current.at = now;
              net.emit('freemove', { x: round2(e.fx), y: round2(e.fy) });
            }
          }
          e.proute.shift();
        }
        // маршрут исчерпан и последний прыжок приземлился — финальный стоп-пакет
        if (
          e.proute.length === 0 &&
          (!e.phop || now - e.phop.start >= e.phop.dur) &&
          freeSyncRef.current.moving
        ) {
          freeSyncRef.current.moving = false;
          net?.emit('freemove', { x: round2(e.fx), y: round2(e.fy), stop: true });
        }
      }

      // Чужие коты в свободной ходьбе («тест»): плавное доведение до последней позиции.
      if (remoteFreeRef.current.size > 0) {
        const kf = 1 - Math.exp(-dt / 80);
        for (const fr of remoteFreeRef.current.values()) {
          fr.x += (fr.tx - fr.x) * kf;
          fr.y += (fr.ty - fr.y) * kf;
        }
      }

      // Плавная камера «теста»: догоняет своего кота, упирается в кромку локации.
      // В мирном режиме добавляются зум и наклон земли (псевдо-3D), переход туда
      // и обратно — с той же экспоненциальной плавностью, что и сама камера.
      if (testMode) {
        const vw = cv.clientWidth || 1;
        const vh = cv.clientHeight || 1;
        const cellW = s.field.cellW;
        const cellH = s.field.cellH;
        const kz = 1 - Math.exp(-dt / CAMZOOM_TAU_MS);
        if (editorOn) {
          // Редактор: камера отъезжает, чтобы весь мир был виден целиком, вид — сверху.
          const bbE = testFieldGeometry(cellW, cellH).bboxPx;
          const pad = 90;
          const zT = Math.max(0.1, Math.min(1.15, Math.min(vw / (bbE.x1 - bbE.x0 + pad), vh / (bbE.y1 - bbE.y0 + pad))));
          camFxRef.current.z += (zT - camFxRef.current.z) * kz;
          camFxRef.current.sq += (1 - camFxRef.current.sq) * kz;
          camFxRef.current.dp += (0 - camFxRef.current.dp) * kz;
          const cxT = (bbE.x0 + bbE.x1) / 2;
          const cyT = (bbE.y0 + bbE.y1) / 2;
          if (!camRef.current.init) {
            camRef.current.x = cxT;
            camRef.current.y = cyT;
            camRef.current.init = true;
          } else {
            const kcE = 1 - Math.exp(-dt / CAMERA_TAU_MS);
            camRef.current.x += (cxT - camRef.current.x) * kcE;
            camRef.current.y += (cyT - camRef.current.y) * kcE;
          }
        } else {
          camFxRef.current.z += ((peaceWalk ? PEACE_ZOOM : 1) - camFxRef.current.z) * kz;
          camFxRef.current.sq += ((peaceWalk ? PEACE_TILT : 1) - camFxRef.current.sq) * kz;
          // перспектива (дальние объекты мельче) — только в мирном режиме
          camFxRef.current.dp += ((peaceWalk ? 1 : 0) - camFxRef.current.dp) * kz;
          const { z, sq } = camFxRef.current;
          const txP = peaceWalk ? e.fx * cellW + cellW / 2 : e.col * cellW + cellW / 2;
          const tyP = peaceWalk ? e.fy * cellH + (cellH - 10) / 2 : e.row * cellH + cellH / 2;
          const bb = testFieldGeometry(cellW, cellH).bboxPx;
          // видимое окно мира: зум сужает его, наклон дополнительно сжимает вертикаль
          const vwG = vw / z;
          const vhG = vh / (z * sq);
          const cxT =
            bb.x1 - bb.x0 >= vwG ? Math.min(Math.max(txP, bb.x0 + vwG / 2), bb.x1 - vwG / 2) : (bb.x0 + bb.x1) / 2;
          const cyT =
            bb.y1 - bb.y0 >= vhG ? Math.min(Math.max(tyP, bb.y0 + vhG / 2), bb.y1 - vhG / 2) : (bb.y0 + bb.y1) / 2;
          if (!camRef.current.init) {
            camRef.current.x = cxT;
            camRef.current.y = cyT;
            camRef.current.init = true;
          } else {
            const kc = 1 - Math.exp(-dt / CAMERA_TAU_MS);
            camRef.current.x += (cxT - camRef.current.x) * kc;
            camRef.current.y += (cyT - camRef.current.y) * kc;
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
            for (const d of liveRemotesRef.current) {
              const cur = de[d.id] ?? es;
              const nv = Math.min(es, cur + amt);
              if (nv !== cur) {
                de[d.id] = nv;
                changed = true;
              }
            }
            // Мишень РАБ всегда в боевом режиме — её энергия восстанавливается сама.
            if (rabOnRef.current) {
              const cur = de[RAB_ID] ?? es;
              const nv = Math.min(es, cur + amt);
              if (nv !== cur) {
                de[RAB_ID] = nv;
                changed = true;
              }
            }
            return changed ? { ...prev, playerEnergy: pe, dummyEnergy: de } : prev;
          });
        }
      }

      e.labels = e.labels.filter((l) => now - l.born < 900);

      // Чужие стрелы догоняют последний сетевой угол каждый кадр. Свою не трогаем.
      if (liveRemotesRef.current.length > 0) {
        for (const d of liveRemotesRef.current) {
          const aim = remoteAimRef.current.get(d.id);
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
    // растёт от наконечника, как на референсе) + тёмный наконечник; точка закрепления —
    // опциональна (прячется настройкой, сама стрела видна всегда).
    // Хвост рисуется двумя встык идущими отрезками: зелёным от закрепления до границы
    // энергии и красным дальше. Если красить сверху один сплошной зелёный хвост, круглая
    // шляпка у закрепления остаётся зелёной даже при нуле энергии — тот самый «зелёный
    // пиксель» в начале стрелы. Поэтому базовая шляпка красится цветом своего участка:
    // при полностью выбитой энергии вся стрела, включая наконечник и закрепление, красная.
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
      const lw = s.arrow.width * k;
      const split = r1 + (shaftEnd - r1) * frac;
      // Цвет участка у закрепления: есть энергия — цвет стрелы, выбрана целиком — красный.
      const baseColor = frac > 0 ? s.arrow.color : SPENT_COLOR;
      // Наконечник темнее хвоста — читается на любом фоне.
      const tipColor = shadeHex(baseColor, ARROW_TIP_SHADE);

      ctx2.save();
      // зелёная часть хвоста (остаток энергии)
      ctx2.lineCap = 'butt';
      if (frac > 0 && split > r1) {
        ctx2.beginPath();
        ctx2.moveTo(ax + ca * r1, ay + sa * r1);
        ctx2.lineTo(ax + ca * split, ay + sa * split);
        ctx2.lineWidth = lw;
        ctx2.strokeStyle = s.arrow.color;
        ctx2.stroke();
      }
      // красная часть (потраченная энергия) — до наконечника
      if (frac < 1 && shaftEnd > split) {
        ctx2.beginPath();
        ctx2.moveTo(ax + ca * split, ay + sa * split);
        ctx2.lineTo(ax + ca * shaftEnd, ay + sa * shaftEnd);
        ctx2.lineWidth = lw;
        ctx2.strokeStyle = SPENT_COLOR;
        ctx2.stroke();
      }
      // круглая шляпка у закрепления — цветом участка, который начинается у базы
      ctx2.beginPath();
      ctx2.arc(ax + ca * r1, ay + sa * r1, lw / 2, 0, Math.PI * 2);
      ctx2.fillStyle = baseColor;
      ctx2.fill();
      // наконечник
      ctx2.beginPath();
      ctx2.moveTo(ax + ca * r2, ay + sa * r2);
      ctx2.lineTo(ax + ca * (r2 - tipLen) - sa * halfW, ay + sa * (r2 - tipLen) + ca * halfW);
      ctx2.lineTo(ax + ca * (r2 - tipLen) + sa * halfW, ay + sa * (r2 - tipLen) - ca * halfW);
      ctx2.closePath();
      ctx2.fillStyle = tipColor;
      ctx2.fill();
      // точка закрепления (масштабируется вместе с моделькой); прячется настройкой,
      // но стрела — линия с наконечником — рисуется в любом случае
      if (showAnchor) {
        ctx2.beginPath();
        ctx2.arc(ax, ay, 4 * k, 0, Math.PI * 2);
        ctx2.fillStyle = baseColor;
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

    const drawHud = (s: SimSettings, e: Engine, screenW?: number) => {
      const ctx2 = ctx;
      const W = screenW ?? s.field.cols * s.field.cellW;
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
      const testMode = fieldFormatRef.current === 'test';
      const { on: editorOn, draft: ed } = editorState();
      let vw = 0;
      let vh = 0;
      if (testMode) {
        // «Тест»: канвас — вьюпорт в мир. Занимает весь кадр, рисунок в мировых
        // координатах через камеру (translate), чёткость — через devicePixelRatio (кап 2).
        vw = cv.clientWidth || 1;
        vh = cv.clientHeight || 1;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const bw = Math.round(vw * dpr);
        const bh = Math.round(vh * dpr);
        if (cv.width !== bw || cv.height !== bh) {
          cv.width = bw;
          cv.height = bh;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        // фон за кромкой локации — самый тёмный цвет темы
        const outside =
          getComputedStyle(document.documentElement).getPropertyValue('--sim-deep').trim() || '#09090b';
        ctx.fillStyle = outside;
        ctx.fillRect(0, 0, vw, vh);
        ctx.save();
        // камера «теста»: экран → зум → мир. В мирном режиме зум приближает поле,
        // а наклон (sq) сжимает землю по вертикали — псевдо-глубина 2.5D
        const fxc = camFxRef.current;
        ctx.translate(Math.round(vw / 2), Math.round(vh / 2));
        ctx.scale(fxc.z, fxc.z);
        ctx.translate(-Math.round(camRef.current.x), -Math.round(camRef.current.y));
        const geo = testFieldGeometry(s.field.cellW, s.field.cellH);
        // ГРУНТ — наклонённая плоскость: трава, доска с сеткой, кромка и якорные
        // точки лежат на земле и сжимаются по вертикали вместе с ней
        ctx.save();
        ctx.scale(1, fxc.sq);
        // трава локации — природная тёмная зелень
        const grad = ctx.createLinearGradient(0, geo.bboxPx.y0, 0, geo.bboxPx.y1);
        grad.addColorStop(0, '#31511f');
        grad.addColorStop(0.55, '#2a461c');
        grad.addColorStop(1, '#233b18');
        ctx.fillStyle = grad;
        ctx.fill(geo.path);
        // зоны клеточной ходьбы: доска с сеткой (цвета — настройки поля).
        // Доска с сеткой режется клипом по кромке локации: сглаженный край
        // подрезает углы зон, и ничего не вылезает за нарисованный островок.
        // Зелёные зоны доски не получают — они остаются травой с цветами.
        ctx.save();
        ctx.clip(geo.path);
        const mapZones = currentTestMap().zones;
        for (const z of mapZones) {
          if (z.kind !== 'cells') continue;
          const zx = z.c0 * s.field.cellW;
          const zy = z.r0 * s.field.cellH;
          const zw = (z.c1 - z.c0 + 1) * s.field.cellW;
          const zh = (z.r1 - z.r0 + 1) * s.field.cellH;
          ctx.fillStyle = s.field.bgColor;
          ctx.fillRect(zx, zy, zw, zh);
          if (s.field.checker) {
            ctx.fillStyle = s.field.bgColorAlt;
            for (let r = z.r0; r <= z.r1; r++) {
              for (let c = z.c0; c <= z.c1; c++) {
                if ((c + r) % 2 === 0) ctx.fillRect(c * s.field.cellW, r * s.field.cellH, s.field.cellW, s.field.cellH);
              }
            }
          }
          if (s.field.showGrid) {
            ctx.strokeStyle = s.field.gridColor;
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let c = z.c0; c <= z.c1 + 1; c++) {
              ctx.moveTo(c * s.field.cellW + 0.5, zy);
              ctx.lineTo(c * s.field.cellW + 0.5, zy + zh);
            }
            for (let r = z.r0; r <= z.r1 + 1; r++) {
              ctx.moveTo(zx, r * s.field.cellH + 0.5);
              ctx.lineTo(zx + zw, r * s.field.cellH + 0.5);
            }
            ctx.stroke();
          }
        }
        // клетки, задетые кромкой (не целиком внутри полигона): в бою они
        // недоступны для прыжков — помечаем лёгкой красной заливкой
        if (s.arrow.battleMode && !editorOn) {
          ctx.fillStyle = 'rgba(214, 69, 65, 0.16)';
          for (const k of testClippedCells()) {
            ctx.fillRect(k.c * s.field.cellW, k.r * s.field.cellH, s.field.cellW, s.field.cellH);
          }
        }
        ctx.restore();
        // земляная кромка поверх подрезанной доски: срезанный край сетки
        // получает аккуратную окантовку и плавно уходит в траву
        ctx.lineJoin = 'round';
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#4a3a28';
        ctx.stroke(geo.path);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(122, 162, 92, 0.35)';
        ctx.stroke(geo.path);
        // атмосферная дымка у дальнего края: лёгкое затемнение верха локации
        // усиливает ощущение глубины (только в мирном режиме — вместе с перспективой)
        if (fxc.dp > 0.01) {
          const bbG = geo.bboxPx;
          const gFar = ctx.createLinearGradient(0, bbG.y0, 0, bbG.y0 + (bbG.y1 - bbG.y0) * 0.5);
          gFar.addColorStop(0, `rgba(6, 12, 4, ${(0.2 * fxc.dp).toFixed(3)})`);
          gFar.addColorStop(1, 'rgba(6, 12, 4, 0)');
          ctx.save();
          ctx.clip(geo.path);
          ctx.fillStyle = gFar;
          ctx.fillRect(bbG.x0, bbG.y0, bbG.x1 - bbG.x0, bbG.y1 - bbG.y0);
          ctx.restore();
        }
        // мирный режим: якорные точки прыжков (центр, середины сторон и углы клетки)
        // и подсветка той, что под курсором; в редакторе точки скрывает сетка.
        // Радиус точки растёт с глубиной — решётка сама подсказывает перспективу.
        if (!s.arrow.battleMode && !editorOn) {
          ctx.beginPath();
          for (const p of peaceAnchorPoints()) {
            const mR = 1 + (peaceDepthScale(p.y) - 1) * fxc.dp;
            ctx.moveTo(p.x * s.field.cellW + 1.7 * mR, p.y * s.field.cellH);
            ctx.arc(p.x * s.field.cellW, p.y * s.field.cellH, 1.7 * mR, 0, Math.PI * 2);
          }
          ctx.fillStyle = 'rgba(235, 240, 225, 0.34)';
          ctx.fill();
          if (e.hoverA) {
            ctx.beginPath();
            ctx.arc(e.hoverA.x * s.field.cellW, e.hoverA.y * s.field.cellH, 5.5, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
            ctx.lineWidth = 1.6;
            ctx.stroke();
          }
        }
        // Оверлей редактора: границы мира, бледная сетка всего мира, подсветка
        // зелёных зон и тянущийся прямоугольник. Клетки: c=0..cols, r=0..rows.
        if (editorOn && ed) {
          const wc = ed.cols * s.field.cellW;
          const wr = ed.rows * s.field.cellH;
          // сетка всего мира — чтобы было видно, какие клетки свободны под новые зоны
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let c = 0; c <= ed.cols; c++) {
            ctx.moveTo(c * s.field.cellW + 0.5, 0);
            ctx.lineTo(c * s.field.cellW + 0.5, wr);
          }
          for (let r = 0; r <= ed.rows; r++) {
            ctx.moveTo(0, r * s.field.cellH + 0.5);
            ctx.lineTo(wc, r * s.field.cellH + 0.5);
          }
          ctx.stroke();
          // зелёные зоны — лёгкая зелёная заливка (доски у них нет, край уже нарисован)
          ctx.fillStyle = 'rgba(112, 178, 92, 0.16)';
          for (const z of ed.zones) {
            if (z.kind !== 'green') continue;
            ctx.fillRect(z.c0 * s.field.cellW, z.r0 * s.field.cellH, (z.c1 - z.c0 + 1) * s.field.cellW, (z.r1 - z.r0 + 1) * s.field.cellH);
          }
          // граница мира
          ctx.setLineDash([7, 5]);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(0.5, 0.5, wc - 1, wr - 1);
          ctx.setLineDash([]);
          // препятствия черновика: спрайт + пунктирная рамка клетки
          for (const o of ed.objects) {
            drawTestObject(
              ctx,
              o.kind,
              s.field.cellW,
              s.field.cellH,
              (o.c + 0.5) * s.field.cellW,
              (o.r + 1) * s.field.cellH,
              1,
              hashStr(o.id) & 7,
            );
            ctx.setLineDash([4, 3]);
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
            ctx.lineWidth = 1.2;
            ctx.strokeRect(o.c * s.field.cellW + 1.5, o.r * s.field.cellH + 1.5, s.field.cellW - 3, s.field.cellH - 3);
            ctx.setLineDash([]);
          }
          // тянущийся прямоугольник
          const dr = ed.drag;
          if (dr) {
            const dc0 = Math.min(dr.c0, dr.c1);
            const dc1 = Math.max(dr.c0, dr.c1);
            const dr0 = Math.min(dr.r0, dr.r1);
            const dr1 = Math.max(dr.r0, dr.r1);
            const dx0 = dc0 * s.field.cellW;
            const dy0 = dr0 * s.field.cellH;
            const dw = (dc1 - dc0 + 1) * s.field.cellW;
            const dh = (dr1 - dr0 + 1) * s.field.cellH;
            const erase = dr.erase || ed.tool === 'erase';
            ctx.fillStyle = erase
              ? 'rgba(224, 92, 92, 0.34)'
              : ed.tool === 'green'
                ? 'rgba(112, 178, 92, 0.34)'
                : 'rgba(120, 170, 250, 0.30)';
            ctx.fillRect(dx0, dy0, dw, dh);
            ctx.strokeStyle = erase ? 'rgba(255, 150, 150, 0.9)' : 'rgba(255, 255, 255, 0.75)';
            ctx.lineWidth = 1.6;
            ctx.strokeRect(dx0 + 0.5, dy0 + 0.5, dw - 1, dh - 1);
          }
        }
        ctx.restore();
        // трава и цветы — билборды: стоят вертикально, основание следует за сжатой
        // землёй (как объекты в Don't Starve); масштаб растёт с глубиной
        for (const d of geo.decor) {
          const mD = 1 + (peaceDepthScale(d.y) - 1) * fxc.dp;
          ctx.save();
          ctx.translate(0, d.y * s.field.cellH * (fxc.sq - 1));
          drawTestDecorItem(ctx, d, s.field.cellW, s.field.cellH, mD);
          ctx.restore();
        }
      } else {
        // Канвас может показываться крупнее клеточного размера (поле на весь кадр).
        // Чтобы без «мыла»: backing store повторяет показанный размер с учётом
        // devicePixelRatio (кап 2), а рисунок идёт в клеточных координатах через
        // ctx.setTransform. Мышь маппится через отношение размеров — не ломается.
        const cssW = cv.clientWidth || W;
        const k = Math.min(2, Math.max(1, (cssW * (window.devicePixelRatio || 1)) / Math.max(1, W)));
        const bw = Math.round(W * k);
        const bh = Math.round(H * k);
        if (cv.width !== bw || cv.height !== bh) {
          cv.width = bw;
          cv.height = bh;
        }
        ctx.setTransform(k, 0, 0, k, 0, 0);

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
        if (id === s.controlled) {
          // «Тест», мирный режим: свой кот стоит в свободной позиции
          if (testMode && !s.arrow.battleMode) return { x: e.fx * s.field.cellW, y: e.fy * s.field.cellH };
          return { x: e.col * s.field.cellW, y: e.row * s.field.cellH };
        }
        // чужой кот в свободной ходьбе («тест») — плавная доведённая позиция
        const free = id.startsWith('p') ? remoteFreeRef.current.get(id) : undefined;
        if (free) return { x: free.x * s.field.cellW, y: free.y * s.field.cellH };
        const vis = id.startsWith('p') ? remoteDrawRef.current.get(id) : undefined;
        if (vis) return { x: vis.col * s.field.cellW, y: vis.row * s.field.cellH };
        return { x: col * s.field.cellW, y: row * s.field.cellH };
      };
      const dummies = dummiesOf(s, liveRemotesRef.current).filter(
        (d) => d.col >= 0 && d.col < s.field.cols && d.row >= 0 && d.row < s.field.rows,
      );
      /** Множитель перспективы для точки опоры (px мира): дальние спрайты мельче.
       *  В бою и вне «теста» — 1; в мирном «тесте» растёт вместе с camFx.dp. */
      const depthM = (groundYpx: number): number => {
        const fx = camFxRef.current;
        if (!testMode || fx.dp <= 0.002) return 1;
        return 1 + (peaceDepthScale(groundYpx / s.field.cellH) - 1) * fx.dp;
      };
      /** Глубинная очередь «теста»: персонажи и препятствия рисуются по дальности
       *  (кто ниже по полю — тот ближе и рисуется поверх); вне «теста» — сразу. */
      const bills: { y: number; fn: () => void }[] = [];
      const runOrQueue = (fn: () => void, y: number) => {
        if (testMode) bills.push({ y, fn });
        else fn();
      };
      const drawChar = (
        sprC: HTMLImageElement,
        pos: { x: number; y: number },
        scalePct: number,
        jellyKey: string | null,
        selected = false,
        whiteC: HTMLCanvasElement | null = null,
        active = false,
      ) => {
        const th0 = (s.field.cellH - 10) * (scalePct / 100);
        const groundY = pos.y + th0;
        // перспектива: рост меняется, точка опоры на земле — нет
        const th = th0 * depthM(groundY);
        const twd = th * (sprC.width / sprC.height);
        // билборд: земля в мирном «тесте» наклонена (сжата по вертикали), спрайт
        // остаётся вертикальным — низ прижат к сжатой земле, верх не заваливается
        const py = testMode ? groundY * camFxRef.current.sq - th : pos.y;
        // тень под ногами — следует за нижним краем спрайта
        ctx.beginPath();
        ctx.ellipse(pos.x + twd / 2, py + th - 4, twd * 0.34, 5.5, 0, 0, Math.PI * 2);
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
          ctx.translate(pos.x + twd / 2, py + th);
          ctx.rotate(amp * 0.08 * Math.cos(now * 0.045));
          ctx.scale(1 + amp * 0.22 * wob, 1 - amp * 0.22 * wob);
          glow(-twd / 2, -th);
          contour(-twd / 2, -th);
          ctx.drawImage(sprC, -twd / 2, -th, twd, th);
          ctx.restore();
        } else {
          glow(pos.x, py);
          contour(pos.x, py);
          ctx.drawImage(sprC, pos.x, py, twd, th);
        }
      };

      // Боевая мишень «РАБ»: общая для комнаты, в боевом режиме (по ней проходят
      // удары), клетка непроходима. Рисуется под котами; имя постоянное.
      const drawRab = () => {
        if (!rabOnRef.current) return;
        const sprR = spritesRef.current[RAB_SPRITE.id] ?? null;
        if (sprR) {
          const tr = { x: RAB_POS.col * s.field.cellW, y: RAB_POS.row * s.field.cellH };
          drawChar(sprR, tr, RAB_SCALE, RAB_ID, false, whiteSpritesRef.current[RAB_SPRITE.id] ?? null, false);
          const thR = (s.field.cellH - 10) * (RAB_SCALE / 100);
          const nameX = tr.x + (sprR.width / sprR.height) * thR * 0.5;
          ctx.font = 'bold 12px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillText(RAB_SPRITE.name, nameX + 1, tr.y - 16);
          ctx.fillStyle = '#f4f4f5';
          ctx.fillText(RAB_SPRITE.name, nameX, tr.y - 17);
        }
      };
      runOrQueue(drawRab, (RAB_POS.row + 1) * s.field.cellH);

      // Манекен «ПОЧУХАТЬ»: виден всем, тащится любым игроком, позиция живёт
      // на сервере. Вне боя (удары по нему не проходят), но клетка непроходима.
      // Имя постоянное; когда кто-то тащит — над ним курсор с именем игрока.
      const drawPoch = () => {
        if (!dummyOnRef.current || !dummyPosRef.current) return;
        const sprP = spritesRef.current[dummySpriteRef.current] ?? null;
        if (sprP) {
          const tp =
            drag && drag.key === DUMMY_ID
              ? { x: drag.x, y: drag.y }
              : { x: dummyPosRef.current.x * s.field.cellW, y: dummyPosRef.current.y * s.field.cellH };
          drawChar(sprP, tp, DUMMY_SCALE, DUMMY_ID, false, whiteSpritesRef.current[dummySpriteRef.current] ?? null, false);
          const thP = (s.field.cellH - 10) * (DUMMY_SCALE / 100);
          const nameX = tp.x + (sprP.width / sprP.height) * thP * 0.5;
          ctx.font = 'bold 12px Inter, system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillText(DUMMY_NAME, nameX + 1, tp.y - 16);
          ctx.fillStyle = '#f4f4f5';
          ctx.fillText(DUMMY_NAME, nameX, tp.y - 17);
          // Обозначение «кто тащит»: курсор-стрелка и имя игрока рядом с манекеном.
          const grab = dummyGrabRef.current;
          if (grab) {
            const gx = nameX;
            const gy = tp.y - 36;
            ctx.font = 'bold 11px Inter, system-ui, sans-serif';
            const label = grab;
            const tw = ctx.measureText(label).width;
            ctx.fillStyle = 'rgba(0,0,0,0.78)';
            ctx.beginPath();
            ctx.roundRect(gx - tw / 2 - 20, gy - 3, tw + 30, 18, 9);
            ctx.fill();
            // курсор-стрелка (как указатель мыши)
            ctx.fillStyle = '#ffd60a';
            ctx.beginPath();
            ctx.moveTo(gx - tw / 2 - 12, gy);
            ctx.lineTo(gx - tw / 2 - 12, gy + 10.5);
            ctx.lineTo(gx - tw / 2 - 9.2, gy + 7.8);
            ctx.lineTo(gx - tw / 2 - 7, gy + 12.5);
            ctx.lineTo(gx - tw / 2 - 5.4, gy + 11.7);
            ctx.lineTo(gx - tw / 2 - 7.6, gy + 7);
            ctx.lineTo(gx - tw / 2 - 4, gy + 7);
            ctx.closePath();
            ctx.fill();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffd60a';
            ctx.fillText(label, gx + 4, gy + 6);
            ctx.textBaseline = 'top';
          }
        }
      };
      runOrQueue(
        drawPoch,
        dummyPosRef.current
          ? dummyPosRef.current.y * s.field.cellH + (s.field.cellH - 10) * (DUMMY_SCALE / 100)
          : -1,
      );

      // манекены-мишени (каждый со своим спрайтом и ростом). Скрытая мишень не рисуется.
      for (const d of dummies) {
        if (!dummyIsDrawn(d, s.controlled)) continue;
        const sprT = brokenSpritesRef.current.has(d.sprite) ? null : (spritesRef.current[d.sprite] ?? null);
        if (!sprT && !d.id.startsWith('p')) continue;
        const tpD = posOfChar(d.id, d.col, d.row);
        const yD = tpD.y + (s.field.cellH - 10) * (d.scale / 100);
        runOrQueue(() => {
          const tp = tpD;
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
          } else {
            // PNG ещё не пришёл или битый — кот всё равно стоит на клетке, не пропадает.
            ctx.beginPath();
            ctx.arc(tp.x + s.field.cellW / 2, tp.y + s.field.cellH * 0.55, 18, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fill();
          }
          if (liveRemotesRef.current.length > 0) {
            const th0 = (s.field.cellH - 10) * (d.scale / 100);
            // имя — над верхом спрайта с учётом перспективы (рост меняет depthM)
            const ny = testMode ? (tp.y + th0) * camFxRef.current.sq - th0 * depthM(tp.y + th0) : tp.y;
            const nameX = sprT ? tp.x + (sprT.width / sprT.height) * th0 * 0.5 : tp.x + s.field.cellW / 2;
            ctx.font = 'bold 12px Inter, system-ui, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = 'rgba(0,0,0,0.7)';
            ctx.fillText(d.name, nameX + 1, ny - 16);
            ctx.fillStyle = '#f4f4f5';
            ctx.fillText(d.name, nameX, ny - 17);
          }
        }, yD);
      }

      // свой кот: под управлением — по клетке движка (в мирном «тесте» — по свободной позиции),
      // иначе стоит там, где его оставили
      const spr = spritesRef.current[s.character.sprite] ?? Object.values(spritesRef.current)[0] ?? null;
      const selfId = s.controlled;
      const mainPos = selfId === 'main' ? { col: e.col, row: e.row } : mainSavedRef.current;
      const selfFree = testMode && !s.arrow.battleMode;
      const cellX = (selfFree ? e.fx : mainPos ? mainPos.col : e.col) * s.field.cellW;
      const cellY = (selfFree ? e.fy : mainPos ? mainPos.row : e.row) * s.field.cellH;
      const cxp = cellX + s.field.cellW / 2;
      const cyp = cellY + s.field.cellH / 2;
      const drawSelf = () => {
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
        // Значок блока (замок) у основания стрелы своего кота — его видит только сам
        // игрок: рисуем только из локального состояния движка, по сети не ходит.
        // Замок висит по центру точки закрепления стрелы (ARROW_ANCHOR_F), а стрела
        // рисуется позже поверх — поэтому замок оказывается «под стрелой».
        // Рисуем фигурами, а не эмодзи: заливки полностью непрозрачные и вид
        // одинаков на любой платформе (эмодзи-шрифты рендерятся по-разному).
        if (selfId === 'main' && e.blocking) {
          const th0 = (s.field.cellH - 10) * (s.character.spriteScale / 100);
          const w0 = th0 * (spr.width / spr.height);
          const ax0 = cellX + w0 * ARROW_ANCHOR_F;
          const ay0 = cellY + th0 * ARROW_ANCHOR_F + s.arrow.anchorOffsetY;
          const u = th0 * 0.3;
          ctx.save();
          ctx.globalAlpha = 1;
          // дужка — полукольцо над корпусом
          ctx.beginPath();
          ctx.arc(ax0, ay0 - u * 0.16, u * 0.2, Math.PI, Math.PI * 2);
          ctx.lineWidth = u * 0.12;
          ctx.strokeStyle = '#9aa2ab';
          ctx.stroke();
          // корпус — сплошная золотая заливка с тёмной обводкой
          rr(ctx, ax0 - u * 0.31, ay0 - u * 0.16, u * 0.62, u * 0.46, u * 0.1);
          ctx.fillStyle = '#ffb02e';
          ctx.fill();
          ctx.lineWidth = Math.max(1, u * 0.05);
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.stroke();
          // скважина
          ctx.beginPath();
          ctx.arc(ax0, ay0 + u * 0.03, u * 0.07, 0, Math.PI * 2);
          ctx.fillStyle = '#4a3200';
          ctx.fill();
          ctx.fillRect(ax0 - u * 0.035, ay0 + u * 0.03, u * 0.07, u * 0.18);
          ctx.restore();
        }
        } else if (!spr) {
          ctx.beginPath();
          ctx.arc(cxp, cyp, 18, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.fill();
        }
      };
      runOrQueue(drawSelf, cellY + (s.field.cellH - 10) * (s.character.spriteScale / 100));

      // глубинная отрисовка «теста»: препятствия встают в общую очередь с котами —
      // дерево перекрывает кота позади себя и скрывается за котом перед собой
      if (testMode) {
        for (const o of testObjects()) {
          const by = (o.r + 1) * s.field.cellH - 2;
          bills.push({
            y: by,
            fn: () =>
              drawTestObject(
                ctx,
                o.kind,
                s.field.cellW,
                s.field.cellH,
                (o.c + 0.5) * s.field.cellW,
                by,
                depthM(by),
                hashStr(o.id) & 7,
              ),
          });
        }
        bills.sort((a, b) => a.y - b.y);
        for (const b of bills) b.fn();
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
        const shown = liveRemotesRef.current.length > 0 ? (remoteAimRef.current.get(d.id)?.display ?? d.angle) : d.angle;
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
        const tm = pickStrikeTarget(s, e.col, e.row, e.angle, selfId, mpAim, liveRemotesRef.current, rabExtra());
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

      if (testMode) {
        // мир выведен, камера больше не нужна — HUD рисуем в экранных координатах
        ctx.restore();
        if (s.hud.show) drawHud(s, e, vw);
      } else if (s.hud.show) {
        drawHud(s, e);
      }
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
          fx: Math.round(st.fx * 100) / 100,
          fy: Math.round(st.fy * 100) / 100,
          format: fieldFormatRef.current,
          battle: settingsRef.current.arrow.battleMode,
          cam: { x: Math.round(camRef.current.x), y: Math.round(camRef.current.y), init: camRef.current.init },
          camFx: {
            z: Math.round(camFxRef.current.z * 100) / 100,
            sq: Math.round(camFxRef.current.sq * 100) / 100,
          },
          hopping: !!st.phop,
          route: st.proute.length,
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
          dummy: dummyOnRef.current
            ? { x: dummyPosRef.current?.x ?? null, y: dummyPosRef.current?.y ?? null, sprite: dummySpriteRef.current, grab: dummyGrabRef.current }
            : null,
          rab: rabOnRef.current ? { col: RAB_POS.col, row: RAB_POS.row } : null,
          dummies: dummiesOf(settingsRef.current, liveRemotesRef.current).map((d) => {
            const vis = remoteDrawRef.current.get(d.id);
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
  }, [stage]);

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
      // Редактор локации: Esc — закрыть (черновик без записи), игровые клавиши молчат.
      if (editorOpenRef.current) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          closeEditor();
        }
        return;
      }
      const action = keyAction(ev);
      const t = ev.target as HTMLElement | null;
      if (t && t.tagName === 'BUTTON' && (action?.type === 'chat' || ev.code === 'Space' || ev.key === ' ')) t.blur();
      // автоповтор ОС игнорируем: каждое физическое нажатие — ровно одно срабатывание;
      // темп движения ограничен только замедлением (спам не превышает скорость шага)
      if (ev.repeat) return;
      if (!action) return;
      const eB = engineRef.current;
      // Блок (удержание К): встаёт в стойку сразу, снимается отпусканием.
      if (action.type === 'block') {
        ev.preventDefault();
        // Блок — стойка игрока (своего кота): за манекеном блокировать нечего.
        if (settingsRef.current.controlled !== 'main' || eB.blocking) return;
        eB.blocking = true;
        // В блоке нельзя двигаться, бить и крутить стрелу — всё начатое прекращаем.
        eB.held = [];
        eB.path = [];
        eB.step = null;
        eB.rot = 0;
        eB.strikeHeld = false;
        netRef.current?.emit('block', { on: true });
        return;
      }
      // Пока блок держится — движение, удары и вращение не работают.
      if (eB.blocking && (action.type === 'rot' || action.type === 'strike' || action.type === 'move')) {
        ev.preventDefault();
        return;
      }
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
      // мирный «тест»: тап — немедленный шаг к соседнему якорю (зажатие довершает
      // шаги циклом); клавиши перебивают клик-маршрут, как в бою
      const sK = settingsRef.current;
      if (fieldFormatRef.current === 'test' && !sK.arrow.battleMode && sK.controlled === 'main') {
        e.proute = [];
        const hb = peaceHalfBox(sK, spritesRef.current[sK.character.sprite]);
        const here = nearestPeaceAnchor(e.fx + hb.dx, e.fy + hb.dy, sK.field.cellW, sK.field.cellH, 1e9);
        const nb = here ? peaceStepNeighbor(here.i, action.dir, sK.field.cellW, sK.field.cellH) : null;
        if (nb !== null) {
          const p = peaceAnchorPoints()[nb];
          e.proute.push({ x: p.x - hb.dx, y: p.y - hb.dy });
        }
        return;
      }
      // одиночное нажатие: шаг сразу, если предыдущий завершён, — быстрее,
      // чем разрешает замедление, двигаться нельзя
      startStepRef.current?.(action.dir);
    };
    const up = (ev: KeyboardEvent) => {
      const e = engineRef.current;
      const action = keyAction(ev);
      if (!action) return;
      if (action.type === 'block') {
        if (e.blocking) {
          e.blocking = false;
          netRef.current?.emit('block', { on: false });
        }
        return;
      }
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
      const e = engineRef.current;
      e.held = [];
      e.rot = 0;
      e.strikeHeld = false;
      // Окно потеряло фокус при зажатом блоке — стойку снимаем, иначе кот
      // остался бы в блоке навсегда (keyup уже не пришёл бы).
      if (e.blocking) {
        e.blocking = false;
        netRef.current?.emit('block', { on: false });
      }
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
    for (const d of dummiesOf(s, liveRemotesRef.current)) {
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

  /** Прямоугольник манекена под точкой (mx,my) канваса — px и размеры спрайта, либо null.
   *  Пока манекен тащат, проверка не нужна: его уже удерживает захват указателя. */
  const hitDummyObjAt = (s: SimSettings, mx: number, my: number) => {
    if (!dummyOnRef.current) return null;
    const pos = dummyPosRef.current;
    if (!pos) return null;
    const sprT = spritesRef.current[dummySpriteRef.current] ?? null;
    const b = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, 0, 0, DUMMY_SCALE);
    const px = pos.x * s.field.cellW;
    const py = pos.y * s.field.cellH;
    if (mx >= px - 4 && mx <= px + b.w + 4 && my >= py - 4 && my <= py + b.h + 4) {
      return { x: px, y: py, w: b.w, h: b.h };
    }
    return null;
  };

  const onMove = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const s = settingsRef.current;
    const e = engineRef.current;
    const testMode = fieldFormatRef.current === 'test';
    // «Тест»: мир больше вьюпорта — курсор переводится в мировые координаты через камеру
    let { mx, my } = canvasPoint(ev);
    if (testMode) {
      const cvp = canvasRef.current;
      if (cvp) {
        const rect = cvp.getBoundingClientRect();
        // обратная проекция камеры: зум сужает окно, наклон сжимает вертикаль земли
        const fxc = camFxRef.current;
        mx = (ev.clientX - rect.left - cvp.clientWidth / 2) / fxc.z + camRef.current.x;
        my = (ev.clientY - rect.top - cvp.clientHeight / 2) / (fxc.z * fxc.sq) + camRef.current.y;
      }
      // Редактор: курсор ведёт тянущийся прямоугольник (и подсвечивает клетку).
      const ed = editorRef.current;
      if (editorOpenRef.current && ed) {
        const c = Math.min(ed.cols - 1, Math.max(0, Math.floor(mx / s.field.cellW)));
        const r = Math.min(ed.rows - 1, Math.max(0, Math.floor(my / s.field.cellH)));
        if (ed.drag) {
          ed.drag.c1 = c;
          ed.drag.r1 = r;
        }
        e.hover = { c, r };
        e.hoverA = null;
        const cvE = canvasRef.current;
        if (cvE) cvE.style.cursor = 'crosshair';
        return;
      }
    }
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
      if (dg.key === DUMMY_ID) {
        // Манекен — общий: пока тащим, позиция уходит на сервер с постоянным темпом,
        // чтобы остальные видели движение в реальном времени.
        const net = netRef.current;
        if (net?.ready && nowT - dummySyncRef.current.at >= DUMMY_EMIT_MS) {
          dummySyncRef.current.at = nowT;
          net.emit('dummyMove', { x: round2(dg.x / s.field.cellW), y: round2(dg.y / s.field.cellH) });
        }
      }
      return;
    }
    const c = Math.floor(mx / s.field.cellW);
    const r = Math.floor(my / s.field.cellH);
    // подсветка клетки — в бою и только по проходимым зонам «теста»
    const hoverOk =
      c >= 0 &&
      c < s.field.cols &&
      r >= 0 &&
      r < s.field.rows &&
      (!testMode || (s.arrow.battleMode && testWalkableCell(c, r)));
    if (hoverOk) e.hover = { c, r };
    else e.hover = null;
    const cv = canvasRef.current;
    if (testMode) {
      // манекена в «тесте» нет — таскать нечего; в мирном режиме подсвечиваем якорь
      // под курсором (клик по нему задаёт шаг), в бою — обычный курсор
      if (!s.arrow.battleMode) {
        const wx = mx / s.field.cellW;
        const wy = my / s.field.cellH;
        const a = nearestPeaceAnchor(wx, wy, s.field.cellW, s.field.cellH, PEACE_SNAP_PX);
        e.hoverA = a ? { x: a.x, y: a.y } : null;
        if (cv) cv.style.cursor = a ? 'pointer' : '';
      } else {
        e.hoverA = null;
        if (cv) cv.style.cursor = '';
      }
      return;
    }
    const hov = hitTargetAt(s, mx, my);
    const hovT = hitDummyObjAt(s, mx, my);
    if (cv) cv.style.cursor = hovT || (hov && hov.id !== s.controlled) ? 'grab' : '';
  };

  const onLeave = () => {
    const e = engineRef.current;
    e.hover = null;
    e.hoverA = null;
    const cv = canvasRef.current;
    if (cv && !dragRef.current) cv.style.cursor = '';
  };

  /** Захват манекена: зажатая ЛКМ на его спрайте начинает перетаскивание.
   *  В редакторе локации зажатая кнопка начинает рисунок зоны (ПКМ — стирание). */
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const ed = editorRef.current;
    if (editorOpenRef.current && ed) {
      if (ev.button !== 0 && ev.button !== 2) return;
      const s = settingsRef.current;
      const cvp = canvasRef.current;
      let mx = 0;
      let my = 0;
      if (cvp) {
        const rect = cvp.getBoundingClientRect();
        const fxc = camFxRef.current;
        mx = (ev.clientX - rect.left - cvp.clientWidth / 2) / fxc.z + camRef.current.x;
        my = (ev.clientY - rect.top - cvp.clientHeight / 2) / (fxc.z * fxc.sq) + camRef.current.y;
      }
      const c = Math.min(ed.cols - 1, Math.max(0, Math.floor(mx / s.field.cellW)));
      const r = Math.min(ed.rows - 1, Math.max(0, Math.floor(my / s.field.cellH)));
      // Инструменты препятствий ставят/снимают камень-дерево кликом — без протягивания;
      // ПКМ по-прежнему рисует ластик, чтобы стирать зоны и объекты протяжкой.
      if (ev.button === 0 && (ed.tool === 'stone' || ed.tool === 'tree')) {
        toggleEditorObject(ed.tool, c, r);
        ev.preventDefault();
        return;
      }
      ed.drag = { c0: c, r0: r, c1: c, r1: r, erase: ev.button === 2 };
      ev.currentTarget.setPointerCapture(ev.pointerId);
      ev.currentTarget.style.cursor = 'crosshair';
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    const s = settingsRef.current;
    const { mx, my } = canvasPoint(ev);
    // Манекен тащится всегда (и в комнате с игроками — это его смысл):
    // захват до проверки манекенов, чтобы живые коты его не блокировали.
    const tObj = hitDummyObjAt(s, mx, my);
    if (tObj) {
      dragRef.current = {
        key: DUMMY_ID,
        grabDX: mx - tObj.x,
        grabDY: my - tObj.y,
        x: tObj.x,
        y: tObj.y,
        w: tObj.w,
        h: tObj.h,
        lastX: mx,
        lastY: my,
        lastT: performance.now(),
        moved: false,
      };
      // Комната видит курсор с именем тащщего; своё имя рисуем тоже — после dummyGrab.
      const net = netRef.current;
      if (net?.ready) net.emit('dummyGrab');
      ev.currentTarget.setPointerCapture(ev.pointerId);
      ev.currentTarget.style.cursor = 'grabbing';
      ev.preventDefault();
      return;
    }
    const t = hitTargetAt(s, mx, my);
    if (!t) return;
    if (liveRemotesRef.current.length > 0) return; // чужих игроков не таскаем
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
    if (dg.key === DUMMY_ID) {
      // Манекен — общий предмет: с котами не конфликтует, ставится в клетку под центром
      // и отправляет финальную позицию на сервер (без ожидания темпа рассылки).
      dummyPosRef.current = { x: c, y: r };
      dummySyncRef.current.at = performance.now();
      const net = netRef.current;
      if (net?.ready) {
        net.emit('dummyMove', { x: c, y: r });
        net.emit('dummyDrop');
      }
      return;
    }
    const e = engineRef.current;
    const mp = s.controlled === 'main' ? null : mainSavedRef.current;
    // занято любым персонажем, кроме перетаскиваемого: управляемый (движок),
    // свой кот (когда стоит сам) и остальные манекены
    const occupied = (cc: number, cr: number) => {
      if (dg.key !== s.controlled && e.col === cc && e.row === cr) return true;
      if (s.controlled !== 'main' && mp && mp.col === cc && mp.row === cr) return true;
      return dummiesOf(s, liveRemotesRef.current).some((d) => d.id !== dg.key && d.col === cc && d.row === cr);
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
    // Редактор: отпускание кнопки завершает рисунок — прямоугольник становится зоной.
    const ed = editorRef.current;
    if (editorOpenRef.current && ed) {
      try {
        ev.currentTarget.releasePointerCapture(ev.pointerId);
      } catch {
        /* захват мог уже сняться */
      }
      commitEditorDrag();
      const cvE = canvasRef.current;
      if (cvE) cvE.style.cursor = 'crosshair';
      return;
    }
    if (!dragRef.current) return;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* захват мог уже сняться */
    }
    dropTarget();
  };

  /** ПКМ в редакторе — стирание без смены инструмента; вне редактора меню не нужно. */
  const onContextMenu = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    ev.preventDefault();
  };

  const onClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    // клик сразу после перетаскивания маршрут не строит
    if (skipClickRef.current) {
      skipClickRef.current = false;
      return;
    }
    // В редакторе клики обрабатывает рисунок зон (pointer down/up) — маршруты не строим.
    if (editorOpenRef.current && editorRef.current) return;
    const s = settingsRef.current;
    const e = engineRef.current;
    const testMode = fieldFormatRef.current === 'test';
    let { mx, my } = canvasPoint(ev);
    if (testMode) {
      const cvp = canvasRef.current;
      if (!cvp) return;
      const rect = cvp.getBoundingClientRect();
      // обратная проекция камеры: зум сужает окно, наклон сжимает вертикаль земли
      const fxc = camFxRef.current;
      mx = (ev.clientX - rect.left - cvp.clientWidth / 2) / fxc.z + camRef.current.x;
      my = (ev.clientY - rect.top - cvp.clientHeight / 2) / (fxc.z * fxc.sq) + camRef.current.y;
      if (!s.arrow.battleMode) {
        // мирный «тест»: клик по якорной точке — шагаем к ней по соседним якорям;
        // новый клик перезапускает маршрут с текущего места
        const a = nearestPeaceAnchor(mx / s.field.cellW, my / s.field.cellH, s.field.cellW, s.field.cellH, PEACE_SNAP_PX);
        if (!a) return;
        const hb = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        const here = nearestPeaceAnchor(e.fx + hb.dx, e.fy + hb.dy, s.field.cellW, s.field.cellH, 1e9);
        if (!here) return;
        e.proute = peaceRoute(here.i, a.i).map((i) => {
          const p = peaceAnchorPoints()[i];
          return { x: p.x - hb.dx, y: p.y - hb.dy };
        });
        return;
      }
    }
    const c = Math.floor(mx / s.field.cellW);
    const r = Math.floor(my / s.field.cellH);
    if (c < 0 || c >= s.field.cols || r < 0 || r >= s.field.rows) return;
    if (testMode && !testWalkableCell(c, r)) return;
    // клетки персонажей непроходимы — маршрут через/на них не строится;
    // в «тесте» непроходимы и клетки вне зон клеточной ходьбы
    const mp = s.controlled === 'main' ? null : mainSavedRef.current;
    e.path = bfsPath(
      e.col,
      e.row,
      c,
      r,
      s.field.cols,
      s.field.rows,
      [
        ...othersOf(s, s.controlled, mp, liveRemotesRef.current, objectExtras()).map((t) => ({ c: t.col, r: t.row })),
        ...(testMode ? testNonWalkableCells() : []),
      ],
    );
  };

  /* ---------- броня ---------- */

  /** Пресет брони уходит на сервер при смене кнопкой (и повторяется после
   *  переподключения — см. onYou). Сервер режет этой бронёй входящий урон;
   *  соседям значение не рассылается — они видят уже порезанный урон в fight.
   *  Пока сокета нет, emit просто молчит: onYou всё равно пришлёт запрос заново. */
  const armorLevel = settings.combat.armorLevel;
  useEffect(() => {
    netRef.current?.emit('armor', { armor: armorLevel / 10 });
  }, [armorLevel]);

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

  /** Применение результата удара: расчёт и отправка на сервер — сразу при нажатии,
   *  локальные видимые эффекты — с откликом удара (visual=true). */
  const landStrike = useCallback((snap: { angle: number; col: number; row: number; flightMs?: number }, visual: boolean) => {
    const s = settingsRef.current;
    const e = engineRef.current;
    const now = performance.now();
    const cellCX = (cc: number) => cc * s.field.cellW + s.field.cellW / 2;
    const cellCY = (cr: number) => cr * s.field.cellH + s.field.cellH / 2;
    const selfId = s.controlled;
    const mp = selfId === 'main' ? null : mainSavedRef.current;

    /** Кого задел удар: единственный соседний персонаж, а если соседних несколько —
     *  тот, на который точнее наведена стрела. null — рядом никого. */
    const t = pickStrikeTarget(s, snap.col, snap.row, snap.angle, selfId, mp, liveRemotesRef.current, rabExtra());
    /** Лаповая зона пресета бьющего: урон, который уходит на сервер для удара по блоку. */
    const zPaws = s.combat.zones.find((zz) => zz.id === 'paws');
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

    if (!t) {
      // рядом никого — удар в пустоту (без надписи и без строки в логе)
      entry = { target: '', zoneId: 'miss', zoneLabel: 'мимо', count: 1, actor: 'Я' };
    } else {
      const tCol = t.col;
      const tRow = t.row;
      const dx = tCol - snap.col;
      const dy = tRow - snap.row;
      const targetBlocking =
        t.id.startsWith('p') && remoteBlockRef.current.has(Number(t.id.slice(1)));
      // Прицельная зона считается ДО блока: хвост — исключение из блока, поэтому
      // важно знать, куда именно шла стрела, даже по блокирующему игроку.
      let aimed: StrikeZone | null | undefined;
      if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
        // Удар с диагонали: зона задаётся стойкой относительно цели, а стрела обязана
        // стоять в окне замедления направления на цель:
        //  слева-сверху (стрела вправо-вниз, окно 45°) и справа-сверху (влево-вниз, 135°) — Морда,
        //  слева-снизу (стрела вправо-вверх, 315°) — Лапы, справа-снизу (влево-вверх, 225°) — Хвост.
        // Вне окна направления — промах, из полос тела с диагонали ничего не берётся.
        const phi = wrap360((Math.atan2(dy, dx) * 180) / Math.PI);
        const forcedId = phi === 45 || phi === 135 ? 'muzzle' : phi === 225 ? 'tail' : 'paws';
        const win = s.slowdown.windows[String(phi) as WindowKey];
        aimed = win && inWindow(snap.angle, win) ? s.combat.zones.find((zz) => zz.id === forcedId) : undefined;
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
        aimed = hit.hit ? resolveZonePixel(hit.ny, entrySide(hit), s.combat.zones) : null;
      }
      // Блок цели: ЛЮБОЙ удар по блокирующему игроку — в «Лапы», куда бы стрела
      // ни шла и с какой стойки ни бьём (прямая/диагональ, любое окно).
      // Единственное исключение — хвост: удар в хвост блок не ловит и остаётся
      // хвостом (хвост — зона с самым маленьким получаемым уроном).
      const z = targetBlocking && zPaws ? (aimed && aimed.id === 'tail' ? aimed : zPaws) : aimed;
      if (z) {
        hitDamage = z.damage;
        struck = t;
        // Манекены и РАБ без брони: полученный урон = урон зоны. По живым игрокам
        // строку с реальным уроном (после брони) принесёт fight от сервера.
        entry = { target: t.name, zoneId: z.id, zoneLabel: z.name, count: 1, actor: 'Я', dmg: hitDamage };
      } else {
        // луч прошёл мимо тела — промах, без надписи и без строки в логе
        entry = { target: '', zoneId: 'miss', zoneLabel: 'мимо', count: 1, actor: 'Я' };
      }
    }

    // Локальные эффекты (манекен, промах, РАБ, оффлайн) проявляются с откликом удара:
    // сетевой удар уже улетел при нажатии — окно отклика бьющего на цель не тратим.
    if (!visual) {
      const id = window.setTimeout(() => landStrike(snap, true), strikeResponseMs(settingsRef.current));
      pendingStrikesRef.current.push(id);
      return;
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
        // Урон едет вместе с ударом: это пресет «Урон игрока» бьющего.
        // Сервер нормализует число и раздаёт fight с этим уроном всей комнате —
        // иначе у цели всегда будет серверная таблица, и пресет 0,0–0,9 не работает.
        // pawsDamage — лаповый урон пресета: если блок встанет за время полёта,
        // сервер переведёт удар в «Лапы» и спишет именно его. Исключение — хвост:
        // блок не переносит удар из хвоста в «Лапы». flightMs — окно отклика
        // бьющего: столько удар «летит» на сервере, и блок успевает его поймать.
        netRef.current.emit('strike', {
          target,
          zone: entry.zoneId,
          angle: snap.angle,
          damage: hitDamage,
          pawsDamage: zPaws ? zPaws.damage : undefined,
          flightMs: snap.flightMs,
        });
        return;
      }
    }

    if (hitDamage !== null && struck) {
      const z = s.combat.zones.find((zz) => zz.id === entry.zoneId);
      if (z) pushDamageLabel(z, struck.col, struck.row);
      // Попадание по мишени РАБ качает её «желе»; бьющий анимирует локально,
      // остальных догоняет rabHit от сервера — анимация видна всей комнате.
      if (struck.id === RAB_ID) {
        jellyRef.current[RAB_ID] = 1;
        if (netRef.current?.ready) {
          netRef.current.emit('rabHit', {
            zone: entry.zoneId,
            part: entry.zoneLabel,
            damage: hitDamage,
          });
        }
      }
    }

    // энергия и лог обновляются функционально от последнего состояния,
    // чтобы не затирать параллельные изменения (например, тик регенерации)
    setCombat((prev) => {
      const es = Math.max(1, s.combat.energyStart);
      let playerEnergy = prev.playerEnergy;
      const de = pruneRemoteEnergy(prev.dummyEnergy, s, liveRemotesRef.current, rabOnRef.current ? [RAB_ID] : []);
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
    // В блоке бить нельзя.
    if (e.blocking) return;
    // удар не проходит, пока стрела вращается (J/L) — сначала нужно остановить стрелу
    if (e.rot !== 0 || e.rotActive !== 0) return;
    // В комнате без связи удар по чужим котам локально не моделируется:
    // иначе получился бы «зомби»-урон, которого нет у остальных.
    if (s.controlled === 'main' && liveRemotesRef.current.length > 0 && !netRef.current?.ready) return;
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
    // Стойка, угол, расчёт и отправка удара — в момент нажатия. Раньше удар ещё
    // resp ждал на клиенте, а сервер потом то же окно полёта: до касания шло
    // ~два отклика. Теперь окно одно, серверное (flightMs) — блок цели успевает.
    const snap = { angle: e.angle, col: e.col, row: e.row, flightMs: resp };
    landStrike(snap, false);
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

  const sendChat = useCallback((text: string) => {
    const net = netRef.current;
    if (!net?.ready) return false;
    net.emit('chat', { text });
    return true;
  }, []);

  /** Вход с экрана entry: подтверждённые кот/имя/размер + комната. Сокет уже
   *  слушает комнаты — join уходит в ту же связь. Настройки персонажа применяем
   *  здесь же: дальше экран входа размонтируется. */
  const joinFromEntry = useCallback(
    (roomId: string, who: { name: string; sprite: SpriteId; scale: number }) => {
      const login = who.name.trim().slice(0, 24);
      if (!login) return;
      const sprite = SPRITES.some((sp) => sp.id === who.sprite) ? who.sprite : settingsRef.current.character.sprite;
      const scale = Math.min(100, Math.max(60, Math.round(who.scale)));
      setSettings((s) => ({
        ...s,
        controlled: 'main',
        character: { ...s.character, sprite, spriteScale: scale },
      }));
      pendingJoinRef.current = { room: roomId, login, sprite, scale };
      setNetStarted(true);
      pickRoom(roomId);
    },
    [pickRoom],
  );

  const fieldW = settings.field.cols * settings.field.cellW;
  const fieldH = settings.field.rows * settings.field.cellH;
  /** Комната «тест»: канвас — вьюпорт с камерой, поле не вписывается в кадр. */
  const testField = fieldFormat === 'test';

  // Канвас рисуется в пикселях клеток (10×100 на 6×150). Боковые колонки (чат и лог)
  // живут рядом с полем, поэтому кадр отдаётся полю целиком: размер вписывается и по
  // ширине, и по высоте, а сверх клеточного размера допускается растяжение до 2× —
  // рендер учитывает devicePixelRatio, так что картинка остаётся чёткой.
  // На узком экране высота следует за шириной, а страница прокручивается вместе с полем.
  useLayoutEffect(() => {
    const frame = fieldFrameRef.current;
    if (!frame) return;
    if (fieldFormatRef.current === 'test') return; // вьюпорт «теста» не вписывается — он и так весь кадр
    const mq = window.matchMedia('(min-width: 64rem)');
    const fit = () => {
      const cs = getComputedStyle(frame);
      const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const availW = Math.max(0, frame.clientWidth - padX);
      const availH = Math.max(0, frame.clientHeight - padY);
      let w = Math.min(availW, fieldW * FIELD_MAX_UPSCALE);
      let h = fieldH * (w / Math.max(1, fieldW));
      if (mq.matches && availH > 0 && h > availH) {
        h = Math.min(availH, fieldH * FIELD_MAX_UPSCALE);
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
  }, [fieldW, fieldH, stage]);

  /** Смена темы: перекрашивает интерфейс и, если цвета поля не настроены вручную,
   *  подгоняет палитру поля под тему (иначе доска остаётся тёмной на светлой теме). */
  const changeTheme = useCallback(
    (t: ThemeId) => {
      setTheme(t);
      applyTheme(t);
      const cur = {
        bgColor: settingsRef.current.field.bgColor,
        bgColorAlt: settingsRef.current.field.bgColorAlt,
        gridColor: settingsRef.current.field.gridColor,
      };
      if (fieldPaletteOf(cur) !== null) patchField(FIELD_PRESETS[t]);
    },
    [patchField],
  );

  /** Карточки для выбора: три грота (состав из roomsinfo) + комната из ссылки,
   *  если в URL стоит чужой код (?room=...) — старые ссылки продолжают работать. */
  const roomRows: RoomRow[] = (() => {
    const info = new Map((roomsRows ?? []).map((r) => [r.id, r]));
    const rows: RoomRow[] = ROOMS.map((r) => ({
      id: r.id,
      title: r.title,
      count: info.get(r.id)?.count ?? 0,
      logins: info.get(r.id)?.logins ?? [],
      here: r.id === roomCode,
    }));
    const urlRoom = roomFromUrl();
    if (urlRoom && urlRoom !== 'demo' && !ROOMS.some((r) => r.id === urlRoom)) {
      rows.push({
        id: urlRoom,
        title: `Комната из ссылки: ${urlRoom}`,
        count: info.get(urlRoom)?.count ?? 0,
        logins: info.get(urlRoom)?.logins ?? [],
        here: urlRoom === roomCode,
      });
    }
    return rows;
  })();

  if (stage === 'entry') {
    return (
      <div className="app-bg relative h-dvh text-[var(--sim-text)]">
        <ThemeBackdrop theme={theme} />
        <div className="relative z-10 h-dvh overflow-y-auto">
          {loaded ? (
            <EntryScreen
              initialSprite={settings.character.sprite}
              initialName={nameFromUrl().slice(0, 24)}
              initialScale={settings.character.spriteScale}
              periodSec={settings.arrow.periodSec}
              damageLevel={settings.combat.damageLevel}
              armorLevel={settings.combat.armorLevel}
              roomRows={roomRows}
              roomsReady={roomsRows !== null}
              roomsStale={roomsStale}
              onPickRoom={joinFromEntry}
              onApplySpeed={(v) => patchArrow({ periodSec: v })}
              onApplyDamage={(k) => {
                const prev = settingsRef.current.combat;
                const prevThroat = Math.max(1, throatDamageFor(prev.damageLevel));
                const nextThroat = Math.max(1, throatDamageFor(k));
                patchCombat({
                  damageLevel: k,
                  // геометрия зон (px, сторона, цвет) сохраняется — меняется только урон;
                  // масштабируем ТЕКУЩИЙ урон зон: ручные правки зон (админка) не стираются.
                  // Раньше пересчёт шёл от базовых значений, и правленые Лапы 2% при смене
                  // пресета превращались в базовые × множитель (до 10% и выше).
                  zones: prev.zones.map((z) => ({
                    ...z,
                    damage: Math.max(0, Math.round((z.damage * nextThroat) / prevThroat)),
                  })),
                });
              }}
              onApplyArmor={(k) => patchCombat({ armorLevel: k })}
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="app-bg relative flex h-dvh min-h-0 flex-col overflow-hidden text-[var(--sim-text)]">
      <ThemeBackdrop theme={theme} />
      <header className="relative z-10 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--sim-line)] bg-[var(--sim-panel)] px-4 py-2.5">
        <div>
          <h1 className="text-base font-bold leading-tight">Общее поле</h1>
          <p className="text-[11px] text-[var(--sim-text-faint)]">
            {settings.field.cols}×{settings.field.rows} · {roomCode ? roomTitle(roomCode) : 'комната не выбрана'} · {peerCount} на поле
          </p>
        </div>
        {/* Панелька выбранных скрытых параметров (СП): живая, повторяет блок «Выбор СП» с экрана входа */}
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-[var(--sim-line-strong)] bg-[var(--sim-inset-soft)] px-2.5 py-1 text-[11px]"
          aria-label="Выбранные скрытые параметры"
        >
          <span className="font-bold text-[var(--sim-text)]">СП:</span>
          <span className="text-[var(--sim-text-muted)]">
            стрела <b className="font-semibold text-[var(--sim-text)]">{fmtSec(settings.arrow.periodSec)}</b>
          </span>
          <span className="text-[var(--sim-text-faint)]">·</span>
          <span className="text-[var(--sim-text-muted)]">
            дамаг <b className="font-semibold text-[var(--sim-text)]">{damageLevelLabel(settings.combat.damageLevel)}</b>
          </span>
          <span className="text-[var(--sim-text-faint)]">·</span>
          <span className="text-[var(--sim-text-muted)]">
            броня <b className="font-semibold text-[var(--sim-text)]">{damageLevelLabel(settings.combat.armorLevel)}</b>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          <Button
            size="sm"
            variant="outline"
            className="btn-neutral h-8 text-xs"
            onClick={() => {
              setRoomsStale(false);
              setSwitchOpen(true);
            }}
          >
            Перейти в другую комнату
          </Button>
          <span className="max-w-[280px] truncate text-[var(--sim-text-muted)]">{netStatus}</span>
        </div>
        <div className="relative z-10 ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-[var(--sim-text-muted)]">
            тема
            <select
              value={theme}
              onChange={(ev) => changeTheme(ev.target.value as ThemeId)}
              className="h-8 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-input-bg)] px-1.5 text-xs text-[var(--sim-text)] outline-none"
            >
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {fieldFormat === 'test' ? (
            <Button
              size="sm"
              variant={editorOpen ? 'default' : 'outline'}
              className={
                editorOpen
                  ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
                  : 'btn-neutral h-8 text-xs'
              }
              onClick={() => (editorOpen ? closeEditor() : openEditor())}
            >
              Редактор локации
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={settings.arrow.battleMode ? 'default' : 'outline'}
            className={
              settings.arrow.battleMode
                ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]'
                : 'btn-neutral h-8 text-xs'
            }
            onClick={() => patchArrow({ battleMode: !settings.arrow.battleMode })}
          >
            Боевой режим: {settings.arrow.battleMode ? 'ВКЛ' : 'ВЫКЛ'} (B)
          </Button>
          <Button
            size="sm"
            variant={settingsOpen ? 'default' : 'outline'}
            className={settingsOpen ? 'h-8 bg-[var(--sim-accent)] text-xs text-white hover:bg-[var(--sim-accent-hover)]' : 'btn-neutral h-8 text-xs'}
            onClick={() => setSettingsOpen((v) => !v)}
          >
            Настройки
          </Button>
        </div>
      </header>

      {/* Один ряд: чат слева · поле в центре · лог ударов справа.
          Ширины колонок тянутся разделителями и запоминаются. */}
      <main
        className="relative z-10 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 lg:flex-row lg:gap-0 lg:overflow-hidden lg:p-3"
        style={{ '--chat-w': `${layout.chatW}px`, '--log-w': `${layout.logW}px` } as CSSProperties}
      >
        <div className="flex h-56 w-full shrink-0 flex-col lg:h-auto lg:min-h-0 lg:w-[var(--chat-w)]">
          <RoomChat lines={chatLines} meId={meId} canSend={netReady} onSend={sendChat} />
        </div>
        <ColResize
          onDrag={(dx) => setLayout((p) => ({ ...p, chatW: clampLayout({ ...p, chatW: p.chatW + dx }).chatW }))}
          onEnd={() => saveLayout(layoutRef.current)}
        />

        <section className="flex w-full min-w-0 flex-col gap-2 lg:h-full lg:min-h-0 lg:flex-1">
          <div className="relative w-full min-w-0 flex-1 lg:min-h-0">
            <div
              ref={fieldFrameRef}
              role="region"
              aria-label="Игровое поле"
              className="relative overflow-hidden rounded-xl border border-[var(--sim-line)] bg-[var(--sim-frame)] p-2 lg:absolute lg:inset-0"
            >
              <canvas
                ref={canvasRef}
                className={testField ? 'block h-full w-full cursor-crosshair rounded-lg' : 'mx-auto block max-w-full cursor-crosshair rounded-lg'}
                style={
                  testField
                    ? undefined
                    : fieldFit
                      ? { width: fieldFit.w, height: fieldFit.h }
                      : { width: '100%', maxWidth: fieldW, aspectRatio: `${fieldW} / ${fieldH}` }
                }
                onPointerMove={onMove}
                onPointerDown={onPointerDown}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={onLeave}
                onContextMenu={onContextMenu}
                onClick={onClick}
              />
              {editorOpen && editorView ? (
                <div className="absolute left-3 top-3 z-20 flex max-h-[calc(100%-24px)] w-[272px] flex-col overflow-hidden rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] shadow-xl">
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--sim-line)] px-3 py-2">
                    <div className="text-xs font-bold">Редактор локации</div>
                    <button
                      type="button"
                      aria-label="Закрыть редактор"
                      className="btn-neutral flex h-6 w-6 items-center justify-center rounded-md text-xs"
                      onClick={closeEditor}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 text-[11px]">
                    <div>
                      <div className="mb-1 font-semibold text-[var(--sim-text-muted)]">Инструмент</div>
                      <div className="flex gap-1.5">
                        {(
                          [
                            { id: 'cells', label: 'Клетки' },
                            { id: 'green', label: 'Зелёная' },
                            { id: 'erase', label: 'Ластик' },
                          ] as { id: EditorTool; label: string }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={
                              editorView.tool === t.id
                                ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1.5 py-1 font-semibold text-white'
                                : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1'
                            }
                            onClick={() => setEditorTool(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        {(
                          [
                            { id: 'stone', label: '⛰ Камень' },
                            { id: 'tree', label: '🌲 Дерево' },
                          ] as { id: EditorTool; label: string }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={
                              editorView.tool === t.id
                                ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1.5 py-1 font-semibold text-white'
                                : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1'
                            }
                            onClick={() => setEditorTool(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      <p className="mt-1 leading-snug text-[var(--sim-text-faint)]">
                        Тяните по полю — зона. Камень и дерево — клик по клетке:
                        поставить, повторный клик — убрать. Через них нельзя пройти.
                      </p>
                    </div>
                    <div>
                      <div className="mb-1 font-semibold text-[var(--sim-text-muted)]">Размер мира</div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-4 text-[var(--sim-text-faint)]">Ш</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols - 1, editorView.rows)}>
                          −
                        </button>
                        <span className="w-7 text-center font-semibold">{editorView.cols}</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols + 1, editorView.rows)}>
                          +
                        </button>
                        <span className="ml-2 w-4 text-[var(--sim-text-faint)]">В</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols, editorView.rows - 1)}>
                          −
                        </button>
                        <span className="w-7 text-center font-semibold">{editorView.rows}</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols, editorView.rows + 1)}>
                          +
                        </button>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <button type="button" className="btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1" onClick={undoEditor}>
                        Отменить
                      </button>
                      <button type="button" className="btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1" onClick={resetEditor}>
                        Сбросить
                      </button>
                    </div>
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-semibold text-[var(--sim-text-muted)]">
                          Зоны ({editorView.zones.length}/{TEST_MAP_LIMITS.zonesMax})
                        </span>
                        {editorView.dirty ? <span className="text-[10px] text-[var(--sim-text-faint)]">не сохранено</span> : null}
                      </div>
                      {editorView.sel.length >= 2 ? (
                        <button
                          type="button"
                          className="mb-1.5 w-full rounded-md bg-[var(--sim-accent)] px-1.5 py-1 text-[11px] font-semibold text-white hover:bg-[var(--sim-accent-hover)]"
                          onClick={mergeEditorZones}
                        >
                          Объединить ({editorView.sel.length})
                        </button>
                      ) : (
                        <p className="mb-1.5 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                          Отметьте галочками две и более зон — появится кнопка объединения.
                        </p>
                      )}
                      <div className="flex flex-col gap-1">
                        {editorView.zones.map((z) => (
                          <div key={z.id} className="flex items-center gap-1.5 rounded-md border border-[var(--sim-line)] bg-[var(--sim-inset-soft)] px-1.5 py-1">
                            <input
                              type="checkbox"
                              checked={editorView.sel.includes(z.id)}
                              onChange={() => toggleEditorSel(z.id)}
                              className="h-3 w-3 shrink-0 accent-[var(--sim-accent)]"
                              aria-label={`Отметить зону ${z.name} для объединения`}
                            />
                            <span
                              aria-hidden
                              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                              style={{ background: z.kind === 'cells' ? 'rgba(120,170,250,0.85)' : 'rgba(112,178,92,0.9)' }}
                            />
                            <input
                              value={z.name}
                              onChange={(ev2) => renameEditorZone(z.id, ev2.target.value)}
                              className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-0.5 py-0.5 text-[11px] outline-none focus:border-[var(--sim-line-strong)] focus:bg-[var(--sim-input-bg)]"
                              aria-label="Название зоны"
                            />
                            <span className="shrink-0 text-[10px] text-[var(--sim-text-faint)]">
                              {z.c1 - z.c0 + 1}×{z.r1 - z.r0 + 1}
                            </span>
                            <button
                              type="button"
                              aria-label={`Удалить зону ${z.name}`}
                              className="btn-neutral flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px]"
                              onClick={() => deleteEditorZone(z.id)}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        {editorView.zones.length === 0 ? (
                          <p className="text-[var(--sim-text-faint)]">Пока пусто — нарисуйте первую зону.</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-auto flex flex-col gap-1.5 border-t border-[var(--sim-line)] pt-2.5">
                      <input
                        type="password"
                        value={editorPass}
                        onChange={(ev2) => setEditorPass(ev2.target.value)}
                        placeholder="Пароль редактора"
                        aria-label="Пароль редактора локации"
                        className="h-7 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-input-bg)] px-2 text-[11px] text-[var(--sim-text)] outline-none"
                      />
                      <button
                        type="button"
                        className="h-8 rounded-md bg-[var(--sim-accent)] px-2 text-xs font-semibold text-white hover:bg-[var(--sim-accent-hover)]"
                        onClick={saveEditorMap}
                      >
                        Сохранить локацию
                      </button>
                      {editorMsg ? <p className="leading-snug text-[var(--sim-text-muted)]">{editorMsg}</p> : null}
                      <p className="leading-snug text-[10px] text-[var(--sim-text-faint)]">
                        Сохранение применяет локацию всем в комнате сразу.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-[var(--sim-text-faint)]">
            <span>W A S D — шаг (те же клавиши на русской: ц ф ы в; зажатие — раз в 120 мс с учётом замедления; спам быстрее не сделает)</span>
            <span>Q E Z X — диагонали</span>
            <span>ЛКМ — маршрут · манекен — тянуть</span>
            <span>B — бой</span>
            <span>Enter — чат</span>
            <span>I — удар</span>
            <span>K (удерживать) — блок</span>
            <span>J — стрела против часовой</span>
            <span>L — по часовой</span>
            <span className="ml-auto">
              Скорость = 100% − замедление · замедление фиксируется в момент прыжка
            </span>
          </div>
        </section>

        {settings.arrow.battleMode && settings.combat.showLog ? (
          <>
            <ColResize
              onDrag={(dx) => setLayout((p) => ({ ...p, logW: clampLayout({ ...p, logW: p.logW - dx }).logW }))}
              onEnd={() => saveLayout(layoutRef.current)}
            />
            <div className="flex h-44 w-full shrink-0 flex-col lg:h-auto lg:min-h-0 lg:w-[var(--log-w)]">
              <FightLog
              lines={combat.log.map(formatLogLine)}
              onClear={() => setCombat((c) => ({ ...c, log: [] }))}
            />
            </div>
          </>
        ) : null}
      </main>

      {/* Надпись об авторах внизу страницы поля */}
      <footer className="relative z-10 shrink-0 pb-1 text-center">
        <p className="text-[10px] leading-tight text-[var(--sim-text-faint)]">{GAME_CREDITS}</p>
      </footer>

      {/* Настройки — выдвижная панель поверх поля: место экрана не отдаёт, открывается кнопкой в шапке */}
      {settingsOpen ? (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setSettingsOpen(false)} />
          <aside
            className="fixed inset-y-0 right-0 z-40 flex w-[min(400px,92vw)] flex-col border-l border-[var(--sim-line)] bg-[var(--sim-panel)] shadow-2xl"
            onKeyDown={(ev) => {
              if (ev.key === 'Escape') setSettingsOpen(false);
            }}
          >
            <div className="flex items-center justify-between border-b border-[var(--sim-line)] px-3 py-2">
              <h2 className="text-sm font-bold text-[var(--sim-text)]">Настройки</h2>
              <Button size="sm" variant="outline" className="btn-neutral h-7 text-xs" onClick={() => setSettingsOpen(false)}>
                Закрыть
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <SettingsPanel
                settings={settings}
                testField={testField}
                dummyOn={dummyOn}
                onToggleDummy={toggleDummy}
                dummySprite={dummySprite}
                onDummySprite={changeDummySprite}
                rabOn={rabOn}
                onToggleRab={toggleRab}
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
            </div>
          </aside>
        </>
      ) : null}

      {/* Переход в другую комнату — модалка с тем же выбором гротов.
          Текущая комната помечена «вы здесь», клик по ней disabled. */}
      {switchOpen ? (
        <>
          <div className="fixed inset-0 z-30 bg-black/50" onClick={() => setSwitchOpen(false)} />
          <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto p-4">
            <div className="w-full max-w-3xl rounded-2xl border border-[var(--sim-line)] bg-[var(--sim-panel)] shadow-2xl">
              <RoomPicker
                rows={roomRows}
                ready={roomsRows !== null}
                stale={roomsStale}
                onPick={pickRoom}
                onCancel={() => setSwitchOpen(false)}
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
