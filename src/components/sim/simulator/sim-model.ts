/**
 * Shared state shapes and pure helpers of the Simulator feature, carved out of
 * simulator.tsx verbatim (W5b stage 2, behavior-preserving; the explanatory
 * comments below travel with the code). Contract:
 *  - types: `AtmosphereLike`/`AtmoClock` (minimal shape of the dynamic Pixi
 *    layer and its room clock), `FloatLabel`/`Step`/`Engine` (shape of the
 *    main rAF-closure state, referenced by hooks and simulator);
 *  - helpers: `fmtSec` (arrow-speed label for the header), `rememberRemoteCell` /
 *    `stepRemoteDraws` (remote cat draw advance — they consume lib/net/move-book,
 *    so they can never move to src/lib/sim; see ARCHITECTURE §1).
 * No React imports in this file.
 */
import type { DayPart, DummyConfig, WeatherKind } from '@/lib/sim/settings';
import { advanceRemoteDraw, enqueueRemoteCell, seedRemoteDraw, type RemoteDraw } from '@/lib/net/move-book';

/** Минимальный облик слоя атмосферы. Модуль с PixiJS грузится динамически (чтобы
 *  не попадать в основной бандл и не падать при SSR), поэтому здесь только интерфейс. */
export interface AtmosphereLike {
  setDayProgress(p: number): void;
  setDaypart(dp: DayPart): void;
  setWeather(w: WeatherKind): void;
  frame(now: number, dtMs: number, camDx: number, camDy: number): void;
  destroy(): void;
}

/** Часы атмосферы: якорь комнаты с сервера либо локальный (поле без сети).
 *  srv — якорь пришёл с сервера: тогда погоду двигает только он. */
export interface AtmoClock {
  cs: number;
  pl: number;
  wl: number;
  w: WeatherKind;
  ws: number;
  srv: boolean;
}

/** «4,8 сек» — подпись скорости стрелы для панели СП в шапке. */
export const fmtSec = (v: number) => `${v.toFixed(1).replace('.', ',')} сек`;

/** Темп достройки чужого шага: не быстрее одной клетки в это время.
 *  Пачка кадров после лага не превращается в спринт через всё поле. */
const REMOTE_STEP_MS = 60;
/** Дальше этого отставания чужого кота не анимируем — сразу ставим в клетку сервера. */
const REMOTE_BACKLOG_MAX = 4;

export interface FloatLabel {
  x: number;
  y: number;
  born: number;
  text: string;
  color: string;
}

export interface Step {
  dir: number;
  sd: number;
  start: number;
  dur: number;
}

export interface Engine {
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
  /** Мирный режим: цель ходьбы по клику (клеточные доли, левый верх спрайта).
   *  stuck/lastD — копилка «нет прогресса» (мс) и прошлая дистанция: цель
   *  упирается в стену — ходьба отменяется. null — стоит на месте. */
  ptarget: { x: number; y: number; stuck: number; lastD: number } | null;
  /** Мирный режим: скорость кота (px мира/с, в экранных осях) — разгон и
   *  «выбегание» с инерцией: кот не встаёт как вкопанный, а мягко тормозит. */
  pvx: number;
  pvy: number;
  /** Куда смотрит моделька в мирном режиме: 1 — вправо (зеркало), -1 — влево
   *  (как нарисован спрайт). Меняется от направления бега — с «желе». */
  face: 1 | -1;
  /** performance.now() последнего кадра спринта — после него выбегание дольше. */
  lastSprint: number;
  /** Прыжок через обрыв (по отпусканию Пробела с зарядом): мирный — лерп fx/fy
   *  с дугой, боевой — клетка уже сменилась, лерп рисуется по px. l0/l1 — подъём
   *  земли (px) в точках отрыва и посадки. null — кот на земле. */
  leap: {
    battle: boolean;
    t0: number;
    dur: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    l0: number;
    l1: number;
    zH: number;
  } | null;
  /** Текущая высота дуги прыжка, px (рисование; в update пересчитывается). */
  leapZ: number;
  /** Сглаженный подъём земли под своим котом, px: цель — уровень его клетки,
   *  догоняет экспоненциально — шаг на уступ не телепортирует модельку. */
  liftV: number;
}

/**
 * Живые соседи с сервера и их отрисовка. Состояние живёт в refs внутри компонента
 * (liveRemotesRef, remoteAimRef, remoteDrawRef), а не в модульных переменных:
 * два экземпляра Simulator не должны делить состояние, а cleanup одного
 * не должен обнулять поле другого.
 * (Не уехали в lib/sim/targeting волной W5a: функции потребуют lib/net/move-book,
 * а lib/sim не знает сетевого слоя — ARCHITECTURE §1.)
 */

export function rememberRemoteCell(map: Map<string, RemoteDraw>, id: string, col: number, row: number) {
  const vis = map.get(id);
  if (!vis) {
    map.set(id, seedRemoteDraw({ col, row }));
    return;
  }
  enqueueRemoteCell(vis, { col, row });
}

export function stepRemoteDraws(remotes: DummyConfig[], map: Map<string, RemoteDraw>, now: number) {
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
