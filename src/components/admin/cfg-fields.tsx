'use client';

/**
 * Строки-редакторы полей конфига (/admin) — вынесены из cfg-dashboard.tsx,
 * чтобы дашборд оставался под лимитом 800 строк (тот же прецедент, что
 * вкладка «Игроки на поле» — players-field-tab.tsx). Чистые презентационные
 * компоненты поверх меты реестра (types http-cfg): здесь нет ни fetch-логики,
 * ни состояния дашборда.
 *
 *   - TechDetails — сворачиваемые технические детали + копирование ключа;
 *   - FieldShell — каркас строки (подпись, бейдж применения, описание);
 *   - RangeFieldRow — числовой диапазон (select по min/max/step);
 *   - BoolFieldRow — ГЛОБАЛЬНЫЙ bool-ключ (master-гейт atmoset, мандат
 *     владелицы 2026-11-08): select «Разрешено/Запрещено»; черновик несёт
 *     1/0-число, POST /cfg уходит строгим boolean (патч-генератор http-cfg);
 *   - ListFieldRow — редактор списка разрешённых значений (F2 §4);
 *   - DiffRow — строка предпросмотра «было → станет» (диапазон / список /
 *     выбор игроками / bool-ключ).
 */

import { useState } from 'react';

import {
  applyBadgeText,
  fmtNum,
  listIssue,
  narrowingWarning,
  type CfgFieldDiff,
  type CfgFieldMeta,
} from '@/lib/net/http-cfg';

function rangeOptions(def: { min: number; max: number; step: number }): number[] {
  const out: number[] = [];
  const step = def.step > 0 ? def.step : 1;
  for (let v = def.min; v <= def.max + 1e-9; v += step) out.push(Number(v.toFixed(4)));
  if (def.max > def.min && out[out.length - 1] !== def.max) out.push(def.max);
  return out;
}

const SELECT_CLS = 'h-8 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-2 text-sm text-[var(--sim-text)]';

/** Сырой тех-ключ/kind/политика — в сворачиваемых «технических деталях» с
 * копированием (§4: русские подписи — primary, ключи — вторично). */
function TechDetails({ def }: { def: CfgFieldMeta }) {
  const [copied, setCopied] = useState(false);
  const copyKey = () => {
    const write = navigator.clipboard?.writeText(def.key);
    if (!write) return;
    write
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined);
  };
  return (
    <details className="mt-2">
      <summary className="cursor-pointer select-none text-[11px] text-[var(--sim-text-faint)]">Технические детали</summary>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--sim-text-faint)]">
        <code className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] text-[var(--sim-text-soft)]">{def.key}</code>
        <button
          type="button"
          className="rounded border border-[var(--sim-line-strong)] px-1.5 py-0.5 hover:bg-black/30"
          onClick={copyKey}
        >
          {copied ? 'Скопировано' : 'Копировать ключ'}
        </button>
        <span>тип: {def.kind}</span>
        <span>охват: {def.scope || 'global'}</span>
        <span>политика: {def.applyPolicy}</span>
      </div>
    </details>
  );
}

/** Каркас строки поля: русская подпись primary, бейдж apply-политики,
 * описание, дети-контролы, подсказка применения, тех-детали. */
function FieldShell({ def, children }: { def: CfgFieldMeta; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--sim-line)] p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-bold text-[var(--sim-text)]">{def.label}</p>
        <span className="rounded-full border border-[var(--sim-line-strong)] px-2 py-0.5 text-[10px] text-[var(--sim-text-soft)]">
          когда вступает: {applyBadgeText(def.applyPolicy)}
        </span>
      </div>
      <p className="mt-1 text-xs text-[var(--sim-text-soft)]">{def.description}</p>
      {children}
      <p className="mt-2 text-[11px] text-[var(--sim-text-faint)]">{def.applyHint}</p>
      <TechDetails def={def} />
    </div>
  );
}

/** Числовой диапазон (§4.1): селектор по min/max/step + явные границы и юниты. */
function RangeFieldRow({
  def,
  value,
  saved,
  onChange,
}: {
  def: CfgFieldMeta;
  value: number;
  saved: number;
  onChange: (v: number) => void;
}) {
  const bounds = def.values as { min: number; max: number; step: number };
  const dirty = Number.isFinite(saved) && Number.isFinite(value) && saved !== value;
  return (
    <FieldShell def={def}>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          className={SELECT_CLS}
          value={Number.isFinite(value) ? value : bounds.min}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          {rangeOptions(bounds).map((v) => (
            <option key={v} value={v}>
              {v} {def.unit}
            </option>
          ))}
        </select>
        {dirty ? (
          <span className="text-[11px] text-amber-300/90">
            не сохранено — на сервере сейчас {fmtNum(saved)} {def.unit}
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-[11px] text-[var(--sim-text-faint)]">
        Границы: от {bounds.min} до {bounds.max} {def.unit}, шаг {bounds.step}.
      </p>
    </FieldShell>
  );
}

/** Глобальный bool-ключ (kind="bool", scope="global" — master-гейт atmoset,
 * мандат владелицы 2026-11-08): select «Разрешено/Запрещено». Черновик и
 * снапшот несут значение как 1/0-число; POST /cfg уходит строгим boolean
 * (конверсия в cfgPatchFromDraft). Room-bool плашки сюда не попадают:
 * дашборд рендерит их отдельной справочной веткой. */
function BoolFieldRow({
  def,
  value,
  saved,
  onChange,
}: {
  def: CfgFieldMeta;
  value: number;
  saved: number;
  onChange: (v: number) => void;
}) {
  const dirty = Number.isFinite(saved) && Number.isFinite(value) && saved !== value;
  return (
    <FieldShell def={def}>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          className={SELECT_CLS}
          value={Number.isFinite(value) && value === 0 ? 0 : 1}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          <option value={1}>Разрешено</option>
          <option value={0}>Запрещено</option>
        </select>
        {dirty ? (
          <span className="text-[11px] text-amber-300/90">
            не сохранено — на сервере сейчас {saved ? 'разрешено' : 'запрещено'}
          </span>
        ) : null}
      </div>
    </FieldShell>
  );
}

/** Редактор СПИСКА разрешённых значений (§4.2): чекбоксы по движковому
 * юнису (registry.values) + ЯВНЫЙ флаг «игроки могут выбирать» (F2 §4):
 * флип флага НЕ мутирует список — allowedValues и playerSelectable
 * хранятся на сервере раздельно (off-then-on возвращает кураторский список,
 * а не движковый юниверс). */
function ListFieldRow({
  def,
  list,
  saved,
  savedChoice,
  draftDefault,
  universe,
  choiceOn,
  onToggleValue,
  onToggleChoice,
  onDefault,
}: {
  def: CfgFieldMeta;
  list: number[];
  saved: { list: number[]; def: number };
  savedChoice: boolean;
  draftDefault: number;
  universe: number[];
  choiceOn: boolean;
  onToggleValue: (v: number, on: boolean) => void;
  onToggleChoice: (on: boolean) => void;
  onDefault: (v: number) => void;
}) {
  const issue = listIssue(list, draftDefault);
  return (
    <FieldShell def={def}>
      <label className="mt-2 flex items-center gap-2 text-xs text-[var(--sim-text-soft)]">
        <input type="checkbox" checked={choiceOn} onChange={(e) => onToggleChoice(e.target.checked)} />
        Игроки могут выбирать значение
      </label>
      <p className="mt-1 text-[11px] text-[var(--sim-text-faint)]">
        {choiceOn
          ? `Разрешено значений: ${list.length} из ${universe.length} (в ${def.unit}).`
          : `Выбор выключен: игроку отдаётся только дефолт (${fmtNum(draftDefault)} ${def.unit}). Сохранённый список (${list.length}) не трогаем.`}
      </p>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {universe.map((v) => (
          <label key={v} className="flex items-center gap-1 text-xs text-[var(--sim-text-soft)]">
            <input type="checkbox" checked={list.includes(v)} onChange={(e) => onToggleValue(v, e.target.checked)} />
            {fmtNum(v)}
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--sim-text-soft)]">
        <span>Дефолт ({def.unit}):</span>
        <select
          className={`${SELECT_CLS} h-7`}
          value={list.includes(draftDefault) ? draftDefault : ''}
          onChange={(e) => onDefault(Number(e.target.value))}
        >
          {!list.includes(draftDefault) ? <option value="">— выберите —</option> : null}
          {list.map((v) => (
            <option key={v} value={v}>
              {fmtNum(v)} {def.unit}
            </option>
          ))}
        </select>
      </div>
      {issue ? <p className="mt-1 text-[11px] font-semibold text-red-300">{issue}</p> : null}
      <p className="mt-1 text-[11px] text-[var(--sim-text-faint)]">
        На сервере сейчас: {saved.list.map(fmtNum).join(' / ') || '—'}, дефолт {fmtNum(saved.def)}, выбор игроками:{' '}
        {savedChoice ? 'вкл' : 'выкл'}.
      </p>
    </FieldShell>
  );
}

/** Одна строка предпросмотра: «было → станет» (+N/−M) + предупреждение сужения. */
function DiffRow({ d }: { d: CfgFieldDiff }) {
  return (
    <li className="rounded border border-[var(--sim-line)] p-2 text-xs text-[var(--sim-text-soft)]">
      <p className="font-semibold text-[var(--sim-text)]">{d.label}</p>
      {d.range ? (
        <p className="mt-1">
          Было: {fmtNum(d.range.before)} {d.range.unit} → станет: <b>{fmtNum(d.range.after)} {d.range.unit}</b>
        </p>
      ) : d.list ? (
        <div className="mt-1 space-y-1">
          <p>
            Список: {d.list.before.length} зн. → <b>{d.list.after.length} зн.</b> (+{d.list.added.length} / −{d.list.removed.length})
          </p>
          {d.list.added.length ? (
            <p>
              Добавляются: {d.list.added.map(fmtNum).join(', ')} {d.list.unit}
            </p>
          ) : null}
          {d.list.removed.length ? (
            <p>
              Убраны: {d.list.removed.map(fmtNum).join(', ')} {d.list.unit}
            </p>
          ) : null}
          {d.list.defBefore !== d.list.defAfter ? (
            <p>
              Дефолт: {fmtNum(d.list.defBefore)} → {fmtNum(d.list.defAfter)}
            </p>
          ) : null}
          {d.list.removed.length ? (
            <p className="font-semibold text-amber-300">⚠ {narrowingWarning(d.list.kind)}</p>
          ) : null}
        </div>
      ) : null}
      {d.bool ? (
        <p className="mt-1">
          Было: {d.bool.before ? 'разрешено' : 'запрещено'} → станет: <b>{d.bool.after ? 'разрешено' : 'запрещено'}</b>
        </p>
      ) : null}
      {d.choice ? (
        <p className="mt-1">
          Выбор игроками: {d.choice.before ? 'вкл' : 'выкл'} → <b>{d.choice.after ? 'вкл' : 'выкл'}</b>
          {d.choice.after
            ? ` — список из ${d.choice.kept} зн. вернётся игрокам целиком`
            : ` — игрокам отдаётся только дефолт, список из ${d.choice.kept} зн. сохраняется на сервере`}
        </p>
      ) : null}
      <p className="mt-1 text-[11px] text-[var(--sim-text-faint)]">{d.hint}</p>
    </li>
  );
}

export { FieldShell, RangeFieldRow, BoolFieldRow, ListFieldRow, DiffRow };
