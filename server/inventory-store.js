/** Server-authoritative item catalogue and per-character inventories. */
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { writeFileAtomic } from "./atomic-file.js";
export const BAG_SLOTS = 10,
  HOTBAR_SLOTS = 5,
  MAX_WEIGHT = 30;
const file = path.join(DATA_DIR, "inventories.json");
const seed = {
  id: "nugget",
  name: "Наггетс",
  weight: 3,
  sprite: "/items/nugget.png",
};
let store = { v: 1, items: { nugget: seed }, inventories: {}, operations: {} };
try {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.v !== 1 || !raw.items || !raw.inventories)
    throw Error("invalid inventory store");
  store = {
    ...raw,
    items: { nugget: seed, ...raw.items },
    operations: raw.operations || {},
  };
  if (!store.items.nugget.sprite)
    store.items.nugget = { ...store.items.nugget, sprite: seed.sprite };
} catch (error) {
  if (error?.code !== "ENOENT") {
    console.error("inventory store load failed:", error.message);
    throw error;
  }
}
const copy = (value) => structuredClone(value);
const units = (weight) => Math.round(weight * 100);
const keyOf = (accountId, characterId) => `${accountId}:${characterId}`;
const empty = () => ({
  version: 0,
  bag: Array(BAG_SLOTS).fill(null),
  hotbar: Array(HOTBAR_SLOTS).fill(null),
});
function commit(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(file, JSON.stringify(next));
  store = next;
}
export const itemCatalogue = () => Object.values(store.items).map(copy);
export const itemById = (id) =>
  store.items[id] ? copy(store.items[id]) : null;
function weightUnits(inventory, items = store.items) {
  return [...inventory.bag, ...inventory.hotbar].reduce(
    (sum, stack) =>
      sum +
      (stack ? units(items[stack.itemId]?.weight || 0) * stack.quantity : 0),
    0,
  );
}
export function inventoryView(accountId, characterId) {
  const inventory = store.inventories[keyOf(accountId, characterId)] || empty();
  return {
    ...copy(inventory),
    characterId,
    weight: weightUnits(inventory) / 100,
    maxWeight: MAX_WEIGHT,
    items: itemCatalogue(),
  };
}
export function saveItem(raw) {
  const id = String(raw?.id || ""),
    name = typeof raw?.name === "string" ? raw.name.trim() : "";
  if (
    !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id) ||
    !name ||
    name.length > 64 ||
    /[\u0000-\u001f]/.test(name)
  )
    return { error: "invalid_item" };
  const weight = raw.weight;
  if (
    !Number.isFinite(weight) ||
    weight <= 0 ||
    weight > MAX_WEIGHT ||
    Math.abs(weight * 100 - Math.round(weight * 100)) > 1e-7
  )
    return { error: "invalid_weight" };
  const sprite = raw.sprite;
  if (
    typeof sprite !== "string" ||
    !(
      sprite === seed.sprite ||
      (/^\/cfg\/items\/files\/[a-f0-9]{64}\.png$/.test(sprite) &&
        fs.existsSync(path.join(DATA_DIR, "items", path.basename(sprite))))
    )
  )
    return { error: "invalid_sprite" };
  if (!store.items[id] && Object.keys(store.items).length >= 500)
    return { error: "catalogue_full" };
  const item = { id, name, weight, sprite },
    items = { ...store.items, [id]: item };
  if (
    Object.values(store.inventories).some(
      (inventory) => weightUnits(inventory, items) > MAX_WEIGHT * 100,
    )
  )
    return { error: "weight_in_use" };
  commit({ ...store, items });
  return { item: copy(item) };
}
export function moveStack(accountId, characterId, raw) {
  const key = keyOf(accountId, characterId),
    old = store.inventories[key] || empty();
  if (!Number.isSafeInteger(raw?.version) || raw.version !== old.version)
    return { error: "stale_inventory", status: 409 };
  const from = raw.from,
    to = raw.to;
  const valid = (slot) =>
    slot &&
    ["bag", "hotbar"].includes(slot.area) &&
    Number.isInteger(slot.index) &&
    slot.index >= 0 &&
    slot.index < (slot.area === "bag" ? BAG_SLOTS : HOTBAR_SLOTS);
  if (!valid(from)) return { error: "invalid_slot" };
  const next = copy(old),
    stack = next[from.area][from.index];
  if (!stack) return { error: "empty_slot" };
  let target = to;
  if (raw.quick === true) {
    const area = from.area === "bag" ? "hotbar" : "bag";
    let index = next[area].findIndex((row) => row?.itemId === stack.itemId);
    if (index < 0) index = next[area].findIndex((row) => row === null);
    if (index < 0) return { error: "no_free_slot" };
    target = { area, index };
  }
  if (
    !valid(target) ||
    (target.area === from.area && target.index === from.index)
  )
    return { error: "invalid_slot" };
  const other = next[target.area][target.index];
  if (other?.itemId === stack.itemId) {
    other.quantity += stack.quantity;
    next[from.area][from.index] = null;
  } else {
    next[target.area][target.index] = stack;
    next[from.area][from.index] = other;
  }
  next.version++;
  commit({ ...store, inventories: { ...store.inventories, [key]: next } });
  return { inventory: inventoryView(accountId, characterId), target };
}
export function grantItems(actorId, accountId, characterId, raw) {
  const { itemId, quantity, operationId } = raw || {};
  if (
    typeof operationId !== "string" ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(operationId)
  )
    return { error: "invalid_operation" };
  const item = store.items[itemId];
  if (!item) return { error: "item_not_found" };
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 10000)
    return { error: "invalid_quantity" };
  const opKey = `${actorId}:${operationId}`,
    fingerprint = JSON.stringify([accountId, characterId, itemId, quantity]);
  if (store.operations[opKey])
    return store.operations[opKey] === fingerprint
      ? { inventory: inventoryView(accountId, characterId), replayed: true }
      : { error: "operation_conflict", status: 409 };
  const key = keyOf(accountId, characterId),
    next = copy(store.inventories[key] || empty());
  if (weightUnits(next) + units(item.weight) * quantity > MAX_WEIGHT * 100)
    return { error: "weight_limit" };
  let area = "bag",
    index = next.bag.findIndex((row) => row?.itemId === itemId);
  if (index < 0) {
    index = next.hotbar.findIndex((row) => row?.itemId === itemId);
    if (index >= 0) area = "hotbar";
  }
  if (index < 0) {
    area = "bag";
    index = next.bag.indexOf(null);
  }
  if (index < 0) {
    area = "hotbar";
    index = next.hotbar.indexOf(null);
  }
  if (index < 0) return { error: "no_free_slot" };
  if (next[area][index]) next[area][index].quantity += quantity;
  else next[area][index] = { itemId, quantity };
  next.version++;
  const operations = { ...store.operations, [opKey]: fingerprint };
  for (const key of Object.keys(operations).slice(0, -1000))
    delete operations[key];
  commit({
    ...store,
    inventories: { ...store.inventories, [key]: next },
    operations,
  });
  return {
    inventory: inventoryView(accountId, characterId),
    item: copy(item),
    replayed: false,
  };
}
/** Account deletion removes private inventory rows and replay identifiers. */
export function forgetInventories(accountId) {
  const inventories = { ...store.inventories },
    operations = { ...store.operations };
  for (const key of Object.keys(inventories))
    if (key.startsWith(accountId + ":")) delete inventories[key];
  for (const [key, value] of Object.entries(operations))
    if (key.startsWith(accountId + ":") || JSON.parse(value)[0] === accountId)
      delete operations[key];
  commit({ ...store, inventories, operations });
}
