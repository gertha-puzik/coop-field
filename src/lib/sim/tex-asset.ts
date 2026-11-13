/**
 * Адрес PNG текстуры редактора. Builtin — статика `/tex/<id>.png`.
 * Замены/кастом отдаёт комната: `/cfg/tex-file/<id>.png` (и legacy
 * `/tex/file/<id>.png`). В next dev страница на :3000, комната на :3780 —
 * относительный file-URL даёт 404, поэтому в development префиксуем
 * localhost:3780 (как sprite-asset.ts).
 */

const FILE_PREFIXES = ["/cfg/tex-file/", "/tex/file/"] as const;

export function texAssetUrl(src: string): string {
  if (process.env.NODE_ENV !== "development") return src;
  if (!FILE_PREFIXES.some((p) => src.startsWith(p))) return src;
  return `http://localhost:3780${src}`;
}
