/**
 * Публичный каталог текстур редактора (GET /tex/catalog). Общий граф —
 * симулятор подтягивает src замен без админ-модуля.
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import { texAssetUrl } from "@/lib/sim/tex-asset";

export type TexCatalogItem = {
  id: string;
  label: string;
  category: string;
  src: string;
  replaced: boolean;
  replacedAt: number;
};

export async function httpTexCatalog(): Promise<TexCatalogItem[] | null> {
  const { status, row } = await apiFetch("/tex/catalog");
  if (status !== 200 || row?.ok !== true || !Array.isArray(row.items)) return null;
  const out: TexCatalogItem[] = [];
  for (const entry of row.items as ApiRow[]) {
    const id = asText(entry.id);
    if (!id) continue;
    out.push({
      id,
      label: asText(entry.label, id),
      category: asText(entry.category),
      src: texAssetUrl(asText(entry.src) || `/tex/${id}.png`),
      replaced: entry.replaced === true,
      replacedAt: typeof entry.replacedAt === "number" ? entry.replacedAt : 0,
    });
  }
  return out.length ? out : null;
}
