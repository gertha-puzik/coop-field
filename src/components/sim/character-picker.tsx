'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { SPRITES, type SpriteId } from '@/lib/sim/settings';

export type CharacterChoice = {
  sprite: SpriteId;
  name: string;
  scale: number;
};

/**
 * Первый экран: спрайт, имя и размер. Пока выбор не подтверждён,
 * поле не показывается и в комнату никто не заходит.
 */
export function CharacterPicker({
  initialSprite,
  initialName,
  initialScale,
  onConfirm,
}: {
  initialSprite: SpriteId;
  initialName: string;
  initialScale: number;
  onConfirm: (choice: CharacterChoice) => void;
}) {
  const [sprite, setSprite] = useState<SpriteId>(initialSprite);
  const [name, setName] = useState(initialName);
  const [scale, setScale] = useState(initialScale);
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  const submit = () => {
    if (!trimmed) {
      setError('Введите имя — пустое на поле не пускает.');
      return;
    }
    setError(null);
    onConfirm({
      sprite,
      name: trimmed.slice(0, 24),
      scale: Math.min(100, Math.max(60, Math.round(scale))),
    });
  };

  return (
    <form
      className="relative z-10 flex h-dvh min-h-0 flex-col bg-transparent text-[var(--sim-text)]"
      onSubmit={(ev) => {
        ev.preventDefault();
        submit();
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-5 sm:px-6 sm:py-8">
          <header>
            <h1 className="text-xl font-bold leading-tight">Общее поле</h1>
            <p className="mt-1 text-sm text-[var(--sim-text-muted)]">Выберите кота, имя и размер. На поле попадёте после подтверждения.</p>
          </header>

          <section>
            <h2 className="mb-2 text-sm font-semibold text-[var(--sim-text)]">Спрайт</h2>
            <div role="radiogroup" aria-label="Спрайт персонажа" className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
              {SPRITES.map((sp) => {
                const active = sprite === sp.id;
                return (
                  <button
                    key={sp.id}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={sp.name}
                    onClick={() => setSprite(sp.id)}
                    className={`relative flex flex-col items-center gap-1 rounded-lg border px-1.5 pb-2 pt-5 transition-colors ${
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
                    <img src={sp.src} alt="" className="h-16 w-auto object-contain sm:h-20" draggable={false} />
                    <span className={`w-full truncate text-center text-[11px] font-medium ${active ? 'text-[var(--sim-accent-text)]' : 'text-[var(--sim-text-soft)]'}`}>
                      {sp.name}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <label className="flex flex-col gap-1.5" htmlFor="character-name">
            <span className="text-sm font-semibold text-[var(--sim-text)]">Имя</span>
            <Input
              id="character-name"
              value={name}
              maxLength={24}
              autoComplete="nickname"
              placeholder="Как вас видеть на поле"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'character-name-error' : 'character-name-hint'}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              className="h-10 border-[var(--sim-line-strong)] bg-[var(--sim-input-bg)] text-[var(--sim-text)] placeholder:text-[var(--sim-text-faint)]"
            />
            {error ? (
              <span id="character-name-error" className="text-xs text-[var(--sim-danger)]" role="alert">
                {error}
              </span>
            ) : (
              <span id="character-name-hint" className="text-xs text-[var(--sim-text-faint)]">
                Обязательное поле. Пустое имя на поле не пускает.
              </span>
            )}
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <span id="character-scale-label" className="text-sm font-semibold text-[var(--sim-text)]">
                Размер
              </span>
              <span className="text-sm tabular-nums text-[var(--sim-text-soft)]">{scale}%</span>
            </div>
            <Slider
              value={[scale]}
              min={60}
              max={100}
              step={1}
              aria-labelledby="character-scale-label"
              onValueChange={(vals) => {
                const next = vals[0];
                if (typeof next === 'number') setScale(next);
              }}
              className="py-1 [&_[data-slot=slider-range]]:bg-[var(--sim-accent-hover)] [&_[data-slot=slider-thumb]]:border-[var(--sim-accent-hover)] [&_[data-slot=slider-thumb]]:bg-zinc-100 [&_[data-slot=slider-track]]:bg-[var(--sim-line-strong)]"
            />
            <p className="mt-1.5 text-xs text-[var(--sim-text-faint)]">Рост модельки в процентах от высоты клетки. 100% — в полный рост.</p>
          </div>
        </div>
      </div>

      <div className="shrink-0 border-t border-[var(--sim-line)] bg-[var(--sim-panel)] px-4 py-3 sm:px-6">
        <div className="mx-auto w-full max-w-3xl">
          <Button type="submit" className="h-11 w-full bg-[var(--sim-accent)] text-base text-white hover:bg-[var(--sim-accent-hover)]">
            На поле
          </Button>
        </div>
      </div>
    </form>
  );
}
