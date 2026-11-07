#!/usr/bin/env node
// P6 «build-варианты»: обрезка Next static-export (out/) под вариант сайта.
// Вызывается из `npm run build:variants` ПОСЛЕ каждой вариантной сборки:
// копирует out/ в вариантный корень в корне репо (контракт preview-build.yml —
// шаг «Сборка обоих вариантов сайта» ждёт www-grotto/index.html и
// www-elyria/index.html), вырезая каталоги маршрутов чужого варианта.
// _next/, index.html, 404.html и прочие корневые файлы копируются целиком.
// Отсутствующий в источнике маршрут — не ошибка (состав страниц меняется
// по фазам). Чистый node:fs — ноль npm-зависимостей, работает сразу после npm ci.
//
// Использование: node scripts/prune-export.mjs <grotto|elyria> [источник=out] [приёмник=www-<вариант>]

import { cp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

// Каталоги маршрутов, которых в варианте НЕ БЫВАЕТ. players/ и admin/ (P3/P4)
// в grotto уже перечислены заранее — обрезка переживёт их появление в out/.
const EXCLUDE = {
  grotto: ["elision", "players", "admin"], // «Пивные гроты»: всё публичное
  elyria: ["combat", "hunger"], // Элизия: ни гротов, ни заглушки Hunger Games
};

const [variant, srcArg = "out", destArg] = process.argv.slice(2);
if (!EXCLUDE[variant]) {
  console.error(`prune-export: вариант "${variant || "<пусто>"}" не распознан — grotto|elyria`);
  process.exit(2);
}
const src = path.resolve(srcArg);
const dest = path.resolve(destArg || `www-${variant}`);

if (!existsSync(path.join(src, "index.html"))) {
  console.error(`prune-export: в источнике "${srcArg}" нет index.html — сначала next build (output: export)`);
  process.exit(2);
}
// Приёмник внутри источника (или равен ему) — rm испортил бы сами данные.
if (src === dest || dest.startsWith(src + path.sep)) {
  console.error(`prune-export: приёмник "${destArg}" внутри источника "${srcArg}" — отказ`);
  process.exit(2);
}

const cut = EXCLUDE[variant].join(", ");
console.log(`prune-export: вариант=${variant}: ${srcArg} -> ${destArg || `www-${variant}`}, режем: ${cut}`);

await rm(dest, { recursive: true, force: true });
await cp(src, dest, { recursive: true });

let removed = [];
for (const dir of EXCLUDE[variant]) {
  const target = path.join(dest, dir);
  if (existsSync(target)) {
    await rm(target, { recursive: true, force: true });
    removed.push(dir);
  }
}

// Самопроверка (контракт build:variants): вырезанных маршрутов нет, index.html есть.
const label = destArg || `www-${variant}`;
const failures = [];
for (const dir of EXCLUDE[variant]) {
  if (existsSync(path.join(dest, dir))) failures.push(`${label}/${dir}/ остался после обрезки`);
}
if (!existsSync(path.join(dest, "index.html"))) failures.push(`${label}/index.html отсутствует`);
if (failures.length) {
  console.error(`prune-export: САМОПРОВЕРКА ПРОВАЛЕНА:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

console.log(`prune-export: ок — ${label} готов (${readdirSync(dest).sort().join(", ")}; вырезано: ${removed.length ? removed.join(", ") : "ничего, каталогов не было"})`);
