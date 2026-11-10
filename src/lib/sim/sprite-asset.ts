/**
 * Адрес PNG спрайта. Базовые лежат в статике сайта (`/sprites/<id>.png`).
 * Личные окрасы отдаёт комната (`/sprites/file/<id>.png`). В `next dev`
 * страница на :3000, комната на :3780 — относительный file-URL даёт 404.
 * Префикс зашит по NODE_ENV, чтобы SSR и гидрация совпали. Прод-сборка
 * same-origin (nginx), префикс не нужен.
 */

const FILE_PREFIX = "/sprites/file/";

/** id спрайта, который сервер вообще согласен рассматривать (слаг, не путь). */
export function isSpriteSlug(id: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(id);
}

export function spriteAssetUrl(src: string): string {
  if (!src.startsWith(FILE_PREFIX)) return src;
  if (process.env.NODE_ENV !== "development") return src;
  return `http://localhost:3780${src}`;
}
