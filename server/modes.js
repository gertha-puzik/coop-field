/**
 * Catalogue of named rooms and access rules. Unknown codes stay open grid
 * (legacy ?room= links). Elision (`test`) is registered-only; beer grottos,
 * combat and hunger stay guest-open. Titles are the human names the picker
 * already used; ids are protocol room codes (normalizeRoomCode).
 */
import { TEST_ROOM } from "./config.js";

const OPEN = "open";
const REGISTERED = "registered";

const MODE_ROOMS = Object.freeze([
  Object.freeze({ id: "grot-1", title: "Пивной грот №1", mode: "beer", access: OPEN, format: "grid" }),
  Object.freeze({ id: "grot-2", title: "Пивной грот №2", mode: "beer", access: OPEN, format: "grid" }),
  Object.freeze({ id: "grot-3", title: "Пивной грот №3", mode: "beer", access: OPEN, format: "grid" }),
  Object.freeze({ id: "demo", title: "Демо", mode: "beer", access: OPEN, format: "grid" }),
  Object.freeze({ id: "combat", title: "Активный бой", mode: "combat", access: OPEN, format: "grid" }),
  Object.freeze({ id: "hunger", title: "Голодные игры", mode: "hunger", access: OPEN, format: "grid" }),
  Object.freeze({ id: TEST_ROOM, title: "Элизия Эйдес", mode: "elision", access: REGISTERED, format: "test" }),
]);

const BY_ID = new Map(MODE_ROOMS.map((r) => [r.id, r]));

function modeOf(code) {
  return BY_ID.get(String(code || "")) || null;
}

function accessOf(code) {
  const hit = modeOf(code);
  return hit ? hit.access : OPEN;
}

function requiresAccount(code) {
  return accessOf(code) === REGISTERED;
}

export { MODE_ROOMS, OPEN, REGISTERED, modeOf, accessOf, requiresAccount };
