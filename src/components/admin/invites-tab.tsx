'use client';

/**
 * Вкладка «Коды приглашений» дашборда /admin. Регистрация закрытого сайта
 * Wanderpaws/Elyria — только по кодам-приглашениям от администрации: код
 * канонического вида XXXX-XXXX живёт 24 часа, отозвать можно только
 * действующий. Сателлит players-field-tab.tsx: тот же каркас (status-баннер,
 * busy-состояния, человекочитаемые отказы humanError, перечитывание списка
 * после каждой операции).
 *
 * Контракты (server-зеркало, ходоки в http-admin-ops.ts):
 *   GET  /admin/invites          — все записи со статусом active|used|expired|revoked;
 *   POST /admin/invites/generate — {count 1..10, note? до 80} → новые коды;
 *   POST /admin/invites/revoke   — {code} отзыв действующего кода.
 *
 * Копирование кода — navigator.clipboard (клик по коду или кнопке «Скопи-
 * ровать»; без prompt-фолбэка — панель живёт за https). Отзыв — с
 * window.confirm (прецедент room-config-panel). Подписи статусов —
 * человеко-русские, машинные коды наружу не светятся.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui';
import {
  httpAdminInvites,
  httpAdminInvitesGenerate,
  httpAdminInviteRevoke,
  type AdminInviteRow,
} from '@/lib/net/http-admin-ops';

type Status = { kind: 'ok' | 'err'; text: string; details?: string } | null;

/** Варианты генерации — сколько кодов за один ход. */
const COUNT_OPTIONS = [1, 3, 5];

/** Человекочитаемое пояснение machine reason (паттерн players-field-tab). */
function humanError(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case 'auth_required':
      return 'Нужен вход в аккаунт администратора.';
    case 'forbidden':
      return 'Раздел открыт только администраторам.';
    case 'csrf_origin_required':
    case 'csrf_origin':
    case 'csrf_origin_mismatch':
      return 'Запрос отклонён защитой CSRF — обновите страницу и попробуйте снова.';
    case 'invalid_count':
      return 'Столько кодов за раз не получится — выберите 1, 3 или 5.';
    case 'invalid_note':
      return 'Заметка длиннее 80 символов — сократите её.';
    case 'unknown_code':
    case 'not_found':
      return 'Кода с таким номером уже нет — обновите список.';
    case 'not_active':
      return 'Отзывать можно только действующие коды.';
    case 'invalid':
    case 'json':
    case 'unexpected_fields':
      return 'Сервер не понял запрос — обновите страницу и попробуйте снова.';
    case 'storage':
    case 'write_failed':
      return 'Не удалось сохранить изменение на сервере.';
    case 'offline':
      return 'Сервер недоступен — проверьте соединение.';
    default:
      return fallback;
  }
}

/** Время создания/использования для строки: «12 ноя, 14:05»; '' — битое поле. */
function fmtTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Остаток жизни кода: «истекает через ~N ч» / «меньше часа» / '' (не жив). */
function lifeLeft(iso: string): string {
  if (!iso) return '';
  const expires = new Date(iso).getTime();
  if (Number.isNaN(expires)) return '';
  const diff = expires - Date.now();
  if (diff <= 0) return 'истёк';
  const hours = Math.floor(diff / 3_600_000);
  return hours >= 1 ? `истекает через ~${hours} ч` : 'истекает меньше чем через час';
}

/** Статус-чип строки: подпись человеческая, машинный код наружу не идёт. */
function inviteChip(row: AdminInviteRow): { text: string; cls: string } {
  switch (row.status) {
    case 'active':
      return {
        text: 'действует',
        cls: 'border-emerald-800/60 bg-emerald-950/40 text-emerald-200',
      };
    case 'used':
      return {
        text: 'использован',
        cls: 'border-[rgba(239,231,255,0.28)] bg-[rgba(10,14,32,0.62)] text-[#efe7ff]',
      };
    case 'expired':
      return {
        text: 'истёк',
        cls: 'border-[rgba(185,179,217,0.35)] bg-black/25 text-[#b9b3d9]',
      };
    case 'revoked':
      return {
        text: 'отозван',
        cls: 'border-red-900/60 bg-red-950/40 text-red-200',
      };
  }
}

export function InvitesTab() {
  const [rows, setRows] = useState<AdminInviteRow[] | null>(null);
  const [status, setStatus] = useState<Status>(null);
  /** «Что занято»: 'load' | 'gen' | 'revoke:<code>' | null. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Формы генерации: количество (1/3/5) и необязательная заметка. */
  const [count, setCount] = useState<number>(COUNT_OPTIONS[0]);
  const [note, setNote] = useState('');
  /** Свежесгенерированные коды — показываются сразу после генерации. */
  const [fresh, setFresh] = useState<AdminInviteRow[]>([]);
  /** Код, чей «скопировано» подсвечено прямо сейчас. */
  const [copied, setCopied] = useState<string | null>(null);
  const copiedTimer = useRef<number | null>(null);
  const aliveRef = useRef(true);

  /** Перечитать весь список (он же — первое наполнение вкладки). */
  const reload = useCallback(async () => {
    setBusy('load');
    const res = await httpAdminInvites();
    if (!aliveRef.current) {
      setBusy(null);
      return;
    }
    setBusy(null);
    if (res.ok === true) {
      setRows(res.invites);
      return;
    }
    setStatus({
      kind: 'err',
      text: humanError(res.reason, res.message || 'Список кодов приглашений не загрузился.'),
      details: res.details || undefined,
    });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    return () => {
      aliveRef.current = false;
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- монтирование вкладки: один стартовый запрос
  }, []);

  /** Копирование кода в буфер: клик по коду или по кнопке «Скопировать». */
  const copyCode = useCallback(async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(code);
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setStatus({ kind: 'err', text: 'Браузер не дал доступ к буферу обмена — скопируйте код вручную.' });
    }
  }, []);

  /** Генерация новых кодов: сразу показываем их и перечитываем список. */
  const generate = useCallback(async () => {
    if (busy !== null) return;
    setBusy('gen');
    const res = await httpAdminInvitesGenerate(count, note);
    setBusy(null);
    if (res.ok === true) {
      setFresh(res.invites);
      setNote('');
      setStatus({ kind: 'ok', text: `Готово: сгенерировано кодов — ${res.invites.length}.` });
      await reload();
      return;
    }
    setStatus({
      kind: 'err',
      text: humanError(res.reason, res.message || 'Сгенерировать коды не удалось.'),
      details: res.details || undefined,
    });
  }, [busy, count, note, reload]);

  /** Отзыв действующего кода — с подтверждением (прецедент room-config-panel). */
  const revoke = useCallback(
    async (row: AdminInviteRow) => {
      if (!window.confirm(`Отозвать код ${row.code}? Зарегистрироваться по нему будет нельзя.`)) return;
      setBusy(`revoke:${row.code}`);
      const res = await httpAdminInviteRevoke(row.code);
      setBusy(null);
      if (res.ok === true) {
        setFresh((prev) => prev.filter((f) => f.code !== row.code));
        setStatus({ kind: 'ok', text: `Код ${row.code} отозван.` });
        await reload();
        return;
      }
      setStatus({
        kind: 'err',
        text: humanError(res.reason, res.message || `Отозвать код ${row.code} не удалось.`),
        details: res.details || undefined,
      });
      await reload();
    },
    [reload],
  );

  /** Смена количества: селект держит число-строку, штатно чиним тип. */
  const pickCount = (v: string) => {
    const num = Number(v);
    setCount(COUNT_OPTIONS.includes(num) ? num : COUNT_OPTIONS[0]);
  };

  return (
    <div className="flex flex-col gap-3">
      {status ? (
        <div
          className={`rounded-lg border p-3 ${
            status.kind === 'ok' ? 'border-emerald-900/60 bg-emerald-950/40' : 'border-red-900/60 bg-red-950/40'
          }`}
        >
          <p className={`text-sm font-semibold ${status.kind === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
            {status.text}
          </p>
          {status.details ? (
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 text-[11px] text-red-200">
              {status.details}
            </pre>
          ) : null}
        </div>
      ) : null}

      <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
        <p className="text-sm font-bold text-[var(--sim-text)]">Сгенерировать коды</p>
        <p className="mt-1 text-[11px] text-[var(--sim-text-soft)]">
          Регистрация закрытого сайта — только по приглашениям. Код вида XXXX-XXXX действует 24 часа.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="block text-xs text-[var(--sim-text-soft)]">
            <span className="mb-1 block">Сколько кодов</span>
            <Select
              aria-label="Сколько кодов сгенерировать"
              className="w-24"
              value={String(count)}
              disabled={busy !== null}
              onChange={(e) => pickCount(e.target.value)}
            >
              {COUNT_OPTIONS.map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
          <label className="min-w-[12rem] flex-1 text-xs text-[var(--sim-text-soft)]">
            <span className="mb-1 block">Заметка — кому или для чего (необязательно)</span>
            <input
              type="text"
              value={note}
              maxLength={80}
              placeholder="например: для друга Айны"
              disabled={busy !== null}
              onChange={(e) => {
                setNote(e.target.value);
                if (e.target.value.length > 80) {
                  setStatus({ kind: 'err', text: 'Заметка длиннее 80 символов — сократите её.' });
                }
              }}
              className="h-8 w-full rounded-md border border-[var(--sim-line)] bg-black/30 px-2 text-sm text-[var(--sim-text)] outline-none focus:border-[var(--sim-line-strong)] disabled:opacity-50"
            />
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={busy !== null}
            onClick={() => void generate()}
          >
            Сгенерировать
          </Button>
        </div>

        {fresh.length > 0 ? (
          <div className="mt-3 rounded-lg border border-[var(--sim-line)] bg-black/20 p-3">
            <p className="text-[11px] font-semibold text-[var(--sim-text)]">
              Новые коды — скопируйте и передайте (действуют 24 часа)
            </p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {fresh.map((row) => (
                <li key={row.code} className="flex items-center gap-1.5">
                  <button
                    type="button"
                    title="Скопировать код"
                    onClick={() => void copyCode(row.code)}
                    className="rounded-md border border-[rgba(246,215,162,0.45)] bg-[rgba(10,14,32,0.62)] px-2 py-1 font-mono text-[13px] tracking-wide text-[#f6d7a2] transition-colors hover:bg-[rgba(226,220,255,0.14)]"
                  >
                    {row.code}
                  </button>
                  {copied === row.code ? (
                    <span className="text-[10px] font-semibold text-emerald-300">скопировано</span>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-1.5 text-[10px]"
                      onClick={() => void copyCode(row.code)}
                    >
                      Скопировать
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold text-[var(--sim-text)]">Все коды приглашений</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={busy !== null}
            onClick={() => void reload()}
          >
            {busy === 'load' ? 'Обновляем…' : 'Обновить список'}
          </Button>
        </div>

        {rows === null ? (
          <p className="mt-2 text-sm text-[var(--sim-text-soft)]">Загружаем коды приглашений…</p>
        ) : rows.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--sim-text-soft)]">
            Кодов ещё нет — сгенерируйте первый набор выше.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1.5">
            {rows.map((row) => {
              const chip = inviteChip(row);
              const life = row.status === 'active' ? lifeLeft(row.expiresAt) : '';
              return (
                <li
                  key={row.code}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--sim-line)] bg-black/20 px-2 py-1.5"
                >
                  <button
                    type="button"
                    title="Скопировать код"
                    onClick={() => void copyCode(row.code)}
                    className="rounded-md border border-[rgba(226,220,255,0.16)] bg-black/30 px-2 py-0.5 font-mono text-[12.5px] tracking-wide text-[#efe7ff] transition-colors hover:bg-[rgba(226,220,255,0.14)]"
                  >
                    {row.code}
                  </button>
                  <span className={`rounded border px-1.5 py-0.5 text-[10px] ${chip.cls}`}>{chip.text}</span>
                  {row.note ? (
                    <span className="max-w-[16rem] truncate text-[11px] text-[var(--sim-text-faint)]" title={row.note}>
                      {row.note}
                    </span>
                  ) : null}
                  {row.claimedByLogin ? (
                    <span className="text-[11px] text-[var(--sim-text-soft)]">использовал: {row.claimedByLogin}</span>
                  ) : null}
                  <span className="text-[11px] text-[var(--sim-text-soft)]">
                    создан {fmtTime(row.createdAt) || '—'}
                    {life ? ` · ${life}` : ''}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {copied === row.code ? (
                      <span className="text-[10px] font-semibold text-emerald-300">скопировано</span>
                    ) : null}
                    {row.status === 'active' ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-[11px]"
                        disabled={busy !== null || busy === `revoke:${row.code}`}
                        onClick={() => void revoke(row)}
                      >
                        {busy === `revoke:${row.code}` ? 'Отзываем…' : 'Отозвать'}
                      </Button>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
