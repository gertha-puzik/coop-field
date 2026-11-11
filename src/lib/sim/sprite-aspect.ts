/**
 * Кэш пропорций спрайтов для билбордов Элизии.
 *
 * WebGL часто получает текстуру окраса по URL раньше, чем HTMLImageElement
 * попадает в spritesRef (личный окрас / поздний ensureFieldSprite). Без кэша
 * aspectOf падает на 2/3: ландшафтный PNG растягивается в «портретный»
 * билборд — вытянутый силуэт. Кэш держит width/height по id и по URL, пока
 * картинка не доехала в обычный image-кэш поля.
 */

const byId = new Map<string, number>();
const byUrl = new Map<string, number>();

function isUrlKey(key: string): boolean {
  return key.includes("/") || /^https?:/i.test(key);
}

/** Запомнить aspect = width/height. id спрайта и URL текстуры — разные ключи. */
export function rememberSpriteAspect(idOrUrl: string, width: number, height: number): void {
  if (!idOrUrl || !(width > 0) || !(height > 0)) return;
  const aspect = width / height;
  if (!(aspect > 0) || !Number.isFinite(aspect)) return;
  if (isUrlKey(idOrUrl)) byUrl.set(idOrUrl, aspect);
  else byId.set(idOrUrl, aspect);
}

/** Живой img имеет приоритет и обновляет кэш; иначе id → url → 2/3. */
export function spriteAspectOf(
  id: string,
  img?: { width: number; height: number } | null,
  url?: string,
): number {
  if (img && img.height > 0 && img.width > 0) {
    const aspect = img.width / img.height;
    if (id) byId.set(id, aspect);
    if (url) byUrl.set(url, aspect);
    return aspect;
  }
  if (id && byId.has(id)) return byId.get(id)!;
  if (url && byUrl.has(url)) return byUrl.get(url)!;
  return 2 / 3;
}

/** Рост с провода → 60..100%, иначе 100 (старый size:3.2 / пустое поле). */
export function catScaleOf(size: unknown): number {
  const rawScale = Math.round(Number(size));
  return Number.isFinite(rawScale) && rawScale >= 60 && rawScale <= 100 ? rawScale : 100;
}

/** Только для юнит-тестов. */
export function clearSpriteAspectsForTests(): void {
  byId.clear();
  byUrl.clear();
}
