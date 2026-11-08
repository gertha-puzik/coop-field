'use client';

/**
 * Предпросмотр «было → станет» дашборда /admin (P4/спек §4.5): список
 * реальных изменений черновика против сервера (buildCfgDiff из http-cfg.ts)
 * и второе подтверждение — «Подтверждаю — применить» отправляет единый
 * PATCH, «Отмена» не отправляет ничего.
 *
 * Вынесен из cfg-dashboard.tsx (прецедент — players-field-tab.tsx), чтобы
 * панель держалась под лимитом 800 строк после вкладки «Броня»
 * (мандат владелицы 2026-11-08): предпросмотр теперь общий для ВСЕХ вкладок
 * (и «Конфиг», и «Броня») — apply-кнопки обеих вкладок открывают его.
 *
 * Чистый рендер: без своей логики/HTTP — только props-диффы.
 */

import { Button } from '@/components/ui/button';
import {
  fmtNum,
  narrowingWarning,
  type CfgFieldDiff,
} from '@/lib/net/http-cfg';

/** Одна строка предпросмотра: «было → станет» (+N/−M) + предупреждение сужения. */
function DiffRow({ d }: { d: CfgFieldDiff }) {
  return (
    <li className="rounded border border-[var(--sim-line)] p-2 text-xs text-[var(--sim-text-soft)]">
      <p className="font-semibold text-[var(--sim-text)]">{d.label}</p>
      {d.range ? (
        <p className="mt-1">
          Было: {fmtNum(d.range.before)} {d.range.unit} → станет: <b>{fmtNum(d.range.after)} {d.range.unit}</b>
        </p>
      ) : d.curve ? (
        <div className="mt-1 space-y-1">
          <p>
            Кривая: {d.curve.before.length} тч. → <b>{d.curve.after.length} тч.</b> (+{d.curve.added.length} / −{d.curve.removed.length})
          </p>
          {d.curve.added.length ? (
            <p>Точки добавляются (броня): {d.curve.added.map(fmtNum).join(', ')}</p>
          ) : null}
          {d.curve.removed.length ? (
            <p>Точки убраны (броня): {d.curve.removed.map(fmtNum).join(', ')}</p>
          ) : null}
        </div>
      ) : d.list ? (
        <div className="mt-1 space-y-1">
          <p>
            Список: {d.list.before.length} зн. → <b>{d.list.after.length} зн.</b> (+{d.list.added.length} / −{d.list.removed.length})
          </p>
          {d.list.added.length ? (
            <p>
              Добавляются: {d.list.added.map(fmtNum).join(', ')} {d.list.unit}
            </p>
          ) : null}
          {d.list.removed.length ? (
            <p>
              Убраны: {d.list.removed.map(fmtNum).join(', ')} {d.list.unit}
            </p>
          ) : null}
          {d.list.defBefore !== d.list.defAfter ? (
            <p>
              Дефолт: {fmtNum(d.list.defBefore)} → {fmtNum(d.list.defAfter)}
            </p>
          ) : null}
          {d.list.removed.length ? (
            <p className="font-semibold text-amber-300">⚠ {narrowingWarning(d.list.kind)}</p>
          ) : null}
        </div>
      ) : null}
      {d.choice ? (
        <p className="mt-1">
          Выбор игроками: {d.choice.before ? 'вкл' : 'выкл'} → <b>{d.choice.after ? 'вкл' : 'выкл'}</b>
          {d.choice.after
            ? ` — список из ${d.choice.kept} зн. вернётся игрокам целиком`
            : ` — игрокам отдаётся только дефолт, список из ${d.choice.kept} зн. сохраняется на сервере`}
        </p>
      ) : null}
      <p className="mt-1 text-[11px] text-[var(--sim-text-faint)]">{d.hint}</p>
    </li>
  );
}

/** Панель предпросмотра: список диффов + подтверждение/отмена второго шага. */
export function ApplyPreview({
  pending,
  busy,
  onConfirm,
  onCancel,
}: {
  pending: CfgFieldDiff[];
  busy: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-950/30 p-3">
      <p className="text-sm font-bold text-amber-200">Предпросмотр изменений — пока ничего не отправлено</p>
      <ul className="mt-2 space-y-2">
        {pending.map((d) => (
          <DiffRow key={d.key} d={d} />
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
          disabled={busy !== null}
          onClick={onConfirm}
        >
          {busy === 'apply' ? 'Применяем…' : 'Подтверждаю — применить'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          disabled={busy !== null}
          onClick={onCancel}
        >
          Отмена — ничего не отправлять
        </Button>
      </div>
    </div>
  );
}
