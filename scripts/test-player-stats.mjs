import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { comfortBonus, DEFAULT_STATS_RULES as rules, settleStats } from "../server/player-stats.js";

assert.equal(comfortBonus(54.99, rules), 0);
assert.equal(comfortBonus(55, rules), 4);
assert.equal(comfortBonus(60, rules), 8);
const base = { at: 0, energy: 0, comfort: 40 };
assert.deepEqual(settleStats(base, rules, 420000, []), { at: 420000, energy: 0, comfort: 40, comfortTickAt: 420000 });
const falling = settleStats({ ...base, comfort: 50.5 }, rules, 840000, [[0, 840000]]);
assert.equal(falling.comfort, 50);
assert.equal(falling.energy, 42);
const partial = settleStats({ ...base, comfort: 55.25 }, rules, 200_000, [[0, 200_000]]);
assert.equal(partial.comfort, 55.25);
const crossing = settleStats(partial, rules, 630_000, [[200_000, 630_000]]);
assert.equal(crossing.comfort, 54.75);
assert.ok(Math.abs(crossing.energy - 32.34) < 1e-10);

const data = mkdtempSync(path.join(tmpdir(), "player-stats-"));
const realNow = Date.now;
let time = realNow();
Date.now = () => time;
process.env.DATA_DIR = data;
try {
  const { touchActivity, recoveryRanges, bindStatsPresence } = await import("../server/presence.js");
  const { acceptSprint, sprintCredit } = await import("../server/sprint-energy.js");
  const { statsView, spendEnergy, checkpointStats, setCharacterStat } = await import("../server/inventory-store.js");
  bindStatsPresence(checkpointStats);
  const cat = { accountId: "runner", characterId: "cat" };
  const { accountId, characterId } = cat;
  const view = () => statsView(accountId, characterId).energy;
  touchActivity(accountId, true);
  assert.equal(view(), 100);
  assert.equal(spendEnergy(accountId, characterId, 98), true);
  assert.equal(acceptSprint(cat, false, time), false);
  assert.equal(view(), 2);
  assert.equal(acceptSprint(cat, true, time), true);
  assert.equal(view(), 0);
  assert.equal(sprintCredit(cat), true);
  for (let i = 0; i < 29; i++) {
    time += 100;
    assert.equal(acceptSprint(cat, true, time), true);
  }
  time += 100;
  assert.equal(acceptSprint(cat, true, time), false);
  assert.equal(sprintCredit(cat), false);
  assert.equal(spendEnergy(accountId, characterId, 10), false);

  // The live heartbeat has 45 seconds of life. Only the following 20 seconds
  // recover energy. Reconnecting must settle both portions before resetting it.
  time += 62_000;
  assert.equal(view(), 1);
  touchActivity(accountId, true);
  assert.equal(view(), 1);
  time += 10_000;
  assert.equal(view(), 1);

  const old = time;
  for (let i = 0; i < 14; i++) {
    time += 40_000;
    touchActivity("active", true);
  }
  assert.deepEqual(recoveryRanges("active", old, time), []);
  const { defaultTestMap, sanitizeTestMap, terrainAt } = await import("../server/testmap.js");
  const { tickWaterEnergy, saveWaterRules, waterRules } = await import("../server/water.js");
  const dry = defaultTestMap();
  assert.equal(sanitizeTestMap(dry).map.water, undefined);
  const water = sanitizeTestMap({ ...dry, water: {
    "0,0": 4, "1,0,1,1": 3, "1.5,0,0.5,1": 0, "2,0": 1,
  } }).map.water;
  assert.equal(terrainAt(water, 1.7, .5), 0);
  assert.equal(terrainAt(water, 1.2, .5), 3);
  assert.equal(sanitizeTestMap({ ...dry, water: [] }).map, undefined);
  touchActivity(accountId, true);
  setCharacterStat(accountId, characterId, "energy", 7);
  Object.assign(cat, { x: 1, y: 1 });
  tickWaterEnergy(cat, time, water);
  time += 2999;
  tickWaterEnergy(cat, time, water);
  assert.equal(view(), 7);
  tickWaterEnergy(cat, ++time, water);
  assert.equal(view(), 4);
  cat.x = 2;
  time += 1000;
  tickWaterEnergy(cat, time, water);
  cat.x = 3;
  tickWaterEnergy(cat, time, water);
  cat.x = 1;
  time += 2600;
  tickWaterEnergy(cat, time, water);
  assert.equal(view(), 4);
  time += 6000;
  tickWaterEnergy(cat, time, water);
  assert.equal(view(), 0);
  assert.equal(saveWaterRules({ ...waterRules(), drainDepth: 5 }), null);
  assert.equal(saveWaterRules({ ...waterRules(), drainSeconds: 5 }).drainSeconds, 5);
  console.log("player stats: PASS — decay, comfort bonus, sprint threshold, offline recovery and deep-water depletion");
} finally {
  Date.now = realNow;
  rmSync(data, { recursive: true, force: true });
}
