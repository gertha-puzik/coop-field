#!/usr/bin/env node
// Раннер юнит-тестов движка (без npm-зависимостей, только node).
// Тесты — .mts/.ts с типами: исполняются через node --experimental-strip-types
// (появился в node 22.6; на 23.6+ флаг уже не нужен, но остаётся совместим).
// Локальный node < 22.6 НЕ роняет прогон: печатаем SKIP и выходим 0.
// CI гоняет по-настоящему (ci.yml → node-version 22).
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [major, minor] = process.versions.node.split(".").map(Number);
const supportsStripTypes = major > 22 || (major === 22 && minor >= 6);

// Список тестов расширяемый: положи самодостаточный файл в scripts/ (без
// поднятого сервера и без сети — это юнит-слой) и добавь сюда одну строку.
const TESTS = [
  "scripts/test-keys.mts",
  "scripts/test-remote-aim.mts",
  "scripts/test-move-book.ts",
  "scripts/test-elev-rules.mts",
  "scripts/test-handbook.mts",
  "scripts/test-elision-scene.mts",
  // Волна C (агент-спека): регресс-пакеты слоёв, доступных без стенда.
  "scripts/test-combat-legacy.mts",
  "scripts/test-cfg-guard.mts",
  "scripts/test-me-dedup.mts",
];

if (!supportsStripTypes) {
  console.log(`SKIP: requires node >=22.6 (CI=node22), локальный node ${process.versions.node}`);
  process.exit(0);
}

const missing = TESTS.filter((rel) => {
  try {
    accessSync(path.join(ROOT, rel), constants.R_OK);
    return false;
  } catch {
    return true;
  }
});
if (missing.length) {
  console.error(`Юнит-тест не найден в репо: ${missing.join(", ")} — проверь список TESTS.`);
  process.exit(1);
}

let failed = 0;
for (const rel of TESTS) {
  console.log(`— ${rel}`);
  const res = spawnSync(process.execPath, ["--experimental-strip-types", rel], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (res.error) {
    console.error(`FAIL ${rel}: ${res.error.message}`);
    failed++;
  } else if (res.status !== 0) {
    console.error(`FAIL ${rel} (exit ${res.status})`);
    failed++;
  }
}

if (failed) {
  console.error(`Юнит-тесты: упали ${failed} шт.`);
  process.exit(1);
}
console.log("Юнит-тесты движка: зелёные.");
