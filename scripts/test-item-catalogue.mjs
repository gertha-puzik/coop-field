/** Isolated store contract: catalogue metadata, bounded stacks, deletion and atomic bulk grants. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const data = mkdtempSync(path.join(tmpdir(), "coop-item-catalogue-"));
process.env.DATA_DIR = data;
const store = await import("../server/inventory-store.js");
const spec = {
  id: "cap-test",
  name: "Стопка",
  description: "Краткое описание",
  category: "decor",
  maxStack: 3,
  weight: 0.01,
  sprite: "/items/nugget.png",
  glows: true,
  glowIntensity: 1.5,
  glowPeriod: 8,
  sparkle: true,
};
const view = (a = "a") => store.inventoryView(a, "char"),
  grant = (a, n) =>
    store.grantItems("admin", a, "char", {
      itemId: spec.id,
      quantity: n,
      operationId: crypto.randomUUID(),
    });
const total = (v) =>
  [...v.bag, ...v.hotbar].reduce((n, s) => n + (s?.quantity || 0), 0);
try {
  assert(store.saveItem(spec).item);
  assert.equal(store.deleteItem("constructor").error,"item_not_found");
  assert.equal(store.grantItems("admin","a","char",{itemId:"constructor",quantity:1,operationId:crypto.randomUUID()}).error,"item_not_found");
  for (const invalid of [
    { description: "x".repeat(201) },
    { category: "bogus" },
    { maxStack: 0 },
    { maxStack: 1.5 },
    { maxStack: 10001 },
  ])
    assert.equal(store.saveItem({ ...spec, ...invalid }).error, "invalid_item");
  assert.equal(store.saveItem({ ...spec, create: true }).error, "item_exists");
  assert(
    store.saveItem({
      id: spec.id,
      name: spec.name,
      weight: spec.weight,
      sprite: spec.sprite,
    }).item,
  );
  assert.equal(
    store.itemById(spec.id).maxStack,
    3,
    "old clients preserve metadata",
  );
  assert.equal(store.itemById(spec.id).description, spec.description);
  assert(!grant("a", 20).error);
  assert.deepEqual(
    view()
      .bag.filter(Boolean)
      .map((s) => s.quantity),
    [3, 3, 3, 3, 3, 3, 2],
  );
  let out = store.moveStack("a", "char", {
    version: view().version,
    from: { area: "bag", index: 0 },
    to: { area: "hotbar", index: 0 },
  });
  assert(!out.error);
  out = store.moveStack("a", "char", {
    version: view().version,
    from: { area: "bag", index: 1 },
    to: { area: "bag", index: 6 },
  });
  assert(!out.error);
  assert.equal(view().bag[1].quantity, 2);
  assert.equal(view().bag[6].quantity, 3);
  assert.equal(total(view()), 20);
  const before = view();
  assert.equal(
    store.saveItem({ ...spec, maxStack: 1 }).error,
    "stack_limit_in_use",
  );
  assert.deepEqual(view(), before, "a cap change which cannot fit is atomic");
  assert(store.saveItem({ ...spec, maxStack: 2 }).item);
  assert.equal(total(view()), 20);
  assert(
    [...view().bag, ...view().hotbar]
      .filter(Boolean)
      .every((s) => s.quantity <= 2),
  );
  assert(view().version > before.version);
  const act = (a, raw) =>
    store.worldItemAction(a, "char", "test", {
      version: view(a).version,
      ...raw,
    });
  out = act("a", {
    action: "drop",
    from: { area: "bag", index: 1 },
    x: 2,
    y: 2,
  });
  assert(!out.error);
  let ground = store.worldItemState("a", "char", "test").ground[0];
  out = act("a", { action: "mouth", id: ground.id });
  assert(!out.error);
  assert.equal(
    act("a", { action: "stash", to: { area: "hotbar", index: 0 } }).error,
    "stack_full",
  );
  assert(view().mouth);
  assert(!act("a", { action: "stash" }).error);
  assert.equal(total(view()), 20);
  // Bag-only pickup must use a free slot, not exceed a full stack.
  assert(
    !act("a", {
      action: "drop",
      from: { area: "hotbar", index: 0 },
      x: 3,
      y: 3,
    }).error,
  );
  ground = store.worldItemState("a", "char", "test").ground[0];
  assert(!act("a", { action: "take", id: ground.id }).error);
  assert(
    [...view().bag, ...view().hotbar]
      .filter(Boolean)
      .every((s) => s.quantity <= 2),
  );
  assert.equal(total(view()), 20);
  const op = crypto.randomUUID(),
    rows = [{ itemId: spec.id, quantity: 3 }],
    recipients = [
      { accountId: "b", characterId: "char" },
      { accountId: "c", characterId: "char" },
    ];
  assert(!store.grantItemBatch("admin", recipients, rows, "Награда", op).error);
  assert.equal(total(view("b")), 3);
  assert.equal(total(view("c")), 3);
  assert.equal(
    store.grantItemBatch("admin", recipients, rows, "Награда", op).replayed,
    true,
  );
  assert.equal(total(view("b")), 3);
  assert.equal(
    store.grantItemBatch("admin", recipients, rows, "Другое", op).error,
    "operation_conflict",
  );
  const beforeB = view("b"),
    beforeA = view();
  assert.equal(
    store.grantItemBatch(
      "admin",
      [
        { accountId: "b", characterId: "char" },
        { accountId: "a", characterId: "char" },
      ],
      [{ itemId: spec.id, quantity: 25 }],
      "",
      crypto.randomUUID(),
    ).error,
    "no_free_slot",
  );
  assert.deepEqual(view("b"), beforeB);
  assert.deepEqual(view(), beforeA);
  assert(!store.deleteItem(spec.id).error);
  assert(!store.itemCatalogue().some((i) => i.id === spec.id));
  assert(
    view().items.some(
      (i) => i.id === spec.id && i.description === spec.description,
    ),
  );
  assert.equal(total(view()), 20);
  assert.equal(grant("b", 1).error, "item_not_found");
  assert.equal(store.saveItem(spec).error, "item_deleted");
  store.deleteItem("nugget");
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const s=await import('./server/inventory-store.js'); console.log(JSON.stringify(s.itemCatalogue()));`,
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, DATA_DIR: data },
      encoding: "utf8",
    },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(
    JSON.parse(probe.stdout.trim()),
    [],
    "deleted seed does not return after restart",
  );
  store.forgetInventories("b");
  const persisted = JSON.parse(
    readFileSync(path.join(data, "inventories.json"), "utf8"),
  );
  assert(
    !persisted.operations[`admin:${op}`],
    "deletion clears bulk replay records involving the account",
  );
  console.log(
    "item catalogue: PASS — metadata, stack caps, moves/pickup/stash, atomic bulk grants, legacy edits, deletion and restart",
  );
} finally {
  rmSync(data, { recursive: true, force: true });
}
