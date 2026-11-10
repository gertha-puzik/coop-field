/**
 * Общий writeFileAtomic: tmp + rename, без своего mode, без оставшегося .tmp.
 * Копия в server/auth.js и запись 0600 в server/room-config.js остаются.
 *
 * Запуск: node scripts/test-atomic-file.mjs
 */
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileAtomic } from "../server/atomic-file.js";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures += 1;
};

const dir = mkdtempSync(path.join(tmpdir(), "coop-atomic-"));
const file = path.join(dir, "book.json");
try {
  writeFileAtomic(file, "{\"v\":1}");
  check(readFileSync(file, "utf8") === "{\"v\":1}", "первый write читается целиком");
  check(!existsSync(`${file}.tmp`), "после rename временный файл не остаётся");
  writeFileAtomic(file, "{\"v\":2}");
  check(readFileSync(file, "utf8") === "{\"v\":2}", "второй write заменяет цель");
  check(!existsSync(`${file}.tmp`), "второй rename тоже забирает .tmp");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

function src(rel) {
  return readFileSync(path.join(root, rel), "utf8");
}

for (const rel of [
  "server/accounts.js",
  "server/avatars.js",
  "server/runtime-config.js",
  "server/sprites.js",
  "server/testmap.js",
  "server/persist.js",
]) {
  const text = src(rel);
  check(text.includes('from "./atomic-file.js"'), `${rel} импортирует общий хелпер`);
  check(!text.includes("function writeFileAtomic"), `${rel} больше не объявляет свою копию`);
}

check(src("server/auth.js").includes("function writeFileAtomic"), "auth.js оставил свою копию");
check(
  src("server/room-config.js").includes("mode: 0o600"),
  "room-config.js по-прежнему пишет со своим mode 0o600",
);

console.log(failures === 0 ? "\nPASS: atomic file" : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
