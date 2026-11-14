/**
 * Сгенерированная шапка профиля (спека 2026-11-14): пиксельный ночной пейзаж
 * 120×40, детерминированный от seed (accountId) — у каждого игрока свой и не
 * меняется между заходами. Чистая функция без DOM: RGBA-байты; рисование в
 * canvas — paintPixels (nearest-neighbour, ×10 → 1200×400 для загрузки).
 */

export const BANNER_W = 120;
export const BANNER_H = 40;

type RGB = readonly [number, number, number];

type Palette = {
  skyTop: RGB;
  skyLow: RGB;
  far: RGB;
  mid: RGB;
  near: RGB;
  moon: RGB;
  star: RGB;
  flowers: readonly RGB[];
};

const PALETTES: readonly Palette[] = [
  // Сиреневая ночь (как макет владелицы)
  { skyTop: [14, 12, 40], skyLow: [92, 70, 140], far: [58, 48, 98], mid: [36, 32, 70], near: [20, 18, 42], moon: [250, 228, 160], star: [236, 230, 255], flowers: [[214, 140, 220], [168, 120, 240], [250, 190, 230]] },
  // Глубокая синяя
  { skyTop: [6, 14, 36], skyLow: [44, 92, 138], far: [32, 64, 96], mid: [20, 42, 68], near: [10, 24, 40], moon: [236, 242, 255], star: [220, 236, 255], flowers: [[120, 200, 240], [180, 160, 250], [240, 240, 200]] },
  // Сумерки с розовым горизонтом
  { skyTop: [22, 14, 44], skyLow: [170, 92, 132], far: [96, 56, 96], mid: [58, 34, 70], near: [30, 18, 40], moon: [255, 236, 200], star: [255, 230, 240], flowers: [[255, 170, 200], [240, 120, 160], [255, 220, 150]] },
  // Лесная полночь
  { skyTop: [8, 18, 28], skyLow: [52, 96, 104], far: [34, 66, 70], mid: [20, 44, 46], near: [10, 26, 26], moon: [240, 250, 220], star: [220, 255, 236], flowers: [[200, 240, 140], [250, 210, 120], [180, 150, 240]] },
];

/** FNV-1a → 32-битное зерно. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mix = (a: RGB, b: RGB, t: number): RGB => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

const BAYER = [0, 2, 3, 1];

/** Сидящий кот-силуэт 5×6 (1 — закрашено), смотрит вправо. */
const CAT = ['1.1..', '111..', '111..', '1111.', '11111', '1111.'];
/** Арка руин 9×7. */
const RUIN = ['1.11111.1', '1.11111.1', '111...111', '11.....11', '11.....11', '11.....11', '11.....11'];
/** Замок 11×8. */
const CASTLE = ['1.1.....1.1', '111..1..111', '111.111.111', '111.111.111', '11111111111', '11111111111', '11111111111', '11111111111'];

export function generateBanner(seed: string): Uint8ClampedArray {
  const rnd = mulberry32(hashSeed(seed || 'wanderpaws'));
  const ri = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pal = PALETTES[Math.floor(rnd() * PALETTES.length)];
  const px = new Uint8ClampedArray(BANNER_W * BANNER_H * 4);

  const set = (x: number, y: number, c: RGB) => {
    if (x < 0 || y < 0 || x >= BANNER_W || y >= BANNER_H) return;
    const i = (y * BANNER_W + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = 255;
  };
  const get = (x: number, y: number): RGB => {
    const i = (y * BANNER_W + x) * 4;
    return [px[i], px[i + 1], px[i + 2]];
  };
  const stamp = (rows: readonly string[], ox: number, oy: number, c: RGB) => {
    rows.forEach((row, dy) => {
      for (let dx = 0; dx < row.length; dx++) if (row[dx] === '1') set(ox + dx, oy + dy, c);
    });
  };

  // 1. Небо: градиент с упорядоченным дизерингом (4 ступени на полосу).
  const horizon = 30;
  for (let y = 0; y < BANNER_H; y++) {
    const t = Math.min(1, y / horizon);
    for (let x = 0; x < BANNER_W; x++) {
      const d = (BAYER[(y % 2) * 2 + (x % 2)] / 4 - 0.375) / 8;
      const tq = Math.round(Math.max(0, Math.min(1, t + d)) * 8) / 8;
      set(x, y, mix(pal.skyTop, pal.skyLow, tq));
    }
  }

  // 2. Звёзды.
  const stars = ri(55, 95);
  for (let s = 0; s < stars; s++) {
    const x = ri(0, BANNER_W - 1);
    const y = ri(0, 22);
    const k = 0.35 + rnd() * 0.65 * (1 - y / 30);
    set(x, y, mix(get(x, y), pal.star, k));
    if (rnd() < 0.08 && y > 0 && y < 21) {
      const soft = mix(get(x, y - 1), pal.star, k * 0.5);
      set(x - 1, y, soft);
      set(x + 1, y, soft);
      set(x, y - 1, soft);
      set(x, y + 1, soft);
    }
  }

  // 3. Луна с ореолом; серп или полная.
  const mx = ri(12, BANNER_W - 13);
  const my = ri(5, 10);
  const mr = ri(3, 5);
  for (let y = my - mr - 4; y <= my + mr + 4; y++) {
    for (let x = mx - mr - 4; x <= mx + mr + 4; x++) {
      if (x < 0 || y < 0 || x >= BANNER_W || y >= BANNER_H) continue;
      const d = Math.hypot(x - mx, y - my);
      if (d > mr && d <= mr + 4) set(x, y, mix(get(x, y), pal.moon, 0.12 * (mr + 4 - d) / 4 + 0.04));
    }
  }
  const crescent = rnd() < 0.6;
  const cx = mx + (rnd() < 0.5 ? -1 : 1) * Math.max(2, Math.round(mr * 0.6));
  const cy = my - 1;
  for (let y = my - mr; y <= my + mr; y++) {
    for (let x = mx - mr; x <= mx + mr; x++) {
      if (Math.hypot(x - mx, y - my) > mr + 0.3) continue;
      if (crescent && Math.hypot(x - cx, y - cy) <= mr + 0.3) continue;
      set(x, y, Math.hypot(x - mx - 1, y - my - 1) < mr * 0.35 ? mix(pal.moon, pal.skyLow, 0.18) : pal.moon);
    }
  }

  // 4. Холмы: три слоя высот (сумма синусов).
  const ridge = (base: number, amp: number) => {
    const f1 = 0.03 + rnd() * 0.04;
    const f2 = 0.08 + rnd() * 0.08;
    const p1 = rnd() * Math.PI * 2;
    const p2 = rnd() * Math.PI * 2;
    return Array.from({ length: BANNER_W }, (_, x) =>
      Math.round(base + amp * Math.sin(x * f1 + p1) + amp * 0.45 * Math.sin(x * f2 + p2)),
    );
  };
  const fill = (h: number[], c: RGB) => {
    for (let x = 0; x < BANNER_W; x++) for (let y = Math.max(0, h[x]); y < BANNER_H; y++) set(x, y, c);
  };

  const far = ridge(25, 2.5);
  fill(far, pal.far);
  // Силуэт вдали: руины или замок на дальнем холме.
  const landmark = rnd() < 0.5 ? RUIN : CASTLE;
  const lx = ri(6, BANNER_W - 6 - landmark[0].length);
  const lBase = Math.min(...far.slice(lx, lx + landmark[0].length));
  stamp(landmark, lx, lBase - landmark.length + 1, mix(pal.far, pal.near, 0.45));

  const mid = ridge(30, 2.5);
  fill(mid, pal.mid);
  // Ели на среднем холме.
  const trees = ri(5, 10);
  for (let t = 0; t < trees; t++) {
    const tx = ri(0, BANNER_W - 1);
    const th = ri(4, 8);
    const ty = mid[tx];
    for (let k = 0; k < th; k++) {
      const half = Math.floor((k * 3) / th);
      for (let dx = -half; dx <= half; dx++) set(tx + dx, ty - th + k + 1, mix(pal.mid, pal.near, 0.6));
    }
  }

  const near = ridge(35, 1.6);
  fill(near, pal.near);

  // 5. Кусты с цветами в нижних углах.
  const bush = (from: number, to: number) => {
    for (let b = 0; b < 4; b++) {
      const bx = ri(from, to);
      const by = ri(34, 38);
      const br = ri(2, 4);
      for (let y = by - br; y <= by + br; y++) {
        for (let x = bx - br - 1; x <= bx + br + 1; x++) {
          if (Math.hypot((x - bx) * 0.8, y - by) <= br) set(x, y, mix(pal.near, pal.mid, 0.35));
        }
      }
      const dots = ri(3, 6);
      for (let d = 0; d < dots; d++) {
        set(bx + ri(-br, br), by + ri(-br, 0), pal.flowers[ri(0, pal.flowers.length - 1)]);
      }
    }
  };
  bush(0, 16);
  bush(BANNER_W - 17, BANNER_W - 1);

  // 6. Кот-силуэт на ближнем холме — смотрит на луну.
  const catX = ri(24, BANNER_W - 30);
  const catY = Math.min(...near.slice(catX, catX + 5)) - CAT.length;
  const flip = mx < catX;
  stamp(flip ? CAT.map((r) => r.split('').reverse().join('')) : CAT, catX, catY, mix(pal.near, [0, 0, 0], 0.4));

  return px;
}

/** Нарисовать RGBA 120×40 в ctx с целым масштабом, без сглаживания. */
export function paintPixels(ctx: CanvasRenderingContext2D, rgba: Uint8ClampedArray, scale: number): void {
  for (let y = 0; y < BANNER_H; y++) {
    for (let x = 0; x < BANNER_W; x++) {
      const i = (y * BANNER_W + x) * 4;
      ctx.fillStyle = `rgba(${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},${rgba[i + 3] / 255})`;
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
}
