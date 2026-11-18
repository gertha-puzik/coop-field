import { spendEnergy, statsRules } from "./inventory-store.js";

// Only consecutive accepted movement packets count toward a paid running interval.
const MAX_PACKET_GAP_MS = 250;
const sessions = new WeakMap();

export function sprintCredit(cat) {
  return (sessions.get(cat)?.remaining ?? 0) > 0;
}

export function acceptSprint(cat, requested, now) {
  if (!cat.accountId || !cat.characterId) return requested;
  let session = sessions.get(cat);
  if (session?.last !== undefined) {
    const gap = now - session.last;
    if (gap >= 0 && gap <= MAX_PACKET_GAP_MS) session.remaining -= gap;
    session.last = undefined;
  }
  if (!requested) return false;
  if (!session || session.remaining <= 0) {
    const rules = statsRules();
    if (!spendEnergy(cat.accountId, cat.characterId, rules.sprintCost, now)) return false;
    session = { remaining: rules.sprintSeconds * 1000 };
    sessions.set(cat, session);
  }
  session.last = now;
  return true;
}
