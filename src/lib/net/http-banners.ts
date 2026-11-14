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

/** Подготовка большого фона: пропорции сохраняются, исходный файл не меняется. */
export async function prepareBanner(file: File): Promise<{ file: File; description: string | null }> {
  if (!['image/png', 'image/jpeg', 'image/gif'].includes(file.type)) {
    throw new Error('Выберите картинку PNG, JPEG или GIF.');
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const { naturalWidth: width, naturalHeight: height } = image;
    if (width < 16 || height < 16) throw new Error('Картинка слишком маленькая: нужно хотя бы 16×16 пикселей.');
    if (width <= 1200 && height <= 400 && file.size <= 2 * 1024 * 1024) {
      return { file, description: null };
    }
    const ratio = Math.min(1, 1200 / width, 400 / height);
    const w = Math.max(1, Math.floor(width * ratio));
    const h = Math.max(1, Math.floor(height * ratio));
    if (w < 16 || h < 16) throw new Error('Слишком вытянутый фон: после уменьшения каждая сторона должна быть не меньше 16 пикселей.');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Браузер не смог подготовить картинку.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, w, h);
    const encode = (type: string, quality?: number) => new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Не удалось уменьшить картинку.')), type, quality);
    });
    let blob = await encode('image/png');
    if (blob.size > 2 * 1024 * 1024) {
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#0a0e20';
      ctx.fillRect(0, 0, w, h);
      blob = await encode('image/jpeg', 0.9);
    }
    if (blob.size > 2 * 1024 * 1024) throw new Error('Не удалось уложить картинку в 2 МБ. Выберите другой файл.');
    const ext = blob.type === 'image/png' ? 'png' : 'jpg';
    return {
      file: new File([blob], `profile-banner.${ext}`, { type: blob.type }),
      description: `Подготовить фон ${width}×${height} → ${w}×${h} пикселей (${Math.ceil(blob.size / 1024)} КБ)? Пропорции сохранятся, обрезки не будет. Исходный файл останется прежним.${file.type === 'image/gif' ? ' Анимация GIF станет неподвижной картинкой.' : ''}${ext === 'jpg' ? ' Прозрачность будет заменена тёмным фоном.' : ''}`,
    };
  } catch (error) {
    throw error instanceof Error && error.name !== 'EncodingError' ? error : new Error('Картинка повреждена или не читается браузером.');
  } finally {
    URL.revokeObjectURL(url);
  }
}
