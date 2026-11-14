/**
 * Горизонтальный фон профиля (/cfg/banners/mine*) — клиент редактора.
 * Литералы /cfg/banners/* только здесь (обход прод-nginx через location /cfg).
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import { httpOrigin } from "./coop";

export type BannerAction =
  | { ok: true; banner: string | null }
  | { ok: false; reason: string; message?: string };

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

function parseErrorRow(
  row: ApiRow | null,
  status: number,
  fallbackReason: string,
): { ok: false; reason: string; message?: string } {
  return {
    ok: false,
    reason:
      status === 401
        ? "auth_required"
        : status === 403
          ? "csrf_origin_required"
          : status === 0
            ? "offline"
            : asText(row?.reason, fallbackReason),
    message: asText(row?.message) || undefined,
  };
}

export async function httpUploadBanner(file: File): Promise<BannerAction> {
  const form = new FormData();
  form.append("file", file, file.name || "banner.png");
  const { status, row } = await postMultipart("/cfg/banners/mine", form);
  if ((status === 200 || status === 201) && row?.ok === true) {
    return { ok: true, banner: asText(row.banner) || null };
  }
  return parseErrorRow(row, status, "upload_failed");
}

export async function httpDeleteBanner(): Promise<BannerAction> {
  const { status, row } = await apiFetch("/cfg/banners/mine", { method: "DELETE" });
  if (status === 200 && row?.ok === true) {
    return { ok: true, banner: asText(row.banner) || null };
  }
  return parseErrorRow(row, status, "delete_failed");
}

export function humanBannerError(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case "auth_required":
      return "Нужен вход в аккаунт.";
    case "csrf_origin_required":
    case "csrf_origin":
    case "csrf":
      return "Запрос отклонён защитой — обновите страницу и попробуйте снова.";
    case "offline":
      return "Сервер недоступен.";
    case "no_file":
      return "Сначала выберите файл.";
    case "bad_content_type":
    case "bad_multipart":
      return "Файл не дошёл — попробуйте ещё раз.";
    case "bad_magic":
      return "Файл не похож на картинку — нужен PNG, JPEG или GIF.";
    case "bad_dims":
      return "Фон не подходит: ширина до 1200 px, высота до 400 px.";
    case "too_large":
      return "Файл больше 2 МБ не принимается — уменьшите картинку.";
    case "rate":
      return "Слишком часто, подождите немного и попробуйте снова.";
    case "io":
    case "storage":
      return "Не получилось сохранить, попробуйте позже.";
    default:
      return fallback;
  }
}
