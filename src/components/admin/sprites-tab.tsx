'use client';

/**
 * Вкладка «Спрайты» дашборда /admin (менеджер спрайтов, задача владелицы:
 * «загрузка и удаление скинов/персонажей с категориями»). Сателлит
 * players-field-tab.tsx: тот же каркас (status-баннер, инлайн-подтверждение
 * удаления вторым кликом — никакого window.confirm, busy-состояния строк).
 *
 * Данные — GET /admin/sprites (полный каталог с владельцами из аккаунтов);
 * операции — POST multipart (upload PNG), PATCH (имя/категория инлайн),
 * DELETE (только загруженные и только свободные; отказ «одет» показывает
 * ники — кого переодеть сначала). Список перечитывается после каждой
 * операции; категории — свободные строки с datalist подсказкой из уже
 * существующих (жёсткого списка нет).
 *
 * Каталог публичный ОБЕИМ сайтам (карусель входа тянет /sprites/catalog),
 * но сама вкладка — только панель Elysium: модуль в бандле страницы /admin
 * (site-изоляция §10.4, https — http-admin-sprites.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  httpAdminSprites,
  httpAdminSpriteUpload,
  httpAdminSpritePatch,
  httpAdminSpriteDelete,
  type AdminSpriteItem,
  type AdminSpriteError,
} from '@/lib/net/http-admin-sprites';

type Status = { kind: 'ok' | 'err'; text: string; details?: string } | null;

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
    case 'too_large':
      return 'Файл больше 3 МБ не принимается — уменьшите PNG.';
    case 'invalid_png':
      return 'Файл не похож на PNG — подпись первых байтов не совпала.';
    case 'invalid_name':
      return 'Имя спрайта: 2–24 символа.';
    case 'invalid_category':
      return 'Категория: 1–32 символа, не пустая.';
    case 'no_file':
      return 'Файл PNG не приложен.';
    case 'bad_content_type':
    case 'invalid_multipart':
    case 'upload_failed':
      return 'Форма загрузки не читается — обновите страницу и попробуйте снова.';
    case 'in_use':
      return 'Спрайт одет — сначала смените скин персонажам списка.';
    case 'builtin_immutable':
      return 'Базовые спрайты раздаются статикой деплоя — удалить их нельзя.';
    case 'unknown_sprite':
      return 'Спрайта с таким id уже нет — обновите список.';
    case 'empty_patch':
    case 'json':
    case 'patch_failed':
      return 'Сервер не понял запрос — обновите страницу и попробуйте снова.';
    case 'storage':
    case 'delete_failed':
      return 'Не удалось сохранить изменение на сервере.';
    case 'offline':
      return 'Сервер недоступен — проверьте соединение.';
    default:
      return fallback;
  }
}

/** Дата загрузки для подсказки строки (builtin — «базовый»). */
function addedLabel(item: AdminSpriteItem): string {
  if (!item.addedAt) return 'базовый';
  return `загружен ${new Date(item.addedAt).toLocaleDateString('ru-RU')}`;
}

export function SpritesTab() {
  const [items, setItems] = useState<AdminSpriteItem[] | null>(null);
  const [status, setStatus] = useState<Status>(null);

  /** Инлайн-подтверждение удаления: id строки; Отмена = ничего не отправлено. */
  const [armedId, setArmedId] = useState<string | null>(null);
  /** Инлайн-редактирование имени/категории: id строки. */
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  /** Форма загрузки. */
  const [upName, setUpName] = useState('');
  const [upCategory, setUpCategory] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [upFile, setUpFile] = useState<File | null>(null);

  const aliveRef = useRef(true);

  const reload = useCallback(async () => {
    const res = await httpAdminSprites();
    if (!aliveRef.current) return;
    if (res.ok === true) {
      setItems(res.items);
      return;
    }
    setStatus({
      kind: 'err',
      text: humanError(res.reason, 'Каталог спрайтов не загрузился.'),
      details: res.message || undefined,
    });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    return () => {
      aliveRef.current = false;
    };
  }, [reload]);

  /** Существующие категории — datalist-подсказка формы (свободный ввод). */
  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const it of items || []) {
      if (it.category && !seen.includes(it.category)) seen.push(it.category);
    }
    return seen;
  }, [items]);

  const upload = useCallback(async () => {
    if (!upFile) {
      setStatus({ kind: 'err', text: 'Сначала выберите PNG-файл.' });
      return;
    }
    setUploading(true);
    const res = await httpAdminSpriteUpload(upFile, upName, upCategory);
    setUploading(false);
    if (res.ok === true && res.item) {
      setStatus({
        kind: 'ok',
        text: `Спрайт «${res.item.name}» загружен (id ${res.item.id}), категория «${res.item.category}».`,
      });
      if (fileRef.current) fileRef.current.value = '';
      setUpFile(null);
      setUpName('');
      await reload();
      return;
    }
    const err = res as AdminSpriteError;
    setStatus({
      kind: 'err',
      text: humanError(err.reason, 'Загрузка не удалась.'),
      details: err.message || undefined,
    });
  }, [upFile, upName, upCategory, reload]);

  const startEdit = useCallback((it: AdminSpriteItem) => {
    setArmedId(null);
    setEditId(it.id);
    setEditName(it.name);
    setEditCategory(it.category);
  }, []);

  const saveEdit = useCallback(
    async (id: string) => {
      setBusyId(id);
      const res = await httpAdminSpritePatch(id, { name: editName, category: editCategory });
      setBusyId(null);
      if (res.ok === true) {
        setEditId(null);
        setStatus({ kind: 'ok', text: 'Изменения сохранены.' });
        await reload();
        return;
      }
      const err = res as AdminSpriteError;
      setStatus({
        kind: 'err',
        text: humanError(err.reason, 'Изменение не сохранилось.'),
        details: err.message || undefined,
      });
    },
    [editName, editCategory, reload],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      const res = await httpAdminSpriteDelete(id);
      setBusyId(null);
      setArmedId(null);
      if (res.ok === true) {
        setStatus({ kind: 'ok', text: `Спрайт ${id} удалён из каталога.` });
        await reload();
        return;
      }
      const err = res as AdminSpriteError;
      const worn = err.wornBy || [];
      setStatus({
        kind: 'err',
        text: humanError(err.reason, 'Удалить не удалось.'),
        details:
          err.message ||
          (worn.length ? `Одет у: ${worn.map((w) => `${w.login} (${w.character})`).join(', ')}` : undefined),
      });
      await reload();
    },
    [reload],
  );

  const canUpload = !uploading && upFile !== null && upName.trim().length >= 2 && upCategory.trim().length > 0;

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

      {/* Загрузка нового скина: PNG + имя + категория (datalist существующих). */}
      <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
        <p className="text-sm font-bold text-[var(--sim-text)]">Загрузить спрайт</p>
        <p className="mt-1 text-[11px] text-[var(--sim-text-faint)]">
          PNG до 3 МБ · имя 2–24 символов (id — транслит имени, смене не подлежит) · категория 1–32 символов (свободная строка).
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png"
            className="h-8 max-w-full rounded-md border border-[var(--sim-line)] bg-black/20 px-2 text-xs text-[var(--sim-text-soft)] file:mr-2 file:rounded file:border-0 file:bg-black/40 file:px-2 file:py-1 file:text-xs file:text-[var(--sim-text-soft)]"
            onChange={(e) => setUpFile(e.target.files ? e.target.files[0] : null)}
          />
          <input
            type="text"
            value={upName}
            onChange={(e) => setUpName(e.target.value)}
            placeholder="Имя (2–24)"
            maxLength={24}
            className="h-8 w-44 rounded-md border border-[var(--sim-line)] bg-black/20 px-2 text-sm text-[var(--sim-text)] placeholder:text-[var(--sim-text-faint)]"
          />
          <input
            type="text"
            value={upCategory}
            onChange={(e) => setUpCategory(e.target.value)}
            placeholder="Категория (1–32)"
            maxLength={32}
            list="sprites-categories"
            className="h-8 w-44 rounded-md border border-[var(--sim-line)] bg-black/20 px-2 text-sm text-[var(--sim-text)] placeholder:text-[var(--sim-text-faint)]"
          />
          <datalist id="sprites-categories">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <Button
            type="button"
            size="sm"
            className="h-8 px-3 text-xs"
            disabled={!canUpload}
            onClick={() => void upload()}
          >
            {uploading ? 'Загружаем…' : 'Загрузить'}
          </Button>
        </div>
      </section>

      {/* Каталог: builtin-базовые и загруженные, с владельцами и действиями. */}
      {items === null ? (
        <p className="text-sm text-[var(--sim-text-soft)]">Загружаем каталог спрайтов…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-[var(--sim-text-soft)]">Каталог пуст.</p>
      ) : (
        <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
          <p className="text-xs text-[var(--sim-text-faint)]">{items.length} спрайтов в каталоге.</p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {items.map((it) => {
              const isArmed = armedId === it.id;
              const isEdit = editId === it.id;
              const isBusy = busyId === it.id;
              return (
                <li
                  key={it.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--sim-line)] bg-black/20 px-2 py-1.5"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- файловый каталог спрайтов, не next/image */}
                  <img
                    src={it.src}
                    alt={it.name}
                    className="h-8 w-8 shrink-0 rounded object-contain"
                    loading="lazy"
                  />
                  {isEdit ? (
                    <span className="flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        maxLength={24}
                        placeholder="Имя"
                        className="h-7 w-40 rounded-md border border-[var(--sim-line)] bg-black/30 px-2 text-sm text-[var(--sim-text)]"
                      />
                      <input
                        type="text"
                        value={editCategory}
                        onChange={(e) => setEditCategory(e.target.value)}
                        maxLength={32}
                        list="sprites-categories"
                        placeholder="Категория"
                        className="h-7 w-36 rounded-md border border-[var(--sim-line)] bg-black/30 px-2 text-sm text-[var(--sim-text)]"
                      />
                      <Button
                        type="button"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        disabled={busyId !== null}
                        onClick={() => void saveEdit(it.id)}
                      >
                        Сохранить
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 text-[11px]"
                        disabled={busyId !== null}
                        onClick={() => setEditId(null)}
                      >
                        Отмена
                      </Button>
                    </span>
                  ) : (
                    <>
                      <span className="text-sm font-semibold text-[var(--sim-text)]">{it.name}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          it.builtin
                            ? 'bg-sky-950/60 text-sky-300'
                            : 'bg-emerald-950/60 text-emerald-300'
                        }`}
                      >
                        {it.builtin ? 'базовый' : 'загружен'}
                      </span>
                      <span className="text-[11px] text-[var(--sim-text-soft)]">
                        {it.category} · {addedLabel(it)} · id {it.id}
                      </span>
                      {it.wornCount > 0 ? (
                        <span className="text-[11px] text-amber-300/90">
                          одет у {it.wornCount}:{' '}
                          {it.wornBy.map((w) => `${w.login} (${w.character})`).join(', ')}
                        </span>
                      ) : (
                        <span className="text-[11px] text-[var(--sim-text-faint)]">никем не одет</span>
                      )}
                      <span className="ml-auto flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px]"
                          disabled={busyId !== null}
                          onClick={() => startEdit(it)}
                        >
                          Изменить
                        </Button>
                        {it.builtin ? null : isArmed ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              className="h-7 border-red-900/70 bg-red-950/60 px-2 text-[11px] text-red-200 hover:bg-red-900/60"
                              disabled={busyId !== null}
                              onClick={() => void remove(it.id)}
                            >
                              Точно удалить?
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              className="h-7 text-[11px]"
                              disabled={busyId !== null}
                              onClick={() => setArmedId(null)}
                            >
                              Отмена
                            </Button>
                          </>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            disabled={busyId !== null || isBusy || it.wornCount > 0}
                            onClick={() => setArmedId(it.id)}
                          >
                            Удалить
                          </Button>
                        )}
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
