'use client';

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import type { DirectionWindow, SimSettings, SlowdownTier, StrikeZone, WindowKey, ZoneSide } from '@/lib/sim/settings';
import {
  DAMAGE_LEVELS,
  DIRECTIONS,
  SPRITES,
  damageLevelLabel,
  throatDamageFor,
  wrap360,
  zoneDamageFor,
} from '@/lib/sim/settings';

interface Props {
  settings: SimSettings;
  patchField: (p: Partial<SimSettings['field']>) => void;
  patchCharacter: (p: Partial<SimSettings['character']>) => void;
  patchArrow: (p: Partial<SimSettings['arrow']>) => void;
  patchSlowdown: (p: Partial<SimSettings['slowdown']>) => void;
  patchWindow: (key: WindowKey, p: Partial<DirectionWindow>) => void;
  patchTier: (i: number, p: Partial<SlowdownTier>) => void;
  patchHud: (p: Partial<SimSettings['hud']>) => void;
  patchCombat: (p: Partial<SimSettings['combat']>) => void;
  patchZone: (i: number, p: Partial<StrikeZone>) => void;
  onResetCombat: () => void;
  onResetAll: () => void;
  onExport: () => string;
  onImport: (json: string) => string | null;
  /** Живой угол стрелы из движка (читается изолированным LiveAngle). */
  getAngle: () => number;
  onManualAngle: (v: number, force?: boolean) => void;
}

/* ---------- мелкие контролы ---------- */

function NumInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
}) {
  // null = показываем значение из пропа; пока поле в фокусе — показываем набранный текст
  const [text, setText] = useState<string | null>(null);
  const display = text ?? String(value);
  return (
    <Input
      type="number"
      inputMode="numeric"
      className={`h-7 px-2 text-xs ${className ?? ''}`}
      value={display}
      min={min}
      max={max}
      step={step}
      onBlur={() => setText(null)}
      onChange={(e) => {
        setText(e.target.value);
        if (e.target.value.trim() === '') return;
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) {
          let v = n;
          if (min !== undefined) v = Math.max(min, v);
          if (max !== undefined) v = Math.min(max, v);
          onChange(v);
        }
      }}
    />
  );
}

function SlideNum({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="py-1.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-300">{label}</span>
        <div className="flex items-center gap-1">
          <NumInput value={value} min={min} max={max} step={step} onChange={onChange} className="w-20" />
          {suffix ? <span className="w-7 text-[10px] text-zinc-500">{suffix}</span> : null}
        </div>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(vals) => onChange(parseFloat(vals[0].toFixed(2)))}
        className="[*_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-range]]:bg-emerald-600"
      />
      {hint ? <div className="mt-0.5 text-[10px] leading-tight text-zinc-500">{hint}</div> : null}
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div>
        <div className="text-xs text-zinc-300">{label}</div>
        {hint ? <div className="text-[10px] leading-tight text-zinc-500">{hint}</div> : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        className="data-[state=checked]:bg-emerald-600 data-[state=unchecked]:bg-zinc-700"
      />
    </div>
  );
}

function ColorInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2 py-1.5">
      <span className="text-xs text-zinc-300">{label}</span>
      <div className="flex items-center gap-1.5">
        <Input
          className="h-7 w-24 px-2 font-mono text-[11px]"
          value={value}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (/^#[0-9a-fA-F]{0,6}$/.test(v)) onChange(v);
          }}
          onBlur={() => {
            if (!/^#[0-9a-fA-F]{6}$/.test(value)) onChange('#ffffff');
          }}
        />
        <label className="relative inline-block h-7 w-8 cursor-pointer overflow-hidden rounded-md border border-zinc-700">
          <span className="block h-full w-full" style={{ background: value }} />
          <input
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : '#ffffff'}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
            aria-label={label}
          />
        </label>
      </div>
    </div>
  );
}

/* ---------- разделы настроек ---------- */

/** Идентификатор раздела настроек (квадратик-иконка в переключателе). */
type TabId = 'field' | 'arrow' | 'slowdown' | 'combat' | 'config';

/** Разделы: квадратик с иконкой темы, клик открывает содержимое. */
const TABS: { id: TabId; icon: string; label: string }[] = [
  { id: 'field', icon: '#', label: 'Поле' },
  { id: 'arrow', icon: '🏹', label: 'Стрела' },
  { id: 'slowdown', icon: '⛔', label: 'Замедление' },
  { id: 'combat', icon: '💥', label: 'Удары и энергия' },
  { id: 'config', icon: '⚙️', label: 'Конфиг' },
];

/* ---------- панель ---------- */

/** Живой угол стрелы: опрашивает движок по таймеру и перерисовывает ТОЛЬКО себя,
 *  чтобы периодические обновления не дёргали рендер всей панели (из-за этого стрела
 *  двигалась рвано). */
function LiveAngle({
  getAngle,
  onManualAngle,
}: {
  getAngle: () => number;
  onManualAngle: (v: number, force?: boolean) => void;
}) {
  const [angle, setAngle] = useState(() => Math.round(wrap360(getAngle())));
  useEffect(() => {
    const iv = setInterval(() => setAngle(Math.round(wrap360(getAngle()))), 150);
    return () => clearInterval(iv);
  }, [getAngle]);
  return (
    <div className="py-1.5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-300">Точный угол стрелы</span>
        <NumInput
          className="w-20"
          value={angle}
          min={0}
          max={360}
          onChange={(v) => onManualAngle(v, true)}
        />
      </div>
      <Slider
        value={[angle]}
        min={0}
        max={360}
        step={1}
        onValueChange={(vals) => onManualAngle(vals[0], false)}
        onValueCommit={(vals) => onManualAngle(vals[0], true)}
        className="[&_[data-slot=slider-range]]:bg-emerald-600"
      />
      <div className="mt-0.5 text-[10px] text-zinc-500">
        Живой угол стрелы; можно задать точно ползунком или числом.
      </div>
    </div>
  );
}

/* ---------- визуальная мишень зон ---------- */

/** Контрастный цвет текста для подложки заданного цвета. */
function textOn(bg: string): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(bg.trim());
  if (!m) return 'rgba(255,255,255,0.94)';
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum > 150 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.94)';
}

/**
 * Визуальная мишень зон удара: спрайт манекена с горизонтальными полосами зон в пикселях
 * тела (0 px — верх спрайта, 150 — низ). Левая половина — зоны левой стороны тела,
 * правая — правой, полосы «на всю ширину» занимают обе половины. Перерисовывается прямо
 * из настроек: правка диапазона в пикселях двигает полосу мгновенно.
 */
function ZoneTarget({
  zones,
  activeId,
  onHover,
}: {
  zones: StrikeZone[];
  activeId: string | null;
  onHover: (id: string | null) => void;
}) {
  const BX = 30; // левый край тела мишени
  const BW = 184; // ширина тела
  const BY = 26; // верх тела
  const BH = 236; // высота тела (соответствует 150 px тела)
  const midX = BX + BW / 2;
  const sprite = SPRITES.find((sp) => sp.id === 'puhlyashik') ?? SPRITES[0];
  const yOf = (py: number) => BY + (Math.max(0, Math.min(150, py)) / 150) * BH;
  const sideLabel = (z: StrikeZone) =>
    z.side === 'both' ? 'вся ширина' : z.side === 'left' ? 'левая половина' : 'правая половина';
  // Деления оси — реальные края полос, а не сетка 30/60/90/120: иначе схема
  // выглядит разрезанной по старым границам, хотя полосы уже другие.
  const ticks = Array.from(
    new Set([
      0,
      150,
      ...zones.flatMap((z) => [Math.min(z.py0, z.py1), Math.max(z.py0, z.py1)]),
    ]),
  ).sort((a, b) => a - b);
  const tickSide: Array<'left' | 'right'> = [];
  for (let i = 0; i < ticks.length; i++) {
    const crowded =
      i > 0 && yOf(ticks[i]) - yOf(ticks[i - 1]) < 12 && tickSide[i - 1] === 'left';
    tickSide.push(crowded ? 'right' : 'left');
  }

  return (
    <svg
      viewBox="0 0 244 292"
      className="mx-auto block w-full max-w-[270px] select-none"
      role="img"
      aria-label="Схема зон удара: спрайт манекена с полосами зон в пикселях тела; слева — левые зоны, справа — правые"
    >
      <text x={122} y={11} textAnchor="middle" fontSize="9" fill="#8b8f98">
        верх тела — 0 px
      </text>
      <text x={122} y={288} textAnchor="middle" fontSize="9" fill="#8b8f98">
        низ тела — 150 px
      </text>
      <defs>
        <clipPath id="zone-target-body">
          <rect x={BX} y={BY} width={BW} height={BH} rx={14} />
        </clipPath>
      </defs>
      {/* тело мишени + спрайт мишени под полосами */}
      <rect x={BX} y={BY} width={BW} height={BH} rx={14} fill="#0b0d11" stroke="rgba(255,255,255,0.12)" />
      <g clipPath="url(#zone-target-body)">
        <image
          href={sprite.src}
          x={midX - 70}
          y={BY}
          width={140}
          height={BH}
          opacity={0.45}
          preserveAspectRatio="xMidYMid meet"
          style={{ pointerEvents: 'none' }}
        />
        {/* полосы зон в пикселях тела */}
        {zones.map((z) => {
          const lo = Math.min(z.py0, z.py1);
          const hi = Math.max(z.py0, z.py1);
          const by = yOf(lo);
          const bh = Math.max(1.5, yOf(hi) - yOf(lo));
          const leftPart = z.side === 'both' || z.side === 'left';
          const rightPart = z.side === 'both' || z.side === 'right';
          const rects = [
            ...(leftPart ? [{ x: BX, w: BW / 2 }] : []),
            ...(rightPart ? [{ x: midX, w: BW / 2 }] : []),
          ];
          // центр подписи: одна полоса на всю ширину — центр тела, иначе центр единственной половины
          const tx = rects.length === 2 ? midX : rects[0].x + rects[0].w / 2;
          const active = activeId === z.id;
          const dim = activeId !== null && !active;
          return (
            <g
              key={z.id}
              data-zone-id={z.id}
              data-py0={z.py0}
              data-py1={z.py1}
              data-damage={z.damage}
              data-side={z.side}
              onMouseEnter={() => onHover(z.id)}
              onMouseLeave={() => onHover(null)}
              style={{ cursor: 'default' }}
            >
              <title>{`${z.name}: ${z.py0}–${z.py1} px тела · урон ${z.damage} · ${sideLabel(z)}`}</title>
              {rects.map((rr, ri) => (
                <rect
                  key={ri}
                  x={rr.x}
                  y={by}
                  width={rr.w}
                  height={bh}
                  fill={z.color}
                  fillOpacity={dim ? 0.22 : active ? 0.95 : 0.72}
                  stroke={active ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.4)'}
                  strokeWidth={active ? 1.4 : 0.8}
                />
              ))}
              {bh >= 7 ? (
                <text
                  x={tx}
                  y={by + bh / 2 + (bh >= 26 ? -3.5 : 2.4)}
                  textAnchor="middle"
                  fontSize={bh >= 13 ? 9.5 : 7}
                  fontWeight={600}
                  fill={textOn(z.color)}
                  style={{ pointerEvents: 'none' }}
                >
                  {z.name}
                </text>
              ) : null}
              {bh >= 26 ? (
                <text
                  x={tx}
                  y={by + bh / 2 + 9.5}
                  textAnchor="middle"
                  fontSize="8.5"
                  fill={textOn(z.color)}
                  opacity={0.85}
                  style={{ pointerEvents: 'none' }}
                >
                  {z.damage}%
                </text>
              ) : null}
            </g>
          );
        })}
        {/* края текущих полос, а не фиксированная сетка 30/60/90/120 */}
        {ticks
          .filter((py) => py > 0 && py < 150)
          .map((py) => (
            <line
              key={py}
              x1={BX}
              x2={BX + BW}
              y1={yOf(py)}
              y2={yOf(py)}
              stroke="rgba(255,255,255,0.55)"
              strokeWidth={1}
              style={{ pointerEvents: 'none' }}
            />
          ))}
        {/* разделитель половин (слева/справа) */}
        <line x1={midX} x2={midX} y1={BY} y2={BY + BH} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 5" />
      </g>
      {/* деления вертикальной оси: края полос в пикселях тела */}
      {ticks.map((py, i) => {
        const right = tickSide[i] === 'right';
        const y = yOf(py);
        const x1 = right ? BX + BW : BX - 4;
        const x2 = right ? BX + BW + 4 : BX;
        return (
          <g key={`${py}-${right ? 'r' : 'l'}`}>
            <line x1={x1} x2={x2} y1={y} y2={y} stroke="rgba(255,255,255,0.45)" />
            <text
              x={right ? BX + BW + 7 : BX - 7}
              y={y + 2.5}
              textAnchor={right ? 'start' : 'end'}
              fontSize="7.5"
              fill="#d4d4d8"
            >
              {py}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function SettingsPanel(props: Props) {
  const { settings: s } = props;
  const [ioText, setIoText] = useState('');
  const [ioMsg, setIoMsg] = useState<string | null>(null);
  /** Зона под подсветкой: наведение на строку или на полосу мишени. */
  const [zoneHover, setZoneHover] = useState<string | null>(null);
  /** Открытый раздел (квадратик-иконка сверху). */
  const [tab, setTab] = useState<TabId>('field');
  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <div className="flex flex-col gap-2.5">
      {/* переключатель разделов: квадратики с иконками тем */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Разделы настроек">
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={t.label}
              onClick={() => setTab(t.id)}
              className={`flex size-11 items-center justify-center rounded-lg border transition-colors ${
                active
                  ? 'border-emerald-500 bg-emerald-950/50 shadow-[0_0_0_1px_rgba(16,185,129,0.35)]'
                  : 'border-zinc-700 bg-zinc-900/40 hover:border-zinc-500'
              }`}
            >
              <span className={t.id === 'field' ? 'text-lg font-black text-zinc-100' : 'text-xl leading-none'}>
                {t.icon}
              </span>
            </button>
          );
        })}
      </div>

      {/* содержимое выбранного раздела */}
      <section aria-label={activeTab.label} className="rounded-lg border border-zinc-800 bg-zinc-900/60">
        <div className="border-b border-zinc-800 px-3 py-2 text-sm font-semibold text-zinc-100">{activeTab.label}</div>
        <div className="px-3 py-2">
          {tab === 'field' && (
            <>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 py-1">
          {(
            [
              ['Клеток по X', 'cols', 1, 40],
              ['Клеток по Y', 'rows', 1, 40],
              ['Ширина клетки', 'cellW', 20, 400],
              ['Высота клетки', 'cellH', 20, 400],
            ] as const
          ).map(([label, key, min, max]) => (
            <div key={key} className="flex items-center justify-between gap-2 py-1">
              <span className="text-xs text-zinc-300">{label}</span>
              <NumInput
                className="w-20"
                value={s.field[key]}
                min={min}
                max={max}
                onChange={(v) => props.patchField({ [key]: v } as Partial<SimSettings['field']>)}
              />
            </div>
          ))}
        </div>
        <Toggle label="Сетка клеток" checked={s.field.showGrid} onChange={(v) => props.patchField({ showGrid: v })} />
        <Toggle
          label="Шахматная подсветка"
          checked={s.field.checker}
          onChange={(v) => props.patchField({ checker: v })}
        />
        <ColorInput label="Фон" value={s.field.bgColor} onChange={(v) => props.patchField({ bgColor: v })} />
        <ColorInput
          label="Фон (шахматный)"
          value={s.field.bgColorAlt}
          onChange={(v) => props.patchField({ bgColorAlt: v })}
        />
        <ColorInput label="Линии сетки" value={s.field.gridColor} onChange={(v) => props.patchField({ gridColor: v })} />
            </>
          )}
          {tab === 'arrow' && (
            <>
        <Toggle
          label="Боевой режим"
          checked={s.arrow.battleMode}
          hint="Клавиша B. В мирном режиме замедлений нет."
          onChange={(v) => props.patchArrow({ battleMode: v })}
        />
        <SlideNum
          label="Скорость вращения (период оборота)"
          value={s.arrow.periodSec}
          min={1.8}
          max={5}
          step={0.1}
          suffix="сек"
          onChange={(v) => props.patchArrow({ periodSec: v })}
        />
        <div className="pb-1.5">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">Готовые значения:</div>
          <div className="flex flex-wrap gap-1">
            {[1.8, 2.5, 3.5, 4, 4.5, 5].map((v) => {
              const active = Math.abs(s.arrow.periodSec - v) < 0.05;
              return (
                <Button
                  key={v}
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  className={
                    active
                      ? 'h-6 bg-emerald-600 px-2 text-[10px] font-semibold text-black hover:bg-emerald-500'
                      : 'h-6 bg-white px-2 text-[10px] font-semibold text-black hover:bg-zinc-200'
                  }
                  onClick={() => props.patchArrow({ periodSec: v })}
                >
                  {String(v).replace('.', ',')} сек
                </Button>
              );
            })}
          </div>
        </div>
        <div className="text-[10px] leading-snug text-zinc-500">
          Стрела вращается вручную: удерживайте <b>J</b> — против часовой, <b>L</b> — по часовой. Период задаёт
          скорость вращения при удержании. Стрела привязана к модельке: точка закрепления сидит на спрайте, а длина,
          толщина и наконечник автоматически растут вместе с персонажем (значения заданы для модельки 100%).
        </div>
        <LiveAngle getAngle={props.getAngle} onManualAngle={props.onManualAngle} />
        <SlideNum
          label="Отступ основания"
          value={s.arrow.radius}
          min={0}
          max={120}
          suffix="px"
          onChange={(v) => props.patchArrow({ radius: v })}
        />
        <SlideNum
          label="Длина стрелы"
          value={s.arrow.length}
          min={10}
          max={200}
          suffix="px"
          onChange={(v) => props.patchArrow({ length: v })}
        />
        <SlideNum
          label="Толщина"
          value={s.arrow.width}
          min={1}
          max={14}
          suffix="px"
          onChange={(v) => props.patchArrow({ width: v })}
        />
        <SlideNum
          label="Размер наконечника"
          value={s.arrow.tipSize}
          min={4}
          max={40}
          suffix="px"
          onChange={(v) => props.patchArrow({ tipSize: v })}
        />
        <SlideNum
          label="Точка закрепления: смещение ↑"
          value={-s.arrow.anchorOffsetY}
          min={-60}
          max={60}
          suffix="px"
          onChange={(v) => props.patchArrow({ anchorOffsetY: -v })}
        />
        <ColorInput label="Цвет стрелы" value={s.arrow.color} onChange={(v) => props.patchArrow({ color: v })} />
        <Toggle label="Орбита стрелы" checked={s.arrow.showOrbit} onChange={(v) => props.patchArrow({ showOrbit: v })} />
        <Toggle
          label="Дуга окна последнего направления"
          checked={s.arrow.showWindowArc}
          hint="Зелёная дуга — углы стрелы, при которых движение в последнем направлении бесплатно."
          onChange={(v) => props.patchArrow({ showWindowArc: v })}
        />
        <Toggle
          label="Точка закрепления и подсветка наведения"
          checked={s.arrow.showRay}
          hint="Выключите, чтобы спрятать кружок закрепления у основания стрелы и подсветку точки наведения на мишени. Сама стрела (линия с наконечником) всегда видна на поле."
          onChange={(v) => props.patchArrow({ showRay: v })}
        />
            </>
          )}
          {tab === 'slowdown' && (
            <>
        <SlideNum
          label="Базовое время шага"
          value={s.character.stepMs}
          min={100}
          max={3000}
          step={10}
          suffix="мс"
          hint="Интервал движения при зажатой клавише (ещё растягивается замедлением); новое нажатие срабатывает сразу, но не раньше, чем завершится предыдущий шаг, — спам не может превысить скорость, разрешённую замедлением."
          onChange={(v) => props.patchCharacter({ stepMs: v })}
        />
        <div className="mb-1 text-[11px] leading-snug text-zinc-400">
          Окно — диапазон углов стрелы, при котором прыжок в этом направлении идёт без замедления. Углы: 0°=вправо,
          90°=вниз, окно идёт от «от» до «до» по часовой.
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-zinc-500">
            <span className="flex-1">Направление</span>
            <span className="w-14 text-center">от, °</span>
            <span className="w-14 text-center">до, °</span>
          </div>
          {DIRECTIONS.map((d) => {
            const w = s.slowdown.windows[d.key];
            return (
              <div key={d.key} className="flex items-center gap-2">
                <span className="flex-1 truncate text-xs text-zinc-300">{d.label}</span>
                <NumInput
                  className="w-14"
                  value={w.start}
                  min={0}
                  max={360}
                  onChange={(v) => props.patchWindow(d.key, { start: v })}
                />
                <NumInput
                  className="w-14"
                  value={w.end}
                  min={0}
                  max={360}
                  onChange={(v) => props.patchWindow(d.key, { end: v })}
                />
              </div>
            );
          })}
        </div>

        <div className="mt-3 mb-1 text-[11px] font-medium text-zinc-300">
          Уровни замедления (по углу между прыжком и стрелой):
        </div>
        <div className="flex flex-col gap-1">
          {s.slowdown.tiers.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-10 text-xs text-zinc-400">≤</span>
              <NumInput
                className="w-14"
                value={t.max}
                min={1}
                max={180}
                onChange={(v) => props.patchTier(i, { max: v })}
              />
              <span className="text-xs text-zinc-500">° →</span>
              <NumInput
                className="w-14"
                value={t.value}
                min={0}
                max={100}
                onChange={(v) => props.patchTier(i, { value: v })}
              />
              <span className="text-xs text-zinc-500">% замедления</span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-zinc-400">Спина (дальше последнего уровня)</span>
            <NumInput
              className="w-14"
              value={s.slowdown.maxSlowdown}
              min={0}
              max={100}
              onChange={(v) => props.patchSlowdown({ maxSlowdown: v })}
            />
            <span className="text-xs text-zinc-500">%</span>
            <span className="w-14" />
          </div>
        </div>
        <div className="mt-2 text-[10px] leading-snug text-zinc-500">
          Скорость прыжка = 100% − замедление. Замедление фиксируется в момент начала прыжка.
        </div>
        <Toggle
          label="Всплывающая метка скорости"
          checked={s.slowdown.showStepLabel}
          onChange={(v) => props.patchSlowdown({ showStepLabel: v })}
        />
        <Toggle
          label="Бейдж скорости под персонажем"
          checked={s.slowdown.showSpeedBadge}
          onChange={(v) => props.patchSlowdown({ showSpeedBadge: v })}
        />
        <Toggle
          label="HUD со схемой замедлений"
          checked={s.hud.show}
          hint="Панель на поле со стрелой и процентами замедления по 8 направлениям."
          onChange={(v) => props.patchHud({ show: v })}
        />
            </>
          )}
          {tab === 'combat' && (
            <>
        <div className="mb-1 text-[11px] leading-snug text-zinc-400">
          Удар — клавиша <b>I</b> (отклик {s.combat.strikeResponseMs} мс: удар применяется через {s.combat.strikeResponseMs} мс
          после нажатия; при удержании и прожатиях — не чаще одного удара в этот же интервал). Нужно стоять вплотную к
          мишени (её клетка непроходима) и навести на неё стрелу. Энергия тратится только при попадании в зону удара;
          промах бесплатен.
        </div>
        <SlideNum
          label="Стартовая энергия"
          value={s.combat.energyStart}
          min={10}
          max={100}
          step={1}
          suffix="%"
          onChange={(v) => props.patchCombat({ energyStart: v })}
        />
        <SlideNum
          label="Трата энергии за попадание"
          value={s.combat.strikeCost}
          min={0}
          max={20}
          step={1}
          suffix="%"
          onChange={(v) => props.patchCombat({ strikeCost: v })}
        />
        <SlideNum
          label="Отклик удара"
          value={s.combat.strikeResponseMs}
          min={30}
          max={600}
          step={5}
          suffix="мс"
          hint="Удар применяется через столько мс после нажатия; при удержании I и прожатиях удары повторяются с этим же интервалом."
          onChange={(v) => props.patchCombat({ strikeResponseMs: v })}
        />

        <div className="mt-3 mb-1 text-[11px] font-medium text-zinc-300">Восстановление энергии:</div>
        <Toggle
          label="Регенерация энергии"
          checked={s.combat.regenEnabled}
          hint="У всех, кто в боевом режиме; мишень — в нём всегда."
          onChange={(v) => props.patchCombat({ regenEnabled: v })}
        />
        <SlideNum
          label="Восстановление за тик"
          value={s.combat.regenAmount}
          min={1}
          max={100}
          suffix="%"
          onChange={(v) => props.patchCombat({ regenAmount: v })}
        />
        <SlideNum
          label="Интервал восстановления"
          value={s.combat.regenIntervalSec}
          min={0.5}
          max={60}
          step={0.5}
          suffix="сек"
          onChange={(v) => props.patchCombat({ regenIntervalSec: v })}
        />
        <div className="text-[10px] leading-snug text-zinc-500">
          Мишени (локальные манекены) всегда в боевом режиме: сквозь них нельзя
          пройти, бить можно любого; если рядом стоят несколько — удар идёт в ту, на которую точнее наведена стрела. У
          каждой своя энергия и своя стрела.
        </div>

        <div className="mt-3 pb-0.5">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-zinc-300">Урон игрока — готовые пресеты:</span>
            <span className="text-[10px] text-zinc-500">горло сейчас: {throatDamageFor(s.combat.damageLevel)}%</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {DAMAGE_LEVELS.map((k) => {
              const active = s.combat.damageLevel === k;
              return (
                <Button
                  key={k}
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  className={
                    active
                      ? 'h-6 bg-emerald-600 px-2 text-[10px] font-semibold text-black hover:bg-emerald-500'
                      : 'h-6 bg-white px-2 text-[10px] font-semibold text-black hover:bg-zinc-200'
                  }
                  onClick={() =>
                    props.patchCombat({
                      damageLevel: k,
                      // геометрия зон (px, сторона, цвет) сохраняется — меняется только урон
                      zones: s.combat.zones.map((z) => ({ ...z, damage: zoneDamageFor(k, z.id) })),
                    })
                  }
                >
                  {damageLevelLabel(k)}
                </Button>
              );
            })}
          </div>
          <div className="mt-1 text-[10px] leading-snug text-zinc-500">
            Зависимость через горло: {throatDamageFor(0)}% при уроне 0,0, дальше +3,67% за каждые 0,1 — при 0,9 горло
            получает {throatDamageFor(9)}%. Остальные зоны растут пропорционально своей базе при 0,0. Кнопка
            перезаписывает урон всех зон; после можно докрутить числа вручную — выбранный пресет подсвечен.
          </div>
        </div>

        <div className="mt-3 mb-1 text-[11px] font-medium text-zinc-300">Зоны удара и урон за 1 удар:</div>
        <ZoneTarget zones={s.combat.zones} activeId={zoneHover} onHover={setZoneHover} />
        <div className="mt-1 text-center text-[10px] leading-snug text-zinc-500">
          Тело манекена в пикселях: 0 px — верх спрайта, 150 — низ. Левая половина — зоны левой стороны тела,
          правая — правой. Наведите на полосу или строку — зона подсветится, правка применяется мгновенно.
        </div>
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500">
            <span className="w-20 shrink-0">Зона</span>
            <span className="w-14 text-center">урон</span>
            <span className="w-14 text-center">от, px</span>
            <span className="w-14 text-center">до, px</span>
            <span className="flex-1 text-center">сторона</span>
          </div>
          {s.combat.zones.map((z, i) => (
            <div
              key={z.id}
              onMouseEnter={() => setZoneHover(z.id)}
              onMouseLeave={() => setZoneHover(null)}
              className={`-mx-0.5 flex items-center gap-1.5 rounded px-0.5 transition-colors ${
                zoneHover === z.id ? 'bg-zinc-800/70' : ''
              }`}
            >
              <span className="flex w-20 shrink-0 items-center gap-1.5 overflow-hidden">
                <span
                  className="inline-block size-2.5 shrink-0 rounded-full border border-black/30"
                  style={{ background: z.color }}
                />
                <span className="truncate text-xs text-zinc-300">{z.name}</span>
              </span>
              <NumInput
                className="w-14"
                value={z.damage}
                min={0}
                max={100}
                onChange={(v) => props.patchZone(i, { damage: v })}
              />
              <NumInput
                className="w-14"
                value={z.py0}
                min={0}
                max={150}
                onChange={(v) => props.patchZone(i, { py0: v })}
              />
              <NumInput
                className="w-14"
                value={z.py1}
                min={0}
                max={150}
                onChange={(v) => props.patchZone(i, { py1: v })}
              />
              <span className="flex flex-1 flex-wrap justify-end gap-0.5">
                {(['left', 'right'] as const).map((sid) => {
                  const active = z.side === 'both' || z.side === sid;
                  // нельзя снять обе стороны — остаётся хотя бы одна половина
                  const next: ZoneSide =
                    active
                      ? z.side === 'both'
                        ? sid
                        : z.side
                      : z.side === sid
                        ? z.side
                        : 'both';
                  return (
                    <button
                      key={sid}
                      type="button"
                      title={sid === 'left' ? 'Левая половина тела' : 'Правая половина тела'}
                      onClick={() => props.patchZone(i, { side: next })}
                      className={`h-6 w-6 rounded border text-[10px] font-semibold transition-colors ${
                        active
                          ? 'border-emerald-500 bg-emerald-950/60 text-emerald-300'
                          : 'border-zinc-700 bg-zinc-900/60 text-zinc-500 hover:border-zinc-500'
                      }`}
                    >
                      {sid === 'left' ? 'Л' : 'П'}
                    </button>
                  );
                })}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-2 text-[10px] leading-snug text-zinc-500">
          Удар летит по лучу стрелы от точки её закрепления: зона — полоса тела, в которую луч входит в ближний
          край манекена (слева — левая половина, справа — правая, сверху/снизу — половина по точке входа). Луч не
          задел тело или попал в промежуток без полосы — промах, энергия не тратится. На поле точка наведения
          подсвечивается цветом зоны прямо при вращении стрелы.
        </div>
        <div className="text-[10px] leading-snug text-zinc-500">
          С диагональной клетки полосы не действуют: слева-сверху и справа-сверху от мишени — только Морда,
          слева-снизу — только Лапы, справа-снизу — только Хвост, и удар проходит лишь когда стрела стоит в окне
          замедления направления на мишень (вправо-вниз / влево-вниз / вправо-вверх / влево-вверх). Вне окна —
          промах.
        </div>
        <Toggle
          label="Лог «Бой» над полем"
          checked={s.combat.showLog}
          hint="Справа от чата. Строки вида «Я => Имя (зона) xN», свежая сверху."
          onChange={(v) => props.patchCombat({ showLog: v })}
        />
        <div className="pt-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => props.onResetCombat()}
          >
            Сбросить энергию и лог ударов
          </Button>
        </div>
            </>
          )}
          {tab === 'config' && (
            <>
        <div className="flex flex-wrap gap-2 py-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              const json = props.onExport();
              setIoText(json);
              setIoMsg('Скопируйте текст ниже или вставьте свой конфиг и нажмите «Импорт».');
              try {
                void navigator.clipboard?.writeText(json);
              } catch {
                /* буфер может быть недоступен */
              }
            }}
          >
            Экспорт
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              const err = props.onImport(ioText);
              setIoMsg(err ? `Ошибка: ${err}` : 'Конфиг применён.');
            }}
          >
            Импорт
          </Button>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 text-xs"
            onClick={() => {
              props.onResetAll();
              setIoMsg('Настройки сброшены.');
            }}
          >
            Сбросить всё
          </Button>
        </div>
        <textarea
          className="h-24 w-full rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-[10px] text-zinc-300"
          placeholder="JSON конфига…"
          value={ioText}
          onChange={(e) => setIoText(e.target.value)}
        />
        {ioMsg ? <div className="text-[10px] text-zinc-500">{ioMsg}</div> : null}
            </>
          )}
        </div>
      </section>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-[11px] leading-relaxed text-zinc-400">
        <div className="mb-1 text-xs font-semibold text-zinc-200">Управление</div>
        W A S D — шаг вверх/влево/вниз/вправо, на русской раскладке те же клавиши — ц ф ы в · Q E Z X — диагонали · ЛКМ по клетке — идти маршрутом · ЛКМ на манекене
        (зажать и тянуть) — перетащить его по клеткам, тряска мышью качает манекен как желе · B — боевой режим · I —
        удар (вплотную, по наведённой стреле) · J — стрела против часовой · L — по часовой. Персонаж прыгает мгновенно,
        без анимаций. Зажатая клавиша движения — шаг раз в 120 мс (с учётом замедления), спам нажатиями быстрее не
        сделает: правила замедления действуют всегда. Отклик удара — 170 мс. Все изменения настроек применяются
        мгновенно.
      </div>
    </div>
  );
}
