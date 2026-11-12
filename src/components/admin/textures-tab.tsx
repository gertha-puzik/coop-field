'use client';

/**
 * Вкладка «Текстуры» дашборда /admin — замена PNG, CRUD своих объектов/поверхностей
 * с названием и категорией-вкладкой редактора (деревья/камни/растения/покрытия/полы).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  httpAdminTextures,
  httpAdminTexCreate,
  httpAdminTexPatch,
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
    case 'invalid_label':
      return 'Название должно быть от 1 до 48 символов.';
    case 'invalid_category':
      return 'Выберите вкладку редактора: деревья, камни, растения, покрытия или поверхности.';
    case 'limit':
      return 'Достигнут лимит своих текстур.';
    case 'builtin_immutable':
      return 'У базовой текстуры меняются только байты PNG; имя и вкладка — у своих.';
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
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newCategory, setNewCategory] = useState('trees');
  const [newGroup, setNewGroup] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editCategory, setEditCategory] = useState('trees');
  const [editGroup, setEditGroup] = useState('');
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const createFileRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    const res = await httpAdminTextures();
    if (!res.ok) {
      setStatus({ kind: 'err', text: humanError(res.reason, 'Не удалось загрузить каталог текстур.'), details: res.message || undefined });
      return;
    }
    setItems(res.items);
    setCategories(res.categories);
    if (res.categories[0] && !res.categories.some((c) => c.id === newCategory)) {
      setNewCategory(res.categories[0].id);
    }
  }, [newCategory]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter !== 'all' && item.category !== filter) return false;
      if (!q) return true;
      return (
        item.id.includes(q) ||
        item.label.toLowerCase().includes(q) ||
        (item.group || '').toLowerCase().includes(q)
      );
    });
  }, [items, filter, query]);

  const afterMutation = async (item?: AdminTexItem) => {
    if (item) setItems((list) => {
      const i = list.findIndex((row) => row.id === item.id);
      if (i < 0) return [...list, item];
      const next = list.slice();
      next[i] = item;
      return next;
    });
    void refreshTexCatalog();
  };

  const create = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy('create');
    setStatus(null);
    const res = await httpAdminTexCreate({
      file,
      label: newLabel.trim() || file.name.replace(/\.png$/i, ''),
      category: newCategory,
      group: newGroup.trim() || undefined,
    });
    setBusy(null);
    if (!res.ok) {
      setStatus({ kind: 'err', text: humanError(res.reason, 'Не удалось добавить текстуру.'), details: res.message || undefined });
      return;
    }
    setNewLabel('');
    setNewGroup('');
    await afterMutation(res.item);
    if (res.item) setItems((list) => [...list.filter((r) => r.id !== res.item!.id), res.item!]);
    setStatus({ kind: 'ok', text: `Добавлена «${res.item?.label || res.item?.id}» во вкладку «${categories.find((c) => c.id === res.item?.category)?.label || res.item?.category}».` });
  };

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
    await afterMutation(res.item);
    setStatus({ kind: 'ok', text: `Текстура «${res.item?.label || id}» заменена.` });
  };

  const saveEdit = async (id: string) => {
    if (busy) return;
    setBusy(id);
    setStatus(null);
    const res = await httpAdminTexPatch(id, {
      label: editLabel.trim(),
      category: editCategory,
      group: editGroup.trim() ? editGroup.trim() : null,
    });
    setBusy(null);
    if (!res.ok) {
      setStatus({ kind: 'err', text: humanError(res.reason, 'Не удалось сохранить название/вкладку.'), details: res.message || undefined });
      return;
    }
    setEditId(null);
    await afterMutation(res.item);
    setStatus({ kind: 'ok', text: `Обновлена «${res.item?.label || id}».` });
  };

  const removeOrRestore = async (item: AdminTexItem) => {
    if (pendingDelete !== item.id) {
      setPendingDelete(item.id);
      return;
    }
    setPendingDelete(null);
    setBusy(item.id);
    setStatus(null);
    const res = await httpAdminTexRestore(item.id);
    setBusy(null);
    if (!res.ok) {
      setStatus({
        kind: 'err',
        text: humanError(res.reason, item.custom ? 'Удаление не удалось.' : 'Откат не удался.'),
        details: res.message || undefined,
      });
      return;
    }
    if (res.deleted) {
      setItems((list) => list.filter((row) => row.id !== item.id));
      void refreshTexCatalog();
      setStatus({ kind: 'ok', text: `«${item.label}» удалена из каталога.` });
      return;
    }
    await afterMutation(res.item);
    setStatus({ kind: 'ok', text: res.restored ? `«${item.id}» возвращена к базовой.` : `«${item.id}» уже была базовой.` });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-[var(--sim-text)]">Текстуры редактора</h2>
          <p className="mt-1 max-w-2xl text-sm text-[var(--sim-text-soft)]">
            Базовые PNG можно заменить или откатить. Свои объекты и поверхности добавляются с названием
            и категорией — они сразу появляются во вкладках «Объекты» / «Поверхность» редактора локации.
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

      <section className="rounded-xl border border-white/10 bg-[rgba(10,14,32,0.45)] p-4">
        <h3 className="text-sm font-semibold text-[var(--sim-text)]">Добавить объект или поверхность</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs text-[var(--sim-text-soft)]">
            Название
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              maxLength={48}
              placeholder="Например: Дуб малый"
              className="mt-1 w-full rounded-md border border-white/15 bg-black/30 px-3 py-2 text-sm text-[var(--sim-text)]"
            />
          </label>
          <label className="text-xs text-[var(--sim-text-soft)]">
            Вкладка редактора
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="mt-1 w-full rounded-md border border-white/15 bg-black/30 px-3 py-2 text-sm text-[var(--sim-text)]"
            >
              {categories.map((cat) => (
                <option key={cat.id} value={cat.id}>{cat.label}</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-[var(--sim-text-soft)]">
            Тег / группа (необязательно)
            <input
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
              maxLength={48}
              placeholder="Например: Мои деревья"
              className="mt-1 w-full rounded-md border border-white/15 bg-black/30 px-3 py-2 text-sm text-[var(--sim-text)]"
            />
          </label>
          <div className="flex items-end">
            <input
              ref={createFileRef}
              type="file"
              accept="image/png,.png"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                void create(file);
              }}
            />
            <Button
              className="w-full"
              disabled={busy === 'create'}
              onClick={() => createFileRef.current?.click()}
            >
              {busy === 'create' ? '…' : 'Выбрать PNG и добавить'}
            </Button>
          </div>
        </div>
      </section>

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
          placeholder="Поиск по имени, тегу или id"
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
              <div className="min-w-0 flex-1">
                {editId === item.id ? (
                  <div className="space-y-1">
                    <input
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      maxLength={48}
                      className="w-full rounded border border-white/20 bg-black/40 px-2 py-1 text-sm"
                      aria-label="Название текстуры"
                    />
                    <select
                      value={editCategory}
                      onChange={(e) => setEditCategory(e.target.value)}
                      className="w-full rounded border border-white/20 bg-black/40 px-2 py-1 text-xs"
                      aria-label="Вкладка редактора"
                    >
                      {categories.map((cat) => (
                        <option key={cat.id} value={cat.id}>{cat.label}</option>
                      ))}
                    </select>
                    <input
                      value={editGroup}
                      onChange={(e) => setEditGroup(e.target.value)}
                      maxLength={48}
                      placeholder="Тег / группа"
                      className="w-full rounded border border-white/20 bg-black/40 px-2 py-1 text-xs"
                      aria-label="Тег текстуры"
                    />
                  </div>
                ) : (
                  <>
                    <h3 className="truncate text-sm font-semibold text-[var(--sim-text)]">{item.label}</h3>
                    <p className="truncate text-xs text-[var(--sim-text-soft)]">{item.id}</p>
                    <p className="text-[11px] text-[var(--sim-text-soft)]">
                      {item.custom ? 'своя' : item.replaced ? `замена · ${item.w}×${item.h}` : 'базовая'}
                      {item.group ? ` · ${item.group}` : ''}
                    </p>
                  </>
                )}
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
              {item.custom ? (
                editId === item.id ? (
                  <>
                    <Button size="sm" disabled={busy === item.id} onClick={() => void saveEdit(item.id)}>
                      Сохранить
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditId(null)}>
                      Отмена
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy === item.id}
                    onClick={() => {
                      setEditId(item.id);
                      setEditLabel(item.label);
                      setEditCategory(item.category);
                      setEditGroup(item.group || '');
                      setPendingDelete(null);
                    }}
                  >
                    Имя / вкладка
                  </Button>
                )
              ) : null}
              <Button
                size="sm"
                variant="outline"
                disabled={(!item.custom && !item.replaced) || busy === item.id}
                onClick={() => void removeOrRestore(item)}
              >
                {pendingDelete === item.id
                  ? (item.custom ? 'Точно удалить?' : 'Точно вернуть?')
                  : (item.custom ? 'Удалить' : 'Вернуть базовую')}
              </Button>
            </div>
          </article>
        ))}
      </div>
      {!visible.length ? <p className="text-sm text-[var(--sim-text-soft)]">Нет текстур по текущему фильтру.</p> : null}
    </div>
  );
}
