"use client";

/**
 * Курсор-лапка, поворачивающаяся по направлению движения мыши.
 *
 * ОС-курсор нельзя повернуть через CSS-transform: браузер рисует картинку
 * курсора как есть. Поэтому при загрузке строим 16 повёрнутых вариантов
 * лапки (public/lapka.svg) как inline SVG data-URL. Общая точка поворота
 * совпадает с хотспотом статичной лапки — центром большой подушечки
 * (16 22 в 32px-картинке): лапка «стоит» под указателем, а пальцы
 * смотрят туда, куда мышь ведут. Направление квантуется в корзины по
 * 22.5°; после короткой остановки лапка возвращается в нейтраль.
 *
 * Картинки живут в CSS-переменной --paw-cursor на <html>; правила курсора
 * в globals.css и players-elyria.module.css подставляют её с фолбэком на
 * статичную /lapka.svg — до инициализации, при prefers-reduced-motion и
 * без JS остаётся прежняя статичная лапка.
 */

import { useEffect } from "react";

const STEPS = 16; // корзины поворота, по 22.5°
const IDLE_MS = 400; // мышь стоит — лапка расслабляется в нейтраль
const MIN_DISTANCE_PX = 2; // суб-пиксельное дрожание руки направлением не считаем

// Геометрия lapka.svg: viewBox 100×100 отрисован в 32px (масштаб 0.32),
// хотспот 16 22 указывает в центр большой подушечки — вокруг него и
// вращаем, точка контакта лапки с указателем не смещается.
const PIVOT_X = 50;
const PIVOT_Y = 68.75;
const PX_PER_UNIT = 0.32;

// Коробка одного варианта: контент лапки лежит в радиусе ~58 единиц от оси,
// полкоробки 64 единицы дают запас под любой поворот. Хотспот каждого
// варианта — центр картинки (20 20 в 41px).
const HALF_UNITS = 64;
const SIDE_PX = Math.round(HALF_UNITS * 2 * PX_PER_UNIT);
const HOT_PX = Math.round(HALF_UNITS * PX_PER_UNIT);

/** Строит STEPS вариантов курсора: url("data:image/svg+xml,…") x y. */
async function buildPawVariants(): Promise<string[]> {
  const res = await fetch("/lapka.svg");
  if (!res.ok) throw new Error(`lapka fetch: ${res.status}`);
  const src = await res.text();
  const inner = src.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const fill = src.match(/\bfill="([^"]+)"/)?.[1] ?? "#fff6e8";
  const variants: string[] = [];
  for (let i = 0; i < STEPS; i++) {
    const doc =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE_PX}" height="${SIDE_PX}" ` +
      `viewBox="${PIVOT_X - HALF_UNITS} ${PIVOT_Y - HALF_UNITS} ${HALF_UNITS * 2} ${HALF_UNITS * 2}" ` +
      `fill="${fill}">` +
      `<g transform="rotate(${(i * 360) / STEPS} ${PIVOT_X} ${PIVOT_Y})">${inner}</g>` +
      `</svg>`;
    variants.push(`url("data:image/svg+xml,${encodeURIComponent(doc)}") ${HOT_PX} ${HOT_PX}`);
  }
  return variants;
}

export function PawCursor() {
  useEffect(() => {
    // prefers-reduced-motion: повороты курсора не включаем — остаётся статичная лапка (фолбэк CSS).
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const root = document.documentElement;
    let variants: string[] = [];
    let applied = -1;
    let idleTimer: number | undefined;
    let lastX = 0;
    let lastY = 0;
    let hasLast = false;

    const apply = (bucket: number) => {
      if (variants.length === 0 || bucket === applied) return;
      applied = bucket;
      root.style.setProperty("--paw-cursor", variants[bucket]);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerType === "touch") return; // на тач-движении курсора нет
      if (!hasLast) {
        lastX = ev.clientX;
        lastY = ev.clientY;
        hasLast = true;
        return;
      }
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (dx * dx + dy * dy < MIN_DISTANCE_PX * MIN_DISTANCE_PX) return;
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => apply(0), IDLE_MS);
      if (variants.length === 0) return;
      // 0° = лапка вверх, 90° = вправо (экранная ось Y смотрит вниз).
      const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      const bucket = ((Math.round(deg / (360 / STEPS)) % STEPS) + STEPS) % STEPS;
      // pointermove уже выровнен с кадром отрисовки — доп rAF не нужен.
      apply(bucket);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    buildPawVariants()
      .then((v) => {
        variants = v;
      })
      .catch(() => {
        /* фетч лапки не удался — продолжаем со статичным курсором */
      });

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.clearTimeout(idleTimer);
      root.style.removeProperty("--paw-cursor");
    };
  }, []);
  return null;
}
