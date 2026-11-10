'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Лог ударов — правая колонка рядом с полем: те же строки, что раньше в окне
 * «Бой», свежая сверху. Колонка уже чата и тянется на всю высоту поля.
 * Кнопка «Очистить» в шапке стирает лог (энергия персонажей не трогается).
 */
export function FightLog({ lines, onClear, onClose }: { lines: string[]; onClear?: () => void; onClose?: () => void }) {
  const logRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const signature = lines.join('\n');

  useEffect(() => {
    const el = logRef.current;
    if (!el || !stuck) return;
    el.scrollTop = 0;
  }, [signature, stuck]);

  return (
    <section
      aria-label="Лог ударов"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-[var(--sim-line)] bg-[var(--sim-panel)]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--sim-line)] px-3 py-2">
        <h2 className="text-sm font-bold tracking-wide text-[var(--sim-text)]">Бой</h2>
        <div className="flex min-w-0 items-center gap-2">
          {/* Подсказку про клавишу удара показываем только на широких экранах (lg+) */}
          <p className="hidden text-[11px] text-[var(--sim-text-faint)] lg:block">I — удар</p>
          {onClear ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="btn-neutral h-6 px-2 text-[10px]"
              aria-label="Очистить лог ударов"
              onClick={onClear}
            >
              Очистить лог
            </Button>
          ) : null}
          {/* Мобильная раскрытая панель закрывается крестиком; на lg+ кнопки нет */}
          {onClose ? (
            <button
              type="button"
              aria-label="Закрыть лог"
              onClick={onClose}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-[var(--sim-line-strong)] text-xs leading-none text-[var(--sim-text-muted)] hover:border-[var(--sim-line-hover)] hover:text-[var(--sim-text)] lg:hidden"
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>
      <div
        id="fightLog"
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={() => {
          const el = logRef.current;
          if (!el) return;
          const near = el.scrollTop < 28;
          setStuck((prev) => (prev === near ? prev : near));
        }}
        className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2 [scrollbar-width:thin]"
      >
        {lines.length === 0 ? (
          <p className="text-sm text-[var(--sim-text-faint)]">ударов ещё не было</p>
        ) : (
          lines.map((line, i) => (
            <p key={`${i}:${line}`} className="truncate text-sm leading-snug text-[var(--sim-text)]">
              {line}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
