import { keyAction } from "../src/lib/sim/keys.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const w = keyAction({ code: "KeyW", key: "ц" });
assert(w?.type === "move" && w.dir === 270, "physical W on Russian");
const a = keyAction({ code: "KeyA", key: "ф" });
assert(a?.type === "move" && a.dir === 180, "physical A");
const s = keyAction({ code: "KeyS", key: "ы" });
assert(s?.type === "move" && s.dir === 90, "physical S");
const d = keyAction({ code: "KeyD", key: "в" });
assert(d?.type === "move" && d.dir === 0, "physical D");

for (const [key, dir] of [
  ["ц", 270],
  ["ф", 180],
  ["ы", 90],
  ["в", 0],
  ["й", 225],
  ["у", 315],
  ["я", 135],
  ["ч", 45],
  ["і", 90],
] as const) {
  const hit = keyAction({ code: "", key });
  assert(hit?.type === "move" && hit.dir === dir, `empty code ${key}`);
  const unidentified = keyAction({ code: "Unidentified", key });
  assert(unidentified?.type === "move" && unidentified.dir === dir, `unidentified ${key}`);
}

assert(keyAction({ code: "", key: "ш" })?.type === "strike", "ш strike");
assert(keyAction({ code: "KeyI", key: "ш" })?.type === "strike", "I code wins");
assert(keyAction({ code: "", key: "о" })?.type === "rot", "о rotate");
assert(keyAction({ code: "", key: "д" })?.type === "rot", "д rotate");
assert(keyAction({ code: "", key: "и" })?.type === "battle", "и battle");
assert(keyAction({ code: "KeyO", key: "o" }) === null, "latin O is not a control");
assert(keyAction({ code: "KeyO", key: "щ" }) === null, "Russian O position is not J");
assert(keyAction({ code: "", key: "w" })?.type === "move", "latin fallback");

console.log("ok: keys, layout fallback");
