/** Actual view geometry with isolated browser image metadata; no DOM/GPU required. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const source = fs.readFileSync("src/lib/sim/world-item-frame.ts", "utf8");
const code = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const api = {};
class FakeImage {
  naturalWidth = 60;
  naturalHeight = 30;
}
vm.runInNewContext(code, {
  exports: api,
  Image: FakeImage,
  require: (id) =>
    id.includes("test-field")
      ? { supportLevelAt: () => 2, TERRAIN_LIFT_PX: 26 }
      : { elisionDayTint: () => [1, 1, 1] },
});
const parent = {
  id: "main",
  url: "/cat.png",
  x: 200,
  y: 300,
  w: 180,
  h: 140,
  lift: 30,
  mirror: false,
  rot: 0,
  pose: { scaleX: 1.1, scaleY: 0.7, rot: 0.1, sway: 3, lift: 12 },
};
const world = {
  selfId: 11,
  ground: [{ id: "ground", itemId: "nugget", x: 3, y: 4 }],
  players: [{ id: 11, mouth: { itemId: "nugget", quantity: 1 } }],
};
api.setWorldItemScene(world, [{ id: "nugget", sprite: "/nugget.png" }]);
const frame = {
  controlledId: "main",
  decals: [parent],
  cellW: 100,
  cellH: 150,
  editor: false,
};
const [ground, mouth] = api.appendWorldItems(frame);
assert.equal(ground.w, 30);
assert.equal(ground.h, 15, "authored aspect preserved");
assert.equal(mouth.w, ground.w);
assert.equal(mouth.h, ground.h, "no size reduction in the mouth");
assert.equal(ground.x + ground.w / 2, 300);
assert.equal(ground.y + ground.h, 600);
assert.equal(ground.lift, 52);
assert.equal(
  mouth.attachment.parentId,
  "main",
  "mouth inherits actual model root, weather and depth",
);
const anchor = api.muzzle(parent);
assert.equal(mouth.attachment.x, anchor.x);
assert.equal(mouth.attachment.y + mouth.h / 2, anchor.y);
const right = api.muzzle({ ...parent, mirror: true });
assert(right.x > anchor.x, "turning moves muzzle with model");
const jumping = { ...parent, lift: 150 };
assert.deepEqual(
  api.muzzle(jumping),
  anchor,
  "jump belongs to model root, without duplicate lift",
);
const editor = { ...frame, decals: [parent], editor: true };
assert.equal(api.appendWorldItems(editor).length, 0);
api.markWorldItemDrop(10, 20);
assert(api.consumeWorldItemDrop({ clientX: 10, clientY: 20 }));
assert(!api.consumeWorldItemDrop({ clientX: 10, clientY: 20 }));
console.log(
  "world item view: PASS — size parity, aspect, terrain, posed attachment and click consumption",
);
