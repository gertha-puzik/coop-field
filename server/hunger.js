/**
 * Hunger-games room skeleton: no invented win rules. The room is an open
 * grid like a grotto; this module only holds an idle round slot so a later
 * wave can attach events without reshaping join/field.
 */
function hungerState(room) {
  if (!room.hunger) room.hunger = { round: 0, phase: "idle" };
  return room.hunger;
}

export { hungerState };
