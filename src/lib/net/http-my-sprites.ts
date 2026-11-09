/**
 * Личные окрасы игроков (/sprites/mine*) — клиент зоны «Свой окрас» профиля
 * игрока. Отдельный модуль по образцу http-admin-sprites.ts: домен свой
 * (сессия игрока, лимит 3/аккаунт, дедуп даблклика), граф импортов держит
 * изоляцию сайтов (§10.4) — модуль циклится только в бандле страницы
 * профиля (Elysium), админ-дашборд его не видит.
 *
 * Контракты (server/my-sprites.js, #83):
 *   GET    /sprites/mine        — {ok, limit:3, count, items:[{id,name,
 *                                 category,src,w,h,bytes,addedAt,hidden}]};
 *   POST   /sprites/mine        — multipart {file, name} → 201 {ok, sprite}
 *                                 | 200 {ok, dedup:true, sprite} (то же тело);
 *   DELETE /sprites/mine/:id     — 200 {ok, id} | отказ worn («сначала
 *                                 переоденьте кота», wornBy) и др.
 * Гейты: сессия 401, apiZone-CSRF по Origin (net.js), потолок тела 1 МБ,
 * PNG-магия, габариты 100–1000 px / до 600 000 px / файл от 1,5 КБ.
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import { httpOrigin } from "./coop";

/** Свои окрасы: строка каталога + личные метки (hidden от админа). */
export type MineSprite = {
  id: string;
  name: string;
  category: string;
  src: string;
  w: number;
  h: number;
  bytes: number;
  addedAt: number;
  hidden: boolean;
};

/** Кого переодеть сначала (отказ worn при удалении одетого). */
export type MineWearer = { login: string; character: string };

export type MineError = {
  ok: false;
  reason: string;
  message?: string;
  wornBy?: MineWearer[];
};

export type MineSpriteListAction =
  | { ok: true; limit: number; count: number; items: MineSprite[] }
  | MineError;

export type MineSpriteMutationAction =
  | { ok: true; sprite?: MineSprite; id?: string; dedup?: boolean }
  | MineError;

const asNum = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function parseWearers(raw: unknown): MineWearer[] {
  if (!Array.isArray(raw)) return [];
  const out: MineWearer[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const row = w as ApiRow;
    const login = asText(row.login);
    if (!login) continue;
    out.push({ login, character: asText(row.character) });
  }
  return out;
}

/** Разбор строки своих окрасов: доверяем только прочитанным полям DTO. */
function parseSprite(row: ApiRow, id?: string): MineSprite {
  return {
    id: asText(row.id, id || ""),
    name: asText(row.name),
    category: asText(row.category),
    src: asText(row.src),
    w: asNum(row.w, 0),
    h: asNum(row.h, 0),
    bytes: asNum(row.bytes, 0),
    addedAt: asNum(row.addedAt, 0),
    hidden: row.hidden === true,
  };
}

/** Разбор отказного тела: message сервера уже человекочитаемый. */
function parseErrorRow(row: ApiRow | null, status: number, fallbackReason: string): MineError {
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
    wornBy: parseWearers(row?.wornBy),
  };
}

/** Список своих окрасов и счётчик лимита (GET /sprites/mine). */
export async function httpMineSprites(): Promise<MineSpriteListAction> {
  const { status, row } = await apiFetch("/sprites/mine");
  if (status === 200 && row?.ok === true && Array.isArray(row.items)) {
    return {
      ok: true,
      limit: asNum(row.limit, 3),
      count: asNum(row.count, 0),
      items: (row.items as ApiRow[]).map((r) => parseSprite(r)),
    };
  }
  return parseErrorRow(row, status, "error");
}

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

/**
 * Загрузка PNG (POST /sprites/mine): FormData {file, name}; id назначает
 * сервер (транслит-слаг имени). 200 с dedup — даблклик повторной отправки
 * той же картинки: слот не тратится, окрас уже есть.
 */
export async function httpUploadMineSprite(file: File, name: string): Promise<MineSpriteMutationAction> {
  const form = new FormData();
  form.append("file", file, file.name || "sprite.png");
  form.append("name", name);
  const { status, row } = await postMultipart("/sprites/mine", form);
  if ((status === 200 || status === 201) && row?.ok === true && row.sprite && typeof row.sprite === "object") {
    return { ok: true, sprite: parseSprite(row.sprite as ApiRow), dedup: row.dedup === true };
  }
  return parseErrorRow(row, status, "upload_failed");
}

/** Удаление своего окраса (DELETE /sprites/mine/:id): отказ worn несёт
 *  wornBy — «кого переодеть сначала». */
export async function httpDeleteMineSprite(id: string): Promise<MineSpriteMutationAction> {
  const { status, row } = await apiFetch(`/sprites/mine/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (status === 200 && row?.ok === true) {
    return { ok: true, id: asText(row.id, id) };
  }
  return parseErrorRow(row, status, "delete_failed");
}

/** Отказ → человеческий русский (без код-жаргона): reason по контракту #83. */
export function humanMineError(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case 'auth_required':
      return 'Нужен вход в аккаунт.';
    case 'csrf_origin_required':
    case 'csrf_origin':
      return 'Запрос отклонён защитой — обновите страницу и попробуйте снова.';
    case 'offline':
      return 'Сервер недоступен.';
    case 'no_file':
      return 'Сначала выберите PNG-файл.';
    case 'bad_content_type':
    case 'bad_multipart':
      return 'Форма загрузки не читается — обновите страницу и попробуйте снова.';
    case 'bad_magic':
      return 'Файл не похож на PNG — нужен PNG-рисунок из редактора окрасов.';
    case 'bad_name':
      return 'Имя окраса: 2–24 символа.';
    case 'bad_dims':
      return 'Картинка не подходит: сторона 100–1000 px, до 600 000 px всего, файл от 1,5 КБ.';
    case 'too_large':
      return 'Файл больше 1 МБ не принимается — уменьшите картинку.';
    case 'limit':
      return 'У вас уже 3 окраса — удалите один в профиле.';
    case 'rate':
      return 'Слишком много загрузок подряд — немного подождите и попробуйте снова.';
    case 'capacity':
      return 'Каталог окрасов переполнен — попробуйте позже.';
    case 'worn':
      return 'Этот окрас сейчас надет — сначала переоденьте кота.';
    case 'forbidden':
      return 'Это окрас другого игрока.';
    case 'unknown_sprite':
      return 'Окраса уже нет — обновите список.';
    case 'io':
    case 'storage':
      return 'Не удалось сохранить файл окраса — попробуйте позже.';
    default:
      return fallback;
  }
}
