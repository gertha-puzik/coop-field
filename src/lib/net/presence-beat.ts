/**
 * Фоновый heartbeat присутствия для Элизии.
 * where=site — на страницах сайта; where=game — на /game/.
 * Слушает pointer/keydown/visibility для active-флага (снятие AFK).
 */
import { httpPresenceHeartbeat, type PresenceWhere } from "./http-presence";

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === "elyria";
const INTERVAL_MS = 20_000;

let timer: ReturnType<typeof setInterval> | null = null;
let where: PresenceWhere = "site";
let lastActiveAt = Date.now();
let started = false;

function markActive() {
  lastActiveAt = Date.now();
}

async function beat() {
  if (!IS_ELYRIA) return;
  const active = Date.now() - lastActiveAt < INTERVAL_MS * 2;
  try {
    await httpPresenceHeartbeat(where, active);
  } catch {
    /* сеть — тихий пропуск */
  }
}

function onVis() {
  if (document.visibilityState === "visible") {
    markActive();
    void beat();
  }
}

/** Запустить (или сменить where) heartbeat вкладки. */
export function startPresenceBeat(next: PresenceWhere = "site") {
  if (!IS_ELYRIA) return;
  where = next;
  markActive();
  if (!started) {
    started = true;
    window.addEventListener("pointerdown", markActive, { passive: true });
    window.addEventListener("keydown", markActive);
    document.addEventListener("visibilitychange", onVis);
  }
  if (timer) clearInterval(timer);
  void beat();
  timer = setInterval(() => void beat(), INTERVAL_MS);
}

export function stopPresenceBeat() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
