/** Actual view geometry with isolated browser image metadata; no DOM/GPU required. */
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createRequire } from "node:module";
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
    id.includes("night-lights")
      ? {
          createNightLightModel: () => ({ update: () => [] }),
          itemGlowAmount: () => 0,
        }
      : id.includes("test-field")
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
  cols: 12,
  rows: 10,
  yaw: 0,
  dayProgress: 3.5,
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

const glowCode = ts.transpileModule(
  fs.readFileSync("src/lib/sim/night-lights.ts", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const glowApi = {};
vm.runInNewContext(glowCode, {
  exports: glowApi,
  require: () => ({ MaterialPluginBase: class {} }),
});
for (const p of [0, 0.5, 1, 1.5, 1.99, 4, NaN]) {
  assert.equal(glowApi.itemGlowAmount(p), 0);
  assert.equal(glowApi.fireflyAmount(p), 0);
}
assert.equal(glowApi.itemGlowAmount(2.7), 1);
assert.equal(glowApi.fireflyAmount(2.7), 0);
assert.equal(glowApi.itemGlowAmount(3.5), 1);
assert.equal(glowApi.fireflyAmount(3.5), 1);
assert(glowApi.itemGlowAmount(3.95) < glowApi.itemGlowAmount(3.8));
const mirrored = { ...parent, mirror: true };
api.setWorldItemScene(world, [
  { id: "nugget", sprite: "/nugget.png", glows: true },
]);
const mirroredFrame = { ...frame, decals: [mirrored] };
const mirroredItems = api.appendWorldItems(mirroredFrame);
assert(mirroredItems.every((i) => i.glows));
assert.equal(mirroredItems[1].mirror, true);
console.log(
  "glow: PASS — day/evening/night transitions, fly visibility and item facing/metadata",
);

let randomState = 123;
const model = glowApi.createNightLightModel(
  () =>
    (randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) /
    4294967296,
);
const valid = (x, z) => x >= 0 && z >= 0 && x <= 1200 && z <= 1500;
const firstLights = model.update(
  { ...mirroredFrame, dayProgress: 3.5 },
  1000,
  "qa-map",
  valid,
  () => 0,
);
assert(firstLights.some((l) => l.kind === "firefly"));
assert(
  firstLights.every(
    (l) =>
      [l.x, l.y, l.z, l.energy].every(Number.isFinite) &&
      l.energy > 0 &&
      l.energy <= 1,
  ),
);
const laterLights = model.update(
  { ...mirroredFrame, dayProgress: 3.5 },
  1005,
  "qa-map",
  valid,
  () => 0,
);
for (const l of firstLights.filter((l) => l.kind === "firefly")) {
  const next = laterLights.find((n) => n.id === l.id);
  if (next)
    assert(
      Math.hypot(next.x - l.x, next.y - l.y, next.z - l.z) < 2,
      "flights move continuously",
    );
}
assert.equal(
  model.update(
    { ...mirroredFrame, dayProgress: 1.5 },
    1100,
    "qa-map",
    valid,
    () => 0,
  ).length,
  0,
);
assert(
  model
    .update(
      { ...mirroredFrame, dayProgress: 2.7 },
      1200,
      "qa-map",
      valid,
      () => 0,
    )
    .every((l) => l.kind === "item"),
);
assert.equal(
  model.update(
    { ...mirroredFrame, editor: true, dayProgress: 3.5 },
    1300,
    "qa-map",
    valid,
    () => 0,
  ).length,
  0,
);
console.log(
  "night lights: PASS — finite bounded sources, smooth paths, daytime/editor off",
);

// Exercise Babylon's real plugin injection, including its fragment uniform declarations.
const load = createRequire(import.meta.url);
const shaderCode = ts.transpileModule(
  fs.readFileSync("src/lib/sim/elision-glow.ts", "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
).outputText;
const shaderApi = {},
  mapKey = {};
vm.runInNewContext(shaderCode, {
  exports: shaderApi,
  require: (id) =>
    id.includes("night-lights")
      ? glowApi
      : id.includes("test-field")
        ? {
            currentTestMap: () => mapKey,
            testPointInIsland: () => true,
            supportLevelAt: () => 0,
            TERRAIN_LIFT_PX: 26,
          }
        : load(id),
});
const { NullEngine } = load("@babylonjs/core/Engines/nullEngine");
const { Scene } = load("@babylonjs/core/scene"),
  { FreeCamera } = load("@babylonjs/core/Cameras/freeCamera"),
  { Vector3 } = load("@babylonjs/core/Maths/math.vector");
const { StandardMaterial } = load("@babylonjs/core/Materials/standardMaterial"),
  { CreatePlane } = load("@babylonjs/core/Meshes/Builders/planeBuilder");
const probeEngine = new NullEngine({ renderWidth: 64, renderHeight: 64 }),
  probeScene = new Scene(probeEngine);
const probeCamera = new FreeCamera("probe", new Vector3(0, 0, -20), probeScene);
probeCamera.setTarget(Vector3.Zero());
probeScene.activeCamera = probeCamera;
const lightView = shaderApi.createWorldGlow(probeScene),
  probeMaterial = new StandardMaterial("probe", probeScene);
probeMaterial.disableLighting = true;
lightView.attach(probeMaterial);
const probeMesh = CreatePlane("probe", { size: 10 }, probeScene);
probeMesh.material = probeMaterial;
await probeMaterial.forceCompilationAsync(probeMesh);
probeScene.render();
const fragment = probeMesh.subMeshes[0].effect.fragmentSourceCode;
assert(
  fragment.includes("uniform vec4 worldGlowLights[24]"),
  "actual StandardMaterial shader declares the light array",
);
assert(
  fragment.includes("worldGlowLights[glowIndex]"),
  "surface illumination is present in the compiled shader",
);
lightView.update(
  {
    ...mirroredFrame,
    cols: 12,
    rows: 10,
    camX: 0,
    camY: 0,
    yaw: 0,
    dayProgress: 3.5,
  },
  1000,
);
probeScene.render();
lightView.destroy();
probeScene.dispose();
probeEngine.dispose();
console.log(
  "world glow shader: PASS — actual Babylon material compilation and light binding",
);
