/** Stats rules and time accounting. The inventory store commits item use and its effects together. */
export const DEFAULT_STATS_RULES = Object.freeze({
  startEnergy: 100,
  travelCost: 10,
  sprintCost: 2,
  sprintSeconds: 3,
  regenSeconds: 20,
  startComfort: 40,
  comfortFloor: 50,
  comfortLoss: 0.5,
  comfortMinutes: 7,
  bonusStep: 5,
  bonusPercent: 4,
});

const bounds = {
  startEnergy: [0, 100], travelCost: [0, 100], sprintCost: [0, 100],
  sprintSeconds: [0.5, 300], regenSeconds: [0.5, 86400],
  startComfort: [0, 100], comfortFloor: [0, 100], comfortLoss: [0, 100],
  comfortMinutes: [0.1, 1440], bonusStep: [1, 100], bonusPercent: [0, 100],
};

export function parseStatsRules(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const keys = Object.keys(bounds);
  if (Object.keys(raw).length !== keys.length || keys.some(key =>
    !Number.isFinite(raw[key]) || raw[key] < bounds[key][0] || raw[key] > bounds[key][1]
  )) return null;
  return Object.fromEntries(keys.map(key => [key, raw[key]]));
}

const bonusSteps = (comfort, rules) =>
  Math.floor(Math.max(0, comfort - rules.comfortFloor) / rules.bonusStep + 1e-9);

export function comfortBonus(comfort, rules) {
  return bonusSteps(comfort, rules) * rules.bonusPercent;
}

export function settleStats(old, rules, now, recoveryRanges) {
  if (!old) return { energy: rules.startEnergy, comfort: rules.startComfort, at: now };
  if (now <= old.at) return old;
  const intervalMs = rules.comfortMinutes * 60_000;
  const anchor = old.comfortTickAt ?? old.at;
  const ticksAt = time => Math.max(0, Math.floor((time - anchor) / intervalMs));
  const comfortAt = time => Math.min(
    old.comfort,
    Math.max(rules.comfortFloor, old.comfort - ticksAt(time) * rules.comfortLoss),
  );
  let recoveryMs = 0;
  for (const [start, end] of recoveryRanges) {
    const duration = end - start;
    recoveryMs += duration;
    if (!rules.bonusPercent) continue;
    const steps = bonusSteps(comfortAt(start), rules);
    if (!rules.comfortLoss) {
      recoveryMs += duration * steps * rules.bonusPercent / 100;
      continue;
    }
    for (let step = 1; step <= steps; step++) {
      const threshold = rules.comfortFloor + step * rules.bonusStep;
      // A threshold still counts when comfort lands exactly on it.
      const ticksUntilBelow = Math.floor((old.comfort - threshold) / rules.comfortLoss + 1e-9) + 1;
      const thresholdEndsAt = anchor + ticksUntilBelow * intervalMs;
      recoveryMs += Math.max(0, Math.min(duration, thresholdEndsAt - start)) * rules.bonusPercent / 100;
    }
  }
  return {
    ...old,
    energy: Math.min(100, old.energy + recoveryMs / (rules.regenSeconds * 1000)),
    comfort: comfortAt(now),
    comfortTickAt: anchor + ticksAt(now) * intervalMs,
    at: now,
  };
}
