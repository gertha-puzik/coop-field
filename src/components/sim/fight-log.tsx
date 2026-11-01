'use client';

import { useEffect, useRef, useState } from 'react';

/** Лог ударов над полем: те же строки, что раньше в окне «Бой», свежая сверху. */
export function FightLog({ lines }: { lines: string[] }) {
  const logRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const signature = lines.join('\n');

  useEffect(() => {
    const el = logRef.current;
    if (!el || !stuck) return;
    el.scrollTop = 0;
  }, [signature, stuck]);

  return (
    <section aria-label="Лог ударов" className="flex w-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#191c21]">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-1.5">
        <h2 className="text-xs font-bold tracking-wide text-zinc-200">Бой</h2>
        <p className="text-[10px] text-zinc-500">I — удар</p>
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
        className="h-28 space-y-0.5 overflow-y-auto px-3 py-2 [scrollbar-width:thin]"
      >
        {lines.length === 0 ? (
          <p className="text-[11px] text-zinc-500">ударов ещё не было</p>
        ) : (
          lines.map((line, i) => (
            <p key={`${i}:${line}`} className="truncate text-[12px] leading-snug text-zinc-100">
              {line}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
