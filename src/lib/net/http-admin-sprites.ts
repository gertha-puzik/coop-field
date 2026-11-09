/**
 * Менеджер спрайтов (/admin/sprites*) — клиент вкладки «Спрайты» дашборда
 * /admin. Отдельный модуль по образцу http-admin-ops.ts: домен свой
 * (каталог скинов из DATA_DIR, не реестр конфига), граф импортов держит
 * изоляцию сайтов (§10.4) — модуль циклится только в бандле страницы
 * /admin (Elysium; вкладка гротто-панели не даём — задача владелицы).
 *
 * Контракты (server/sprites.js):
 *   GET    /admin/sprites        — {ok, items:[{id,name,category,builtin,
 *                                   src,addedAt,wornBy:[{login,character}],
 *                                   wornCount}]};
 *   POST   /admin/sprites        — multipart/form-data {file, name, category}
 *                                   → 200 {ok, item:{id,name,category,builtin,
 *                                   src,addedAt}} (id = translit-slug имени,
 *                                   коллизия — суффикс -2/-3);
 *   PATCH  /admin/sprites/:id    — JSON {name?, category?} → 200 {ok, item};
 *   DELETE /admin/sprites/:id    — 200 {ok, id} | отказ: builtin_immutable /
 *                                   in_use ({wornBy} — кого переодеть сначала).
 * Гейты: сессия 401, роль admin 403, apiZone-CSRF по Origin (net.js),
 * лимит тела 3 МБ, PNG-магия первых 8 байт.
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import { httpOrigin } from "./coop";

/** Владелец спрайта: логин аккаунта + имя персонажа (для строки «одет у»). */
export type SpriteWearer = { login: string; character: string };

/** Строка админского каталога (владеет всем: и builtin, и загруженные).
 *  #83: owner — логин аккаунта-владельца личного окраса (null — админский/
 *  builtin), hidden — рычаг модерации (из каталога/вайтлиста уходит, файл остаётся). */
export type AdminSpriteItem = {
  id: string;
  name: string;
  category: string;
  builtin: boolean;
  src: string;
  addedAt: number;
  wornBy: SpriteWearer[];
  wornCount: number;
  owner: string | null;
  hidden: boolean;
};

/** Отказ операции: reason + человекочитаемый message сервера. */
export type AdminSpriteError = {
  ok: false;
  reason: string;
  message: string;
  wornBy?: SpriteWearer[];
};

export type AdminSpriteListAction =
  | { ok: true; items: AdminSpriteItem[] }
  | AdminSpriteError;

export type AdminSpriteMutationAction =
  | { ok: true; item?: AdminSpriteItem; id?: string }
  | AdminSpriteError;

const asNum = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function parseWearers(raw: unknown): SpriteWearer[] {
  if (!Array.isArray(raw)) return [];
  const out: SpriteWearer[] = [];
  for (const w of raw) {
    if (!w || typeof w !== "object") continue;
    const row = w as ApiRow;
    const login = asText(row.login);
    if (!login) continue;
    out.push({ login, character: asText(row.character) });
  }
  return out;
}

/** Разбор строки каталога: доверяем только прочитанным полям DTO. */
function parseItem(row: ApiRow, id?: string): AdminSpriteItem {
  const wornBy = parseWearers(row.wornBy);
  const owner = asText(row.owner);
  return {
    id: asText(row.id, id || ""),
    name: asText(row.name),
    category: asText(row.category),
    builtin: row.builtin === true,
    src: asText(row.src),
    addedAt: asNum(row.addedAt, 0),
    wornBy,
    wornCount: asNum(row.wornCount, wornBy.length),
    owner: owner || null,
    hidden: row.hidden === true,
  };
}

/** Разбор отказного тела: message сервера уже человекочитаемый. */
function parseErrorRow(
  row: ApiRow | null,
  status: number,
  fallbackReason: string,
): AdminSpriteError {
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
              : asText(row?.reason, fallbackReason),
    message: asText(row?.message),
    wornBy: parseWearers(row?.wornBy),
  };
}

/** Каталог с владельцами (GET /admin/sprites). */
export async function httpAdminSprites(): Promise<AdminSpriteListAction> {
  const { status, row } = await apiFetch("/admin/sprites");
  if (status === 200 && row?.ok === true && Array.isArray(row.items)) {
    return { ok: true, items: (row.items as ApiRow[]).map((r) => parseItem(r)) };
  }
  return parseErrorRow(row, status, "error");
}

/** POST multipart — apiFetch не подходит (он ставит content-type JSON):
 *  браузер сам формирует multipart-boundary, руками заголовок НЕ ставим. */
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
 * Загрузка PNG (POST /admin/sprites): FormData {file, name, category};
 * id назначает сервер (translit-slug имени), ответ несёт полную строку item.
 */
export async function httpAdminSpriteUpload(
  file: File,
  name: string,
  category: string,
): Promise<AdminSpriteMutationAction> {
  const form = new FormData();
  form.append("file", file, file.name || "sprite.png");
  form.append("name", name);
  form.append("category", category);
  const { status, row } = await postMultipart("/admin/sprites", form);
  if (status === 200 && row?.ok === true && row.item && typeof row.item === "object") {
    return { ok: true, item: parseItem(row.item as ApiRow) };
  }
  return parseErrorRow(row, status, "upload_failed");
}

/** Переименование/смена категории и скрытие (PATCH /admin/sprites/:id JSON
 *  {name?, category?, hidden?}); пустые значения не отправляем — за них
 *  отвечает сервер. hidden — модерация «одетого» окраса: из каталога и
 *  белого списка строка уходит, файл остаётся. */
export async function httpAdminSpritePatch(
  id: string,
  patch: { name?: string; category?: string; hidden?: boolean },
): Promise<AdminSpriteMutationAction> {
  const { status, row } = await apiFetch(`/admin/sprites/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: patch,
  });
  if (status === 200 && row?.ok === true && row.item && typeof row.item === "object") {
    return { ok: true, item: parseItem(row.item as ApiRow, id) };
  }
  return parseErrorRow(row, status, "patch_failed");
}

/** Удаление загруженного спрайта (DELETE /admin/sprites/:id): отказ
 *  in_use несёт wornBy — список «кого переодеть сначала» для статуса. */
export async function httpAdminSpriteDelete(id: string): Promise<AdminSpriteMutationAction> {
  const { status, row } = await apiFetch(`/admin/sprites/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (status === 200 && row?.ok === true) {
    return { ok: true, id: asText(row.id, id) };
  }
  return parseErrorRow(row, status, "delete_failed");
}
