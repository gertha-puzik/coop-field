/** Server-authoritative item catalogue and per-character inventories. */
import { randomUUID } from "node:crypto";
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
  if (raw.glows !== undefined && typeof raw.glows !== "boolean")
    return { error: "invalid_item" };
  for (const [key, min, max] of [
    ["glowIntensity", 0, 3],
    ["glowPeriod", 0, 60],
  ]) {
    if (
      raw[key] !== undefined &&
      (!Number.isFinite(raw[key]) ||
        raw[key] < min ||
        raw[key] > max ||
        (key === "glowPeriod" && raw[key] > 0 && raw[key] < 0.5))
    )
      return { error: "invalid_item" };
  }
  if (raw.sparkle !== undefined && typeof raw.sparkle !== "boolean")
    return { error: "invalid_item" };
  const item = {
      id,
      name,
      weight,
      sprite,
      glows: raw.glows ?? store.items[id]?.glows ?? false,
      glowIntensity: raw.glowIntensity ?? store.items[id]?.glowIntensity ?? 1,
      glowPeriod: raw.glowPeriod ?? store.items[id]?.glowPeriod ?? 0,
      sparkle: raw.sparkle ?? store.items[id]?.sparkle ?? false,
    },
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

/** One atomic ownership transaction: inventory, mouth and world never diverge. */
export function worldItemState(accountId, characterId, room) {
  return {
    ground: Object.values(store.ground || {})
      .filter((row) => row.room === room)
      .map(copy),
    mouth: copy(
      store.inventories[keyOf(accountId, characterId)]?.mouth || null,
    ),
  };
}
export function worldItemAction(accountId, characterId, room, raw) {
  const key = keyOf(accountId, characterId),
    old = store.inventories[key] || empty();
  if (raw.version !== old.version)
    return { error: "stale_inventory", status: 409 };
  const inventory = copy(old),
    ground = { ...store.ground };
  if (raw.action === "stash") {
    const stack = inventory.mouth;
    if (!stack) return { error: "empty_mouth" };
    if (raw.expectedItemId && stack.itemId !== raw.expectedItemId)
      return { error: "stale_inventory", status: 409 };
    if (
      weightUnits(inventory) + units(store.items[stack.itemId].weight) >
      MAX_WEIGHT * 100
    )
      return { error: "weight_limit" };
    const area = raw.to?.area || "hotbar";
    if (!["bag", "hotbar"].includes(area)) return { error: "invalid_slot" };
    let index = raw.to?.index;
    if (index === undefined) {
      index = inventory[area].findIndex((s) => s?.itemId === stack.itemId);
      if (index < 0) index = inventory[area].indexOf(null);
    }
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= inventory[area].length
    )
      return { error: "no_free_slot" };
    const other = inventory[area][index];
    if (other && other.itemId !== stack.itemId)
      return { error: "slot_occupied" };
    inventory[area][index] = {
      itemId: stack.itemId,
      quantity: (other?.quantity || 0) + 1,
    };
    inventory.mouth = null;
  } else if (raw.action === "drop") {
    let itemId;
    if (raw.from === "mouth") {
      if (!inventory.mouth) return { error: "empty_mouth" };
      itemId = inventory.mouth.itemId;
      inventory.mouth = null;
    } else {
      const slot = raw.from;
      if (
        !slot ||
        !["bag", "hotbar"].includes(slot.area) ||
        !Number.isInteger(slot.index) ||
        slot.index < 0 ||
        slot.index >= inventory[slot.area].length
      )
        return { error: "invalid_slot" };
      const stack = inventory[slot.area][slot.index];
      if (!stack) return { error: "empty_slot" };
      itemId = stack.itemId;
      if (--stack.quantity === 0) inventory[slot.area][slot.index] = null;
    }
    if (raw.expectedItemId && raw.expectedItemId !== itemId)
      return { error: "stale_inventory", status: 409 };
    if (Object.values(ground).filter((row) => row.room === room).length >= 1000)
      return { error: "ground_full" };
    const id = randomUUID();
    ground[id] = { id, room, itemId, x: raw.x, y: raw.y };
  } else if (raw.action === "mouth" || raw.action === "take") {
    const row = ground[raw.id];
    if (!row || row.room !== room) return { error: "item_gone", status: 409 };
    if (raw.action === "mouth") {
      if (inventory.mouth) return { error: "mouth_full" };
      inventory.mouth = { itemId: row.itemId, quantity: 1 };
    } else {
      const item = store.items[row.itemId];
      if (weightUnits(inventory) + units(item.weight) > MAX_WEIGHT * 100)
        return { error: "weight_limit" };
      let index = inventory.bag.findIndex(
        (stack) => stack?.itemId === row.itemId,
      );
      if (index < 0) index = inventory.bag.indexOf(null);
      if (index < 0) return { error: "no_free_slot" };
      if (inventory.bag[index]) inventory.bag[index].quantity++;
      else inventory.bag[index] = { itemId: row.itemId, quantity: 1 };
    }
    delete ground[row.id];
  } else return { error: "invalid_action" };
  inventory.version++;
  commit({
    ...store,
    ground,
    inventories: { ...store.inventories, [key]: inventory },
  });
  return { inventory: inventoryView(accountId, characterId) };
}
export function transferMouth(sender, recipient, expected) {
  const from = keyOf(sender.accountId, sender.characterId),
    to = keyOf(recipient.accountId, recipient.characterId);
  const a = copy(store.inventories[from] || empty()),
    b = copy(store.inventories[to] || empty());
  if (
    from === to ||
    !a.mouth ||
    a.version !== expected.version ||
    a.mouth.itemId !== expected.itemId
  )
    return { error: "offer_expired", status: 409 };
  if (b.mouth) return { error: "mouth_full" };
  b.mouth = a.mouth;
  a.mouth = null;
  a.version++;
  b.version++;
  commit({
    ...store,
    inventories: { ...store.inventories, [from]: a, [to]: b },
  });
  return { ok: true };
}
