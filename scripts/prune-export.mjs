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

import { cp, rm, readFile, readdir } from "node:fs/promises";
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

// Чистка немонтируемых чанков (follow-up §10.4): next export кладёт чанки
// ВСЕХ маршрутов (включая вырезанные только что) в общий _next/static/chunks.
// Вырезанные каталоги ссылаться на них больше не могут — но файлы остаются
// в поставке варианта. Собираем граф упомянутостей: html(.html) → тела чанков
// (строки static/chunks/<name>.js) → фикс-пойнт; всё не попавшее в граф — удаляем.
const chunksDir = path.join(dest, "_next", "static", "chunks");
if (existsSync(chunksDir)) {
  // 1. Пул корней: каждая уцелевшая страница html ссылается на стартовые чанки.
  const pageFiles = [];
  const walk = async (dir) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (ent.name.endsWith(".html")) pageFiles.push(p);
    }
  };
  await walk(dest);
  // Два формата: прямые html-ссылки /_next/static/chunks/X.js И КАРТЫ
  // async-загрузчиков В ТЕЛАХ ЧАНКОВ — "static/chunks/X.js" относительные
  // (без /_next). Без второго паттерна prune вырезал lazy-чанки runtime-карт:
  // страницы молча теряли атмосферу/Babylon/профили (владелица 2026-11-08).
  const chunkRefs = [
    /_next\/static\/chunks\/([A-Za-z0-9._%-]+\.js)/g,
    /(?:^|[^\w])static\/chunks\/([A-Za-z0-9._%-]+\.js)/g,
  ];
  const pooled = new Set();
  const scanText = (text) => {
    for (const re of chunkRefs) for (const m of text.matchAll(re)) pooled.add(m[1]);
  };
  for (const f of pageFiles) scanText(await readFile(f, "utf8"));
  // 2. Фикс-пойнт: тела известных чанков тоже ссылаются на чанки (динамика).
  let grew = true;
  while (grew) {
    grew = false;
    for (const name of Array.from(pooled)) {
      const p = path.join(chunksDir, name);
      if (!existsSync(p)) continue;
      const before = pooled.size;
      scanText(await readFile(p, "utf8"));
      if (pooled.size !== before) grew = true;
    }
  }
  if (pooled.size === 0) {
    console.error("prune-export: пул чанков пуст — html-ссылок на _next не найдено; отказ (не чистим вслепую)");
    process.exit(1);
  }
  // 3. Удаление немонтируемых chunk-файлов.
  const onDisk = (await readdir(chunksDir)).filter((n) => n.endsWith(".js"));
  let pruned = 0;
  for (const name of onDisk) {
    if (!pooled.has(name)) {
      await rm(path.join(chunksDir, name), { force: true });
      pruned += 1;
    }
  }
  console.log(`prune-export: чанки: граф ${pooled.size}, удалено немонтируемых: ${pruned}`);
}

// Самопроверка (контракт build:variants): вырезанных маршрутов нет, index.html есть.
const label = destArg || `www-${variant}`;
const failures = [];
for (const dir of EXCLUDE[variant]) {
  if (existsSync(path.join(dest, dir))) failures.push(`${label}/${dir}/ остался после обрезки`);
}
if (!existsSync(path.join(dest, "index.html"))) failures.push(`${label}/index.html отсутствует`);
// Целостность после чистки: каждая упоминаемая ссылка на чанк обязана существовать.
if (existsSync(chunksDir)) {
  // Оба формата (см. пул выше): прямые /_next/... и относительные карты static/...
  const chunkRefs = [
    /_next\/static\/chunks\/([A-Za-z0-9._%-]+\.js)/g,
    /(?:^|[^\w])static\/chunks\/([A-Za-z0-9._%-]+\.js)/g,
  ];
  const walkVerify = async (dir) => {
    for (const ent of await readdir(path.join(dir), { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walkVerify(p);
      else if (/\.(html|txt|js)$/.test(ent.name)) {
        const text = await readFile(p, "utf8");
        for (const re of chunkRefs) {
          for (const m of text.matchAll(re)) {
            if (!existsSync(path.join(chunksDir, m[1]))) failures.push(`${label}: ссылка на удалённый чанк ${m[1]} (файл ${p.replace(dest + path.sep, "")})`);
          }
        }
      }
    }
  };
  await walkVerify(dest);
}
if (failures.length) {
  console.error(`prune-export: САМОПРОВЕРКА ПРОВАЛЕНА:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}

console.log(`prune-export: ок — ${label} готов (${readdirSync(dest).sort().join(", ")}; вырезано: ${removed.length ? removed.join(", ") : "ничего, каталогов не было"})`);
