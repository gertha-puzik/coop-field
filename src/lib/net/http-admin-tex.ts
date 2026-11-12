/**
 * Админ-текстуры редактора (/admin/tex*, server/textures.js) — клиент вкладки
 * «Текстуры» дашборда /admin. Изоляция сайтов: модуль только в бандле /admin.
 *
 *   GET    /admin/tex           — {ok, items, categories}
 *   POST   /admin/tex/:id       — multipart {file} → замена PNG
 *   DELETE /admin/tex/:id       — вернуть builtin
 *   GET    /tex/catalog         — публичный список src (для движка)
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import { httpOrigin } from "./coop";
import { texAssetUrl } from "@/lib/sim/tex-asset";

export type AdminTexItem = {
  id: string;
  label: string;
  category: string;
  group: string | null;
  src: string;
  replaced: boolean;
  replacedAt: number;
  w: number;
  h: number;
  bytes: number;
};

export type AdminTexCategory = { id: string; label: string };

export type AdminTexError = { ok: false; reason: string; message: string };
export type AdminTexListAction =
  | { ok: true; items: AdminTexItem[]; categories: AdminTexCategory[] }
  | AdminTexError;
export type AdminTexMutationAction =
  | { ok: true; item?: AdminTexItem; id?: string; restored?: boolean }
  | AdminTexError;

const asNum = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function parseItem(row: ApiRow, id?: string): AdminTexItem {
  return {
    id: asText(row.id, id || ""),
    label: asText(row.label, asText(row.id, id || "")),
    category: asText(row.category),
    group: asText(row.group) || null,
    src: texAssetUrl(asText(row.src) || `/tex/${asText(row.id, id || "")}.png`),
    replaced: row.replaced === true,
    replacedAt: asNum(row.replacedAt, 0),
    w: asNum(row.w, 0),
    h: asNum(row.h, 0),
    bytes: asNum(row.bytes, 0),
  };
}

function parseError(row: ApiRow | null, status: number, fallback: string): AdminTexError {
  return {
    ok: false,
    reason:
      status === 401
        ? "auth_required"
        : status === 403 && row?.reason === "forbidden"
          ? "forbidden"
          : status === 403
            ? "csrf_origin"
            : status === 0
              ? "offline"
              : asText(row?.reason, fallback),
    message: asText(row?.message),
  };
}

export async function httpAdminTextures(): Promise<AdminTexListAction> {
  const { status, row } = await apiFetch("/admin/tex");
  if (status === 200 && row?.ok === true && Array.isArray(row.items)) {
    const categories = Array.isArray(row.categories)
      ? (row.categories as ApiRow[])
          .map((c) => ({ id: asText(c.id), label: asText(c.label, asText(c.id)) }))
          .filter((c) => c.id)
      : [];
    return {
      ok: true,
      items: (row.items as ApiRow[]).map((r) => parseItem(r)),
      categories,
    };
  }
  return parseError(row, status, "error");
}

async function postMultipart(path: string, form: FormData): Promise<{ status: number; row: ApiRow | null }> {
  try {
    const res = await fetch(`${httpOrigin()}${path}`, {
      method: "POST",
      credentials: "include",
      body: form,
    });
    const text = await res.text();
    let row: ApiRow | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      row = parsed && typeof parsed === "object" ? (parsed as ApiRow) : null;
    } catch {
      row = null;
    }
    return { status: res.status, row };
  } catch {
    return { status: 0, row: null };
  }
}

export async function httpAdminTexReplace(id: string, file: File): Promise<AdminTexMutationAction> {
  const form = new FormData();
  form.append("file", file, file.name || `${id}.png`);
  const { status, row } = await postMultipart(`/admin/tex/${encodeURIComponent(id)}`, form);
  if (status === 200 && row?.ok === true && row.item && typeof row.item === "object") {
    return { ok: true, item: parseItem(row.item as ApiRow, id) };
  }
  return parseError(row, status, "upload_failed");
}

export async function httpAdminTexRestore(id: string): Promise<AdminTexMutationAction> {
  const { status, row } = await apiFetch(`/admin/tex/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (status === 200 && row?.ok === true) {
    const item =
      row.item && typeof row.item === "object" ? parseItem(row.item as ApiRow, id) : undefined;
    return { ok: true, id: asText(row.id, id), restored: row.restored === true, item };
  }
  return parseError(row, status, "restore_failed");
}
