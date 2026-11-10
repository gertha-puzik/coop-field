/**
 * Сенсорное управление котом для тач-экранов — семантика 1:1 с клавиатурой
 * из use-keyboard.ts (WASD + Space), только события приходят от пальца.
 * Джойстик: «палец лёг на сектор» повторяет keydown 'move' (пуш угла в
 * engine.held, снятие клик-цели мирной комнаты, startStep в сетке/бою),
 * «ушёл с сектора» — keyup 'move'. Кнопка «прыжок»: удержание = keydown
 * Space (заряд приседа, emit space on:true), отпускание = keyup Space
 * (charge по времени удержания уходит в leapRequestRef, игровой цикл
 * запускает прыжок; emit space on:false/hold). Гварды те же: прыжок —
 * только для своего кота и не в блоке. Все мутабельные ref-ы приходят
 * пропсами (TouchControlsDeps), как SimKeyboardDeps у use-keyboard.
 *
 * Отличия от use-keyboard, намеренные:
 *  - сектор джойстика переключается перетаскиванием: смена сектора = keyup
 *    старого угла + keydown нового (эквивалент двух быстрых клавиш W→D);
 *  - мёртвая зона у центра — «нейтраль»: направление отпускается;
 *  - размонтирование (открылся редактор локации) повторяет window blur из
 *    use-keyboard: зажатое тихо снимается, недожатый присед гасится без
 *    «выстрела» (emit space on:false/cancel:true — чужим просто выпрямление).
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { SimSettings } from '@/lib/sim/settings';
import type { Engine } from '../sim-model';
import type { createCoopClient } from '@/lib/net/coop';

/** Мёртвая зона джойстика, px от центра: ближе — «нейтраль», угла нет. */
const STICK_DEAD_R = 14;

export interface TouchControlsDeps {
  engineRef: RefObject<Engine>;
  settingsRef: RefObject<SimSettings>;
  spaceHoldRef: RefObject<{ holding: boolean; since: number; releaseAt: number; charge: number }>;
  netRef: RefObject<ReturnType<typeof createCoopClient> | null>;
  fieldFormatRef: RefObject<'grid' | 'test'>;
  startStepRef: RefObject<((dir: number) => void) | null>;
  leapRequestRef: RefObject<number | null>;
}

/** Палец относительно центра джойстика → один из 8 углов (шаг 45°,
 *  SCREEN-градусы: 0=вправо, 90=вниз — как atan2 в экранных осях с Y вниз,
 *  те же значения, что у KeyD/KeyS/… из lib/sim/keys.ts). Внутри мёртвой
 *  зоны — null: направления нет. */
export function dirFromOffset(dx: number, dy: number): number | null {
  if (Math.hypot(dx, dy) < STICK_DEAD_R) return null;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  const snapped = Math.round(deg / 45) * 45;
  return ((snapped % 360) + 360) % 360;
}

/** `pointer: coarse` — основной указатель палец (телефон/планшет).
 *  Смена primary-указателя подхватывается на лету: подключили мышь —
 *  управление исчезло, осталась клавиатура. */
function useCoarsePointer(): boolean {
  const [coarse, setCoarse] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(pointer: coarse)');
    const sync = () => setCoarse(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return coarse;
}

export function useTouchControls(deps: TouchControlsDeps) {
  const {
    engineRef,
    settingsRef,
    spaceHoldRef,
    netRef,
    fieldFormatRef,
    startStepRef,
    leapRequestRef,
  } = deps;

  /** Рамка видимости: показывать виртуальные кнопки решает тип основного
   *  указателя (подписка на matchMedia в useCoarsePointer — это state, а не
   *  ref, чтобы включение/отключение реагировало мгновенно; игровые значения
   *  остаются в ref-ах, как у use-keyboard). */
  const coarse = useCoarsePointer();

  /** Сектор, зажатый джойстиком сейчас (SCREEN-градусы); null — нейтраль. */
  const activeDirRef = useRef<number | null>(null);
  const [activeDir, setActiveDir] = useState<number | null>(null);
  /** Палец держит «прыжок» (для колец/подсветки; сама семантика — в spaceHoldRef). */
  const [spaceHolding, setSpaceHolding] = useState(false);
  /** pointerId пальцев, захвативших джойстик/кнопку — мультитач-гварды:
   *  второй палец мимо круга не перехватывает управление. */
  const stickPtrRef = useRef<number | null>(null);
  const jumpPtrRef = useRef<number | null>(null);
  /** Кнопка «прыжок»: элемент нужен rAF-циклу заряда — кольцо рисуется
   *  правкой CSS-переменной прямо в DOM, без ре-рендера. */
  const jumpElRef = useRef<HTMLDivElement | null>(null);

  // ---- Семантика клавиатуры (портирована из use-keyboard.ts дословно) ----

  /** Сектор нажат пальцем — семантика keydown 'move': угол в engine.held
   *  (без дублей, маршрут сбрасывается), в мирной «тест»-комнате клик-цель
   *  снимается (ходьбу перехватывает палец, цикл ведёт кота по held), в
   *  сетке/бою — одиночный шаг сразу (startStep). */
  const movePress = useCallback(
    (dir: number) => {
      const e = engineRef.current;
      // Пока блок держится (K внешней клавиатуры), движение не работает — так
      // же, как в use-keyboard: «в блоке нельзя двигаться, бить и крутить».
      if (e.blocking) return;
      if (!e.held.includes(dir)) {
        e.held.push(dir);
        e.path = [];
      }
      // мирный «тест»: ходьба свободная (по пикселям) — её ведёт игровой цикл
      // по зажатым направлениям; клик-цель перебивается пальцем там же.
      const sK = settingsRef.current;
      if (fieldFormatRef.current === 'test' && !sK.arrow.battleMode && sK.controlled === 'main') {
        e.ptarget = null;
        return;
      }
      // одиночное нажатие: шаг сразу, если предыдущий завершён, — быстрее,
      // чем разрешает замедление, двигаться нельзя
      startStepRef.current?.(dir);
    },
    [engineRef, settingsRef, fieldFormatRef, startStepRef],
  );

  /** Сектор отпущен/сменился — семантика keyup 'move': снять угол из engine.held. */
  const moveRelease = useCallback(
    (dir: number) => {
      const e = engineRef.current;
      e.held = e.held.filter((d) => d !== dir);
    },
    [engineRef],
  );

  /** Палец лёг на «прыжок» — семантика keydown Space (после гварда
   *  «свой кот и не в блоке»): начинается присед, комнате — emit space on:true.
   *  Возврат true — присед начат (кнопка светит заряд); false — гвард. */
  const spacePress = useCallback((): boolean => {
    if (settingsRef.current.controlled !== 'main' || engineRef.current.blocking) return false;
    const sp = spaceHoldRef.current;
    if (!sp.holding) {
      sp.holding = true;
      sp.since = performance.now();
      sp.releaseAt = 0;
      sp.charge = 0;
      // Присед видят все: комнату ставим в известность (эхо себе не приходит).
      netRef.current?.emit('space', { on: true });
    }
    return true;
  }, [settingsRef, engineRef, spaceHoldRef, netRef]);

  /** Палец ушёл с «прыжка» — семантика keyup Space: заряд «выстрела» по
   *  времени удержания (тап — минимальный подпрыг 0.15, полные 4 с — ровно 1)
   *  уходит в leapRequestRef (его забирает игровой цикл); комнате —
   *  длительность удержания (чужие клиенты считают заряд по ней, не сверяя
   *  свои performance.now). */
  const spaceRelease = useCallback(() => {
    const sp = spaceHoldRef.current;
    if (sp.holding) {
      sp.holding = false;
      sp.charge = 0.15 + 0.85 * Math.min(1, (performance.now() - sp.since) / 4000);
      sp.releaseAt = performance.now();
      leapRequestRef.current = sp.charge;
      netRef.current?.emit('space', { on: false, hold: Math.round(sp.releaseAt - sp.since) });
    }
  }, [spaceHoldRef, leapRequestRef, netRef]);

  // ---- Собственно тач: палец → события клавиатуры ----

  /** Смена сектора: старый угол — keyup, новый — keydown (перетаскивание
   *  переключает направления, как W→D двумя быстрыми нажатиями). */
  const setDir = useCallback(
    (dir: number | null) => {
      const prev = activeDirRef.current;
      if (prev === dir) return;
      if (prev !== null) moveRelease(prev);
      activeDirRef.current = dir;
      setActiveDir(dir);
      if (dir !== null) movePress(dir);
    },
    [movePress, moveRelease],
  );

  const stickDown = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      // второй палец, когда джойстик уже занят, — мимо
      if (stickPtrRef.current !== null) return;
      ev.preventDefault();
      // захват: палец, уехавший за круг, продолжает крутить джойстик
      ev.currentTarget.setPointerCapture(ev.pointerId);
      stickPtrRef.current = ev.pointerId;
      const r = ev.currentTarget.getBoundingClientRect();
      setDir(dirFromOffset(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2)));
    },
    [setDir],
  );

  const stickMove = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (stickPtrRef.current !== ev.pointerId) return;
      const r = ev.currentTarget.getBoundingClientRect();
      setDir(dirFromOffset(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2)));
    },
    [setDir],
  );

  /** Отпускание/сбой пальца — во всех случаях keyup: направление снимается. */
  const stickUp = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (ev.pointerId !== stickPtrRef.current) return;
      stickPtrRef.current = null;
      setDir(null);
    },
    [setDir],
  );

  const jumpDown = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (jumpPtrRef.current !== null) return;
      ev.preventDefault();
      ev.currentTarget.setPointerCapture(ev.pointerId);
      jumpPtrRef.current = ev.pointerId;
      if (spacePress()) setSpaceHolding(true);
    },
    [spacePress],
  );

  const jumpUp = useCallback(
    (ev: ReactPointerEvent<HTMLDivElement>) => {
      if (ev.pointerId !== jumpPtrRef.current) return;
      jumpPtrRef.current = null;
      spaceRelease();
      setSpaceHolding(false);
    },
    [spaceRelease],
  );

  // ---- Кольцо заряда на кнопке ----

  // rAF красит CSS-переменную --jump-charge прямо в DOM (0..1 за 4 с — та же
  // формула, что у «выстрела»): кольцо честно показывает будущий прыжок,
  // не тратя ре-рендеры React.
  useEffect(() => {
    if (!spaceHolding) return;
    const el = jumpElRef.current;
    let raf = 0;
    const tick = () => {
      const sp = spaceHoldRef.current;
      if (sp.holding) {
        el?.style.setProperty(
          '--jump-charge',
          String(Math.min(1, (performance.now() - sp.since) / 4000)),
        );
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      el?.style.setProperty('--jump-charge', '0');
    };
  }, [spaceHolding, spaceHoldRef]);

  // Размонтирование (открылся редактор и т.п.) ≈ window blur из use-keyboard:
  // зажатый сектор тихо отпускаем, недожатый присед гасим БЕЗ «выстрела» —
  // иначе кот остался бы приплющенным или улетел из ниоткуда.
  useEffect(() => {
    const activeRef = activeDirRef;
    return () => {
      const e = engineRef.current;
      const d = activeRef.current;
      if (d !== null) e.held = e.held.filter((x) => x !== d);
      activeRef.current = null;
      const sp = spaceHoldRef.current;
      if (sp.holding) {
        sp.holding = false;
        sp.releaseAt = 0;
        // Присед снят без «выстрела» — чужим тоже (cancel: кот просто выпрямится).
        netRef.current?.emit('space', { on: false, cancel: true });
      }
    };
  }, [engineRef, spaceHoldRef, netRef]);

  return {
    coarse,
    activeDir,
    spaceHolding,
    stickDown,
    stickMove,
    stickUp,
    jumpDown,
    jumpUp,
    jumpElRef,
  };
}
