'use client';

/**
 * Строки-редакторы полей конфига (/admin) — вынесены из cfg-dashboard.tsx,
 * чтобы дашборд оставался под лимитом 800 строк (тот же прецедент, что
 * вкладка «Игроки на поле» — players-field-tab.tsx). Чистые презентационные
 * компоненты поверх меты реестра (types http-cfg): здесь нет ни fetch-логики,
 * ни состояния дашборда.
 *
 *   - FieldShell — каркас строки (подпись, описание, контролы);
 *   - RangeFieldRow — числовое поле (input с границами реестра — мандат
 *     владелицы 2026-11-08: «интервал погоды — числовой инпут, а не список
 *     огромный»; способ ввода «Длина части суток» тот же);
 *   - BoolFieldRow — ГЛОБАЛЬНЫЙ bool-ключ (master-гейт atmoset, мандат
 *     владелицы 2026-11-08): select «Разрешено/Запрещено»; черновик несёт
 *     1/0-число, POST /cfg уходит строгим boolean (патч-генератор http-cfg);
 *   - ListFieldRow — редактор списка разрешённых значений (F2 §4) + ввод
 *     СВОИХ значений: customValueIssue (http-cfg) — зеркальный валидатор
 *     серверного sanitizeList (юнис ∪ custom-границы).
 */

import { useState } from 'react';

import {
  canonByKind,
  customValueIssue,
  fmtNum,
  listIssue,
  type CfgFieldMeta,
} from '@/lib/net/http-cfg';

const INPUT_CLS = 'h-8 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-2 text-sm text-[var(--sim-text)]';

/** Каркас строки поля: подпись, описание, дети-контролы. */
function FieldShell({ def, children }: { def: CfgFieldMeta; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--sim-line)] p-3">
      <p className="text-sm font-bold text-[var(--sim-text)]">{def.label}</p>
      <p className="mt-1 text-xs text-[var(--sim-text-soft)]">{def.description}</p>
      {children}
    </div>
  );
}

/** Числовое поле: input с границами/шагом реестра; клэмп черновика в bounds. */
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
  const step = bounds.step > 0 ? bounds.step : 1;
  const dirty = Number.isFinite(saved) && Number.isFinite(value) && saved !== value;
  return (
    <FieldShell def={def}>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          type="number"
          className={`${INPUT_CLS} w-24`}
          min={bounds.min}
          max={bounds.max}
          step={step}
          value={Number.isFinite(value) ? value : bounds.min}
          onChange={(e) => {
            if (e.target.value === '') return; // промежуточный пустой ввод не трогает черновик
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            onChange(Math.min(bounds.max, Math.max(bounds.min, n)));
          }}
        />
        <span className="text-xs text-[var(--sim-text-soft)]">{def.unit}</span>
        {dirty ? (
          <span className="text-[11px] text-amber-300/90">
            не сохранено (на сервере сейчас {fmtNum(saved)} {def.unit})
          </span>
        ) : null}
      </div>
    </FieldShell>
  );
}

/** Глобальный bool-ключ (kind="bool", scope="global" — master-гейт atmoset):
 *  select «Разрешено/Запрещено». Черновик и снапшот несут значение как
 *  1/0-число; POST /cfg уходит строгим boolean (конверсия в cfgPatchFromDraft). */
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
          className={INPUT_CLS}
          value={Number.isFinite(value) && value === 0 ? 0 : 1}
          onChange={(e) => onChange(Number(e.target.value))}
        >
          <option value={1}>Разрешено</option>
          <option value={0}>Запрещено</option>
        </select>
        {dirty ? (
          <span className="text-[11px] text-amber-300/90">
            не сохранено (на сервере сейчас {saved ? 'разрешено' : 'запрещено'})
          </span>
        ) : null}
      </div>
    </FieldShell>
  );
}

/** Редактор СПИСКА разрешённых значений (§4.2): чекбоксы по юнису меты +
 *  СВОИ значения (мандат владелицы 2026-11-08 «добавь возможность добавлять
 *  свои значения»: периоды стрелы — любые в custom-границах, уровни/десятые —
 *  их юнис и есть полный диапазон) + ЯВНЫЙ флаг «игроки могут выбирать»
 *  (F2 §4): флип флага НЕ мутирует список. */
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
  const [customRaw, setCustomRaw] = useState('');
  const [customErr, setCustomErr] = useState<string | null>(null);
  const shown = Array.from(new Set([...universe, ...list])).sort((a, b) => a - b);
  const tryAdd = () => {
    const err = customValueIssue(def, customRaw, list);
    setCustomErr(err);
    if (err) return;
    const v = canonByKind(def.kind, Number(customRaw.trim().replace(',', '.')));
    setCustomRaw('');
    onToggleValue(v, true);
  };
  return (
    <FieldShell def={def}>
      <label className="mt-2 flex items-center gap-2 text-xs text-[var(--sim-text-soft)]">
        <input type="checkbox" checked={choiceOn} onChange={(e) => onToggleChoice(e.target.checked)} />
        Игроки могут выбирать значение
      </label>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {shown.map((v) => (
          <label key={v} className="flex items-center gap-1 text-xs text-[var(--sim-text-soft)]">
            <input type="checkbox" checked={list.includes(v)} onChange={(e) => onToggleValue(v, e.target.checked)} />
            {fmtNum(v)}
          </label>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--sim-text-soft)]">
        <span>Добавить своё:</span>
        <input
          type="text"
          inputMode="decimal"
          className={`${INPUT_CLS} h-7 w-24`}
          value={customRaw}
          placeholder={def.kind === 'periods' ? 'напр. 3,2' : undefined}
          onChange={(e) => {
            setCustomRaw(e.target.value);
            setCustomErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              tryAdd();
            }
          }}
        />
        <button
          type="button"
          className="rounded-md border border-[var(--sim-line-strong)] px-2 py-1 text-xs hover:bg-black/30"
          onClick={tryAdd}
        >
          Добавить
        </button>
        {customErr ? <span className="text-[11px] text-red-300">{customErr}</span> : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--sim-text-soft)]">
        <span>Дефолт:</span>
        <select
          className={`${INPUT_CLS} h-7`}
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
      {savedChoice !== choiceOn ? (
        <p className="mt-1 text-[11px] text-amber-300/90">
          выбор игроками не сохранён (на сервере сейчас {savedChoice ? 'вкл' : 'выкл'})
        </p>
      ) : null}
    </FieldShell>
  );
}

export { FieldShell, RangeFieldRow, BoolFieldRow, ListFieldRow };
