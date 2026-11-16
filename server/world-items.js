/** Live-room authority for world items. Transfers commit only after recipient consent. */
import { randomUUID } from "node:crypto";
import { rooms } from "./room.js";
import { withTestLocation, TEST_OBST_CELLS } from "./testmap.js";
import { testPointInIsland } from "./world.js";
import { locationFromRoom } from "./location-world.js";
import {
  inventoryView,
  worldItemState,
  worldItemAction,
  transferMouth,
} from "./inventory-store.js";
const offers = new Map();
const range = 1.5;
export const ITEM_REACH_PX = 70;
const itemClose = (a, b) =>
  Math.hypot((a.x - b.x) * 100, (a.y - b.y) * 150) <= ITEM_REACH_PX;
function live(accountId, characterId) {
  for (const room of rooms.values()) {
    if (room.fmt !== "test") continue;
    for (const [ws, cat] of room.sockets)
      if (
        ws.account?.id === accountId &&
        cat.characterId === characterId &&
        ws.readyState === 1
      )
        return { accountId, characterId, room, cat };
  }
  return null;
}
function byCat(room, id) {
  for (const [ws, cat] of room.sockets)
    if (cat.id === id && ws.account && cat.characterId && ws.readyState === 1)
      return {
        accountId: ws.account.id,
        characterId: cat.characterId,
        room,
        cat,
      };
  return null;
}
const foot = (cat) => ({
  x: (cat.fm ? cat.fx : cat.x - 1) + (cat.freeFoot?.dx ?? 0.45),
  y: (cat.fm ? cat.fy : cat.y - 1) + (cat.freeFoot?.dy ?? 0.95),
});
const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) <= range;
const identity = (a) => `${a.accountId}:${a.characterId}`;
function validOffer(offer) {
  const a = live(offer.from.accountId, offer.from.characterId),
    b = live(offer.to.accountId, offer.to.characterId);
  if (
    !a ||
    !b ||
    offer.until < Date.now() ||
    a.room !== b.room ||
    a.cat.id !== offer.from.catId ||
    b.cat.id !== offer.to.catId ||
    !close(foot(a.cat), foot(b.cat))
  )
    return false;
  const inv = inventoryView(a.accountId, a.characterId);
  return (
    inv.version === offer.version &&
    inv.mouth?.itemId === offer.itemId &&
    !worldItemState(b.accountId, b.characterId, b.room.code).mouth
  );
}
function prune() {
  for (const [id, offer] of offers) if (!validOffer(offer)) offers.delete(id);
}
export function worldItemsView(accountId, characterId) {
  const self = live(accountId, characterId);
  if (!self)
    return { room: null, selfId: null, ground: [], players: [], offers: [] };
  prune();
  const state = worldItemState(accountId, characterId, self.room.code);
  return {
    room: self.room.code,
    selfId: self.cat.id,
    ...state,
    players: [...self.room.sockets]
      .filter(([ws, c]) => ws.account && c.characterId)
      .map(([ws, c]) => ({
        id: c.id,
        name: c.login,
        ...foot(c),
        mouth: worldItemState(ws.account.id, c.characterId, self.room.code)
          .mouth,
      })),
    offers: [...offers.values()]
      .filter((o) => identity(o.to) === identity(self))
      .map((o) => ({
        id: o.id,
        fromId: o.from.catId,
        name: o.name,
        itemId: o.itemId,
        until: o.until,
      })),
  };
}
export function actOnWorldItem(accountId, characterId, raw) {
  const self = live(accountId, characterId);
  if (!self) return { error: "not_on_field" };
  prune();
  const state = worldItemState(accountId, characterId, self.room.code);
  if (raw.action === "offer") {
    const target = byCat(self.room, raw.targetId),
      inv = inventoryView(accountId, characterId);
    if (
      !target ||
      identity(target) === identity(self) ||
      !close(foot(self.cat), foot(target.cat))
    )
      return { error: "too_far" };
    if (!state.mouth) return { error: "empty_mouth" };
    if (
      worldItemState(target.accountId, target.characterId, self.room.code).mouth
    )
      return { error: "mouth_full" };
    if (
      [...offers.values()].some(
        (o) =>
          identity(o.from) === identity(self) ||
          identity(o.to) === identity(target),
      )
    )
      return { error: "offer_pending" };
    const id = randomUUID();
    offers.set(id, {
      id,
      from: { ...self, room: undefined, cat: undefined, catId: self.cat.id },
      to: { ...target, room: undefined, cat: undefined, catId: target.cat.id },
      version: inv.version,
      itemId: state.mouth.itemId,
      name: self.cat.login,
      until: Date.now() + 20000,
    });
    return { ok: true };
  }
  if (raw.action === "accept" || raw.action === "cancel") {
    const offer = offers.get(raw.offerId);
    if (!offer || identity(offer.to) !== identity(self))
      return { error: "offer_expired", status: 409 };
    offers.delete(offer.id);
    return raw.action === "cancel"
      ? { ok: true }
      : transferMouth(offer.from, offer.to, offer);
  }
  if (raw.action === "stash")
    return worldItemAction(accountId, characterId, self.room.code, raw);
  if (raw.action === "release")
    raw = { ...raw, action: "drop", from: "mouth", ...foot(self.cat) };
  if (raw.action === "drop") {
    if (!Number.isFinite(raw.x) || !Number.isFinite(raw.y))
      return { error: "invalid_point" };
    const valid = withTestLocation(
      locationFromRoom(self.room.code),
      () =>
        testPointInIsland(raw.x, raw.y) &&
        !TEST_OBST_CELLS.has(`${Math.floor(raw.x)},${Math.floor(raw.y)}`),
    );
    if (!valid) return { error: "invalid_point" };
  } else {
    const row = state.ground.find((row) => row.id === raw.id);
    if (!row) return { error: "item_gone", status: 409 };
    if (!itemClose(foot(self.cat), row)) return { error: "too_far" };
  }
  return worldItemAction(accountId, characterId, self.room.code, raw);
}
