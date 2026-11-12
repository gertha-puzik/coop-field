'use client';

/**
 * Вкладка «Текстуры» дашборда /admin — замена PNG объектов и поверхностей
 * редактора локации (деревья, камни, растения, покрытия, полы). Каталог id
 * фиксирован сервером; здесь только подмена байтов и откат к builtin.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  httpAdminTextures,
  httpAdminTexReplace,
  httpAdminTexRestore,
  type AdminTexItem,
} from '@/lib/net/http-admin-tex';
import { refreshTexCatalog } from '@/lib/sim/textures';

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
    case 'too_large':
      return 'Файл больше 2 МБ не принимается — уменьшите PNG.';
    case 'invalid_png':
      return 'Файл не похож на PNG — проверьте формат и размер стороны.';
    case 'no_file':
      return 'Файл PNG не приложен.';
    case 'unknown_texture':
      return 'Такой текстуры в каталоге редактора нет.';
    case 'offline':
      return 'Сервер недоступен — проверьте соединение.';
    default:
      return fallback;
  }
}

export function TexturesTab() {
  const [items, setItems] = useState<AdminTexItem[]>([]);
  const [categories, setCategories] = useState<{ id: string; label: string }[]>([]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const reload = useCallback(async () => {
    const res = await httpAdminTextures();
    if (!res.ok) {
      setStatus({ kind: 'err', text: humanError(res.reason, 'Не удалось загрузить каталог текстур.'), details: res.message || undefined });
      return;
    }
    setItems(res.items);
    setCategories(res.categories);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'all' && item.category !== filter) return false;
      if (!q) return true;
      return item.id.includes(q) || item.label.toLowerCase().includes(q) || (item.group || '').toLowerCase().includes(q);
    });
  }, [items, filter, query]);

  const replace = async (id: string, file: File | undefined) => {
    if (!file || busy) return;
    setBusy(id);
    setStatus(null);
    const res = await httpAdminTexReplace(id, file);
    setBusy(null);
    if (!res.ok) {
      setStatus({ kind: 'err', text: humanError(res.reason, 'Замена не удалась.'), details: res.message || undefined });
      return;
    }
    if (res.item) setItems((list) => list.map((row) => (row.id === id ? res.item! : row)));
    void refreshTexCatalog();
    setStatus({ kind: 'ok', text: `Текстура «${res.item?.label || id}» заменена.` });
  };

  const restore = async (id: string) => {
    if (pendingRestore !== id) {
      setPendingRestore(id);
      return;
    }
    setPendingRestore(null);
    setBusy(id);
    setStatus(null);
    const res = await httpAdminTexRestore(id);
    setBusy(null);
    if (!res.ok) {
      setStatus({ kind: 'err', text: humanError(res.reason, 'Откат не удался.'), details: res.message || undefined });
      return;
    }
    if (res.item) setItems((list) => list.map((row) => (row.id === id ? res.item! : row)));
    void refreshTexCatalog();
    setStatus({ kind: 'ok', text: res.restored ? `«${id}» возвращена к базовой.` : `«${id}» уже была базовой.` });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--sim-text)]">Текстуры редактора</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--sim-text-soft)]">
            Все текстуры вкладок «Объекты» и «Поверхность»: деревья, камни, растения, покрытия клеток и бесшовные полы.
            Замена действует сразу в каталоге; в открытой игровой комнате обновите страницу при необходимости.
          </p>
        </div>
        <Button variant="outline" disabled={!!busy} onClick={() => void reload()}>
          Обновить список
        </Button>
      </div>

      {status ? (
        <div
          className={`rounded-lg border p-3 ${
            status.kind === 'ok' ? 'border-emerald-900/60 bg-emerald-950/40' : 'border-red-900/60 bg-red-950/40'
          }`}
        >
          <p className={`text-sm font-semibold ${status.kind === 'ok' ? 'text-emerald-300' : 'text-red-300'}`}>{status.text}</p>
          {status.details ? <p className="mt-1 text-xs text-red-200">{status.details}</p> : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={`rounded-md border px-3 py-1.5 text-sm ${filter === 'all' ? 'border-[rgba(226,220,255,0.45)] bg-white/10' : 'border-white/10'}`}
          aria-pressed={filter === 'all'}
          onClick={() => setFilter('all')}
        >
          Все
        </button>
        {categories.map((cat) => (
          <button
            type="button"
            key={cat.id}
            className={`rounded-md border px-3 py-1.5 text-sm ${filter === cat.id ? 'border-[rgba(226,220,255,0.45)] bg-white/10' : 'border-white/10'}`}
            aria-pressed={filter === cat.id}
            onClick={() => setFilter(cat.id)}
          >
            {cat.label}
          </button>
        ))}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по имени или id"
          aria-label="Поиск текстур"
          className="ml-auto min-w-[12rem] rounded-md border border-white/15 bg-black/30 px-3 py-1.5 text-sm"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {visible.map((item) => (
          <article
            key={item.id}
            className="flex flex-col gap-2 rounded-xl border border-white/10 bg-[rgba(10,14,32,0.55)] p-3"
          >
            <div className="flex items-center gap-3">
              <span
                className="h-16 w-16 shrink-0 rounded-md border border-white/10 bg-[length:contain] bg-center bg-no-repeat"
                style={{ backgroundImage: `url(${item.src})`, backgroundColor: '#1a2238' }}
                aria-hidden
              />
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-[var(--sim-text)]">{item.label}</h3>
                <p className="truncate text-xs text-[var(--sim-text-soft)]">{item.id}</p>
                <p className="text-[11px] text-[var(--sim-text-soft)]">
                  {item.replaced
                    ? `замена · ${item.w}×${item.h}`
                    : item.group
                      ? item.group
                      : 'базовая'}
                </p>
              </div>
            </div>
            <div className="mt-auto flex flex-wrap gap-2">
              <input
                ref={(el) => { fileRefs.current[item.id] = el; }}
                type="file"
                accept="image/png,.png"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  void replace(item.id, file);
                }}
              />
              <Button
                size="sm"
                disabled={busy === item.id}
                onClick={() => fileRefs.current[item.id]?.click()}
              >
                {busy === item.id ? '…' : 'Заменить PNG'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!item.replaced || busy === item.id}
                onClick={() => void restore(item.id)}
              >
                {pendingRestore === item.id ? 'Точно вернуть?' : 'Вернуть базовую'}
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!visible.length ? <p className="text-sm text-[var(--sim-text-soft)]">Нет текстур по текущему фильтру.</p> : null}
    </div>
  );
}
