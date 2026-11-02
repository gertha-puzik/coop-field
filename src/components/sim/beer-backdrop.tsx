'use client';

import { useEffect, useRef } from 'react';

/**
 * Живой фон «Пивной» темы на канвасе:
 *  - тёплые пятна света медленно дрейфуют (эффект света через бокал);
 *  - пузырьки всплывают тремя слоями глубины с покачиванием и параллаксом;
 *  - у «поверхности» (верх экрана) пузырьки лопаются с колечком;
 *  - пузырьки разбегаются от курсора и увлекаются его движением: чем быстрее
 *    мышь, тем сильнее «взмах», а на резком движении у курсора взбивается
 *    пена из мелких брызг;
 *  - компактное тёплое свечение движется за курсором мгновенно;
 *  - внизу — две полупрозрачные волны пены.
 *
 * Канвас pointer-events-none, мышь слушаем на window: клики и жесты игры
 * не перекрываются. При prefers-reduced-motion рисуется один статичный кадр.
 */

type Bubble = {
  bx: number; // базовый X (колебание и параллакс прибавляются отдельно)
  y: number;
  r: number;
  vy: number; // скорость всплытия, px/с
  wob: number; // фаза покачивания
  wobV: number;
  amp: number; // амплитуда покачивания, px
  vx: number; // горизонтальная скорость от мыши, px/с
  layer: number; // 0 — дальний, 1 — средний, 2 — ближний
};

type Ring = { x: number; y: number; r: number; life: number };

type Foam = { x: number; y: number; vx: number; vy: number; r: number; life: number };

type Blob = {
  ux: number; // базовый центр, доли ширины/высоты
  uy: number;
  rx: number; // радиус дрейфа, доли размера
  ry: number;
  sx: number; // скорость дрейфа, рад/с
  sy: number;
  px: number; // фаза
  py: number;
  r: number; // радиус пятна, доли min(w, h)
  rgb: string;
  a: number;
};

const LAYERS = [
  { count: 16, rMin: 1.5, rMax: 3.2, vMin: 9, vMax: 18, alpha: 0.32, para: 8 },
  { count: 12, rMin: 3, rMax: 6, vMin: 18, vMax: 30, alpha: 0.5, para: 18 },
  { count: 8, rMin: 6, rMax: 11, vMin: 30, vMax: 46, alpha: 0.75, para: 32 },
];

const BLOBS: Blob[] = [
  { ux: 0.2, uy: 0.14, rx: 0.09, ry: 0.06, sx: 0.13, sy: 0.09, px: 0, py: 0, r: 0.52, rgb: '245, 178, 68', a: 0.1 },
  { ux: 0.82, uy: 0.76, rx: 0.07, ry: 0.08, sx: 0.07, sy: 0.11, px: 1.3, py: 0.4, r: 0.58, rgb: '217, 119, 6', a: 0.11 },
  { ux: 0.55, uy: 0.42, rx: 0.11, ry: 0.05, sx: 0.05, sy: 0.13, px: 2.1, py: 1.1, r: 0.66, rgb: '253, 224, 141', a: 0.06 },
];

const TAU = Math.PI * 2;
const GLOW_R = 105; // компактное свечение у курсора

export function BeerBackdrop() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let w = 0;
    let h = 0;
    let raf = 0;
    let t = 0;

    const mouse = { x: -9999, y: -9999, px: -9999, py: -9999, on: false };
    const vel = { x: 0, y: 0 }; // сглаженная скорость мыши, px/с
    const bubbles: Bubble[] = [];
    const rings: Ring[] = [];
    const foam: Foam[] = [];

    const resize = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = window.innerWidth;
      h = window.innerHeight;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const spawn = (b: Bubble, first: boolean) => {
      const L = LAYERS[b.layer];
      b.bx = Math.random() * w;
      b.y = first ? Math.random() * h : h + 16 + Math.random() * 60;
      b.r = L.rMin + Math.random() * (L.rMax - L.rMin);
      b.vy = L.vMin + Math.random() * (L.vMax - L.vMin);
      b.wob = Math.random() * TAU;
      b.wobV = 0.8 + Math.random() * 1.6;
      b.amp = 4 + Math.random() * 14;
      b.vx = 0;
    };

    resize();
    for (let l = 0; l < LAYERS.length; l++) {
      for (let i = 0; i < LAYERS[l].count; i++) {
        const b: Bubble = { bx: 0, y: 0, r: 0, vy: 0, wob: 0, wobV: 0, amp: 0, vx: 0, layer: l };
        spawn(b, true);
        bubbles.push(b);
      }
    }

    const step = (dt: number) => {
      t += dt;

      // Скорость мыши: мгновенная за кадр → сглаженная (взмах затухает мягко).
      if (mouse.px > -9000) {
        const ivx = (mouse.x - mouse.px) / dt;
        const ivy = (mouse.y - mouse.py) / dt;
        const k = Math.min(1, dt * 12);
        vel.x += (ivx - vel.x) * k;
        vel.y += (ivy - vel.y) * k;
      }
      mouse.px = mouse.x;
      mouse.py = mouse.y;
      const speed = Math.hypot(vel.x, vel.y);

      const nx = mouse.on ? (mouse.x - w / 2) / w : 0; // параллакс от мыши

      for (const b of bubbles) {
        b.wob += b.wobV * dt;
        b.y -= b.vy * dt;

        if (mouse.on) {
          const x = b.bx + Math.sin(b.wob) * b.amp;
          const dx = x - mouse.x;
          const dy = b.y - mouse.y;
          const d2 = dx * dx + dy * dy;

          // Разбегание от курсора, как пена от помешивания.
          const R = 120 + b.layer * 45;
          if (d2 < R * R && d2 > 0.01) {
            const d = Math.sqrt(d2);
            const f = (1 - d / R) * (140 + b.layer * 90);
            b.vx += (dx / d) * f * dt;
            const cap = 90 + b.layer * 60;
            if (b.vx > cap) b.vx = cap;
            if (b.vx < -cap) b.vx = -cap;
          }

          // Увлечение движением: быстрый взмах гонит пузыри за мышью.
          if (speed > 60) {
            const R2 = 250 + b.layer * 40;
            if (d2 < R2 * R2 && d2 > 0.01) {
              const d = Math.sqrt(d2);
              const fall = 1 - d / R2;
              b.vx += vel.x * fall * dt * 1.5;
              b.y += vel.y * fall * dt * 0.3;
              const cap = 200 + b.layer * 90;
              if (b.vx > cap) b.vx = cap;
              if (b.vx < -cap) b.vx = -cap;
            }
          }
        }
        b.vx *= Math.pow(0.88, dt * 60);
        b.bx += b.vx * dt;
        if (b.bx < -30) b.bx = w + 29;
        if (b.bx > w + 30) b.bx = -29;

        if (b.y < h * 0.07 - b.r) {
          // У «поверхности» пузырёк лопается: колечко + новый снизу.
          const x = b.bx + Math.sin(b.wob) * b.amp;
          if (rings.length < 24) rings.push({ x, y: Math.max(h * 0.07, b.y), r: b.r + 2, life: 1 });
          spawn(b, false);
        }
      }

      // Взбитая пена: на быстром движении курсора рождаются мелкие брызги.
      if (mouse.on && speed > 420) {
        const p = Math.min(0.85, (speed - 380) / 2200);
        if (Math.random() < p && foam.length < 46) {
          foam.push({
            x: mouse.x + (Math.random() - 0.5) * 30,
            y: mouse.y + (Math.random() - 0.5) * 30,
            vx: vel.x * 0.14 + (Math.random() - 0.5) * 50,
            vy: vel.y * 0.1 - 24 - Math.random() * 46,
            r: 0.8 + Math.random() * 1.9,
            life: 1,
          });
        }
      }
      for (let i = foam.length - 1; i >= 0; i--) {
        const f = foam[i];
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.vy += 14 * dt; // брызги чуть тяжелеют и оседают
        f.vx *= Math.pow(0.9, dt * 60);
        f.life -= 1.7 * dt;
        if (f.life <= 0) foam.splice(i, 1);
      }

      for (let i = rings.length - 1; i >= 0; i--) {
        const g = rings[i];
        g.r += 55 * dt;
        g.life -= 1.9 * dt;
        if (g.life <= 0) rings.splice(i, 1);
      }

      return nx;
    };

    const drawBlobs = () => {
      ctx.globalCompositeOperation = 'lighter';
      for (const bl of BLOBS) {
        const cx = (bl.ux + Math.sin(t * bl.sx + bl.px) * bl.rx) * w;
        const cy = (bl.uy + Math.cos(t * bl.sy + bl.py) * bl.ry) * h;
        const rad = bl.r * Math.min(w, h);
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        g.addColorStop(0, `rgba(${bl.rgb}, ${bl.a})`);
        g.addColorStop(1, `rgba(${bl.rgb}, 0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      }
    };

    const drawCursorGlow = () => {
      if (!mouse.on || mouse.x < -100) return;
      // Мгновенно: рисуем строго в позиции курсора, без запаздывания.
      const g = ctx.createRadialGradient(mouse.x, mouse.y, 0, mouse.x, mouse.y, GLOW_R);
      g.addColorStop(0, 'rgba(253, 230, 168, 0.16)');
      g.addColorStop(0.5, 'rgba(245, 178, 68, 0.06)');
      g.addColorStop(1, 'rgba(245, 178, 68, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(mouse.x - GLOW_R, mouse.y - GLOW_R, GLOW_R * 2, GLOW_R * 2);
    };

    const drawBubbles = (nx: number) => {
      for (const b of bubbles) {
        const L = LAYERS[b.layer];
        const x = b.bx + Math.sin(b.wob) * b.amp - nx * L.para;
        const a = L.alpha;
        ctx.beginPath();
        ctx.arc(x, b.y, b.r, 0, TAU);
        ctx.fillStyle = `rgba(252, 224, 154, ${a * 0.55})`;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = `rgba(255, 240, 200, ${a})`;
        ctx.stroke();
        // Блик слева сверху — объём.
        ctx.beginPath();
        ctx.arc(x - b.r * 0.32, b.y - b.r * 0.32, Math.max(0.6, b.r * 0.3), 0, TAU);
        ctx.fillStyle = `rgba(255, 255, 255, ${a * 0.85})`;
        ctx.fill();
      }
    };

    const drawFoam = () => {
      for (const f of foam) {
        ctx.beginPath();
        ctx.arc(f.x, f.y, f.r, 0, TAU);
        ctx.fillStyle = `rgba(255, 248, 224, ${Math.max(0, f.life) * 0.8})`;
        ctx.fill();
      }
    };

    const drawRings = () => {
      for (const g of rings) {
        ctx.beginPath();
        ctx.arc(g.x, g.y, g.r, 0, TAU);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = `rgba(253, 230, 168, ${Math.max(0, g.life) * 0.45})`;
        ctx.stroke();
      }
    };

    const drawWaves = () => {
      const wave = (yBase: number, amp: number, ph: number, alpha: number) => {
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x <= w + 10; x += 10) {
          const y = yBase + Math.sin(x * 0.011 + ph) * amp + Math.sin(x * 0.023 - ph * 1.6) * amp * 0.6;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = `rgba(255, 244, 214, ${alpha})`;
        ctx.fill();
      };
      wave(h - 30, 8, t * 0.5, 0.05);
      wave(h - 16, 6, t * 0.35 + 2, 0.08);
    };

    const draw = (nx: number) => {
      ctx.clearRect(0, 0, w, h);
      drawBlobs();
      drawCursorGlow();
      drawBubbles(nx);
      drawFoam();
      drawRings();
      ctx.globalCompositeOperation = 'source-over';
      drawWaves();
    };

    if (reduced) {
      // Без движения: один спокойный кадр, без слушателей мыши и цикла.
      draw(0);
      const onResizeStatic = () => {
        resize();
        draw(0);
      };
      window.addEventListener('resize', onResizeStatic);
      return () => window.removeEventListener('resize', onResizeStatic);
    }

    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const nx = step(dt);
      draw(nx);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const onMove = (ev: PointerEvent) => {
      mouse.x = ev.clientX;
      mouse.y = ev.clientY;
      if (!mouse.on) {
        mouse.on = true;
        mouse.px = ev.clientX;
        mouse.py = ev.clientY;
        vel.x = 0;
        vel.y = 0;
      }
    };
    const onOut = (ev: PointerEvent) => {
      // Ушёл из окна — свечение гаснет, пузырьки успокаиваются.
      if (!ev.relatedTarget) {
        mouse.on = false;
        vel.x = 0;
        vel.y = 0;
      }
    };
    const onResize = () => resize();

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerout', onOut, { passive: true });
    window.addEventListener('resize', onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerout', onOut);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 h-full w-full" />;
}
