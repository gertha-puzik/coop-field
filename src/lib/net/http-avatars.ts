/**
 * Своя аватарка профиля (/avatars/mine*) — клиент блока «Аватар» редактора
 * своего профиля. Отдельный модуль по образцу http-my-sprites.ts: те же
 * сессионные маршруты (apiZone-CSRF по Origin, как у личных окрасов),
 * multipart-отправка FormData (boundary ставит браузер), человеко-русские
 * тексты отказов. Литералы /avatars/* живут ТОЛЬКО здесь — как /sprites/mine
 * только в http-my-sprites.ts; импортирует их один потребитель — страница
 * профиля (src/components/players/player-profile.tsx), каталог и админ-панель
 * модуль в свой бандл не тянут.
 *
 * Контракты (server/avatars.js, контент-волна профиля):
 *   POST   /avatars/mine   — multipart {file} → 200 {ok:true,
 *                            avatar:"/avatars/file/<id>.<ext>?v=<unixMs>"}
 *   DELETE /avatars/mine   — 200 {ok:true, avatar:null} (после удаления)
 *   Ошибки 4xx JSON {reason}: no_file, bad_multipart, bad_content_type,
 *   bad_magic, bad_dims, too_large, rate, auth_required, io.
 *   Лимиты сервера: PNG или JPEG, каждая сторона 64–1500 px, до 2 МБ,
 *   не чаще раза в 10 секунд (rate).
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import { httpOrigin } from "./coop";

/** Мутация аватара: успех несёт avatar (новый URL или null после удаления),
 *  отказ — reason сервера (человеко-текст даёт humanAvatarError). */
export type AvatarAction =
  | { ok: true; avatar: string | null }
  | { ok: false; reason: string; message?: string };

/** POST multipart — boundary ставит браузер, руками content-type НЕ задаём. */
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

/** Разбор отказного тела: статус важнее пустого reason (401/403/сеть),
 *  message сервера уже человекочитаемый — показываем рядом с переводом. */
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

/**
 * Загрузка своей картинки (POST /avatars/mine): FormData {file}, id и
 * cache-busting ?v=<unixMs> назначает сервер. Ответ — свежий avatar-URL.
 */
export async function httpUploadAvatar(file: File): Promise<AvatarAction> {
  const form = new FormData();
  form.append("file", file, file.name || "avatar.png");
  const { status, row } = await postMultipart("/avatars/mine", form);
  if ((status === 200 || status === 201) && row?.ok === true) {
    return { ok: true, avatar: asText(row.avatar) || null };
  }
  return parseErrorRow(row, status, "upload_failed");
}

/** Удаление своей картинки (DELETE /avatars/mine): после успеха avatar null. */
export async function httpDeleteAvatar(): Promise<AvatarAction> {
  const { status, row } = await apiFetch("/avatars/mine", { method: "DELETE" });
  if (status === 200 && row?.ok === true) {
    return { ok: true, avatar: asText(row.avatar) || null };
  }
  return parseErrorRow(row, status, "delete_failed");
}

/** Отказ → человеческий русский (без код-жаргона): reason по контракту
 *  server/avatars.js; сеть и защита — тексты по образцу соседей. */
export function humanAvatarError(reason: string | undefined, fallback: string): string {
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
      return "Файл не похож на картинку — нужен PNG или JPEG.";
    case "bad_dims":
      return "Картинка не подходит: сторона 64–1500 px, до 2 мегабайт.";
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
