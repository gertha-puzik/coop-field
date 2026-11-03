'use client';

import { Button } from '@/components/ui/button';
import type { CoopRoomInfo } from '@/lib/net/coop';

/** Строка списка комнат: состав с сервера + людское имя и пометка «вы здесь». */
export type RoomRow = CoopRoomInfo & { title: string; here: boolean };

/** «1 игрок / 2 игрока / 5 игроков», ноль — «Пусто». */
export function playersLabel(n: number): string {
  if (n <= 0) return 'Пусто';
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} игрок`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} игрока`;
  return `${n} игроков`;
}

/** Сколько имён показывать в карточке, остальные — «и ещё N». */
const LOGIN_CHIPS = 6;

/**
 * Выбор комнаты: карточки гротов с числом игроков и их именами.
 * Без обёртки (embedded) — симулятор кладёт его внутрь своей колонки
 * (экран входа); с обёрткой — на весь экран или в модалку.
 */
export function RoomPicker({
  rows,
  ready,
  stale,
  onPick,
  onCancel,
  embedded,
}: {
  rows: RoomRow[];
  /** roomsinfo уже приходил — иначе вместо чисел показываем «…». */
  ready: boolean;
  /** Данные не обновляются (сервер без протокола rooms): предупреждение внизу. */
  stale?: boolean;
  onPick: (id: string) => void;
  /** Только для модалки: вернуться на поле без смены комнаты. */
  onCancel?: () => void;
  /** Внутри экрана входа: без узкой внешней обёртки. */
  embedded?: boolean;
}) {
  const first = !onCancel;
  const content = (
    <>
      <header>
        <h1 className="text-xl font-bold leading-tight">{first ? 'Выберите комнату' : 'Перейти в другую комнату'}</h1>
        <p className="mt-1 text-sm text-[var(--sim-text-muted)]">
          {first
            ? 'Пивной грот №1–№3 и «тест» — игроки одни и те же, поле у каждого своё. В «тесте» — нарисованная лужайка с закутком: камера едет за котом, в мирном режиме ходьба свободная.'
            : 'Состав комнат обновляется сам. Текущая комната помечена «вы здесь».'}
        </p>
      </header>

      <div role="radiogroup" aria-label="Комнаты" className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {rows.map((row) => {
          const extra = Math.max(0, row.logins.length - LOGIN_CHIPS);
          return (
            <button
              key={row.id}
              type="button"
              role="radio"
              aria-checked={row.here}
              disabled={row.here}
              onClick={() => {
                if (!row.here) onPick(row.id);
              }}
              className={`relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-colors ${
                row.here
                  ? 'border-[var(--sim-accent-hover)] bg-[var(--sim-accent-tint)] shadow-[0_0_0_1px_var(--sim-accent-glow-strong)]'
                  : 'border-[var(--sim-line-strong)] bg-[var(--sim-inset-strong)] hover:border-[var(--sim-accent-hover)] hover:bg-[var(--sim-accent-tint)]'
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="text-sm font-bold leading-tight text-[var(--sim-text)]">
                  <span aria-hidden className="mr-1">🍺</span>
                  {row.title}
                </span>
                {row.here ? (
                  <span className="shrink-0 rounded bg-[var(--sim-accent-hover)] px-1.5 py-px text-[10px] font-bold leading-none text-white">
                    вы здесь
                  </span>
                ) : null}
              </span>
              <span className="text-xs font-semibold tabular-nums text-[var(--sim-text-soft)]">
                {ready ? playersLabel(row.count) : '…'}
              </span>
              <span className="flex min-h-6 flex-wrap gap-1">
                {ready && row.logins.length === 0 ? (
                  <span className="text-[11px] text-[var(--sim-text-faint)]">никого нет</span>
                ) : null}
                {row.logins.slice(0, LOGIN_CHIPS).map((login, i) => (
                  <span
                    key={`${row.id}-${login}-${i}`}
                    className="max-w-full truncate rounded bg-[var(--sim-inset)] px-1.5 py-0.5 text-[11px] text-[var(--sim-text-soft)]"
                  >
                    {login}
                  </span>
                ))}
                {extra > 0 ? (
                  <span className="rounded px-1 py-0.5 text-[11px] text-[var(--sim-text-faint)]">и ещё {extra}</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      {stale ? (
        <p className="mt-4 text-xs text-[var(--sim-text-faint)]" role="status">
          Состав комнат недоступен (сервер без списка комнат). Зайти можно — просто выберите грот.
        </p>
      ) : null}

      {onCancel ? (
        <div className="mt-5">
          <Button variant="outline" className="btn-neutral h-9 w-full text-sm" onClick={onCancel}>
            Отмена — остаться в комнате
          </Button>
        </div>
      ) : null}
    </>
  );
  if (embedded) return <div>{content}</div>;
  return <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6 sm:py-8">{content}</div>;
}
