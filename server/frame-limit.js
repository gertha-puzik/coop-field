/**
 * Один потолок рассылок на сокет для кадров, у которых не было своего
 * кулдауна: block, space, atmo, atmoset, dummy, dummyMove, dummyGrab,
 * dummyDrop, rab, rabHit.
 *
 * Зазор 50 мс — тот же, что FREE_MOVE_GAP_MS у рассылки freemove
 * (server/movement.js): dummyMove не чаще перетаскивания. Запас 2 кадра,
 * чтобы пара keydown+keyup в одном тике не терялась (scripts/test-ws.mjs
 * шлёт block on и block off подряд, пока удар ещё летит). Лишний кадр
 * молча отбрасывается, как strike при своём кулдауне: нового события нет.
 *
 * Бюджет общий на сокет, не отдельная копия логики на каждый тип кадра.
 */
import { EV } from "./protocol.js";

export const BROADCAST_FRAME_GAP_MS = 50;
export const BROADCAST_FRAME_BURST = 2;

const LIMITED = new Set([
  EV.BLOCK,
  EV.SPACE,
  EV.ATMO,
  EV.ATMOSET,
  EV.DUMMY,
  EV.DUMMY_MOVE,
  EV.DUMMY_GRAB,
  EV.DUMMY_DROP,
  EV.RAB,
  EV.RAB_HIT,
]);

export function isFrameLimited(event) {
  return LIMITED.has(event);
}

/**
 * @param {{ broadcastFrames?: { tokens: number, ts: number } }} ws
 * @param {number} [now]
 * @returns {boolean} true — кадр можно отдать обработчику
 */
export function allowBroadcastFrame(ws, now = Date.now()) {
  const slot = ws.broadcastFrames || (ws.broadcastFrames = {
    tokens: BROADCAST_FRAME_BURST,
    ts: now,
  });
  if (now > slot.ts) {
    const gained = Math.floor((now - slot.ts) / BROADCAST_FRAME_GAP_MS);
    if (gained > 0) {
      slot.tokens = Math.min(BROADCAST_FRAME_BURST, slot.tokens + gained);
      slot.ts += gained * BROADCAST_FRAME_GAP_MS;
    }
  }
  if (slot.tokens < 1) return false;
  slot.tokens -= 1;
  return true;
}
