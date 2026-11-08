'use client';

/**
 * Вкладка «Броня» дашборда /admin (мандат владелицы 2026-11-08: «Броня:
 * уровни защиты и тп — сделай чтоб можно было добавлять значения»).
 * Сателлит по прецеденту players-field-tab.tsx — дашборд держим под лимитом.
 *
 * Редактор ключа реестра combat.armorCurve (kind points): таблица точек
 * [броня, урон%], добавление/удаление строк, мини-SVG-превью кривой
 * «было → станет» (сервер — бледная линия, черновик — акцентная).
 *
 * Контракт — общий с прочими полями дашборда (никаких своих HTTP-путей):
 * черновик живёт в дашборде (CfgDraft.points), отправка — единым PATCH
 * через cfgPatchFromDraft/httpCfgApply с двумя шагами подтверждения
 * (предпросмотр «было → станет» рендерит дашборд поверх buildCfgDiff).
 * Клиент сортирует/канонизирует точки сам (normalizePoints — как серверный
 * sanitizePoints), дубли x снимаются; конечный арбитр валидации — сервер.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { normalizePoints, type CfgFieldMeta, type CfgAdminSnapshot } from '@/lib/net/http-cfg';

/** Строка редактора: сырой текст — парсим на лету, запятая = десятичный
 *  разделитель (русская раскладка). Пустая строка = «точка убрана». */
type Row = { x: string; y: string };

const parseNum = (raw: string): number | null => {
  const s = raw.trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const rowsFromPoints = (points: number[][]): Row[] =>
  points.map((p) => ({ x: String(p[0]).replace('.', ','), y: String(p[1]).replace('.', ',') }));

/** SVG-превью: оси 0..0,9 (броня) и 5..60 (урон%); координаты в viewBox 200×130. */
function polyPoints(curve: number[][]): string {
  const sx = (x: number) => 18 + (x / 0.9) * 176;
  const sy = (y: number) => 122 - ((y - 5) / 55) * 116;
  return curve.map((p) => `${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(' ');
}

export function ArmorTab({
  snap,
  meta,
  points,
  issue,
  busy,
  onPoints,
  onApply,
}: {
  snap: CfgAdminSnapshot;
  meta: CfgFieldMeta;
  /** Кривая черновика (уже канонизированная: сортировка/2 знака). */
  points: number[][];
  /** Блокирующая проблема черновика кривой (null = готова к отправке). */
  issue: string | null;
  busy: string | null;
  /** Черновик дашборда обновился (дерево ниже рендерит предпросмотр). */
  onPoints: (next: number[][]) => void;
  /** Шаг 1 применения — показать общий предпросмотр «было → станет». */
  onApply: () => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => rowsFromPoints(points));
  /** Свежий проп-кривая дочитывается эффектом ниже (после refresh()), а не
   *  на каждый push — локальный набор строк не сбрасывается посреди правки. */
  const pointsRef = useRef(points);
  pointsRef.current = points;
  useEffect(() => {
    setRows(rowsFromPoints(pointsRef.current));
  }, [snap]);

  /** Пушим наружу канонизированный черновик кривой на каждую правку строк. */
  const push = (next: Row[]) => {
    setRows(next);
    const parsed = next
      .map((r) => [parseNum(r.x), parseNum(r.y)] as const)
      .filter((p): p is [number, number] => p[0] !== null && p[1] !== null)
      .map((p) => [p[0], p[1]]);
    onPoints(parsed);
  };

  const setRow = (i: number, part: keyof Row, value: string) => {
    const next = rows.map((r, idx) => (idx === i ? { ...r, [part]: value } : r));
    push(next);
  };

  const removeRow = (i: number) => {
    const next = rows.filter((_, idx) => idx !== i);
    if (next.length) push(next);
  };

  const addRow = () => {
    const last = rows.length ? parseNum(rows[rows.length - 1].x) ?? 0.9 : 0;
    const b = meta.points ?? { xMin: 0, xMax: 0.9, xStep: 0.01, yMin: 5, yMax: 60 };
    const nx = Math.min(b.xMax, Math.round((last + (b.xStep || 0.01)) * 100) / 100);
    push([...rows, { x: String(nx).replace('.', ','), y: rows.length ? rows[rows.length - 1].y : '40' }]);
  };

  const savedRows = useMemo(
    () => normalizePoints(snap.values.combat.armorCurve, meta.points) ?? [],
    [snap, meta],
  );
  const previewPoints = useMemo(() => normalizePoints(points, meta.points) ?? [], [points, meta]);

  return (
    <section className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
      <p className="text-sm text-[var(--sim-text-soft)]">{meta.description}</p>
      <p className="mt-1 text-[11px] text-[var(--sim-text-faint)]">{meta.applyHint}</p>

      {/* Таблица точек: [броня, урон%] + удаление; сортировку берёт на себя клиент. */}
      <div className="mt-3 flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-[11px] font-semibold text-[var(--sim-text-soft)]">
          <span className="w-20">Броня (0–0,9)</span>
          <span className="w-20">Урон% (5–60)</span>
          <span className="grow" />
        </div>
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              className="h-8 w-20 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-2 text-sm text-[var(--sim-text)]"
              inputMode="decimal"
              value={r.x}
              aria-label={`Броня точки ${i + 1}`}
              onChange={(e) => setRow(i, 'x', e.target.value)}
            />
            <input
              className="h-8 w-20 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-2 text-sm text-[var(--sim-text)]"
              inputMode="decimal"
              value={r.y}
              aria-label={`Проходящий урон точки ${i + 1}`}
              onChange={(e) => setRow(i, 'y', e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 px-2 text-[11px]"
              disabled={busy !== null || rows.length <= 2}
              onClick={() => removeRow(i)}
            >
              Удалить
            </Button>
            <span className="text-[10px] text-[var(--sim-text-faint)]">
              {previewPoints[i] ? `${previewPoints[i][0]} → ${previewPoints[i][1]}%` : 'не разобрана'}
            </span>
          </div>
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 w-fit px-3 text-xs"
          disabled={busy !== null || previewPoints.length >= 16}
          onClick={addRow}
        >
          Добавить точку
        </Button>
      </div>

      {/* Мини-SVG-превью: «было → станет» — сервер ближе к серому, черновик акцентом. */}
      <div className="mt-3 flex flex-wrap items-start gap-4">
        <svg viewBox="0 0 200 130" className="h-40 w-full max-w-[320px]" role="img" aria-label="Кривая брони: было и станет">
          {/* Оси: x 0..0,9 (броня), y 5..60 (урон%). */}
          <line x1="18" y1="122" x2="194" y2="122" stroke="var(--sim-line-strong)" strokeWidth="1" />
          <line x1="18" y1="6" x2="18" y2="122" stroke="var(--sim-line-strong)" strokeWidth="1" />
          <text x="18" y="129" fontSize="7" fill="var(--sim-text-faint)">0</text>
          <text x="176" y="129" fontSize="7" fill="var(--sim-text-faint)">0,9</text>
          <text x="24" y="12" fontSize="7" fill="var(--sim-text-faint)">60%</text>
          <text x="24" y="120" fontSize="7" fill="var(--sim-text-faint)">5%</text>
          <polyline points={polyPoints(savedRows)} fill="none" stroke="var(--sim-line)" strokeWidth="1.5" strokeDasharray="4 3" />
          {savedRows.length > 1 && (
            <polyline points={polyPoints(previewPoints)} fill="none" stroke="var(--sim-accent)" strokeWidth="2" />
          )}
          {previewPoints.map((p, i) => (
            <circle key={i} cx={18 + (p[0] / 0.9) * 176} cy={122 - ((p[1] - 5) / 55) * 116} r="2.2" fill="var(--sim-accent)" />
          ))}
        </svg>
        <div className="flex-1 text-[11px] text-[var(--sim-text-faint)]">
          <p>
            На сервере сейчас: {savedRows.length} тч. (
            {savedRows.map((p) => `${String(p[0]).replace('.', ',')}→${p[1]}%`).join(', ') || '—'}).
          </p>
          <p>
            Черновик: {previewPoints.length} тч. Первая точка = масштаб (её урон% принимается за 100%); между точками —
            линейная интерполяция, после последней — наклон последнего отрезка до 0,9.
          </p>
          <p>Сервер пересортирует и перепроверит кривую на PATCH-е: дублей x и растущего урона% не пропустит.</p>
        </div>
      </div>

      {issue ? <p className="mt-2 text-[11px] font-semibold text-red-300">{issue}</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          className="h-8 bg-[var(--sim-accent)] text-xs text-black hover:bg-[var(--sim-accent-hover)]"
          disabled={busy !== null || issue !== null}
          onClick={onApply}
        >
          Проверить и применить…
        </Button>
        <span className="text-[11px] text-[var(--sim-text-faint)]">
          Отправка — единым PATCH со всеми правками вкладки «Конфиг» (после предпросмотра).
        </span>
      </div>
    </section>
  );
}
