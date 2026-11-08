'use client';

import { useMemo, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  CONSTANT_CARDS,
  MECHANIC_CARDS,
  type CatalogMode,
  type ConstantCard,
  type MechanicCard,
} from '@/lib/net/gerta-catalog';

/**
 * Compile-time вариант сайта (P3): сворачивается сборщиком, поэтому подписи и
 * placeholder Элизии не попадают в grotto-бандл (спек §2A).
 */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

const MODE_LABEL: Record<CatalogMode, string> = IS_ELYRIA
  ? {
      all: 'все режимы',
      beer: 'гроты',
      elision: 'Элизия',
      hunger: 'голодные',
    }
  : ({
      all: 'все режимы',
      beer: 'гроты',
      hunger: 'голодные',
      // Ключ elision недостижим: CARD_MODES в grotto его не содержит, а чип
      // фильтра строится из CARD_MODES.
    } as Record<CatalogMode, string>);

/**
 * Режимы, о которых справочник говорит в этом варианте сайта (P3): grotto не
 * упоминает Элизию вовсе, у Элизии свой набор. «all»-карточки общие.
 */
const CARD_MODES: readonly CatalogMode[] = IS_ELYRIA ? ['elision'] : ['beer', 'hunger'];

function cardVisible(mode: CatalogMode): boolean {
  return mode === 'all' || CARD_MODES.includes(mode);
}

const APPLY_LABEL = {
  now: 'сразу в этой комнате',
  'new-room': 'с новой комнатой',
  restart: 'после перезапуска сервера',
  never: 'нельзя крутить из админки — это устройство игры',
} as const;

function matches(hay: string, q: string) {
  return hay.toLowerCase().includes(q);
}

function cardText(c: ConstantCard | MechanicCard) {
  if ('name' in c) {
    return `${c.title} ${c.name} ${c.file} ${c.note} ${c.value}`;
  }
  return `${c.title} ${c.does} ${c.files.join(' ')} ${c.functions.join(' ')} ${c.breaks}`;
}

/**
 * Справочник Герты: как устроена игра, простыми словами.
 * Данные — из gerta-catalog.ts, не из скопированного текста.
 */
export function GertaHandbook() {
  const [q, setQ] = useState('');
  const [mode, setMode] = useState<CatalogMode | 'any'>('any');
  const [onlyEditable, setOnlyEditable] = useState(false);
  const needle = q.trim().toLowerCase();

  const mechanics = useMemo(
    () =>
      MECHANIC_CARDS.filter((c) => {
        if (!cardVisible(c.mode)) return false;
        if (mode !== 'any' && c.mode !== 'all' && c.mode !== mode) return false;
        if (needle && !matches(cardText(c), needle)) return false;
        return true;
      }),
    [mode, needle],
  );
  const constants = useMemo(
    () =>
      CONSTANT_CARDS.filter((c) => {
        if (!cardVisible(c.mode)) return false;
        if (mode !== 'any' && c.mode !== 'all' && c.mode !== mode) return false;
        if (onlyEditable && !c.editable) return false;
        if (needle && !matches(cardText(c), needle)) return false;
        return true;
      }),
    [mode, needle, onlyEditable],
  );

  return (
    <div className="flex flex-col gap-3 text-[var(--sim-text)]">
      <div>
        <h3 className="text-sm font-bold">Как устроена игра</h3>
        <p className="mt-1 text-[11px] leading-snug text-[var(--sim-text-muted)]">
          Это справочник Герты: карточки собраны из кода, а не списаны руками. Встроенного
          ИИ-чата нет и не будет — Cursor читает эти же карточки и AGENTS.md.
        </p>
      </div>
      <label className="block text-[11px] text-[var(--sim-text-faint)]">
        Поиск
        <Input
          className="mt-1 h-8 text-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={IS_ELYRIA ? 'удар, Элизия, пароль…' : 'удар, манекен, пароль…'}
        />
      </label>
      <div className="flex flex-wrap gap-1">
        {(['any', ...CARD_MODES] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setMode(id)}
            className={`h-6 rounded px-2 text-[10px] font-semibold ${
              mode === id
                ? 'bg-[var(--sim-accent)] text-black'
                : 'bg-[var(--sim-inset)] text-[var(--sim-text-soft)]'
            }`}
          >
            {id === 'any' ? 'все' : MODE_LABEL[id]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOnlyEditable((v) => !v)}
          className={`h-6 rounded px-2 text-[10px] font-semibold ${
            onlyEditable
              ? 'bg-[var(--sim-accent)] text-black'
              : 'bg-[var(--sim-inset)] text-[var(--sim-text-soft)]'
          }`}
        >
          только что можно крутить
        </button>
      </div>

      <section>
        <h4 className="text-xs font-bold text-[var(--sim-text-soft)]">Механики ({mechanics.length})</h4>
        <ul className="mt-2 flex flex-col gap-2">
          {mechanics.map((c) => (
            <li
              key={c.id}
              className="rounded-lg border border-[var(--sim-line-strong)] bg-[var(--sim-inset-soft)] p-2"
            >
              <p className="text-xs font-bold">
                {c.title}{' '}
                <span className="font-normal text-[var(--sim-text-faint)]">· {MODE_LABEL[c.mode]}</span>
              </p>
              <p className="mt-1 text-[11px] leading-snug text-[var(--sim-text-muted)]">{c.does}</p>
              <p className="mt-1 text-[10px] text-[var(--sim-text-faint)]">
                Файлы: {c.files.join(', ')}
              </p>
              <p className="text-[10px] text-[var(--sim-text-faint)]">
                Функции: {c.functions.join(', ')}
              </p>
              <p className="text-[10px] text-[var(--sim-text-faint)]">
                Параметры: {c.params.join(', ')}
              </p>
              <p className="mt-1 text-[11px] text-[var(--sim-text-soft)]">
                Сломается, если: {c.breaks}
              </p>
              <p className="text-[10px] text-[var(--sim-text-faint)]">Зависит от: {c.deps.join(', ')}</p>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h4 className="text-xs font-bold text-[var(--sim-text-soft)]">Константы ({constants.length})</h4>
        <ul className="mt-2 flex flex-col gap-2">
          {constants.map((c) => (
            <li
              key={c.id}
              className="rounded-lg border border-[var(--sim-line-strong)] bg-[var(--sim-inset-soft)] p-2"
            >
              <p className="text-xs font-bold">
                {c.title}{' '}
                <span className="font-normal text-[var(--sim-text-faint)]">
                  · {c.editable ? 'можно менять' : 'устройство игры'}
                </span>
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-[var(--sim-text-faint)]">
                {c.name} = {c.value}
                {c.unit ? ` ${c.unit}` : ''}
                {c.range ? ` (${c.range})` : ''}
              </p>
              <p className="text-[10px] text-[var(--sim-text-faint)]">{c.file}</p>
              <p className="mt-1 text-[11px] leading-snug text-[var(--sim-text-muted)]">{c.note}</p>
              <p className="mt-1 text-[10px] text-[var(--sim-text-soft)]">
                Когда применится: {APPLY_LABEL[c.apply]}
              </p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
