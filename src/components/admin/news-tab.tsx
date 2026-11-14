'use client';

/**
 * Вкладка «Новости доски» дашборда /admin: pin, DnD-порядок, rich-text body.
 * Сохранение — POST /cfg/news. Новые записи вставляются выше старых (под
 * закреплёнными); pinned всегда сверху на главной.
 */

import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui';
import { NewsRichEditor } from '@/components/admin/news-rich-editor';
import { httpHomeNews, type HomeNewsItem } from '@/lib/net/http-home-news';
import { httpAdminHomeNewsSave } from '@/lib/net/http-admin-ops';

type Status = { kind: 'ok' | 'err'; text: string; details?: string } | null;
type DraftRow = {
  key: string;
  id?: string;
  title: string;
  body: string;
  pinned: boolean;
};

const TITLE_MAX = 80;
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
    case 'http_405':
    case 'method_not_allowed':
      return 'Сервер отклонил способ сохранения — обновите страницу и попробуйте снова.';
    default:
      return fallback;
  }
}

function cleanDetails(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!t || t.startsWith('<') || /<!DOCTYPE|Not Allowed/i.test(t)) return undefined;
  return t.slice(0, 240);
}

/** pinned вверх; внутри групп — исходный порядок. */
function normalizeDraft(list: DraftRow[]): DraftRow[] {
  return [...list.filter((r) => r.pinned), ...list.filter((r) => !r.pinned)];
}

function toDraft(items: HomeNewsItem[]): DraftRow[] {
  return normalizeDraft(
    items.map((it, i) => ({
      key: it.id || `row-${i}`,
      id: it.id,
      title: it.title,
      body: it.body,
      pinned: it.pinned === true,
    })),
  );
}

function bodyPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Редактор новостей доски главной. */
export function NewsTab() {
  const [draft, setDraft] = useState<DraftRow[]>([]);
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [dragKey, setDragKey] = useState<string | null>(null);

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
    setDraft((list) =>
      normalizeDraft(list.map((row) => (row.key === key ? { ...row, ...patch } : row))),
    );
  };

  const addRow = () => {
    if (draft.length >= ITEMS_MAX) return;
    const row: DraftRow = {
      key: `new-${Date.now()}`,
      title: '',
      body: '',
      pinned: false,
    };
    setDraft((list) => {
      const pinned = list.filter((r) => r.pinned);
      const rest = list.filter((r) => !r.pinned);
      // Новая — выше старых незакреплённых.
      return [...pinned, row, ...rest];
    });
  };

  const removeRow = (key: string) => {
    setDraft((list) => list.filter((row) => row.key !== key));
  };

  const onDropOn = (targetKey: string) => {
    if (!dragKey || dragKey === targetKey) return;
    setDraft((list) => {
      const from = list.findIndex((r) => r.key === dragKey);
      const to = list.findIndex((r) => r.key === targetKey);
      if (from < 0 || to < 0) return list;
      const next = [...list];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return normalizeDraft(next);
    });
    setDragKey(null);
  };

  const save = async () => {
    const items = draft
      .map((row) => ({
        id: row.id,
        title: row.title.trim(),
        body: row.body,
        pinned: row.pinned,
      }))
      .filter((row) => row.title && bodyPlain(row.body));
    if (!items.length) {
      setStatus({ kind: 'err', text: 'Добавьте хотя бы одну запись с заголовком и текстом.' });
      return;
    }
    setBusy(true);
    const res = await httpAdminHomeNewsSave(items);
    setBusy(false);
    if (!res.ok) {
      const reason =
        /405|Not Allowed/i.test(res.details || '') || /405|Not Allowed/i.test(res.message || '')
          ? 'http_405'
          : res.reason;
      setStatus({
        kind: 'err',
        text: humanError(reason, 'Не удалось сохранить.'),
        details: cleanDetails(res.message || res.details),
      });
      return;
    }
    setDraft(toDraft(res.items));
    setStatus({ kind: 'ok', text: 'Новости доски сохранены — оба сайта увидят обновление.' });
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-[var(--uk-page-muted-text)]">
        Записки на доске «Что нового?». Закреплённые всегда сверху; новые — выше старых.
        Перетащите запись за «⋮⋮», чтобы сменить порядок. В тексте — жирность, курсив, подчёркивание и размер.
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
              onDragOver={(ev) => ev.preventDefault()}
              onDrop={() => onDropOn(row.key)}
              className={`flex flex-col gap-2 rounded-xl border bg-[var(--uk-panel-bg)] p-3 ${
                row.pinned ? 'border-amber-700/60' : 'border-[var(--uk-border)]'
              } ${dragKey === row.key ? 'opacity-60' : ''}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    draggable={!busy}
                    onDragStart={() => setDragKey(row.key)}
                    onDragEnd={() => setDragKey(null)}
                    className="cursor-grab select-none px-1 text-[var(--uk-page-muted-text)] active:cursor-grabbing"
                    title="Перетащить"
                    aria-label="Перетащить запись"
                    role="button"
                  >
                    ⋮⋮
                  </span>
                  <span className="text-xs text-[var(--uk-page-muted-text)]">
                    {row.pinned ? 'Закреплена' : `Запись ${idx + 1}`}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    type="button"
                    variant={row.pinned ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => updateRow(row.key, { pinned: !row.pinned })}
                    disabled={busy}
                  >
                    {row.pinned ? 'Открепить' : 'Закрепить'}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeRow(row.key)} disabled={busy}>
                    Удалить
                  </Button>
                </div>
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
              <div className="flex flex-col gap-1 text-sm">
                <span>Текст</span>
                <NewsRichEditor
                  value={row.body}
                  disabled={busy}
                  onChange={(html) => updateRow(row.key, { body: html })}
                />
              </div>
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
