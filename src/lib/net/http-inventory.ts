import { httpOrigin } from "./coop";
export const ITEM_CATEGORIES = [
  ["food", "Еда", "♧"],
  ["resources", "Ресурсы", "❧"],
  ["materials", "Материалы", "⚒"],
  ["consumables", "Расходуемые", "♜"],
  ["special", "Особые", "★"],
  ["decor", "Декор", "♣"],
  ["other", "Другое", "•••"],
] as const;
export type ItemDefinition = {
  description?: string;
  category?: string;
  maxStack?: number;
  deletedAt?: number;
  glows?: boolean;
  glowIntensity?: number;
  glowPeriod?: number;
  sparkle?: boolean;
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
  mouth?: ItemStack | null;
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
        mouth_full: "Пасть уже занята.",
        empty_mouth: "В пасти нет предмета.",
        too_far: "Подойдите ближе к предмету или игроку.",
        item_gone: "Предмет уже подняли.",
        invalid_point: "Здесь нельзя положить предмет.",
        not_on_field: "Сначала войдите на игровое поле.",
        offer_pending: "Дождитесь ответа на предложение.",
        offer_expired: "Предложение больше недоступно.",
        ground_full: "На локации слишком много предметов.",
        auth_required: "Войдите в аккаунт.",
        forbidden: "Нет права «Предметы и выдача».",
        character_not_found: "Персонаж не найден. Обновите список.",
        item_deleted:
          "Этот ID принадлежит удалённому предмету. Используйте новый ID.",
        item_exists: "Предмет с таким ID уже существует.",
        stack_full: "Стопка уже заполнена.",
        stack_limit_in_use:
          "Не хватает свободных слотов у игроков для уменьшения стопки. Освободите слоты или увеличьте лимит.",
        item_not_found: "Предмет не найден.",
        invalid_quantity: "Укажите целое положительное количество.",
        invalid_item:
          "Проверьте ID, название, описание, категорию и параметры предмета.",
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
        slot_occupied: "Этот слот занят другим предметом.",
        invalid_slot: "Выберите другой слот.",
        operation_conflict: "Операция уже использована. Обновите страницу.",
        catalogue_full: "В каталоге уже 500 предметов.",
      } as Record<string, string>
    )[reason] || "Нет связи с сервером. Попробуйте ещё раз."
  );
}

export type WorldItem = {
  id: string;
  room: string;
  itemId: string;
  x: number;
  y: number;
};
export type WorldItemsSnapshot = {
  room: string | null;
  selfId: number | null;
  mouth?: ItemStack | null;
  ground: WorldItem[];
  players: {
    id: number;
    name: string;
    x: number;
    y: number;
    mouth: ItemStack | null;
  }[];
  offers: {
    id: string;
    fromId: number;
    name: string;
    itemId: string;
    until: number;
  }[];
};
