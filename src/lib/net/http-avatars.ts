/**
 * Своя аватарка профиля (/avatars/mine*) — клиент блока «Аватар» редактора
 * своего профиля. Отдельный модуль по образцу http-my-sprites.ts: те же
 * сессионные маршруты (apiZone-CSRF по Origin, как у личных окрасов),
 * multipart или части по 512 КиБ для крупных файлов, человеко-русские
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
 *   Лимиты сервера: PNG/JPEG до 2 МБ или GIF до 100 МБ, каждая сторона 64–1500 px,
 *   не чаще раза в 10 секунд (rate).
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import { postProfileImage } from "./http-profile-image";

/** Мутация аватара: успех несёт avatar (новый URL или null после удаления),
 *  отказ — reason сервера (человеко-текст даёт humanAvatarError). */
export type AvatarAction =
  | { ok: true; avatar: string | null }
  | { ok: false; reason: string; message?: string };

/** HTTP status takes precedence when a proxy returns an empty/non-JSON response. */
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
  const { status, row } = await postProfileImage("/avatars/mine", file);
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
      return "Файл не похож на картинку — нужен PNG, JPEG или GIF.";
    case "bad_dims":
      return "Картинка: сторона 64–1500 px; GIF до 100 МБ, PNG/JPEG до 2 МБ.";
    case "too_large":
      return "GIF — до 100 МБ, PNG/JPEG — до 2 МБ.";
    case "proxy_too_large":
      return "Сервер отклонил размер файла. Попробуйте GIF поменьше.";
    case "upload_conflict":
    case "upload_expired":
      return "Загрузка прервалась — выберите файл ещё раз.";
    case "rate":
      return "Слишком часто, подождите немного и попробуйте снова.";
    case "io":
    case "storage":
      return "Не получилось сохранить, попробуйте позже.";
    default:
      return fallback;
  }
}
