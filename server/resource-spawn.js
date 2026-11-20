import { randomInt, randomUUID } from "node:crypto";
import { knownLocation, locationCatalogue, locationRoom, passageContains } from "./location-world.js";
import { withTestLocation, testMap, TEST_WIDTH, TEST_HEIGHT, TEST_OBST_CELLS } from "./testmap.js";
import { testPointInIsland } from "./world.js";
import { commitSpawnState, readSpawnState, spawnGround, itemCatalogue } from "./inventory-store.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;
const MAX_RULES = 50;
const MAX_LOG = 200;
const MINUTE = 60000;
// Moscow uses UTC+03:00 year-round.
const MOSCOW_OFFSET = 180 * MINUTE;
const DAY = 1440 * MINUTE;
const int = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;
const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function nextSpawnAt(schedule, now) {
  if (schedule.mode === "interval") return now + schedule.minutes * MINUTE;
  if (schedule.mode === "random") return now + randomInt(schedule.min, schedule.max + 1) * MINUTE;
  const midnight = Math.floor((now + MOSCOW_OFFSET) / DAY) * DAY - MOSCOW_OFFSET;
  const slots = schedule.times.map(value => {
    const [hours, minutes] = value.split(":").map(Number);
    return midnight + (hours * 60 + minutes) * MINUTE;
  });
  return slots.find(time => time > now) ?? slots[0] + DAY;
}

function parseSchedule(raw) {
  if (raw?.mode === "interval" && int(raw.minutes, 1, 10080))
    return { mode: raw.mode, minutes: raw.minutes };
  if (raw?.mode === "random" && int(raw.min, 1, 10080) && int(raw.max, raw.min, 10080))
    return { mode: raw.mode, min: raw.min, max: raw.max };
  if (raw?.mode === "daily" && Array.isArray(raw.times) && raw.times.length &&
      raw.times.length <= 24 && raw.times.every(time => typeof time === "string" && clock.test(time)))
    return { mode: raw.mode, times: [...new Set(raw.times)].sort() };
  return null;
}

function parseRule(raw, catalogue) {
  const name = typeof raw?.name === "string" ? raw.name.trim() : "";
  const schedule = parseSchedule(raw?.schedule);
  if (!name || name.length > 80 || typeof raw.enabled !== "boolean" || !schedule ||
      !int(raw.min, 1, MAX_LIMIT) || !int(raw.max, raw.min, MAX_LIMIT) ||
      !Array.isArray(raw.locations) || !raw.locations.length || raw.locations.length > 100 ||
      !raw.locations.every(id => Number.isSafeInteger(id) && knownLocation(id)) ||
      !Array.isArray(raw.items) || !raw.items.length || raw.items.length > 100 ||
      !raw.items.every(row => row && catalogue.has(row.itemId) && int(row.weight, 0, 1000)) ||
      !raw.items.some(row => row.weight > 0) ||
      new Set(raw.items.map(row => row.itemId)).size !== raw.items.length) return null;
  return { name, enabled: raw.enabled, schedule, min: raw.min, max: raw.max,
    locations: [...new Set(raw.locations)], items: raw.items.map(({ itemId, weight }) => ({ itemId, weight })) };
}

function availableItems() {
  return new Map(itemCatalogue().map(item => [item.id, item.name]));
}

export function spawnOverview() {
  const state = readSpawnState();
  return { ...state, defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT,
    items: [...availableItems()].map(([id, name]) => ({ id, name })),
    locations: locationCatalogue() };
}

function findPoint(occupied) {
  for (let tries = 0; tries < 600; tries++) {
    const x = randomInt(TEST_WIDTH) + randomInt(25, 76) / 100;
    const y = randomInt(TEST_HEIGHT) + randomInt(25, 76) / 100;
    if (TEST_OBST_CELLS.has(`${Math.floor(x)},${Math.floor(y)}`) ||
        !testPointInIsland(x, y) ||
        (testMap.passages || []).some(passage => passageContains(passage, x, y, 0.15)) ||
        occupied.some(row => Math.abs(row.x - x) < 0.4 && Math.abs(row.y - y) < 0.4)) continue;
    return { x, y };
  }
  return null;
}

function pickItem(items, totalWeight) {
  let draw = randomInt(totalWeight);
  for (const row of items) {
    draw -= row.weight;
    if (draw < 0) return row.itemId;
  }
}

function runRule(state, rule, source, now, catalogue, staged, seenGround) {
  const pool = rule.items.filter(row => row.weight > 0 && catalogue.has(row.itemId));
  const weight = pool.reduce((sum, item) => sum + item.weight, 0);
  for (const locationId of rule.locations) {
    const room = locationRoom(locationId);
    const ground = seenGround.get(room) || spawnGround(room);
    seenGround.set(room, ground);
    const limit = state.limits[locationId] ?? DEFAULT_LIMIT;
    const free = Math.max(0, Math.min(limit - ground.filter(row => row.spawned === true).length, 1000 - ground.length));
    const requested = randomInt(rule.min, rule.max + 1);
    const rows = [];
    let reason = !weight ? "no_items" : !free ? "limit" : "";
    if (!reason) {
      try {
        withTestLocation(locationId, () => {
          for (let i = 0; i < Math.min(free, requested); i++) {
            const point = findPoint(ground.concat(rows));
            if (!point) { reason = "no_space"; break; }
            rows.push({ id: randomUUID(), room, itemId: pickItem(pool, weight), ...point, spawned: true });
          }
        });
      } catch (error) {
        console.warn("resource spawn map unavailable:", locationId, error.message);
        reason = "map_unavailable";
      }
    }
    staged.push(...rows);
    ground.push(...rows);
    const counts = new Map();
    for (const row of rows) counts.set(row.itemId, (counts.get(row.itemId) || 0) + 1);
    state.log.unshift({ id: randomUUID(), at: now, locationId, source, ruleName: rule.name,
      requested, reason: reason || (rows.length < requested ? "limit" : ""),
      items: [...counts].map(([itemId, count]) => ({ itemId, name: catalogue.get(itemId), count })) });
  }
  state.log = state.log.slice(0, MAX_LOG);
}

export function changeSpawnSettings(raw, now = Date.now()) {
  const state = readSpawnState();
  const index = state.rules.findIndex(rule => rule.id === raw?.id);
  const added = [];
  if (raw?.action === "limit") {
    if (!Number.isSafeInteger(raw.locationId) || !knownLocation(raw.locationId) || !int(raw.limit, 0, MAX_LIMIT))
      return { error: "invalid_spawn" };
    state.limits[raw.locationId] = raw.limit;
  } else if (raw?.action === "save") {
    const data = parseRule(raw.rule, availableItems());
    if (!data || (raw.id != null && index < 0) || (index < 0 && state.rules.length >= MAX_RULES))
      return { error: "invalid_spawn" };
    const old = state.rules[index];
    const keepTime = old?.enabled && JSON.stringify(old.schedule) === JSON.stringify(data.schedule);
    const rule = { ...data, id: old?.id ?? randomUUID(),
      next: !data.enabled ? null : keepTime ? old.next : nextSpawnAt(data.schedule, now) };
    if (old) state.rules[index] = rule;
    else state.rules.push(rule);
  } else if (index >= 0 && raw.action === "remove") {
    state.rules.splice(index, 1);
  } else if (index >= 0 && raw.action === "force") {
    runRule(state, state.rules[index], "manual", now, availableItems(), added, new Map());
  } else return { error: "invalid_spawn" };
  commitSpawnState(state, added);
  return { ok: true };
}

export function tickResourceSpawn(now = Date.now(), skipMissed = false) {
  const state = readSpawnState();
  const due = state.rules.filter(rule => rule.enabled && rule.next <= now);
  if (!due.length) return;
  const added = [];
  const ground = new Map();
  const catalogue = availableItems();
  for (const rule of due) {
    if (!skipMissed) runRule(state, rule, "scheduled", now, catalogue, added, ground);
    rule.next = nextSpawnAt(rule.schedule, now);
  }
  commitSpawnState(state, added);
}
