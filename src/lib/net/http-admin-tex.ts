/**
 * Админ-текстуры редактора (server/textures.js) — клиент вкладки «Текстуры».
 * Изоляция сайтов: модуль только в бандле /admin.
 *
 * Канон клиента — /cfg/tex* (прод nginx уже проксирует весь /cfg в Node;
 * exact /admin/tex на проде может отсутствовать). Сервер держит и /admin/tex*.
 *
 *   GET    /cfg/tex             — {ok, items, categories}
 *   POST   /cfg/tex             — multipart create {file,label,category,group?}
 *   POST   /cfg/tex/:id         — multipart {file} → замена PNG
 *   PATCH  /cfg/tex/:id         — JSON {label?,category?,group?} (только custom)
 *   DELETE /cfg/tex/:id         — custom: удалить; builtin: вернуть PNG
 *   GET    /cfg/tex-catalog     — публичный список src (для движка)
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import { httpOrigin } from "./coop";
import { texAssetUrl } from "@/lib/sim/tex-asset";

export type AdminTexItem = {
  id: string;
  label: string;
  category: string;
  group: string | null;
  custom: boolean;
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
  | { ok: true; item?: AdminTexItem; id?: string; restored?: boolean; deleted?: boolean }
  | AdminTexError;

const asNum = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function parseItem(row: ApiRow, id?: string): AdminTexItem {
  return {
    id: asText(row.id, id || ""),
    label: asText(row.label, asText(row.id, id || "")),
    category: asText(row.category),
    group: asText(row.group) || null,
    custom: row.custom === true,
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
  const { status, row } = await apiFetch("/cfg/tex");
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

export async function httpAdminTexCreate(input: {
  file: File;
  label: string;
  category: string;
  group?: string;
}): Promise<AdminTexMutationAction> {
  const form = new FormData();
  form.append("file", input.file, input.file.name || "tex.png");
  form.append("label", input.label);
  form.append("category", input.category);
  if (input.group) form.append("group", input.group);
  const { status, row } = await postMultipart("/cfg/tex", form);
  if (status === 200 && row?.ok === true && row.item && typeof row.item === "object") {
    return { ok: true, item: parseItem(row.item as ApiRow) };
  }
  return parseError(row, status, "create_failed");
}

export async function httpAdminTexReplace(id: string, file: File): Promise<AdminTexMutationAction> {
  const form = new FormData();
  form.append("file", file, file.name || `${id}.png`);
  const { status, row } = await postMultipart(`/cfg/tex/${encodeURIComponent(id)}`, form);
  if (status === 200 && row?.ok === true && row.item && typeof row.item === "object") {
    return { ok: true, item: parseItem(row.item as ApiRow, id) };
  }
  return parseError(row, status, "upload_failed");
}

export async function httpAdminTexPatch(
  id: string,
  patch: { label?: string; category?: string; group?: string | null },
): Promise<AdminTexMutationAction> {
  const { status, row } = await apiFetch(`/cfg/tex/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
  if (status === 200 && row?.ok === true && row.item && typeof row.item === "object") {
    return { ok: true, item: parseItem(row.item as ApiRow, id) };
  }
  return parseError(row, status, "patch_failed");
}

export async function httpAdminTexRestore(id: string): Promise<AdminTexMutationAction> {
  const { status, row } = await apiFetch(`/cfg/tex/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (status === 200 && row?.ok === true) {
    if (row.deleted === true) return { ok: true, id: asText(row.id, id), deleted: true };
    const item =
      row.item && typeof row.item === "object" ? parseItem(row.item as ApiRow, id) : undefined;
    return { ok: true, id: asText(row.id, id), restored: row.restored === true, item };
  }
  return parseError(row, status, "restore_failed");
}
