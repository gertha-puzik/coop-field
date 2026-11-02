'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { CoopChatMessage } from '@/lib/net/coop';

const NAME_COLOR = /^#[0-9a-fA-F]{6}$/;

function nameColor(color?: string) {
  return color && NAME_COLOR.test(color) ? color : '#e4e4e7';
}

function clock(ts: number) {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Чат комнаты — левая колонка рядом с полем: строка ввода сверху,
 * под ней лента сообщений на всю оставшуюся высоту колонки.
 */
export function RoomChat({
  lines,
  meId,
  canSend,
  onSend,
}: {
  lines: CoopChatMessage[];
  meId: number | null;
  canSend: boolean;
  onSend: (text: string) => boolean;
}) {
  const [draft, setDraft] = useState('');
  const [stuck, setStuck] = useState(true);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (!el || !stuck) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, stuck]);

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (onSend(text)) setDraft('');
  };

  return (
    <section
      aria-label="Чат комнаты"
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-xl border border-zinc-800 bg-[#191c21]"
    >
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
        <h2 className="text-sm font-bold tracking-wide text-zinc-200">Чат</h2>
        <p className="text-[11px] text-zinc-500">Enter — написать · Esc — на поле</p>
      </div>
      {/* ввод сверху: не нужно тянуться вниз, чтобы написать в комнату */}
      <form onSubmit={submit} className="flex items-center gap-2 border-b border-zinc-800 p-2">
        <label className="sr-only" htmlFor="roomChatInput">
          Сообщение
        </label>
        <input
          id="roomChatInput"
          value={draft}
          maxLength={200}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="send"
          placeholder={canSend ? 'Сообщение комнате…' : 'Нет связи с комнатой'}
          disabled={!canSend}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(ev) => {
            if (ev.key === 'Escape') {
              ev.preventDefault();
              ev.currentTarget.blur();
            }
          }}
          className="h-9 min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus-visible:border-zinc-500 disabled:opacity-50"
        />
        <Button type="submit" size="sm" className="h-9 text-sm" disabled={!canSend || !draft.trim()}>
          Отправить
        </Button>
      </form>
      <div
        id="roomChatLog"
        ref={logRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        onScroll={() => {
          const el = logRef.current;
          if (!el) return;
          const near = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
          setStuck((prev) => (prev === near ? prev : near));
        }}
        className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-3 py-2 [scrollbar-width:thin]"
      >
        {lines.length === 0 ? (
          <p className="text-sm text-zinc-500">Пока тихо. Сообщение увидят все в этой комнате.</p>
        ) : (
          lines.map((line) => {
            const mine = meId != null && line.id === meId;
            return (
              <p key={line.seq} className="break-words text-sm leading-snug text-zinc-100">
                <span className="mr-1.5 text-[11px] text-zinc-500">{clock(line.ts)} </span>
                <span className="font-semibold" style={{ color: nameColor(line.color) }}>
                  {line.login || 'Кот'}
                </span>
                {mine ? <span className="text-[11px] text-zinc-500"> · вы</span> : null}
                <span className="text-zinc-400">: </span>
                {line.text}
              </p>
            );
          })
        )}
      </div>
    </section>
  );
}
