/**
 * Математика кадра шапки 3:1 (спека 2026-11-14). Координаты — в пикселях рамки:
 * off — положение левого-верхнего угла масштабированной картинки относительно
 * рамки (≤ 0, иначе открылся бы край). Без DOM — под unit-тест.
 */

export type Offset = { x: number; y: number };

/** Минимальный масштаб, при котором картинка целиком закрывает рамку. */
export function coverScale(imgW: number, imgH: number, frameW: number, frameH: number): number {
  return Math.max(frameW / imgW, frameH / imgH);
}

/** Сдвиг, при котором края картинки не заходят внутрь рамки. */
export function clampOffset(
  off: Offset,
  imgW: number,
  imgH: number,
  scale: number,
  frameW: number,
  frameH: number,
): Offset {
  const minX = Math.min(0, frameW - imgW * scale);
  const minY = Math.min(0, frameH - imgH * scale);
  return { x: Math.min(0, Math.max(minX, off.x)) || 0, y: Math.min(0, Math.max(minY, off.y)) || 0 };
}

/** Прямоугольник исходника (для drawImage), видимый в рамке. */
export function cropRect(
  off: Offset,
  scale: number,
  frameW: number,
  frameH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  return { sx: -off.x / scale, sy: -off.y / scale, sw: frameW / scale, sh: frameH / scale };
}
