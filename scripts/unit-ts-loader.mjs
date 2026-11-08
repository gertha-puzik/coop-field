#!/usr/bin/env node
/**
 * Resolve-хуки для юнит-тестов клиентского TS без бандлера.
 * Регистрируется тестом через module.register() ДО динамического импорта
 * клиента (образец: scripts/test-me-dedup.mts).
 *
 * Зачем: node --experimental-strip-types исполняет .ts как есть, но НЕ
 * понимает ни алиас tsconfig «@/…», ни относительные импорты без расширения
 * (оба приняты в проекте ради сборки Next). Лоадер хуки делает симметрично:
 *   - «@/lib/x/y»      → <repo>/src/lib/x/y.ts (без расширения — .ts)
 *   - «./x» / «../x»   → retry с «.ts», если обычный резолв не нашёл файл
 *
 * Запуск: node --experimental-strip-types scripts/test-me-dedup.mts
 * (лоадер сам по себе ничего не делает — это модуль хуков).
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function resolve(specifier, context, nextResolve) {
  // Алиас tsconfig («@/» → src/…): только для юнит-прогонов клиента.
  if (specifier.startsWith("@/")) {
    let file = path.join(ROOT, "src", specifier.slice(2));
    if (!path.extname(file)) file += ".ts";
    if (!existsSync(file)) throw new Error(`unit-ts-loader: «${specifier}» не нашлось в src/ (нужно для юнит-импорта)`);
    return nextResolve(pathToFileURL(file).href, context);
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // Относительный без расширения: strip-types требует явный «.ts».
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !path.extname(specifier)) {
      return nextResolve(specifier + ".ts", context);
    }
    throw err;
  }
}
