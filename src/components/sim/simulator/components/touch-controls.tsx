/**
 * Сенсорное управление поверх игрового канваса (мобильный UX): слева-снизу —
 * 8-направленный джойстик («палец-кружок» снапится на ближайшие 45°),
 * справа-снизу — большая кнопка «прыжок» с кольцом заряда при удержании.
 * Монтируется слотом touchControls внутри FieldStage: рисуется поверх HUD
 * канваса (z-50 выше z-20), ловит события только своими кругами
 * (pointer-events: auto у кругов, контейнер pointer-events: none —
 * остальное поле спокойно принимает клики), на десктопе срабатывает
 * matchMedia-гвард и не рендерится ничего. Семантика — 100% клавиатурная
 * (см. hooks/use-touch-controls.ts: семантика keydown/keyup из WASD/Space).
 */
import { MOVE_DIRS } from '@/lib/sim/keys';
import { useTouchControls, type TouchControlsDeps } from '../hooks/use-touch-controls';

/** Вынос «пальца-кружка» из центра джойстика, px. */
const KNOB_R = 40;
/** Радиус кольца точек-направлений джойстика, px. */
const NOTCH_R = 53;

export function TouchControls(props: TouchControlsDeps) {
  const t = useTouchControls(props);
  // Десктоп (pointer: fine) вообще ничего не рендерит: управляет клавиатура.
  if (!t.coarse) return null;
  return (
    // Контейнер прозрачен для событий поля: круги включают pointer-events-auto,
    // всё остальное проходит сквозь нулевой слой на канвас.
    <div
      data-sim-touch-controls=""
      role="group"
      aria-label="Сенсорное управление"
      className="pointer-events-none absolute inset-0 z-50 select-none"
    >
      {/* Джойстик движения: сектор под пальцем = зажатая клавиша WASD. */}
      <div
        role="group"
        aria-label="Джойстик движения — 8 направлений"
        className="pointer-events-auto absolute bottom-3 left-3 h-32 w-32 touch-none rounded-full border border-[var(--sim-line-strong)] bg-[var(--sim-inset)] shadow-lg [-webkit-tap-highlight-color:transparent]"
        onPointerDown={t.stickDown}
        onPointerMove={t.stickMove}
        onPointerUp={t.stickUp}
        onPointerCancel={t.stickUp}
        onLostPointerCapture={t.stickUp}
      >
        {MOVE_DIRS.map((d) => {
          const active = t.activeDir === d;
          return (
            <span
              key={d}
              aria-hidden
              className="absolute left-1/2 top-1/2 h-2 w-2 rounded-full"
              style={{
                // поворот на угол d+90° переводит «вверх» в экранный угол d
                // (0°=вправо, 90°=вниз — та же система, что у KeyD/KeyS)
                background: active ? 'var(--sim-accent)' : 'var(--sim-line-hover)',
                opacity: active ? 1 : 0.55,
                transform: `translate(-50%, -50%) rotate(${d + 90}deg) translateY(-${NOTCH_R}px)${active ? ' scale(1.4)' : ''}`,
              }}
            />
          );
        })}
        {/* «Палец-кружок»: висит на зажатом секторе (нейтраль — в центре). */}
        <span
          aria-hidden
          className="absolute left-1/2 top-1/2 h-11 w-11 rounded-full border border-[var(--sim-accent-glow-strong)] bg-[var(--sim-accent-soft)] shadow-md transition-transform duration-75"
          style={{
            transform:
              t.activeDir === null
                ? 'translate(-50%, -50%)'
                : `translate(calc(-50% + ${Math.round(Math.cos((t.activeDir * Math.PI) / 180) * KNOB_R)}px), calc(-50% + ${Math.round(Math.sin((t.activeDir * Math.PI) / 180) * KNOB_R)}px))`,
          }}
        />
      </div>
      {/* Кнопка «прыжок»: пробел большим пальцем. Удержание заряжает прыжок
          (кольцо заполняется за 4 с — как присед с клавиатуры), отпускание —
          выстрел вверх с набранным зарядом. */}
      <div
        ref={t.jumpElRef}
        role="button"
        aria-label="Прыжок — удержание заряжает"
        className="pointer-events-auto absolute bottom-3 right-3 h-24 w-24 touch-none select-none rounded-full border border-[var(--sim-line-strong)] bg-[var(--sim-inset)] shadow-lg [-webkit-tap-highlight-color:transparent]"
        onPointerDown={t.jumpDown}
        onPointerUp={t.jumpUp}
        onPointerCancel={t.jumpUp}
        onLostPointerCapture={t.jumpUp}
      >
        {/* Кольцо заряда: conic-градиент по CSS-переменной --jump-charge,
            которую rAF-цикл хука пишет прямо в DOM (0 — пусто, 1 — полный). */}
        <span
          aria-hidden
          className="absolute inset-0 rounded-full"
          style={{
            background:
              'conic-gradient(from -90deg, var(--sim-accent) calc(var(--jump-charge, 0) * 1turn), transparent 0)',
          }}
        />
        <span
          aria-hidden
          className={`absolute inset-[5px] flex flex-col items-center justify-center gap-0.5 rounded-full border border-[var(--sim-line)] ${
            t.spaceHolding ? 'bg-[var(--sim-accent-tint)]' : 'bg-[var(--sim-panel)]'
          }`}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 19V6M6 12l6-6 6 6" />
          </svg>
          <span className="text-[11px] font-semibold">Прыжок</span>
        </span>
      </div>
    </div>
  );
}
