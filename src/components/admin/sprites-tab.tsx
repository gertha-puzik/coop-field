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
 * операции; категории — свободные строки, выбор существующих — дропдаун
 * CategoryField. Нативный datalist убран: Chrome 154–156 ломал свой пикер
 * (crbug 566683388 и соседние) — отчёт владелицы 2026-11-10 «стрелочка есть,
 * выпадающего списка нет»; свой попап живёт в DOM и не зависит от браузера.
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

/**
 * Поле категории со встроенной стрелкой-дропдауном существующих категорий
 * (замена нативному datalist, см. шапку файла). Попап живёт в DOM: клик по
 * стрелке открывает список независимо от браузерного пикера; клик мимо и
 * Escape закрывают; панель ровно по ширине поля; текущее значение подсвечено.
 * Пустой список категорий — стрелка не рендерится вовсе (нет мёртвого
 * индикатора, дразнящего пустым списком). Ввод остаётся свободной строкой.
 */
function CategoryField({
  categories,
  value,
  onChange,
  placeholder,
  inputClassName,
}: {
  categories: string[];
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  /** Классы собственно инпута: размеры/фон мест вставки (форма/строка). */
  inputClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const arrow = categories.length > 0 ? (
    <button
      type="button"
      aria-label="Существующие категории"
      title="Существующие категории"
      onClick={() => setOpen((v) => !v)}
      className="absolute right-1 top-1/2 flex h-6 w-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded text-sm font-bold leading-none text-[var(--sim-text)] hover:bg-black/40"
    >
      ▾
    </button>
  ) : null;

  return (
    <div ref={rootRef} className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        maxLength={32}
        className={`${inputClassName} pl-2 pr-7`}
      />
      {arrow}
      {open ? (
        <ul className="absolute right-0 top-full z-50 mt-1 max-h-56 w-full overflow-auto rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] py-1 shadow-lg">
          {categories.map((c) => (
            <li key={c}>
              <button
                type="button"
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                }}
                className={`block w-full px-2 py-1 text-left text-xs ${
                  c === value
                    ? 'bg-black/40 font-semibold text-[var(--sim-text)]'
                    : 'text-[var(--sim-text)] hover:bg-black/40'
                }`}
              >
                {c}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
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

  /** Существующие категории — пункты дропдауна у инпутов (свободный ввод
   *  сохраняется: категория — не жёсткий список). */
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

  /** #83: скрытие — рычаг модерации «одетого» окраса (DELETE против него
   *  бессилен): строка уходит из каталога и вайтлиста, файл остаётся. */
  const toggleHidden = useCallback(
    async (it: AdminSpriteItem) => {
      setBusyId(it.id);
      const res = await httpAdminSpritePatch(it.id, { hidden: !it.hidden });
      setBusyId(null);
      if (res.ok === true) {
        setStatus({
          kind: 'ok',
          text: it.hidden ? `Окрас «${it.name}» снова виден.` : `Окрас «${it.name}» скрыт из каталога.`,
        });
        await reload();
        return;
      }
      const err = res as AdminSpriteError;
      setStatus({
        kind: 'err',
        text: humanError(err.reason, 'Скрытие не получилось.'),
        details: err.message || undefined,
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

      {/* Загрузка нового скина: PNG + имя + категория (дропдаун существующих). */}
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
          <CategoryField
            categories={categories}
            value={upCategory}
            onChange={setUpCategory}
            placeholder="Категория (1–32)"
            inputClassName="h-8 w-44 rounded-md border border-[var(--sim-line)] bg-black/20 text-sm text-[var(--sim-text)] placeholder:text-[var(--sim-text-faint)]"
          />
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
                      <CategoryField
                        categories={categories}
                        value={editCategory}
                        onChange={setEditCategory}
                        placeholder="Категория"
                        inputClassName="h-7 w-36 rounded-md border border-[var(--sim-line)] bg-black/30 text-sm text-[var(--sim-text)]"
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
                      {/* #83: владелец строки — логин игрока (личный окрас) или
                          админский/uploads-builtin без владельца. */}
                      {!it.builtin ? (
                        <span className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] font-bold text-[var(--sim-text-soft)]">
                          {it.owner ? `владелец: ${it.owner}` : 'владелец: админ'}
                        </span>
                      ) : null}
                      {it.hidden ? (
                        <span className="rounded bg-red-950/70 px-1.5 py-0.5 text-[10px] font-bold text-red-300">
                          скрыт
                        </span>
                      ) : null}
                      {it.wornCount > 0 ? (
                        <span className="text-[11px] text-amber-300/90">
                          одет у {it.wornCount}:{' '}
                          {it.wornBy.map((w) => `${w.login} (${w.character})`).join(', ')}
                        </span>
                      ) : (
                        <span className="text-[11px] text-[var(--sim-text-faint)]">никем не одет</span>
                      )}
                      <span className="ml-auto flex items-center gap-1.5">
                        {!it.builtin ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            disabled={busyId !== null}
                            title={it.hidden ? 'Вернуть окрас в каталог' : 'Скрыть окрас из каталога (файл остаётся)'}
                            onClick={() => void toggleHidden(it)}
                          >
                            {it.hidden ? 'Показать' : 'Скрыть'}
                          </Button>
                        ) : null}
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
