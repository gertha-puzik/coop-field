import { httpOrigin } from "./coop";
export type ItemDefinition = {
  id: string;
  name: string;
  weight: number;
  sprite: string | null;
};
export type ItemStack = { itemId: string; quantity: number };
export type InventoryArea = "bag" | "hotbar";
export type InventorySlot = { area: InventoryArea; index: number };
export type InventorySnapshot = {
  characterId: string;
  version: number;
  bag: (ItemStack | null)[];
  hotbar: (ItemStack | null)[];
  weight: number;
  maxWeight: number;
  items: ItemDefinition[];
};
export type ItemRecipient = {
  accountId: string;
  login: string;
  name: string;
  characters: { id: string; name: string; weight: number }[];
};
export const itemSprite = (url: string) =>
  url.startsWith("/cfg/") ? httpOrigin() + url : url;
export async function inventoryRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(httpOrigin() + path, {
    method,
    signal: AbortSignal.timeout(12000),
    credentials: "include",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const row = await response.json();
  if (!response.ok || !row.ok) throw new Error(row.reason || "offline");
  return row as T;
}
export async function uploadItemSprite(file: File) {
  const response = await fetch(httpOrigin() + "/cfg/items/sprite", {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    credentials: "include",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const row = await response.json();
  if (!response.ok || !row.ok) throw new Error(row.reason || "offline");
  return row.sprite as string;
}
export function inventoryError(error: unknown) {
  const reason = error instanceof Error ? error.message : "";
  return (
    (
      {
        auth_required: "Войдите в аккаунт.",
        forbidden: "Нет права «Предметы и выдача».",
        character_not_found: "Персонаж не найден. Обновите список.",
        item_not_found: "Предмет не найден.",
        invalid_quantity: "Укажите целое положительное количество.",
        invalid_item: "Проверьте ID и название предмета.",
        invalid_weight:
          "Вес должен быть больше нуля и не больше 30 (до двух знаков после запятой).",
        invalid_sprite: "Загрузите PNG-спрайт предмета.",
        invalid_png: "Нужен корректный PNG-файл.",
        invalid_dimensions:
          "Спрайт слишком большой: максимум 2048 по стороне и 1 мегапиксель.",
        too_large: "Файл превышает 2 МБ.",
        weight_limit:
          "Недостаточно места по весу. Максимум — 30 вместе с хотбаром.",
        no_free_slot: "Нет свободного слота.",
        weight_in_use: "Новый вес перегрузит инвентарь одного из персонажей.",
        stale_inventory:
          "Инвентарь изменился. Данные обновлены — повторите перемещение.",
        invalid_slot: "Выберите другой слот.",
        operation_conflict: "Операция уже использована. Обновите страницу.",
        catalogue_full: "В каталоге уже 500 предметов.",
      } as Record<string, string>
    )[reason] || "Нет связи с сервером. Попробуйте ещё раз."
  );
}
