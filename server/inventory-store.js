/** Server-authoritative item catalogue and per-character inventories. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { DEFAULT_STATS_RULES, parseStatsRules, settleStats, comfortBonus } from "./player-stats.js";
import { recoveryRanges, presenceOf } from "./presence.js";
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
export const statsRules = () => store.statsRules || DEFAULT_STATS_RULES;
const persistedStats = (key, now, rules = statsRules()) => {
  const old = store.playerStats?.[key];
  const accountId = key.slice(0, key.indexOf(":"));
  return settleStats(old, rules, now, old ? recoveryRanges(accountId, old.at, now) : []);
};
function setPlayerStats(key, stats) {
  commit({ ...store, playerStats: { ...store.playerStats, [key]: stats } });
}

export function saveStatsRules(raw) {
  const rules = parseStatsRules(raw);
  if (!rules) return null;
  const now = Date.now();
  const previous = statsRules();
  const decayChanged = rules.comfortMinutes !== previous.comfortMinutes ||
    rules.comfortLoss !== previous.comfortLoss || rules.comfortFloor !== previous.comfortFloor;
  const playerStats = Object.fromEntries(Object.keys(store.playerStats || {}).map(key => {
    const stats = persistedStats(key, now);
    return [key, decayChanged ? { ...stats, comfortTickAt: now } : stats];
  }));
  commit({ ...store, statsRules: rules, playerStats });
  return rules;
}

export function checkpointStats(accountId, now, heartbeat) {
  const row = store.playerStats;
  const keys = Object.keys(row || {}).filter(key => key.startsWith(accountId + ":") &&
    now > row[key].at && (!heartbeat || now - row[key].at >= 20_000 ||
      ["away", "resting"].includes(presenceOf(accountId, now))));
  if (!keys.length) return;
  const playerStats = { ...row };
  for (const key of keys) playerStats[key] = persistedStats(key, now);
  commit({ ...store, playerStats });
}

export function statsView(accountId, characterId, now = Date.now()) {
  const key = keyOf(accountId, characterId);
  const rules = statsRules();
  const stats = persistedStats(key, now, rules);
  if (!store.playerStats?.[key]) setPlayerStats(key, stats);
  return {
    energy: stats.energy, comfort: stats.comfort,
    bonus: comfortBonus(stats.comfort, rules),
    recovering: ["away", "resting"].includes(presenceOf(accountId, now)),
    rules,
  };
}

export function itemUseHistory(accountId, characterId, offset) {
  const history = store.playerStats?.[keyOf(accountId, characterId)]?.history || [];
  const end = offset + 30;
  return { entries: history.slice(offset, end), nextOffset: end < history.length ? end : null };
}

export function spendEnergy(accountId, characterId, cost, now = Date.now()) {
  if (!accountId || !characterId || cost === 0) return true;
  const key = keyOf(accountId, characterId);
  const stats = persistedStats(key, now);
  if (stats.energy < cost) return false;
  setPlayerStats(key, { ...stats, energy: stats.energy - cost });
  return true;
}

export function setCharacterStat(accountId, characterId, stat, value) {
  if ((stat !== "energy" && stat !== "comfort") || !Number.isFinite(value) || value < 0 || value > 100)
    return false;
  const key = keyOf(accountId, characterId);
  const now = Date.now();
  const stats = persistedStats(key, now);
  setPlayerStats(key, {
    ...stats,
    [stat]: value,
    ...(stat === "comfort" ? { comfortTickAt: now } : {}),
  });
  return true;
}

export const ITEM_CATEGORIES = [
  "food",
  "resources",
  "materials",
  "consumables",
  "special",
  "decor",
  "other",
];
export const itemCatalogue = ({ includeDeleted = false } = {}) =>
  Object.values(store.items)
    .filter((i) => includeDeleted || !i.deletedAt)
    .map(copy);
const stackLimit = (item) => item?.maxStack ?? 10000;
function addToSlots(
  inventory,
  itemId,
  quantity,
  areas = ["bag", "hotbar"],
  items = store.items,
) {
  const limit = stackLimit(items[itemId]);
  for (const area of areas)
    for (const stack of inventory[area]) {
      if (stack?.itemId !== itemId || stack.quantity >= limit) continue;
      const amount = Math.min(quantity, limit - stack.quantity);
      stack.quantity += amount;
      quantity -= amount;
      if (!quantity) return true;
    }
  for (const area of areas)
    for (let i = 0; i < inventory[area].length; i++) {
      if (inventory[area][i]) continue;
      const amount = Math.min(quantity, limit);
      inventory[area][i] = { itemId, quantity: amount };
      quantity -= amount;
      if (!quantity) return true;
    }
  return false;
}
export function deleteItem(id) {
  const item = Object.hasOwn(store.items, id) ? store.items[id] : null;
  if (!item || item.deletedAt) return { error: "item_not_found", status: 404 };
  commit({
    ...store,
    items: { ...store.items, [id]: { ...item, deletedAt: Date.now() } },
  });
  return { item: copy(item) };
}
export const itemById = (id) =>
  Object.hasOwn(store.items, id) ? copy(store.items[id]) : null;
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
    items: itemCatalogue({ includeDeleted: true }),
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
  if (store.items[id]?.deletedAt) return { error: "item_deleted" };
  if (raw.create === true && store.items[id])
    return { error: "item_exists", status: 409 };
  const description = raw.description ?? store.items[id]?.description ?? "";
  const category = raw.category ?? store.items[id]?.category ?? "other";
  const maxStack = raw.maxStack ?? store.items[id]?.maxStack ?? 10000;
  if (
    typeof description !== "string" ||
    description.length > 200 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(description) ||
    !ITEM_CATEGORIES.includes(category) ||
    !Number.isInteger(maxStack) ||
    maxStack < 1 ||
    maxStack > 10000
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
  const energyRestore = raw.energyRestore ?? store.items[id]?.energyRestore ?? 0;
  const comfortRestore = raw.comfortRestore ?? store.items[id]?.comfortRestore ?? 0;
  if ([energyRestore, comfortRestore].some(value => !Number.isFinite(value) || value < 0 || value > 100))
    return { error: "invalid_item" };
  const item = {
      energyRestore,
      comfortRestore,
      id,
      name,
      weight,
      sprite,
      description: description.trim(),
      category,
      maxStack,
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
  const inventories = copy(store.inventories);
  for (const inventory of Object.values(inventories)) {
    let overflow = 0;
    for (const stack of [...inventory.bag, ...inventory.hotbar])
      if (stack?.itemId === id && stack.quantity > maxStack) {
        overflow += stack.quantity - maxStack;
        stack.quantity = maxStack;
      }
    if (overflow) {
      if (!addToSlots(inventory, id, overflow, ["bag", "hotbar"], items))
        return { error: "stack_limit_in_use", status: 409 };
      inventory.version++;
    }
  }
  commit({ ...store, items, inventories });
  return { item: copy(item) };
}
export function useItem(accountId, characterId, raw) {
  const key = keyOf(accountId, characterId);
  const old = store.inventories[key] || empty();
  if (old.version !== raw.version) return { error: "stale_inventory", status: 409 };
  const { area, index } = raw.from || {};
  if (!["bag", "hotbar"].includes(area) || !Number.isInteger(index) || index < 0 || index >= old[area].length)
    return { error: "invalid_slot" };
  const stack = old[area][index];
  if (!stack || stack.itemId !== raw.itemId) return { error: "empty_slot" };
  const item = store.items[stack.itemId];
  if (!item || !(item.energyRestore || item.comfortRestore)) return { error: "not_consumable" };
  const now = Date.now();
  const stats = persistedStats(key, now);
  const energy = Math.min(item.energyRestore || 0, 100 - stats.energy);
  const comfort = Math.min(item.comfortRestore || 0, 100 - stats.comfort);
  if (!(energy || comfort)) return { error: "stats_full" };
  const inventory = copy(old);
  if (--inventory[area][index].quantity === 0) inventory[area][index] = null;
  inventory.version++;
  const next = {
    ...stats,
    energy: stats.energy + energy,
    comfort: stats.comfort + comfort,
    comfortTickAt: stats.comfort <= statsRules().comfortFloor ? now : (stats.comfortTickAt ?? now),
    history: [{ id: randomUUID(), at: now, name: item.name, energy, comfort }, ...(stats.history || [])],
  };
  commit({
    ...store,
    inventories: { ...store.inventories, [key]: inventory },
    playerStats: { ...store.playerStats, [key]: next },
  });
  return { inventory: inventoryView(accountId, characterId) };
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
    let index = next[area].findIndex(
      (row) =>
        row?.itemId === stack.itemId &&
        row.quantity < stackLimit(store.items[stack.itemId]),
    );
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
    const amount = Math.min(
      stack.quantity,
      stackLimit(store.items[stack.itemId]) - other.quantity,
    );
    if (amount <= 0) return { error: "stack_full" };
    other.quantity += amount;
    stack.quantity -= amount;
    if (!stack.quantity) next[from.area][from.index] = null;
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
  const item = Object.hasOwn(store.items, itemId) ? store.items[itemId] : null;
  if (!item || item.deletedAt) return { error: "item_not_found" };
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
  if (!addToSlots(next, itemId, quantity)) return { error: "no_free_slot" };
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
/** Multi-recipient grants are one atomic, replay-safe transaction. */
export function grantItemBatch(
  actorId,
  recipients,
  rows,
  comment,
  operationId,
) {
  if (
    typeof operationId !== "string" ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(operationId)
  )
    return { error: "invalid_operation" };
  if (
    !Array.isArray(recipients) ||
    recipients.length < 1 ||
    recipients.length > 20 ||
    !Array.isArray(rows) ||
    rows.length < 1 ||
    rows.length > 20 ||
    typeof comment !== "string" ||
    comment.length > 200 ||
    /[\u0000-\u001f]/.test(comment)
  )
    return { error: "invalid_request" };
  if (
    recipients.some(
      (r) =>
        !r ||
        typeof r.accountId !== "string" ||
        typeof r.characterId !== "string",
    ) ||
    rows.some((r) => !r || typeof r.itemId !== "string")
  )
    return { error: "invalid_request" };
  if (
    new Set(recipients.map((r) => keyOf(r.accountId, r.characterId))).size !==
    recipients.length
  )
    return { error: "invalid_request" };
  const fingerprint = JSON.stringify(["batch", recipients, rows, comment]),
    opKey = `${actorId}:${operationId}`;
  if (store.operations[opKey])
    return store.operations[opKey] === fingerprint
      ? { replayed: true }
      : { error: "operation_conflict", status: 409 };
  const inventories = { ...store.inventories };
  for (const recipient of recipients) {
    const key = keyOf(recipient.accountId, recipient.characterId),
      inventory = copy(inventories[key] || empty());
    for (const row of rows) {
      const item = Object.hasOwn(store.items, row.itemId)
        ? store.items[row.itemId]
        : null;
      if (!item || item.deletedAt) return { error: "item_not_found" };
      if (
        !Number.isSafeInteger(row.quantity) ||
        row.quantity < 1 ||
        row.quantity > 10000
      )
        return { error: "invalid_quantity" };
      if (
        weightUnits(inventory) + units(item.weight) * row.quantity >
        MAX_WEIGHT * 100
      )
        return { error: "weight_limit" };
      if (!addToSlots(inventory, row.itemId, row.quantity))
        return { error: "no_free_slot" };
    }
    inventory.version++;
    inventories[key] = inventory;
  }
  const operations = { ...store.operations, [opKey]: fingerprint };
  for (const key of Object.keys(operations).slice(0, -1000))
    delete operations[key];
  commit({ ...store, inventories, operations });
  return { replayed: false };
}
/** Account deletion removes private inventory rows and replay identifiers. */
export function forgetInventories(accountId) {
  const inventories = { ...store.inventories },
    operations = { ...store.operations };
  for (const key of Object.keys(inventories))
    if (key.startsWith(accountId + ":")) delete inventories[key];
  for (const [key, value] of Object.entries(operations))
    if (
      key.startsWith(accountId + ":") ||
      JSON.parse(value)[0] === accountId ||
      (JSON.parse(value)[0] === "batch" &&
        JSON.parse(value)[1].some((r) => r.accountId === accountId))
    )
      delete operations[key];
  const playerStats = { ...store.playerStats };
  for (const key of Object.keys(playerStats))
    if (key.startsWith(accountId + ":")) delete playerStats[key];
  commit({ ...store, inventories, operations, playerStats });
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
      index = inventory[area].findIndex(
        (s) =>
          s?.itemId === stack.itemId &&
          s.quantity < stackLimit(store.items[stack.itemId]),
      );
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
    if (other && other.quantity >= stackLimit(store.items[stack.itemId]))
      return { error: "stack_full" };
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
      const item = Object.hasOwn(store.items, row.itemId)
        ? store.items[row.itemId]
        : null;
      if (weightUnits(inventory) + units(item.weight) > MAX_WEIGHT * 100)
        return { error: "weight_limit" };
      if (!addToSlots(inventory, row.itemId, 1, ["bag"]))
        return { error: "no_free_slot" };
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

// Spawn checkpoints, journal and ground items share the inventory transaction.
export function readSpawnState() {
  return copy(store.resourceSpawn ?? { rules: [], limits: {}, log: [] });
}

export function spawnGround(room) {
  return Object.values(store.ground || {}).filter(row => row.room === room).map(copy);
}

export function commitSpawnState(resourceSpawn, added = []) {
  const ground = { ...store.ground };
  for (const row of added) ground[row.id] = row;
  commit({ ...store, ground, resourceSpawn });
}
