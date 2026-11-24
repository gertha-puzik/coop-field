import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeFileAtomic } from './atomic-file.js';
import { drainEnergy } from './inventory-store.js';
import { terrainAt, testMap } from './testmap.js';

const file = path.join(DATA_DIR, 'water-rules.json');
const limits = {
  slow1: [30, 0, 99], slow2: [45, 0, 99], slow3: [60, 0, 99], slow4: [80, 0, 99],
  sink1: [10, 0, 99], sink2: [15, 0, 99], sink3: [35, 0, 99], sink4: [45, 0, 99],
  submergedOpacity: [20, 0, 100], swimDepth: [4, 1, 4],
  drainDepth: [3, 1, 4], drainSeconds: [3, 1, 600], drainEnergy: [3, 0, 100],
};

function validate(input) {
  if (!input || typeof input !== 'object') return null;
  const rules = {};
  for (const [key, [, min, max]] of Object.entries(limits)) {
    const value = input[key];
    if (!Number.isInteger(value) || value < min || value > max) return null;
    rules[key] = value;
  }
  return rules;
}

let rules = Object.fromEntries(Object.entries(limits).map(([key, [value]]) => [key, value]));
try {
  // Add percentage defaults to maps deployed before per-depth immersion existed.
  rules = validate({ ...rules, ...JSON.parse(fs.readFileSync(file, 'utf8')) }) ?? rules;
} catch (error) {
  if (error.code !== 'ENOENT') console.warn('Water rules:', error.message);
}

export const waterRules = () => rules;

export function saveWaterRules(input) {
  const next = validate(input);
  if (!next) return null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(file, JSON.stringify(next, null, 2));
  rules = next;
  return next;
}

export function waterDepthFor(cat, water = testMap.water) {
  const x = cat.fm === 1 && Number.isFinite(cat.fx) ? cat.fx + (cat.freeFoot?.dx ?? .5) : cat.x - .5;
  const y = cat.fm === 1 && Number.isFinite(cat.fy) ? cat.fy + (cat.freeFoot?.dy ?? .95) : cat.y - .5;
  return terrainAt(water, x, y);
}

export function tickWaterEnergy(cat, now, water = testMap.water) {
  if (!cat.accountId || !cat.characterId || waterDepthFor(cat, water) < rules.drainDepth || (cat.jp && now < (cat.freeJumpUntil || 0))) {
    cat.waterSince = undefined;
    return;
  }
  cat.waterSince ??= now;
  const interval = rules.drainSeconds * 1000;
  const elapsed = Math.floor((now - cat.waterSince) / interval);
  if (elapsed > 0) {
    drainEnergy(cat.accountId, cat.characterId, elapsed * rules.drainEnergy, now);
    cat.waterSince += elapsed * interval;
  }
}
