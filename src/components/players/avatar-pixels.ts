/**
 * Картинка → RGBA-сетка w×h для пиксельного редактора аватарки (спека
 * 2026-11-14-avatar-crop-paint): центральный квадрат (cover), уменьшение
 * сглаживанием браузера. Не прочиталось (сеть, чужой origin) → null.
 */
export async function imageToPixels(url: string | null, w: number, h: number): Promise<Uint8ClampedArray | null> {
  if (!url) return null;
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = url;
    await img.decode();
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (!iw || !ih) return null;
    const side = Math.min(iw, ih);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, (iw - side) / 2, (ih - side) / 2, side, side, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null;
  }
}
