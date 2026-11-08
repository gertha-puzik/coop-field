'use client';

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import type { DirectionWindow, SimSettings, SlowdownTier, SpriteId, SpriteMeta, StrikeZone, WindowKey, ZoneSide, DayPart, WeatherKind } from '@/lib/sim/settings';
import {
  DAYPARTS,
  DAYPART_LABEL,
  DIRECTIONS,
  SPRITES,
  SPRITE_GROUPS,
  WEATHERS,
  WEATHER_LABEL,
  damageLevelLabel,
  throatDamageFor,
  wrap360,
} from '@/lib/sim/settings';
import { armorLevelMultiplierOn } from '@/lib/sim/armor-curve';
import type { CoopAtmo } from '@/lib/net/coop';
import { GertaHandbook } from './gerta-handbook';
import { loadUniverses, snapPeriodToAllowed, universesNow, type Universes } from '@/lib/net/cfg-live';

/**
 * Compile-time вариант сайта (P3, спек §2A): подсказки про мир уточняются
 * по варианту, сворачивается при сборке — тексты Элизии в grotto не едут.
 */
const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria';

interface Props {
  settings: SimSettings;
  /** Роль сессии из whoami (P3): админ-вкладки рендерятся только при 'admin'. */
  role?: 'guest' | 'registered' | 'admin';
  /** Комната «тест»: чистый полигон — манекен и мишень РАБ недоступны. */
  testField?: boolean;
  /** Атмосфера комнаты (общая): время суток и погода. */
  atmo: CoopAtmo;
  onAtmo: (dp: DayPart, w: WeatherKind) => void;
  /** Темп цикла атмосферы (общий для комнаты): минуты части суток и интервала погоды. */
  atmoCfg: { phaseMin: number; weatherMin: number };
  onAtmoCfg: (phaseMin: number, weatherMin: number) => void;
  /** Дебаг: атмосферный слой (тонировка суток, облака, дождь) — виден только у этого клиента. */
  atmoLayerOn: boolean;
  onAtmoLayer: (on: boolean) => void;
  /** Манекен «ПОЧУХАТЬ» включён в комнате (состояние комнаты, не локальная настройка). */
  dummyOn: boolean;
  onToggleDummy: (on: boolean) => void;
  /** Выбранный скин манекена (из списка персонажей). */
  dummySprite: SpriteId;
  onDummySprite: (sprite: SpriteId) => void;
  /** Боевая мишень «РАБ» включена в комнате. */
  rabOn: boolean;
  onToggleRab: (on: boolean) => void;
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
        <span className="text-xs text-[var(--sim-text-soft)]">{label}</span>
        <div className="flex items-center gap-1">
          <NumInput value={value} min={min} max={max} step={step} onChange={onChange} className="w-20" />
          {suffix ? <span className="w-7 text-[10px] text-[var(--sim-text-faint)]">{suffix}</span> : null}
        </div>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(vals) => onChange(parseFloat(vals[0].toFixed(2)))}
        className="[*_[data-slot=slider-thumb]]:size-3.5 [&_[data-slot=slider-range]]:bg-[var(--sim-accent)]"
      />
      {hint ? <div className="mt-0.5 text-[10px] leading-tight text-[var(--sim-text-faint)]">{hint}</div> : null}
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
        <div className="text-xs text-[var(--sim-text-soft)]">{label}</div>
        {hint ? <div className="text-[10px] leading-tight text-[var(--sim-text-faint)]">{hint}</div> : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        className="data-[state=checked]:bg-[var(--sim-accent)] data-[state=unchecked]:bg-[var(--sim-line-strong)]"
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
      <span className="text-xs text-[var(--sim-text-soft)]">{label}</span>
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
        <label className="relative inline-block h-7 w-8 cursor-pointer overflow-hidden rounded-md border border-[var(--sim-line-strong)]">
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
type TabId = 'field' | 'arrow' | 'slowdown' | 'combat' | 'io' | 'handbook';

/**
 * Разделы настроек. Права решает серверная роль на сессии (whoami.role),
 * локальных паролей больше нет (P3, спек §5): вкладки admin:true рендерятся
 * только админу; «Данные» (личный JSON экспорта/импорта этого браузера)
 * доступны всем. Сервер по-прежнему арбитр любых сетевых правок.
 */

/** Разделы: квадратик с иконкой темы, клик открывает содержимое.
 *  «Общий» (#) и «Справочник» — всем; admin: true — только роли admin. */
const TABS: { id: TabId; icon: string; label: string; admin?: boolean }[] = [
  { id: 'field', icon: '#', label: 'Общий' },
  { id: 'handbook', icon: '📖', label: 'Справочник' },
  { id: 'io', icon: '📋', label: 'Данные' },
  { id: 'arrow', icon: '🏹', label: 'Стрела', admin: true },
  { id: 'slowdown', icon: '⛔', label: 'Замедление', admin: true },
  { id: 'combat', icon: '💥', label: 'Удары и энергия', admin: true },
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
        <span className="text-xs text-[var(--sim-text-soft)]">Точный угол стрелы</span>
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
        className="[&_[data-slot=slider-range]]:bg-[var(--sim-accent)]"
      />
      <div className="mt-0.5 text-[10px] text-[var(--sim-text-faint)]">
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
  /** Живые universes (GET /cfg, кэш на вкладку): предлагаемые значения СП. */
  const [universes, setUniverses] = useState<Universes>(universesNow());
  useEffect(() => {
    let dead = false;
    void loadUniverses().then((u) => {
      if (!dead) setUniverses(u);
    });
    return () => {
      dead = true;
    };
  }, []);

  /** Админ-вкладки рендерит только сессия с ролью admin (truth на сервере). */
  const isAdmin = props.role === 'admin';
  /** Видимые вкладки: без роли admin — общие разделы. */
  const visibleTabs = TABS.filter((t) => !t.admin || isAdmin);
  const requestedTab = TABS.find((t) => t.id === tab) ?? TABS[0];
  /** Если админская вкладка открыта, а роль не админ — показываем «Общий». */
  const activeTab = isAdmin || !requestedTab.admin ? requestedTab : TABS[0];

  return (
    <div className="flex flex-col gap-2.5">
      {/* переключатель разделов: квадратики с иконками тем.
          Роль admin (whoami) открывает админ-вкладки — паролей больше нет. */}
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Разделы настроек">
        {visibleTabs.map((t) => {
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
                  ? 'border-[var(--sim-accent)] bg-[var(--sim-accent-tint)] shadow-[0_0_0_1px_var(--sim-accent-glow)]'
                  : 'border-[var(--sim-line-strong)] bg-[var(--sim-inset-soft)] hover:border-[var(--sim-line-hover)]'
              }`}
            >
              <span className={t.id === 'field' ? 'text-lg font-black text-[var(--sim-text)]' : 'text-xl leading-none'}>
                {t.icon}
              </span>
            </button>
          );
        })}
      </div>

      {/* содержимое выбранного раздела */}
      <section aria-label={activeTab.label} className="rounded-lg border border-[var(--sim-line)] bg-[var(--sim-inset)]">
        <div className="border-b border-[var(--sim-line)] px-3 py-2 text-sm font-semibold text-[var(--sim-text)]">{activeTab.label}</div>
        <div className="px-3 py-2">
          {tab === 'field' && (
            <>
        {/* «Тест» — чистый полигон: манекен и мишень РАБ недоступны */}
        {!props.testField && (
          <>
        <Toggle
          label="Включить манекен"
          hint="Манекен «ПОЧУХАТЬ» на поле: вне боя, но сквозь него нельзя ходить. Видно всем, тащить может любой игрок — движение и имя тащщего (курсор) видно в реальном времени."
          checked={props.dummyOn}
          onChange={(v) => props.onToggleDummy(v)}
        />
        <div className="flex items-center justify-between gap-3 py-1.5">
          <div>
            <div className="text-xs text-[var(--sim-text-soft)]">Спрайт манекена</div>
            <div className="text-[10px] leading-tight text-[var(--sim-text-faint)]">
              Скин «ПОЧУХАТЬ» из списка присвоенных имён персонажей; выбор виден всей комнате.
            </div>
          </div>
          <select
            aria-label="Спрайт манекена"
            value={props.dummySprite}
            onChange={(e) => props.onDummySprite(e.target.value as SpriteId)}
            className="h-7 max-w-36 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-inset-soft)] px-1.5 text-xs text-[var(--sim-text)] outline-none focus:border-[var(--sim-accent)]"
          >
            {SPRITE_GROUPS.map((g) => {
              const opts = g.spriteIds
                .map((id) => SPRITES.find((sp) => sp.id === id))
                .filter((sp): sp is SpriteMeta => Boolean(sp));
              if (!opts.length) return null;
              return (
                <optgroup key={g.id} label={g.name}>
                  {opts.map((sp) => (
                    <option key={sp.id} value={sp.id}>
                      {sp.name}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
        </div>
        <Toggle
          label="Включить мишень"
          hint="Боевая мишень «РАБ» на поле: в боевом режиме — по ней проходят удары, и она физическое препятствие, сквозь неё нельзя ходить. Спрайт один у всех мишеней."
          checked={props.rabOn}
          onChange={(v) => props.onToggleRab(v)}
        />
          </>
        )}
        {/* Атмосфера — только рисованная локация. На клеточном поле (пивные
            гроты) суток и погоды нет: вуаль и циферблат там портили картинку. */}
        {props.testField ? (
        <>
        <div className="py-1.5">
          <div className="text-xs text-[var(--sim-text-soft)]">Время суток</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {DAYPARTS.map((dp) => {
              const active = props.atmo.dp === dp;
              return (
                <Button
                  key={dp}
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  className={
                    active
                      ? 'h-6 bg-[var(--sim-accent)] px-2 text-[10px] font-semibold text-black hover:bg-[var(--sim-accent-hover)]'
                      : 'h-6 bg-white px-2 text-[10px] font-semibold text-black hover:bg-zinc-200'
                  }
                  onClick={() => props.onAtmo(dp, props.atmo.w)}
                >
                  {DAYPART_LABEL[dp]}
                </Button>
              );
            })}
          </div>
          <div className="mt-0.5 text-[10px] leading-tight text-[var(--sim-text-faint)]">
            Кнопка перематывает цикл к середине части суток — общая для всей комнаты.
          </div>
        </div>
        <div className="py-1.5">
          <div className="text-xs text-[var(--sim-text-soft)]">Погода</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {WEATHERS.map((w) => {
              const active = props.atmo.w === w;
              return (
                <Button
                  key={w}
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  className={
                    active
                      ? 'h-6 bg-[var(--sim-accent)] px-2 text-[10px] font-semibold text-black hover:bg-[var(--sim-accent-hover)]'
                      : 'h-6 bg-white px-2 text-[10px] font-semibold text-black hover:bg-zinc-200'
                  }
                  onClick={() => props.onAtmo(props.atmo.dp, w)}
                >
                  {WEATHER_LABEL[w]}
                </Button>
              );
            })}
          </div>
          <div className="mt-0.5 text-[10px] leading-tight text-[var(--sim-text-faint)]">
            Тоже общая: дождь, облака и свет меняются у всех одновременно.
          </div>
        </div>
        {/* Дебаг-тумблер: локальное выключение атмосферного слоя (для сравнения
            «с тонировкой / без» при ловле графических багов). По сети не едет. */}
        <Toggle
          label="Слой атмосферы (дебаг)"
          hint="Выключает тонировку времени суток, облака и дождь — только у тебя, остальным игрокам не мешает. Часы на панели остаются."
          checked={props.atmoLayerOn}
          onChange={(v) => props.onAtmoLayer(v)}
        />
        {/* Темп цикла — тоже общий: сервер держит часы комнаты и рассылает якорь. */}
        <SlideNum
          label="Длительность части суток"
          value={props.atmoCfg.phaseMin}
          min={1}
          max={30}
          step={1}
          suffix="мин"
          hint="Утро, день, вечер и ночь идут по очереди сами; полный цикл — 4 части"
          onChange={(v) => props.onAtmoCfg(v, props.atmoCfg.weatherMin)}
        />
        <SlideNum
          label="Смена погоды каждые"
          value={props.atmoCfg.weatherMin}
          min={2}
          max={60}
          step={1}
          suffix="мин"
          hint="Погода меняется сама и всегда на другую; кнопкой можно поставить любую сейчас"
          onChange={(v) => props.onAtmoCfg(props.atmoCfg.phaseMin, v)}
        />
        </>
        ) : null}
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
        <SlideNum
          label="Скорость вращения (период оборота)"
          value={s.arrow.periodSec}
          min={universes.arrowPeriods[0] ?? 1.8}
          max={universes.arrowPeriods[universes.arrowPeriods.length - 1] ?? 5}
          step={0.1}
          suffix="сек"
          onChange={(v) => props.patchArrow({ periodSec: v })}
        />
        <div className="pb-1.5">
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--sim-text-faint)]">Готовые значения:</div>
          <div className="flex flex-wrap gap-1">
            {universes.arrowPeriods.map((v) => {
              const active = Math.abs(s.arrow.periodSec - v) < 0.05;
              return (
                <Button
                  key={v}
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  className={
                    active
                      ? 'h-6 bg-[var(--sim-accent)] px-2 text-[10px] font-semibold text-black hover:bg-[var(--sim-accent-hover)]'
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
        <div className="text-[10px] leading-snug text-[var(--sim-text-faint)]">
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
        <SlideNum
          label="Скорость ходьбы (мирный режим)"
          value={s.character.peaceSpeed}
          min={40}
          max={800}
          step={10}
          suffix="px/с"
          hint={
            IS_ELYRIA
              ? 'Свободная ходьба по траве «Элизии Эйдес»: сколько пикселей мира кот проходит в секунду, пока зажаты клавиши (или летит клик-цель).'
              : 'Свободная ходьба по полю: сколько пикселей мира кот проходит в секунду, пока зажаты клавиши (или летит клик-цель).'
          }
          onChange={(v) => props.patchCharacter({ peaceSpeed: v })}
        />
        <div className="mb-1 text-[11px] leading-snug text-[var(--sim-text-muted)]">
          Окно — диапазон углов стрелы, при котором прыжок в этом направлении идёт без замедления. Углы: 0°=вправо,
          90°=вниз, окно идёт от «от» до «до» по часовой.
        </div>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-[var(--sim-text-faint)]">
            <span className="flex-1">Направление</span>
            <span className="w-14 text-center">от, °</span>
            <span className="w-14 text-center">до, °</span>
          </div>
          {DIRECTIONS.map((d) => {
            const w = s.slowdown.windows[d.key];
            return (
              <div key={d.key} className="flex items-center gap-2">
                <span className="flex-1 truncate text-xs text-[var(--sim-text-soft)]">{d.label}</span>
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

        <div className="mt-3 mb-1 text-[11px] font-medium text-[var(--sim-text-soft)]">
          Уровни замедления (по углу между прыжком и стрелой):
        </div>
        <div className="flex flex-col gap-1">
          {s.slowdown.tiers.map((t, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-10 text-xs text-[var(--sim-text-muted)]">≤</span>
              <NumInput
                className="w-14"
                value={t.max}
                min={1}
                max={180}
                onChange={(v) => props.patchTier(i, { max: v })}
              />
              <span className="text-xs text-[var(--sim-text-faint)]">° →</span>
              <NumInput
                className="w-14"
                value={t.value}
                min={0}
                max={100}
                onChange={(v) => props.patchTier(i, { value: v })}
              />
              <span className="text-xs text-[var(--sim-text-faint)]">% замедления</span>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <span className="flex-1 text-xs text-[var(--sim-text-muted)]">Спина (дальше последнего уровня)</span>
            <NumInput
              className="w-14"
              value={s.slowdown.maxSlowdown}
              min={0}
              max={100}
              onChange={(v) => props.patchSlowdown({ maxSlowdown: v })}
            />
            <span className="text-xs text-[var(--sim-text-faint)]">%</span>
            <span className="w-14" />
          </div>
        </div>
        <div className="mt-2 text-[10px] leading-snug text-[var(--sim-text-faint)]">
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
        <div className="mb-1 text-[11px] leading-snug text-[var(--sim-text-muted)]">
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

        <div className="mt-3 mb-1 text-[11px] font-medium text-[var(--sim-text-soft)]">Восстановление энергии:</div>
        <Toggle
          label="Регенерация энергии"
          checked={s.combat.regenEnabled}
          hint="У всех, кто в комнате."
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
        <div className="text-[10px] leading-snug text-[var(--sim-text-faint)]">
          Коты в комнате всегда в боевом режиме: сквозь них нельзя пройти, бить можно любого соседа;
          если рядом стоят несколько — удар идёт в того, на кого точнее наведена стрела. У каждого своя энергия
          и своя стрела.
        </div>

        <div className="mt-3 pb-0.5">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-[var(--sim-text-soft)]">Урон игрока — готовые пресеты:</span>
            <span className="text-[10px] text-[var(--sim-text-faint)]">горло сейчас: {throatDamageFor(s.combat.damageLevel)}%</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {universes.damage.map((k) => {
              const active = s.combat.damageLevel === k;
              return (
                <Button
                  key={k}
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  className={
                    active
                      ? 'h-6 bg-[var(--sim-accent)] px-2 text-[10px] font-semibold text-black hover:bg-[var(--sim-accent-hover)]'
                      : 'h-6 bg-white px-2 text-[10px] font-semibold text-black hover:bg-zinc-200'
                  }
                  onClick={() => {
                    const prevThroat = Math.max(1, throatDamageFor(s.combat.damageLevel));
                    const nextThroat = Math.max(1, throatDamageFor(k));
                    props.patchCombat({
                      damageLevel: k,
                      // геометрия зон (px, сторона, цвет) сохраняется — меняется только урон;
                      // масштабируем ТЕКУЩИЙ урон зон: ручные правки зон не стираются
                      // (раньше пересчёт от базы затирал их при смене пресета)
                      zones: s.combat.zones.map((z) => ({
                        ...z,
                        damage: Math.max(0, Math.round((z.damage * nextThroat) / prevThroat)),
                      })),
                    });
                  }}
                >
                  {damageLevelLabel(k)}
                </Button>
              );
            })}
          </div>
          <div className="mt-1 text-[10px] leading-snug text-[var(--sim-text-faint)]">
            Зависимость через горло: {throatDamageFor(0)}% при уроне 0,0, дальше +3,67% за каждые 0,1 — при 0,9 горло
            получает {throatDamageFor(9)}%. Остальные зоны растут пропорционально текущим значениям — ручные правки
            урона зон сохраняются. Кнопка меняет урон всех зон; после можно докрутить числа вручную — выбранный
            пресет подсвечен.
          </div>
        </div>

        <div className="mt-3 pb-0.5">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <span className="text-[11px] font-medium text-[var(--sim-text-soft)]">Броня — готовые пресеты:</span>
            <span className="text-[10px] text-[var(--sim-text-faint)]">
              урон по вам проходит: {Math.round(armorLevelMultiplierOn(universes.armorCurve, s.combat.armorLevel) * 100)}%
            </span>
          </div>
          <div className="flex flex-wrap gap-1">
            {universes.armor.map((k) => {
              const active = s.combat.armorLevel === k;
              return (
                <Button
                  key={k}
                  size="sm"
                  variant={active ? 'default' : 'outline'}
                  className={
                    active
                      ? 'h-6 bg-[var(--sim-accent)] px-2 text-[10px] font-semibold text-black hover:bg-[var(--sim-accent-hover)]'
                      : 'h-6 bg-white px-2 text-[10px] font-semibold text-black hover:bg-zinc-200'
                  }
                  onClick={() => props.patchCombat({ armorLevel: k })}
                >
                  {damageLevelLabel(k)}
                </Button>
              );
            })}
          </div>
          <div className="mt-1 text-[10px] leading-snug text-[var(--sim-text-faint)]">
            Броня режет получаемый урон по кривой сервера: 0,0 — проходит весь урон, а при 0,9 через вас идёт{' '}
            {Math.round(armorLevelMultiplierOn(universes.armorCurve, 9) * 100)}%. Режет любой входящий удар, включая хвост:
            блок хвост не ловит, а броня — режет.
          </div>
        </div>

        <div className="mt-3 mb-1 text-[11px] font-medium text-[var(--sim-text-soft)]">Зоны удара и урон за 1 удар:</div>
        <ZoneTarget zones={s.combat.zones} activeId={zoneHover} onHover={setZoneHover} />
        <div className="mt-1 text-center text-[10px] leading-snug text-[var(--sim-text-faint)]">
          Тело манекена в пикселях: 0 px — верх спрайта, 150 — низ. Левая половина — зоны левой стороны тела,
          правая — правой. Наведите на полосу или строку — зона подсветится, правка применяется мгновенно.
        </div>
        <div className="mt-2 flex flex-col gap-1">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-[var(--sim-text-faint)]">
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
                zoneHover === z.id ? 'bg-[var(--sim-hover)]' : ''
              }`}
            >
              <span className="flex w-20 shrink-0 items-center gap-1.5 overflow-hidden">
                <span
                  className="inline-block size-2.5 shrink-0 rounded-full border border-black/30"
                  style={{ background: z.color }}
                />
                <span className="truncate text-xs text-[var(--sim-text-soft)]">{z.name}</span>
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
                          ? 'border-[var(--sim-accent)] bg-[var(--sim-accent-tint)] text-[var(--sim-accent-text)]'
                          : 'border-[var(--sim-line-strong)] bg-[var(--sim-inset)] text-[var(--sim-text-faint)] hover:border-[var(--sim-line-hover)]'
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
        <div className="mt-2 text-[10px] leading-snug text-[var(--sim-text-faint)]">
          Удар летит по лучу стрелы от точки её закрепления: зона — полоса тела, в которую луч входит в ближний
          край манекена (слева — левая половина, справа — правая, сверху/снизу — половина по точке входа). Луч не
          задел тело или попал в промежуток без полосы — промах, энергия не тратится. На поле точка наведения
          подсвечивается цветом зоны прямо при вращении стрелы.
        </div>
        <div className="text-[10px] leading-snug text-[var(--sim-text-faint)]">
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
          {tab === 'handbook' && <GertaHandbook />}
          {tab === 'io' && (
            <>
        <p className="text-[11px] leading-snug text-[var(--sim-text-muted)]">
          Этот JSON — настройки <b>этого браузера</b> (стрела, зоны, поле). Применяются сразу
          у вас, соседи их не видят. Панель «Данные» личная: она не управляет сервером.
        </p>
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
              if (!window.confirm('Сбросить все настройки этого браузера? Соседей и сервер это не затронет. Отменить потом нельзя.')) {
                return;
              }
              props.onResetAll();
              setIoMsg('Настройки сброшены.');
            }}
          >
            Сбросить всё
          </Button>
        </div>
        <textarea
          className="h-24 w-full rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-deep)] p-2 font-mono text-[10px] text-[var(--sim-text-soft)]"
          placeholder="JSON конфига…"
          value={ioText}
          onChange={(e) => setIoText(e.target.value)}
        />
        {ioMsg ? <div className="text-[10px] text-[var(--sim-text-faint)]">{ioMsg}</div> : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
