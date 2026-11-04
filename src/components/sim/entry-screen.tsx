'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import {
  DAMAGE_LEVELS,
  GAME_CREDITS,
  SPRITES,
  armorLevelMultiplier,
  damageLevelLabel,
  throatDamageFor,
  type SpriteId,
} from '@/lib/sim/settings';
import { RoomPicker, type RoomRow } from './room-picker';

/** Готовые значения периода оборота стрелы — те же, что в настройках («Стрела»). */
const SPEED_PRESETS = [1.8, 2.5, 3.5, 4, 4.5, 5];

const fmtSec = (v: number) => `${v.toFixed(1).replace('.', ',')} сек`;

/** Значение в строке «Выбор СП»: подтверждённое — акцентное с галочкой, остальное — обычное. */
function SpVal({ done, children }: { done: boolean; children: ReactNode }) {
  return (
    <span
      className={
        done
          ? 'font-semibold text-[var(--sim-accent-text)]'
          : 'text-[var(--sim-text-soft)]'
      }
    >
      {children}
      {done ? ' ✓' : ''}
    </span>
  );
}

/** Стиль чипа-пресета — как в панели настроек: активный акцентный, остальные белые. */
function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? 'default' : 'outline'}
      className={
        active
          ? 'h-6 bg-[var(--sim-accent)] px-2 text-[10px] font-semibold text-black hover:bg-[var(--sim-accent-hover)]'
          : 'h-6 bg-white px-2 text-[10px] font-semibold text-black hover:bg-zinc-200'
      }
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

/** Один пункт «Скрытых параметров»: контролы + кнопка подтверждения и метка «применено». */
function ParamCard({
  title,
  status,
  done,
  onConfirm,
  children,
}: {
  title: string;
  /** Что показывать в метке применённого: «3,5 сек», «0,4»… */
  status: string;
  done: boolean;
  onConfirm: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-3 transition-colors ${
        done
          ? 'border-[var(--sim-accent-hover)] bg-[var(--sim-accent-tint)]'
          : 'border-[var(--sim-line-strong)] bg-[var(--sim-inset-strong)]'
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-[var(--sim-text)]">{title}</h3>
        {done ? (
          <span className="shrink-0 rounded bg-[var(--sim-accent-hover)] px-1.5 py-px text-[10px] font-bold leading-none text-white">
            ✓ применено: {status}
          </span>
        ) : (
          <span className="shrink-0 text-[10px] text-[var(--sim-text-faint)]">не подтверждено</span>
        )}
      </div>
      {children}
      <Button
        type="button"
        size="sm"
        disabled={done}
        className="mt-2.5 h-8 w-full bg-[var(--sim-accent)] text-xs font-bold text-black hover:bg-[var(--sim-accent-hover)]"
        onClick={onConfirm}
      >
        {done ? 'Подтверждено' : 'Подтвердить'}
      </Button>
    </div>
  );
}

/**
 * Вход на поле одной страницей, три блока рядом:
 *  слева — имя (сверху) и карусель скинов в 2 ряда, крутится в стороны;
 *  в центре — небольшой блок «Выбор СП» с записью выбранных скрытых параметров;
 *  справа — «Скрытые параметры»: скорость стрелы (ползунок + пресеты 5…1,8 сек),
 *  дамаг и броня (пресеты 0,0–0,9). Каждый пункт игрок подтверждает — только
 *  подтверждённое значение уходит в настройки.
 * Когда имя введено и все три пункта подтверждены — ниже открывается выбор комнаты.
 */
export function EntryScreen({
  initialSprite,
  initialName,
  initialScale,
  periodSec,
  damageLevel,
  armorLevel,
  roomRows,
  roomsReady,
  roomsStale,
  onPickRoom,
  onApplySpeed,
  onApplyDamage,
  onApplyArmor,
}: {
  initialSprite: SpriteId;
  initialName: string;
  initialScale: number;
  /** Текущие значения настроек — стартовые для ползунка и пресетов. */
  periodSec: number;
  damageLevel: number;
  armorLevel: number;
  roomRows: RoomRow[];
  roomsReady: boolean;
  roomsStale?: boolean;
  /** Клик по карточке комнаты: кто идёт — решение EntryScreen (имя/скин/размер). */
  onPickRoom: (id: string, who: { name: string; sprite: SpriteId; scale: number }) => void;
  onApplySpeed: (periodSec: number) => void;
  onApplyDamage: (level: number) => void;
  onApplyArmor: (level: number) => void;
}) {
  const [name, setName] = useState(initialName);
  const [sprite, setSprite] = useState<SpriteId>(initialSprite);
  const [scale, setScale] = useState(initialScale);
  const [speedVal, setSpeedVal] = useState(Math.round(periodSec * 10) / 10);
  const [damageVal, setDamageVal] = useState(damageLevel);
  const [armorVal, setArmorVal] = useState(armorLevel);
  /** Подтверждённые значения; null — пункт ещё не подтверждали. */
  const [speedOk, setSpeedOk] = useState<number | null>(null);
  const [damageOk, setDamageOk] = useState<number | null>(null);
  const [armorOk, setArmorOk] = useState<number | null>(null);
  /** Прошлый выбор СП (то, что сохранилось с последнего входа): снимается один
   *  раз при открытии экрана — дальше ползунки живут своей жизнью. */
  const prevSpRef = useRef({ speed: Math.round(periodSec * 10) / 10, damage: damageLevel, armor: armorLevel });

  /** «Использовать предыдущие СП»: подтягивает сохранённый выбор и подтверждает
   *  все три пункта разом — каждый раз тыкать одно и то же не нужно. */
  const applyPrevSp = () => {
    const p = prevSpRef.current;
    setSpeedVal(p.speed);
    setDamageVal(p.damage);
    setArmorVal(p.armor);
    onApplySpeed(p.speed);
    onApplyDamage(p.damage);
    onApplyArmor(p.armor);
    setSpeedOk(p.speed);
    setDamageOk(p.damage);
    setArmorOk(p.armor);
  };

  const trimmed = name.trim();
  const speedDone = speedOk !== null && Math.abs(speedOk - speedVal) < 0.05;
  const damageDone = damageOk !== null && damageOk === damageVal;
  const armorDone = armorOk !== null && armorOk === armorVal;
  const doneCount = [speedDone, damageDone, armorDone].filter(Boolean).length;
  const roomsOpen = !!trimmed && doneCount === 3;

  /* --- карусель скинов: 2 ряда, колонки по 2 спрайта, крутится в стороны --- */
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef({ active: false, moved: false, startX: 0, startLeft: 0 });
  const cols: (typeof SPRITES)[number][][] = [];
  for (let i = 0; i < SPRITES.length; i += 2) cols.push(SPRITES.slice(i, i + 2));

  const scrollTrack = (dir: 1 | -1) => {
    const el = trackRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.75), behavior: 'smooth' });
  };
  const onTrackPointerDown = (ev: React.PointerEvent<HTMLDivElement>) => {
    // Мышью карусель можно тащить; тач и колесо скроллят нативно.
    if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
    const el = trackRef.current;
    if (!el) return;
    dragRef.current = { active: true, moved: false, startX: ev.clientX, startLeft: el.scrollLeft };
  };
  const onTrackPointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    const el = trackRef.current;
    if (!d.active || !el) return;
    const dx = ev.clientX - d.startX;
    if (Math.abs(dx) > 6) d.moved = true;
    if (d.moved) el.scrollLeft = d.startLeft - dx;
  };
  const endTrackDrag = () => {
    dragRef.current.active = false;
  };
  /** После перетаскивания клик по спрайту не должен менять выбор. */
  const onTrackClickCapture = (ev: React.MouseEvent<HTMLDivElement>) => {
    if (dragRef.current.moved) {
      ev.preventDefault();
      ev.stopPropagation();
      dragRef.current.moved = false;
    }
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <header>
        <h1 className="text-xl font-bold leading-tight">Общее поле</h1>
        <p className="mt-1 text-sm text-[var(--sim-text-muted)]">
          Слева — имя и скин, справа — скрытые параметры (выбранное дублируется в центре). Подтвердите три пункта —
          ниже откроется выбор комнаты.
        </p>
      </header>

      <div className="mt-5 grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(200px,230px)_minmax(0,1fr)]">
        {/* Блок 1: имя сверху, под ним карусель скинов в 2 ряда */}
        <section aria-label="Кот" className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
          <label className="flex flex-col gap-1.5" htmlFor="entry-name">
            <span className="text-sm font-semibold text-[var(--sim-text)]">Имя</span>
            <Input
              id="entry-name"
              value={name}
              maxLength={24}
              autoComplete="nickname"
              placeholder="Как вас видеть на поле"
              aria-describedby="entry-name-hint"
              onChange={(e) => setName(e.target.value)}
              className="h-10 border-[var(--sim-line-strong)] bg-[var(--sim-input-bg)] text-[var(--sim-text)] placeholder:text-[var(--sim-text-faint)]"
            />
            <span id="entry-name-hint" className="text-xs text-[var(--sim-text-faint)]">
              Обязательное поле. Пустое имя на поле не пускает.
            </span>
          </label>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-[var(--sim-text)]">Скин</h2>
              <div className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label="Листнуть скины влево"
                  className="btn-neutral h-7 w-7 px-0 text-xs"
                  onClick={() => scrollTrack(-1)}
                >
                  ‹
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label="Листнуть скины вправо"
                  className="btn-neutral h-7 w-7 px-0 text-xs"
                  onClick={() => scrollTrack(1)}
                >
                  ›
                </Button>
              </div>
            </div>
            <div
              ref={trackRef}
              role="radiogroup"
              aria-label="Скин персонажа"
              onPointerDown={onTrackPointerDown}
              onPointerMove={onTrackPointerMove}
              onPointerUp={endTrackDrag}
              onPointerLeave={endTrackDrag}
              onClickCapture={onTrackClickCapture}
              className="flex cursor-grab snap-x snap-mandatory gap-2 overflow-x-auto pb-1 select-none active:cursor-grabbing [scrollbar-width:thin]"
            >
              {cols.map((col, ci) => (
                <div key={`col-${ci}`} className="flex shrink-0 snap-start flex-col gap-2">
                  {col.map((sp) => {
                    const active = sprite === sp.id;
                    return (
                      <button
                        key={sp.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={sp.name}
                        onClick={() => setSprite(sp.id)}
                        className={`relative flex w-24 flex-col items-center gap-1 rounded-lg border px-1.5 pb-1.5 pt-4 transition-colors ${
                          active
                            ? 'border-[var(--sim-accent-hover)] bg-[var(--sim-accent-tint)] shadow-[0_0_0_1px_var(--sim-accent-glow-strong)]'
                            : 'border-[var(--sim-line-strong)] bg-[var(--sim-inset-strong)] hover:border-[var(--sim-line-hover)]'
                        }`}
                      >
                        {active ? (
                          <span className="absolute right-1 top-1 rounded bg-[var(--sim-accent-hover)] px-1 py-px text-[10px] font-bold leading-none text-white">
                            выбран
                          </span>
                        ) : null}
                        <img src={sp.src} alt="" className="h-14 w-auto object-contain sm:h-16" draggable={false} />
                        <span
                          className={`w-full truncate text-center text-[11px] font-medium ${
                            active ? 'text-[var(--sim-accent-text)]' : 'text-[var(--sim-text-soft)]'
                          }`}
                        >
                          {sp.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-[var(--sim-text-faint)]">
              Карусель крутится в стороны: тяните мышью, колесом или кнопками ‹ ›.
            </p>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between gap-3">
              <span id="entry-scale-label" className="text-sm font-semibold text-[var(--sim-text)]">
                Размер
              </span>
              <span className="text-sm tabular-nums text-[var(--sim-text-soft)]">{scale}%</span>
            </div>
            <Slider
              value={[scale]}
              min={60}
              max={100}
              step={1}
              aria-labelledby="entry-scale-label"
              onValueChange={(vals) => {
                const next = vals[0];
                if (typeof next === 'number') setScale(next);
              }}
              className="py-1 [&_[data-slot=slider-range]]:bg-[var(--sim-accent-hover)] [&_[data-slot=slider-thumb]]:border-[var(--sim-accent-hover)] [&_[data-slot=slider-thumb]]:bg-zinc-100 [&_[data-slot=slider-track]]:bg-[var(--sim-line-strong)]"
            />
            <p className="mt-1.5 text-xs text-[var(--sim-text-faint)]">Рост модельки в процентах от высоты клетки. 100% — в полный рост.</p>
          </div>
        </section>

        {/* Средний блок: записанный выбор СП — стрела, дамаг, броня. Значения обновляются
            сразу при выборе; ✓ отмечает уже подтверждённые пункты. */}
        <section
          aria-label="Выбор СП"
          className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4"
        >
          <p className="text-[13px] leading-relaxed text-[var(--sim-text)]">
            <span className="font-bold">Выбор СП:</span> стрела <SpVal done={speedDone}>{fmtSec(speedVal)}</SpVal>, дамаг{' '}
            <SpVal done={damageDone}>{damageLevelLabel(damageVal)}</SpVal>, броня{' '}
            <SpVal done={armorDone}>{damageLevelLabel(armorVal)}</SpVal>
          </p>
          <p className="mt-2 text-[11px] leading-snug text-[var(--sim-text-faint)]">
            Значения берутся из блока справа и применяются к вам на поле. ✓ — пункт подтверждён.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={doneCount === 3}
            aria-label="Использовать предыдущие скрытые параметры"
            className="mt-3 h-9 w-full bg-[var(--sim-accent)] text-xs font-bold text-black hover:bg-[var(--sim-accent-hover)] disabled:opacity-60"
            onClick={applyPrevSp}
          >
            {doneCount === 3 ? 'СП подтверждены' : 'Использовать предыдущие СП'}
          </Button>
          <p className="mt-1.5 text-[11px] leading-snug text-[var(--sim-text-faint)]">
            Подтягивает выбор вашего прошлого входа ({fmtSec(prevSpRef.current.speed)},{' '}
            {damageLevelLabel(prevSpRef.current.damage)}, {damageLevelLabel(prevSpRef.current.armor)}) и
            подтверждает все три пункта разом.
          </p>
        </section>

        {/* Блок 2: скрытые параметры, каждый пункт подтверждается */}
        <section aria-label="Скрытые параметры" className="rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] p-4">
          <h2 className="text-base font-bold text-[var(--sim-text)]">Скрытые параметры</h2>
          <p className="mt-1 text-xs text-[var(--sim-text-muted)]">
            Применяются к вам на поле. Каждый пункт нужно подтвердить — подтверждается то, что сейчас выставлено.
          </p>

          <div className="mt-3 flex flex-col gap-3">
            <ParamCard
              title="Скорость стрелы"
              status={fmtSec(speedVal)}
              done={speedDone}
              onConfirm={() => {
                onApplySpeed(speedVal);
                setSpeedOk(speedVal);
              }}
            >
              <div className="flex items-center gap-3">
                <Slider
                  value={[speedVal]}
                  min={1.8}
                  max={5}
                  step={0.1}
                  aria-label="Период оборота стрелы"
                  onValueChange={(vals) => {
                    const v = vals[0];
                    if (typeof v === 'number') setSpeedVal(Math.round(v * 10) / 10);
                  }}
                  className="flex-1 py-1 [&_[data-slot=slider-range]]:bg-[var(--sim-accent-hover)] [&_[data-slot=slider-thumb]]:border-[var(--sim-accent-hover)] [&_[data-slot=slider-thumb]]:bg-zinc-100 [&_[data-slot=slider-track]]:bg-[var(--sim-line-strong)]"
                />
                <span className="w-16 text-right text-sm tabular-nums text-[var(--sim-text-soft)]">{fmtSec(speedVal)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {SPEED_PRESETS.map((v) => (
                  <Chip key={v} active={Math.abs(speedVal - v) < 0.05} onClick={() => setSpeedVal(v)}>
                    {String(v).replace('.', ',')} сек
                  </Chip>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-snug text-[var(--sim-text-faint)]">
                Период оборота стрелы: 1,8 сек — крутится быстро, 5 сек — медленно. Как «Скорость вращения» в настройках.
              </p>
            </ParamCard>

            <ParamCard
              title="Дамаг"
              status={damageLevelLabel(damageVal)}
              done={damageDone}
              onConfirm={() => {
                onApplyDamage(damageVal);
                setDamageOk(damageVal);
              }}
            >
              <div className="flex flex-wrap gap-1">
                {DAMAGE_LEVELS.map((k) => (
                  <Chip key={k} active={damageVal === k} onClick={() => setDamageVal(k)}>
                    {damageLevelLabel(k)}
                  </Chip>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-snug text-[var(--sim-text-faint)]">
                Урон игрока: горло получает {throatDamageFor(damageVal)}% при пресете {damageLevelLabel(damageVal)}, остальные зоны —
                пропорционально своим базам.
              </p>
            </ParamCard>

            <ParamCard
              title="Броня"
              status={damageLevelLabel(armorVal)}
              done={armorDone}
              onConfirm={() => {
                onApplyArmor(armorVal);
                setArmorOk(armorVal);
              }}
            >
              <div className="flex flex-wrap gap-1">
                {DAMAGE_LEVELS.map((k) => (
                  <Chip key={k} active={armorVal === k} onClick={() => setArmorVal(k)}>
                    {damageLevelLabel(k)}
                  </Chip>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] leading-snug text-[var(--sim-text-faint)]">
                Броня режет получаемый урон: при {damageLevelLabel(armorVal)} по вам проходит{' '}
                {Math.round(armorLevelMultiplier(armorVal) * 100)}% урона.
              </p>
            </ParamCard>
          </div>
        </section>
      </div>

      {/* Выбор комнаты открывается ниже, когда имя введено и все пункты подтверждены */}
      <section aria-label="Выбор комнаты" className="mt-4">
        {roomsOpen ? (
          <RoomPicker
            rows={roomRows}
            ready={roomsReady}
            stale={roomsStale}
            embedded
            onPick={(id) => onPickRoom(id, { name: trimmed, sprite, scale })}
          />
        ) : (
          <div className="rounded-xl border border-dashed border-[var(--sim-line-strong)] bg-[var(--sim-inset)] px-4 py-6 text-center">
            <p className="text-sm font-semibold text-[var(--sim-text-soft)]">Выбор комнаты пока закрыт</p>
            <p className="mt-1 text-xs text-[var(--sim-text-faint)]" role="status">
              {!trimmed
                ? 'Введите имя слева — без него на поле не пустят.'
                : `Подтвердите три скрытых параметра справа (${doneCount} из 3) — здесь откроется выбор комнаты.`}
            </p>
          </div>
        )}
      </section>

      {/* Предисловие внизу страницы */}
      <footer className="mt-6 text-center">
        <p className="text-[11px] leading-snug text-[var(--sim-text-faint)]">{GAME_CREDITS}</p>
      </footer>
    </div>
  );
}
