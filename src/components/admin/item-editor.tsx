"use client";
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Input, Dropdown, Dialog } from "@/components/ui";
import {
  ITEM_CATEGORIES,
  inventoryRequest,
  inventoryError,
  uploadItemSprite,
  itemSprite,
  type ItemDefinition,
} from "@/lib/net/http-inventory";
import s from "./items.module.css";
export function ItemGlyph({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const paths: Record<string, string> = {
    box: "m3 7 9-5 9 5-9 5-9-5Zm0 0v10l9 5 9-5V7M12 12v10",
    gift: "M3 8h18v4H3zM5 12v10h14V12M12 8v14M12 8C4 8 5 0 9 3l3 5Zm0 0c8 0 7-8 3-5l-3 5Z",
    layers: "m2 7 10-5 10 5-10 5-10-5Zm0 5 10 5 10-5M2 17l10 5 10-5",
    eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Zm7 0a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z",
    save: "M4 3h13l4 4v14H3V3h1Zm3 0v6h10V3M7 21v-8h10v8",
    trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
    search: "M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 6 6",
    settings: "M3 6h18M3 12h18M3 18h18M7 3v6M16 9v6M10 15v6",
    user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 22v-2a8 8 0 0 1 16 0v2",
    file: "M3 6h7l2 3h9v12H3V6Z",
    plus: "M12 4v16M4 12h16",
    edit: "m4 17 12-13 4 4L8 21H3l1-4Z",
    expand: "M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6",
    spark: "m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z",
  };
  return (
    <svg
      className={className}
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.box} />
    </svg>
  );
}
export function ItemPanel({
  title,
  icon,
  children,
  className = "",
}: {
  title: string;
  icon: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`${s.panel} ${className}`}>
      <h3>
        <ItemGlyph name={icon} />
        {title}
      </h3>
      <div className={s.panelBody}>{children}</div>
    </section>
  );
}
export function ItemStepper({
  label,
  value,
  min,
  max,
  step = 1,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  const id = useId();
  const change = (n: number) =>
    onChange(Number(Math.max(min, Math.min(max, n)).toFixed(2)));
  return (
    <div className={s.stepRow}>
      <label htmlFor={id}>{label}</label>
      <div className={s.stepper}>
        <button
          type="button"
          disabled={disabled || value <= min}
          aria-label={`Уменьшить: ${label}`}
          onClick={() => change(value - step)}
        >
          −
        </button>
        <Input
          id={id}
          type="number"
          required
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button
          type="button"
          disabled={disabled || value >= max}
          aria-label={`Увеличить: ${label}`}
          onClick={() => change(value + step)}
        >
          +
        </button>
      </div>
    </div>
  );
}
function ItemPreview({
  item,
  large = false,
}: {
  item: ItemDefinition;
  large?: boolean;
}) {
  const [night, setNight] = useState(true);
  const intensity = night && item.glows ? (item.glowIntensity ?? 1) : 0;
  return (
    <div className={`${s.preview} ${large ? s.previewLarge : ""}`}>
      <div
        className={s.previewScene}
        data-night={night}
        style={
          {
            "--item-light": intensity,
            "--pulse-period": `${item.glowPeriod || 8}s`,
            "--pulse-play": item.glowPeriod ? "running" : "paused",
          } as CSSProperties
        }
      >
        <span className={s.moon} aria-hidden="true">
          ☾
        </span>
        <span className={s.stars} aria-hidden="true">
          ✦ · ✧ · ✦
        </span>
        <span className={s.leaves} aria-hidden="true">
          ❧
        </span>
        <span className={s.leavesRight} aria-hidden="true">
          ❧
        </span>
        <div className={s.pedestal} />
        <div className={s.itemAura} />
        {item.sprite ? (
          <img
            className={s.previewSprite}
            src={itemSprite(item.sprite)}
            alt={`Предпросмотр: ${item.name || "новый предмет"}`}
          />
        ) : (
          <ItemGlyph name="box" className={s.emptySprite} />
        )}
        {intensity > 0 && item.sparkle ? (
          <span className={s.gemGlint} aria-hidden="true">
            ✦
          </span>
        ) : null}
      </div>
      <strong>{item.name || "Название предмета"}</strong>
      <p>
        {item.description ||
          ITEM_CATEGORIES.find((c) => c[0] === item.category)?.[1] ||
          "Предмет"}
      </p>
      <div className={s.segment} aria-label="Освещение предпросмотра">
        <button
          type="button"
          aria-pressed={!night}
          onClick={() => setNight(false)}
        >
          День
        </button>
        <button
          type="button"
          aria-pressed={night}
          onClick={() => setNight(true)}
        >
          Ночь
        </button>
      </div>
    </div>
  );
}
export const emptyItem = (): ItemDefinition => ({
  id: "",
  name: "",
  description: "",
  category: "other",
  maxStack: 10,
  weight: 3,
  sprite: "",
  glows: false,
  glowIntensity: 1,
  glowPeriod: 0,
  sparkle: false,
});
export function ItemEditor({
  item,
  initial,
  onSaved,
  onCancel,
  footer,
}: {
  item?: ItemDefinition;
  initial?: ItemDefinition;
  onSaved: (i: ItemDefinition) => void | Promise<void>;
  onCancel?: () => void;
  footer?: ReactNode;
}) {
  const [draft, setDraft] = useState<ItemDefinition>(() => ({
      ...emptyItem(),
      ...initial,
      ...item,
      maxStack: item?.maxStack ?? initial?.maxStack ?? (item ? 10000 : 10),
    })),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState(""),
    [filename, setFilename] = useState(""),
    [expanded, setExpanded] = useState(false),
    [tab, setTab] = useState("main");
  const fileId = useId(),
    previewTitle = useId();
  const set = (patch: Partial<ItemDefinition>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setNote("");
  };
  const upload = async (file?: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("Максимальный размер PNG — 2 МБ.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const sprite = await uploadItemSprite(file);
      set({ sprite });
      setFilename(file.name);
    } catch (e) {
      setError(inventoryError(e));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNote("");
    try {
      const out = await inventoryRequest<{ item: ItemDefinition }>(
        "/cfg/items",
        "POST",
        { ...draft, create: !item },
      );
      setNote(`Предмет «${out.item.name}» сохранён.`);
      await onSaved(out.item);
    } catch (e) {
      setError(inventoryError(e));
    } finally {
      setBusy(false);
    }
  };
  const spriteUpload = (
    <div className={s.upload}>
      <span>
        <ItemGlyph name="file" />
        {filename || (draft.sprite ? "PNG-спрайт загружен" : "Файл не выбран")}
      </span>
      <label htmlFor={fileId} className={s.fileButton}>
        <ItemGlyph name="file" />
        Выбрать файл
      </label>
      <Input
        id={fileId}
        className={s.fileInput}
        type="file"
        accept="image/png"
        disabled={busy}
        onChange={(e) => {
          void upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
  const categories = (
    <div className={s.categories}>
      {ITEM_CATEGORIES.map((c) => (
        <button
          key={c[0]}
          type="button"
          disabled={busy}
          aria-pressed={draft.category === c[0]}
          onClick={() => set({ category: c[0] })}
        >
          <span aria-hidden="true">{c[2]}</span>
          {c[1]}
        </button>
      ))}
    </div>
  );
  const main = (
    <>
      <ItemStepper
        label="Вес (в одной штуке)"
        value={draft.weight}
        min={0.01}
        max={30}
        step={0.01}
        disabled={busy}
        onChange={(weight) => set({ weight })}
      />
      <ItemStepper
        label="Макс. размер стопки"
        value={draft.maxStack ?? 10}
        min={1}
        max={10000}
        disabled={busy}
        onChange={(maxStack) => set({ maxStack })}
      />
      <ItemStepper
        label="Яркость свечения (0–3)"
        value={draft.glowIntensity ?? 1}
        min={0}
        max={3}
        step={0.1}
        disabled={busy || !draft.glows}
        onChange={(glowIntensity) => set({ glowIntensity })}
      />
      <label className={s.check}>
        <input
          type="checkbox"
          checked={!!draft.sparkle}
          disabled={busy || !draft.glows}
          onChange={(e) => set({ sparkle: e.target.checked })}
        />
        Мерцание драгоценного камня
      </label>
    </>
  );
  const extra = (
    <>
      <label className={s.check}>
        <input
          type="checkbox"
          checked={!!draft.glows}
          disabled={busy}
          onChange={(e) => set({ glows: e.target.checked })}
        />
        Светится вечером и ночью
      </label>
      <label className={s.period}>
        Период пульсации, сек (0 — постоянный)
        <Input
          type="number"
          min={0}
          max={60}
          step={0.5}
          value={draft.glowPeriod ?? 0}
          disabled={busy || !draft.glows}
          onChange={(e) => set({ glowPeriod: Number(e.target.value) })}
        />
      </label>
      <label>Файл модели / спрайта</label>
      {spriteUpload}
    </>
  );
  const basic = (
    <div className={s.basic}>
      <label className={s.spriteThumb} htmlFor={fileId} title="Заменить спрайт">
        {draft.sprite ? (
          <img src={itemSprite(draft.sprite)} alt="Спрайт предмета" />
        ) : (
          <ItemGlyph name="box" />
        )}
        <span>
          <ItemGlyph name="edit" />
        </span>
      </label>
      <div className={s.basicFields}>
        <div className={s.twoFields}>
          <label>
            <span>
              ID предмета <b>*</b>
            </span>
            <Input
              required
              pattern="[a-z0-9][a-z0-9_-]{0,47}"
              maxLength={48}
              value={draft.id}
              disabled={busy || !!item}
              placeholder="item_id"
              onChange={(e) => set({ id: e.target.value })}
            />
          </label>
          <label>
            <span>
              Название <b>*</b>
            </span>
            <Input
              required
              maxLength={64}
              value={draft.name}
              disabled={busy}
              placeholder="Название предмета"
              onChange={(e) => set({ name: e.target.value })}
            />
          </label>
        </div>
        <label>
          Описание
          <textarea
            maxLength={200}
            rows={2}
            value={draft.description || ""}
            disabled={busy}
            placeholder="Краткое описание предмета…"
            onChange={(e) => set({ description: e.target.value })}
          />
          <small className={s.counter}>
            {draft.description?.length || 0} / 200
          </small>
        </label>
      </div>
    </div>
  );
  return (
    <form
      className={`${s.editor} ${item ? s.compact : ""}`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {!item ? (
        <>
          <header className={s.pageHeader}>
            <ItemGlyph name="box" />
            <div>
              <h2>Создание предмета</h2>
              <p>Добавьте новый предмет в игру и настройте его параметры.</p>
            </div>
            <div className={s.formActions}>
              <Button
                type="button"
                className={s.quiet}
                disabled={busy}
                onClick={() => {
                  if (onCancel) onCancel();
                  else {
                    setDraft(emptyItem());
                    setFilename("");
                    setError("");
                    setNote("");
                  }
                }}
              >
                Отмена
              </Button>
              <Button
                className={s.primary}
                type="submit"
                disabled={busy || !draft.sprite}
              >
                <ItemGlyph name="save" />
                {busy ? "Сохраняем…" : "Создать предмет"}
              </Button>
            </div>
          </header>
        </>
      ) : null}
      {!item ? (
        <>
          <div className={s.createTop}>
            <div className={s.createInfo}>
              <ItemPanel title="Базовая информация" icon="box">
                {basic}
              </ItemPanel>
              <ItemPanel title="Категория" icon="layers">
                {categories}
              </ItemPanel>
            </div>
            <ItemPanel
              title="Предпросмотр"
              icon="eye"
              className={s.previewPanel}
            >
              <button
                className={s.expand}
                type="button"
                aria-label="Увеличить предпросмотр"
                onClick={() => setExpanded(true)}
              >
                <ItemGlyph name="expand" />
              </button>
              <ItemPreview item={draft} />
            </ItemPanel>
          </div>
          <div className={s.createBottom}>
            <ItemPanel title="Основные параметры" icon="settings">
              {main}
            </ItemPanel>
            <ItemPanel title="Дополнительно" icon="spark">
              {extra}
            </ItemPanel>
          </div>
        </>
      ) : (
        <>
          <div className={s.editBasic}>{basic}</div>
          <div className={s.editTabs}>
            <button
              type="button"
              aria-pressed={tab === "main"}
              onClick={() => setTab("main")}
            >
              <ItemGlyph name="settings" />
              Основные
            </button>
            <button
              type="button"
              aria-pressed={tab === "visual"}
              onClick={() => setTab("visual")}
            >
              <ItemGlyph name="eye" />
              Визуал и предпросмотр
            </button>
          </div>
          {tab === "main" ? (
            <div className={s.editParams}>
              <div>{main}</div>
              <div>
                <label>
                  Категория
                  <Dropdown
                    aria-label="Категория предмета"
                    value={draft.category || "other"}
                    disabled={busy}
                    options={ITEM_CATEGORIES.map((c) => ({
                      value: c[0],
                      label: c[1],
                    }))}
                    onChange={(value) => set({ category: value })}
                  />
                </label>
                {extra}
              </div>
            </div>
          ) : (
            <div className={s.editVisual}>
              <ItemPreview item={draft} />
              <div>{extra}</div>
            </div>
          )}
          <footer className={s.editorFooter}>
            <div inert={busy || undefined}>{footer}</div>
            <Button
              type="submit"
              className={s.primary}
              disabled={busy || !draft.sprite}
            >
              <ItemGlyph name="save" />
              {busy ? "Сохраняем…" : "Сохранить изменения"}
            </Button>
          </footer>
        </>
      )}
      {error ? (
        <p role="alert" className={s.error}>
          {error}
        </p>
      ) : null}
      {note ? (
        <p role="status" className={s.success}>
          {note}
        </p>
      ) : null}
      <Dialog
        open={expanded}
        onClose={() => setExpanded(false)}
        labelledBy={previewTitle}
        className={s.previewDialog}
      >
        <h2 id={previewTitle}>Предпросмотр предмета</h2>
        <ItemPreview item={draft} large />
        <Button
          type="button"
          className={s.quiet}
          onClick={() => setExpanded(false)}
        >
          Закрыть
        </Button>
      </Dialog>
    </form>
  );
}
