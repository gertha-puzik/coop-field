/**
 * Справочник Герты: карточки ссылаются на живые файлы, MAX_PLAYERS совпадает
 * с protocol.ts. Запуск через npm run test:unit (strip-types).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONSTANT_CARDS, MECHANIC_CARDS, HANDBOOK_FILES } from "../src/lib/net/gerta-catalog.ts";
import { MAX_PLAYERS, MOVE_COOLDOWN_MS } from "../src/lib/net/protocol.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function assert(cond: boolean, label: string) {
  if (!cond) throw new Error(label);
}

assert(CONSTANT_CARDS.length >= 10, "constant cards");
assert(MECHANIC_CARDS.length >= 8, "mechanic cards");
assert(
  CONSTANT_CARDS.some((c) => c.name === "MAX_PLAYERS" && c.value === String(MAX_PLAYERS)),
  "MAX_PLAYERS live",
);
assert(
  CONSTANT_CARDS.some((c) => c.name === "MOVE_COOLDOWN_MS" && c.value === String(MOVE_COOLDOWN_MS)),
  "MOVE_COOLDOWN live",
);
assert(
  CONSTANT_CARDS.filter((c) => !c.editable).every((c) => c.apply === "never"),
  "invariants are not knobs",
);
for (const rel of HANDBOOK_FILES) {
  assert(fs.existsSync(path.join(ROOT, rel)), `missing ${rel}`);
}
console.log("ok: gerta handbook catalog");
