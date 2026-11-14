'use client';

/**
 * Вкладка «Новости доски» дашборда /admin: правка записок «Что нового?»
 * на главной (оба сайта читают GET /cfg/news). Сохранение — PUT /admin/news.
 */

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { httpHomeNews, type HomeNewsItem } from '@/lib/net/http-home-news';
import { httpAdminHomeNewsSave } from '@/lib/net/http-admin-ops';

type Status = { kind: 'ok' | 'err'; text: string; details?: string } | null;
type DraftRow = { key: string; id?: string; title: string; body: string };

const TITLE_MAX = 80;
const BODY_MAX = 500;
const ITEMS_MAX = 12;

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
    case 'invalid_items':
      return 'Нужен непустой список: у каждой записи заголовок и текст.';
    case 'write_failed':
    case 'storage':
      return 'Не удалось сохранить на сервере.';
    case 'offline':
      return 'Сервер недоступен — проверьте соединение.';
    default:
      return fallback;
  }
}

function toDraft(items: HomeNewsItem[]): DraftRow[] {
  return items.map((it, i) => ({
    key: it.id || `row-${i}`,
    id: it.id,
    title: it.title,
    body: it.body,
  }));
}

/** Редактор новостей доски главной. */
export function NewsTab() {
  const [draft, setDraft] = useState<DraftRow[]>([]);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const res = await httpHomeNews();
    setLoading(false);
    if (!res.ok) {
      setStatus({ kind: 'err', text: humanError(res.reason, 'Не удалось загрузить новости.'), details: res.details });
      return;
    }
    setDraft(toDraft(res.items));
    setStatus(null);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const updateRow = (key: string, patch: Partial<DraftRow>) => {
    setDraft((list) => list.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const addRow = () => {
    if (draft.length >= ITEMS_MAX) return;
    setDraft((list) => [
      ...list,
      { key: `new-${Date.now()}`, title: '', body: '' },
    ]);
  };

  const removeRow = (key: string) => {
    setDraft((list) => list.filter((row) => row.key !== key));
  };

  const save = async () => {
    const items = draft
      .map((row) => ({
        id: row.id,
        title: row.title.trim(),
        body: row.body.trim(),
      }))
      .filter((row) => row.title && row.body);
    if (!items.length) {
      setStatus({ kind: 'err', text: 'Добавьте хотя бы одну запись с заголовком и текстом.' });
      return;
    }
    setBusy(true);
    const res = await httpAdminHomeNewsSave(items);
    setBusy(false);
    if (!res.ok) {
      setStatus({
        kind: 'err',
        text: humanError(res.reason, 'Не удалось сохранить.'),
        details: res.message || res.details,
      });
      return;
    }
    setDraft(toDraft(res.items));
    setStatus({ kind: 'ok', text: 'Новости доски сохранены — оба сайта увидят обновление.' });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--uk-page-muted-text)]">
        Записки на доске «Что нового?» на главной. Сохранение сразу видно на гротах и на закрытом сайте.
      </p>
      {status ? (
        <div
          role="status"
          className={
            status.kind === 'ok'
              ? 'rounded-lg border border-emerald-800/50 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-100'
              : 'rounded-lg border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-sm text-rose-100'
          }
        >
          {status.text}
          {status.details ? <div className="mt-1 opacity-80">{status.details}</div> : null}
        </div>
      ) : null}
      {loading ? (
        <p className="text-sm text-[var(--uk-page-muted-text)]">Загружаем…</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {draft.map((row, idx) => (
            <li
              key={row.key}
              className="flex flex-col gap-2 rounded-xl border border-[var(--uk-border)] bg-[var(--uk-panel-bg)] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-[var(--uk-page-muted-text)]">Запись {idx + 1}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(row.key)} disabled={busy}>
                  Удалить
                </Button>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                <span>Заголовок</span>
                <input
                  className="rounded-md border border-[var(--uk-border-strong)] bg-[var(--uk-field-bg)] px-2 py-1.5 text-[var(--uk-field-text)]"
                  value={row.title}
                  maxLength={TITLE_MAX}
                  onChange={(ev) => updateRow(row.key, { title: ev.target.value })}
                  disabled={busy}
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>Текст</span>
                <textarea
                  className="min-h-[4.5rem] rounded-md border border-[var(--uk-border-strong)] bg-[var(--uk-field-bg)] px-2 py-1.5 text-[var(--uk-field-text)]"
                  value={row.body}
                  maxLength={BODY_MAX}
                  onChange={(ev) => updateRow(row.key, { body: ev.target.value })}
                  disabled={busy}
                />
              </label>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={addRow} disabled={busy || draft.length >= ITEMS_MAX}>
          Добавить запись
        </Button>
        <Button type="button" onClick={() => void save()} disabled={busy || loading}>
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </Button>
        <Button type="button" variant="ghost" onClick={() => void reload()} disabled={busy}>
          Обновить
        </Button>
      </div>
    </div>
  );
}
