'use client';
/**
 * Плашка «Управление» при первом входе в комнату (issue #124): короткие
 * русские подписи раскладки поверх игрового поля. Раскладка — из
 * hooks/use-keyboard.ts и lib/sim/keys.ts (физические клавиши, работают и
 * на йцукен).
 *
 * Контракт:
 * - один раз на браузер: флаг KEY_HINT_SEEN_KEY в localStorage пишется при
 *   закрытии (крестик / «Понятно» / Esc). Чтение и запись — в try/catch:
 *   приватный режим или запрет хранилища не роняют поле (тогда плашка просто
 *   покажется ещё раз в следующей сессии);
 * - клавиши НЕ перехватываются: свой keydown слушает только Escape и ничего
 *   не гасит; кнопки не забирают фокус по клику мышью (preventDefault на
 *   mousedown), так что Пробел/Enter после закрытия идут в игру, а не
 *   «нажимают» кнопку;
 * - тач (pointer: coarse): вместо клавиш — строка про джойстик и «Прыжок»
 *   из touch-controls.tsx. Плашка сверху поля, джойстик и кнопка прыжка —
 *   снизу, z ниже их z-50: не склеивается и не перекрывает;
 * - showKeyHintAgain() (справочник) стирает флаг и шлёт window-событие —
 *   смонтированная плашка открывается сразу, иначе при следующем входе.
 *
 * Вариант сайта сверяется инлайном (AGENTS.md, правило 8): в мирной сборке
 * строки боя (удар/блок/стрела) лежат в мёртвой ветке и вырезаются сборщиком.
 */
import { useCallback, useEffect, useState } from 'react';
import { KEY_HINT_SEEN_KEY } from '@/lib/sim/engine-consts';

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

/** Событие «показать подсказку снова» (справочник → смонтированная плашка). */
const SHOW_EVENT = 'coop-field:key-hint-show';

type Row = { keys: readonly string[]; label: string };

const ROWS: readonly Row[] = IS_ELYRIA
  ? [
      { keys: ['W', 'A', 'S', 'D'], label: 'идти' },
      { keys: ['Q', 'E', 'Z', 'X'], label: 'идти по диагонали' },
      { keys: ['Shift'], label: 'бежать (держать)' },
      { keys: ['Пробел'], label: 'присесть, отпустить — прыжок' },
      { keys: ['[', ']'], label: 'повернуть обзор' },
      { keys: ['Enter'], label: 'чат' },
    ]
  : [
      { keys: ['W', 'A', 'S', 'D'], label: 'шаг' },
      { keys: ['Q', 'E', 'Z', 'X'], label: 'шаг по диагонали' },
      { keys: ['J', 'L'], label: 'повернуть стрелу' },
      { keys: ['I'], label: 'удар' },
      { keys: ['K'], label: 'блок (держать)' },
      { keys: ['Пробел'], label: 'присесть, отпустить — прыжок' },
      { keys: ['Enter'], label: 'чат' },
    ];

function readSeen(): boolean {
  try {
    return window.localStorage.getItem(KEY_HINT_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeSeen(seen: boolean): void {
  try {
    if (seen) window.localStorage.setItem(KEY_HINT_SEEN_KEY, '1');
    else window.localStorage.removeItem(KEY_HINT_SEEN_KEY);
  } catch {
    /* приватный режим / квота — подсказка просто не запомнится */
  }
}

/** Справочник: «Показать подсказку по клавишам снова». */
export function showKeyHintAgain(): void {
  writeSeen(false);
  try {
    window.dispatchEvent(new Event(SHOW_EVENT));
  } catch {
    /* нет window (SSR) — покажется при следующем входе */
  }
}

/** Клик мышью по кнопке плашки не уводит фокус с поля/страницы. */
const keepFocus = (ev: { preventDefault: () => void }) => ev.preventDefault();

export function KeyHint() {
  const [open, setOpen] = useState(false);
  const [coarse, setCoarse] = useState(false);

  useEffect(() => {
    if (!readSeen()) setOpen(true);
    const show = () => setOpen(true);
    window.addEventListener(SHOW_EVENT, show);
    let mq: MediaQueryList | null = null;
    const sync = () => setCoarse(!!mq?.matches);
    try {
      mq = window.matchMedia('(pointer: coarse)');
      sync();
      mq.addEventListener('change', sync);
    } catch {
      mq = null;
    }
    return () => {
      window.removeEventListener(SHOW_EVENT, show);
      mq?.removeEventListener('change', sync);
    };
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    writeSeen(true);
  }, []);

  // Esc закрывает плашку; событие не гасим — остальные слушатели его видят.
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      data-sim-key-hint=""
      role="dialog"
      aria-modal="false"
      aria-labelledby="simKeyHintTitle"
      // Тач: прижата к верху кадра и короче — джойстик и «Прыжок» живут внизу.
      className={`pointer-events-auto absolute left-1/2 ${coarse ? 'top-2 p-2.5' : 'top-14 p-3'} z-[45] w-[min(22rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] text-[var(--sim-text)] shadow-lg`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3 id="simKeyHintTitle" className="text-sm font-bold">
          Управление
        </h3>
        <button
          type="button"
          aria-label="Закрыть подсказку"
          title="Закрыть (Esc)"
          onMouseDown={keepFocus}
          onClick={close}
          className="-mr-1 -mt-1 flex h-6 w-6 items-center justify-center rounded-md text-base leading-none text-[var(--sim-text-muted)] hover:bg-[var(--sim-inset)] hover:text-[var(--sim-text)]"
        >
          ×
        </button>
      </div>
      {coarse ? (
        <p className="mt-1 text-xs leading-snug">
          Джойстик слева — идти. «Прыжок» справа: держать — заряд, отпустить — прыжок.
        </p>
      ) : (
        <>
          <ul className="mt-2 flex flex-col gap-1.5 text-xs">
            {ROWS.map((row) => (
              <li key={row.label} className="flex items-center gap-2">
                <span className="flex shrink-0 gap-0.5">
                  {row.keys.map((k) => (
                    <kbd
                      key={k}
                      className="min-w-6 rounded border border-[var(--sim-line)] bg-[var(--sim-inset)] px-1.5 py-0.5 text-center font-mono text-[11px] leading-4"
                    >
                      {k}
                    </kbd>
                  ))}
                </span>
                <span className="text-[var(--sim-text-muted)]">— {row.label}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] leading-snug text-[var(--sim-text-faint)]">
            Работает и на русской раскладке. Клавиши действуют уже сейчас.
          </p>
        </>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[11px] text-[var(--sim-text-faint)]">{coarse ? '' : 'Снова: Настройки → Справочник'}</span>
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={close}
          className="rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-accent-soft)] px-3 py-1 text-xs font-semibold hover:bg-[var(--sim-accent-tint)]"
        >
          Понятно
        </button>
      </div>
    </div>
  );
}
