'use client';

/**
 * Мини-редактор body новости доски: жирность / курсив / подчёркивание / размер.
 * Пишет ограниченный HTML (b/i/u/span.news-size-*), сервер ре-санитизирует.
 */

import { useEffect, useRef } from 'react';

type Size = 'sm' | 'md' | 'lg';

type Props = {
  value: string;
  disabled?: boolean;
  onChange: (html: string) => void;
};

function runCmd(cmd: string, value?: string) {
  // document.execCommand — достаточный минимум для b/i/u без новых зависимостей.
  document.execCommand(cmd, false, value);
}

function wrapSize(size: Size) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
  const text = sel.toString();
  if (!text) return;
  const safe = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  document.execCommand('insertHTML', false, `<span class="news-size-${size}">${safe}</span>`);
}

const TOOL_BTN =
  'rounded border border-[var(--uk-border-strong)] bg-[var(--uk-field-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--uk-field-text)] hover:bg-[var(--uk-panel-soft-bg)] disabled:opacity-50';

/** contentEditable + панель форматирования для одной записи. */
export function NewsRichEditor({ value, disabled, onChange }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const lastExternal = useRef(value);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (value === lastExternal.current && el.innerHTML === value) return;
    if (document.activeElement === el) return;
    el.innerHTML = value || '';
    lastExternal.current = value;
  }, [value]);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const html = el.innerHTML;
    lastExternal.current = html;
    onChange(html);
  };

  const act = (fn: () => void) => {
    if (disabled) return;
    ref.current?.focus();
    fn();
    emit();
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Форматирование текста">
        <button type="button" className={TOOL_BTN} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => act(() => runCmd('bold'))} title="Жирный">
          <b>Ж</b>
        </button>
        <button type="button" className={TOOL_BTN} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => act(() => runCmd('italic'))} title="Курсив">
          <i>К</i>
        </button>
        <button type="button" className={TOOL_BTN} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => act(() => runCmd('underline'))} title="Подчёркнутый">
          <span className="underline">Ч</span>
        </button>
        <span className="mx-1 h-4 w-px bg-[var(--uk-border)]" aria-hidden />
        <button type="button" className={TOOL_BTN} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => act(() => wrapSize('sm'))} title="Мелкий">
          A−
        </button>
        <button type="button" className={TOOL_BTN} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => act(() => wrapSize('md'))} title="Обычный">
          A
        </button>
        <button type="button" className={TOOL_BTN} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={() => act(() => wrapSize('lg'))} title="Крупный">
          A+
        </button>
      </div>
      <div
        ref={ref}
        role="textbox"
        aria-multiline="true"
        aria-label="Текст новости"
        contentEditable={!disabled}
        suppressContentEditableWarning
        className="news-rich-editor min-h-[5rem] rounded-md border border-[var(--uk-border-strong)] bg-[var(--uk-field-bg)] px-2 py-1.5 text-sm text-[var(--uk-field-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--uk-focus-ring)]"
        onInput={emit}
        onBlur={emit}
      />
    </div>
  );
}
