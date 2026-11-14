'use client';

/**
 * Вкладка «Объявления» дашборда /admin: рассылка в колокольчик всем
 * аккаунтам. Контракт — http-notifications.ts (/admin/announcements*).
 */

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  httpAdminAnnouncementCreate,
  httpAdminAnnouncementDelete,
  httpAdminAnnouncements,
  type AnnouncementRow,
} from '@/lib/net/http-notifications';

type Status = { kind: 'ok' | 'err'; text: string } | null;

const TITLE_MAX = 80;
const BODY_MAX = 800;

function humanError(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case 'auth_required':
      return 'Нужен вход в аккаунт администратора.';
    case 'forbidden':
      return 'Раздел открыт только администраторам.';
    case 'csrf_origin_required':
    case 'csrf':
      return 'Запрос отклонён защитой — обновите страницу.';
    case 'invalid_title':
    case 'invalid_body':
      return 'Нужны заголовок и текст объявления.';
    case 'offline':
      return 'Сервер недоступен.';
    default:
      return fallback;
  }
}

function fmtTime(ts: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString('ru-RU', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function AnnouncementsTab() {
  const [rows, setRows] = useState<AnnouncementRow[] | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>(null);

  const reload = useCallback(async () => {
    setBusy('load');
    const items = await httpAdminAnnouncements();
    setBusy(null);
    setRows(items);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async () => {
    const t = title.trim();
    const b = body.trim();
    if (!t || !b) {
      setStatus({ kind: 'err', text: 'Нужны заголовок и текст.' });
      return;
    }
    setBusy('create');
    setStatus(null);
    const res = await httpAdminAnnouncementCreate(t, b);
    setBusy(null);
    if (!res.ok) {
      setStatus({ kind: 'err', text: humanError(res.reason, 'Не удалось отправить объявление.') });
      return;
    }
    setTitle('');
    setBody('');
    setStatus({ kind: 'ok', text: 'Объявление разослано в колокольчики.' });
    await reload();
  };

  const remove = async (id: string) => {
    if (!window.confirm('Удалить это объявление из журнала?')) return;
    setBusy(`del:${id}`);
    const res = await httpAdminAnnouncementDelete(id);
    setBusy(null);
    if (!res.ok) {
      setStatus({ kind: 'err', text: humanError(res.reason, 'Не удалось удалить.') });
      return;
    }
    setRows((prev) => (prev ? prev.filter((r) => r.id !== id) : prev));
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
        <h2 className="text-base font-bold text-[var(--sim-text)]">Новое объявление</h2>
        <p className="mt-1 text-sm text-[var(--sim-text-soft)]">
          Текст уйдёт всем аккаунтам в колокольчик шапки. Заголовок до {TITLE_MAX} символов.
        </p>
        <label className="mt-3 block">
          <span className="text-[11px] text-[var(--sim-text-faint)]">Заголовок</span>
          <Input
            className="mt-1 h-9"
            value={title}
            maxLength={TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            disabled={busy !== null}
          />
        </label>
        <label className="mt-3 block">
          <span className="text-[11px] text-[var(--sim-text-faint)]">Текст</span>
          <textarea
            className="mt-1 min-h-24 w-full rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-2 text-sm text-[var(--sim-text)] outline-none focus-visible:border-[var(--sim-line-hover)]"
            value={body}
            maxLength={BODY_MAX}
            onChange={(e) => setBody(e.target.value)}
            disabled={busy !== null}
          />
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
            disabled={busy !== null}
            onClick={() => void create()}
          >
            {busy === 'create' ? 'Отправляем…' : 'Разослать'}
          </Button>
          {status ? (
            <span className={`text-sm ${status.kind === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>
              {status.text}
            </span>
          ) : null}
        </div>
      </section>

      <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-[var(--sim-text)]">Журнал</h2>
          <Button type="button" size="sm" variant="outline" className="h-7 text-[11px]" disabled={busy === 'load'} onClick={() => void reload()}>
            Обновить
          </Button>
        </div>
        {rows === null || busy === 'load' ? (
          <p className="mt-3 text-sm text-[var(--sim-text-soft)]">Загружаем…</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--sim-text-soft)]">Объявлений ещё не было.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="rounded-lg border border-[rgba(226,220,255,0.12)] bg-[rgba(10,14,32,0.35)] p-3"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-[var(--sim-text)]">{row.title}</div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--sim-text-soft)]">{row.body}</p>
                    <p className="mt-2 text-[11px] text-[var(--sim-text-faint)]">
                      {fmtTime(row.createdAt)}
                      {row.authorLogin ? ` · ${row.authorLogin}` : ''}
                      {row.delivered ? ` · доставлено: ${row.delivered}` : ''}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[11px]"
                    disabled={busy !== null}
                    onClick={() => void remove(row.id)}
                  >
                    Удалить
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
