/**
 * Адрес PNG текстуры редактора. Builtin — статика `/tex/<id>.png`.
 * Замены админки отдаёт комната (`/tex/file/<id>.png`). В next dev страница
 * на :3000, комната на :3780 — относительный file-URL даёт 404, поэтому в
 * development префиксуем localhost:3780 (как sprite-asset.ts).
 */

const FILE_PREFIX = "/tex/file/";

export function texAssetUrl(src: string): string {
  if (!src.startsWith(FILE_PREFIX)) return src;
  if (process.env.NODE_ENV !== "development") return src;
  return `http://localhost:3780${src}`;
}
