'use client';

import type { ThemeId } from '@/lib/sim/theme';
import { BeerBackdrop } from '@/components/sim/beer-backdrop';

/**
 * Декоративный слой под интерфейсом: в «Пивной» теме — живой канвас
 * (пузырьки, свет и пена, реагирующие на курсор), в «Ночной» мерцают
 * звёзды, в «Светлой» медленно плывут облака. Ничего не перехватывает
 * у мыши (pointer-events-none) и рисуется только в просветах между панелями.
 */

/** Детерминированный «рандом»: без него звёзды при каждом рендере прыгали бы. */
const rnd = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const STARS = Array.from({ length: 26 }, (_, i) => ({
  left: rnd(i + 200) * 99,
  top: rnd(i + 260) * 92,
  size: 1 + rnd(i + 320) * 1.8,
  dur: 2.2 + rnd(i + 380) * 3.4,
  delay: -rnd(i + 440) * 5,
}));

const CLOUDS = Array.from({ length: 6 }, (_, i) => ({
  left: rnd(i + 500) * 90 - 10,
  top: 4 + rnd(i + 560) * 70,
  w: 140 + rnd(i + 620) * 220,
  h: 46 + rnd(i + 680) * 50,
  dur: 34 + rnd(i + 740) * 30,
  delay: -rnd(i + 800) * 30,
  op: 0.35 + rnd(i + 860) * 0.3,
}));

export function ThemeBackdrop({ theme }: { theme: ThemeId }) {
  return (
    <div data-sim-backdrop aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {theme === 'beer' && <BeerBackdrop />}
      {theme === 'night' &&
        STARS.map((s, i) => (
          <span
            key={i}
            className="sim-star"
            style={{
              left: `${s.left}%`,
              top: `${s.top}%`,
              width: s.size,
              height: s.size,
              animationDuration: `${s.dur}s`,
              animationDelay: `${s.delay}s`,
            }}
          />
        ))}
      {theme === 'light' &&
        CLOUDS.map((c, i) => (
          <span
            key={i}
            className="sim-cloud"
            style={{
              left: `${c.left}%`,
              top: `${c.top}%`,
              width: c.w,
              height: c.h,
              opacity: c.op,
              animationDuration: `${c.dur}s`,
              animationDelay: `${c.delay}s`,
            }}
          />
        ))}
    </div>
  );
}
