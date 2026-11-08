'use client';

import { useEffect, useState } from 'react';

/**
 * Звёздный фон ночных страниц: детерминированные звёзды, одинаковые на сервере
 * и клиенте. Вынесен из wander-gate.tsx (главное меню) как переиспользуемый
 * блок — тот же массив и те же классы/стили: на меню звёзды остаются у
 * .wander-sky, на контентных страницах их кладут в fixed-обёртку .star-backdrop
 * за контентом (z ниже панелей, pointer-events:none).
 *
 * Рендерит ТОЛЬКО спаны звёзд — компонент не добавляет DOM-узлов, поэтому
 * замена инлайн-блока в NightSky бит-в-бит сохраняет прежнюю разметку.
 * Звёзды появляются после гидрации: сервер и браузер по-разному округляют
 * числа в inline style, поэтому пустой первый кадр — нарочно.
 */

/** Детерминированные звёзды: сервер и клиент рисуют одни и те же точки. */
const rnd = (seed: number) => {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

const STARS = Array.from({ length: 72 }, (_, i) => ({
  left: rnd(i + 11) * 100,
  top: rnd(i + 90) * 78,
  size: 1.2 + rnd(i + 140) * 2.4,
  dur: 1.8 + rnd(i + 200) * 3.6,
  delay: -rnd(i + 260) * 6,
  spark: rnd(i + 310) > 0.82,
}));

export function StarBackdrop() {
  // Звёзды только после гидрации: сервер округляет style иначе, чем клиент.
  const [starsOn, setStarsOn] = useState(false);
  useEffect(() => setStarsOn(true), []);
  return starsOn
    ? STARS.map((star, i) => (
        <span
          key={i}
          className={star.spark ? 'wander-star wander-spark' : 'wander-star'}
          style={{
            left: `${star.left}%`,
            top: `${star.top}%`,
            width: star.size,
            height: star.size,
            animationDuration: `${star.dur}s`,
            animationDelay: `${star.delay}s`,
          }}
        />
      ))
    : null;
}
