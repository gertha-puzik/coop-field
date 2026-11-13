'use client';

/**
 * Вкладка «Статусы» дашборда /admin: каталог подписей на поле + назначение
 * аккаунтам. Контракт server/statuses.js (/admin/statuses*).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui';
import {
  httpAdminStatusAssign,
  httpAdminStatusCreate,
  httpAdminStatusDelete,
  httpAdminStatusRename,
  httpAdminStatuses,
  type AdminStatusAccount,
  type AdminStatusRow,
} from '@/lib/net/http-admin-ops';

type Status = { kind: 'ok' | 'err'; text: string; details?: string } | null;

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
    case 'protected':
      return 'Статус «Тестер» удалить нельзя.';
    case 'taken':
      return 'Такой id статуса уже есть.';
    case 'not_found':
    case 'no_such_account':
      return 'Запись не найдена — обновите список.';
    case 'unknown_status':
      return 'Такого статуса нет в каталоге.';
    case 'invalid_label':
    case 'invalid_id':
    case 'invalid_account':
    case 'json':
      return 'Сервер не понял запрос — проверьте поля.';
    case 'offline':
      return 'Сервер недоступен — проверьте соединение.';
    case 'proxy_html':
      return 'Запрос ушёл в статику, а не в комнату — обновите страницу после выкладки room-сервера.';
    default:
      return fallback;
  }
}

export function StatusesTab() {
  const [statuses, setStatuses] = useState<AdminStatusRow[] | null>(null);
  const [accounts, setAccounts] = useState<AdminStatusAccount[] | null>(null);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [q, setQ] = useState('');

  const applySnap = useCallback((snap: Awaited<ReturnType<typeof httpAdminStatuses>>) => {
    if (snap.ok) {
      setStatuses(snap.statuses);
      setAccounts(snap.accounts);
      return true;
    }
    // Сбрасываем null-скелет «Загрузка…», иначе ошибка и спиннер висят вместе.
    setStatuses((prev) => prev ?? []);
    setAccounts((prev) => prev ?? []);
    setStatus({
      kind: 'err',
      text: humanError(snap.reason, snap.message || 'Не удалось загрузить статусы.'),
      details: snap.details,
    });
    return false;
  }, []);

  const reload = useCallback(async () => {
    setBusy('load');
    setStatus(null);
    const snap = await httpAdminStatuses();
    applySnap(snap);
    setBusy(null);
  }, [applySnap]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    if (!accounts) return [];
    const needle = q.trim().toLowerCase();
    if (!needle) return accounts;
    return accounts.filter(
      (a) =>
        a.login.toLowerCase().includes(needle) ||
        a.displayName.toLowerCase().includes(needle) ||
        a.accountId.toLowerCase().includes(needle) ||
        a.statusLabel.toLowerCase().includes(needle),
    );
  }, [accounts, q]);

  const onCreate = async () => {
    const label = newLabel.trim();
    if (!label) {
      setStatus({ kind: 'err', text: 'Укажите название нового статуса.' });
      return;
    }
    setBusy('create');
    setStatus(null);
    const snap = await httpAdminStatusCreate(label);
    if (applySnap(snap)) {
      setNewLabel('');
      setStatus({ kind: 'ok', text: `Статус «${label}» добавлен.` });
    }
    setBusy(null);
  };

  const onRename = async (row: AdminStatusRow) => {
    const next = window.prompt('Новое название статуса', row.label);
    if (next == null) return;
    const label = next.trim();
    if (!label || label === row.label) return;
    setBusy(`rename:${row.id}`);
    setStatus(null);
    const snap = await httpAdminStatusRename(row.id, label);
    if (applySnap(snap)) setStatus({ kind: 'ok', text: `Статус переименован в «${label}».` });
    setBusy(null);
  };

  const onDelete = async (row: AdminStatusRow) => {
    if (row.id === 'tester') {
      setStatus({ kind: 'err', text: 'Статус «Тестер» удалить нельзя.' });
      return;
    }
    if (!window.confirm(`Удалить статус «${row.label}»? Назначения перейдут на «Тестер».`)) return;
    setBusy(`del:${row.id}`);
    setStatus(null);
    const snap = await httpAdminStatusDelete(row.id);
    if (applySnap(snap)) setStatus({ kind: 'ok', text: `Статус «${row.label}» удалён.` });
    setBusy(null);
  };

  const onAssign = async (accountId: string, statusId: string) => {
    setBusy(`assign:${accountId}`);
    setStatus(null);
    const snap = await httpAdminStatusAssign(accountId, statusId);
    if (applySnap(snap)) setStatus({ kind: 'ok', text: 'Статус обновлён.' });
    setBusy(null);
  };

  return (
    <div className="space-y-6">
      {status ? (
        <p
          role="status"
          className={
            status.kind === 'ok'
              ? 'rounded-md border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-100'
              : 'rounded-md border border-red-900/50 bg-red-950/30 px-3 py-2 text-sm text-red-100'
          }
        >
          {status.text}
        </p>
      ) : null}

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-[#efe7ff]">Каталог статусов</h3>
        <p className="text-xs text-[var(--sim-text-soft)]">
          Подпись видна над котом на поле третьей строкой. «Тестер» — статус по умолчанию, его
          нельзя удалить.
        </p>
        <ul className="space-y-2">
          {(statuses || []).map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-[rgba(226,220,255,0.18)] bg-[rgba(10,14,32,0.45)] px-3 py-2"
            >
              <span className="min-w-[10rem] flex-1 text-sm text-[#efe7ff]">{row.label}</span>
              <span className="font-mono text-[11px] text-[var(--sim-text-soft)]">{row.id}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!!busy}
                onClick={() => void onRename(row)}
              >
                Переименовать
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!!busy || row.id === 'tester'}
                onClick={() => void onDelete(row)}
              >
                Удалить
              </Button>
            </li>
          ))}
          {statuses === null ? (
            <li className="text-sm text-[var(--sim-text-soft)]">Загрузка…</li>
          ) : null}
        </ul>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-[var(--sim-text-soft)]">
            Новый статус
            <input
              className="rounded-md border border-[rgba(226,220,255,0.28)] bg-[rgba(10,14,32,0.62)] px-2 py-1.5 text-sm text-[#efe7ff]"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              maxLength={48}
              placeholder="Например: Модератор"
            />
          </label>
          <Button type="button" disabled={!!busy || !newLabel.trim()} onClick={() => void onCreate()}>
            Добавить
          </Button>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-[#efe7ff]">Назначения игрокам</h3>
        <label className="flex max-w-md flex-col gap-1 text-xs text-[var(--sim-text-soft)]">
          Поиск
          <input
            className="rounded-md border border-[rgba(226,220,255,0.28)] bg-[rgba(10,14,32,0.62)] px-2 py-1.5 text-sm text-[#efe7ff]"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Логин, имя, id…"
          />
        </label>
        <div className="overflow-x-auto rounded-md border border-[rgba(226,220,255,0.18)]">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="bg-[rgba(10,14,32,0.72)] text-[11px] uppercase tracking-wide text-[var(--sim-text-soft)]">
              <tr>
                <th className="px-3 py-2 font-medium">Логин</th>
                <th className="px-3 py-2 font-medium">Имя</th>
                <th className="px-3 py-2 font-medium">Статус</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.accountId} className="border-t border-[rgba(226,220,255,0.12)]">
                  <td className="px-3 py-2 text-[#efe7ff]">
                    {a.login}
                    <div className="font-mono text-[10px] text-[var(--sim-text-soft)]">{a.accountId}</div>
                  </td>
                  <td className="px-3 py-2 text-[#efe7ff]">{a.displayName}</td>
                  <td className="px-3 py-2">
                    <Select
                      aria-label={`Статус ${a.login}`}
                      value={a.statusId}
                      disabled={!!busy || !statuses?.length}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v && v !== a.statusId) void onAssign(a.accountId, v);
                      }}
                    >
                      {(statuses || []).map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
              {accounts && filtered.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-[var(--sim-text-soft)]">
                    Никого не найдено.
                  </td>
                </tr>
              ) : null}
              {accounts === null ? (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-[var(--sim-text-soft)]">
                    Загрузка…
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={() => void reload()}>
          Обновить
        </Button>
      </section>
    </div>
  );
}
