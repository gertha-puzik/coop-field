#!/usr/bin/env node
/**
 * Сверяет разрешённую версию ws в двух lockfile: корневом (разработка, фронт)
 * и deploy/vps/package-lock.json (прод-сервер комнаты). Расхождение — ошибка:
 * иначе «локально всё работает, а на VPS другая версия ws» ловится только в бою.
 * Запускается в CI (.github/workflows/ci.yml).
 */
import { readFileSync } from "node:fs";

function resolvedWs(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const pkgs = lock.packages || {};
  const direct = pkgs["node_modules/ws"];
  if (direct?.version) return direct.version;
  // запас на старый формат lockfile v1
  const legacy = lock.dependencies?.ws;
  if (legacy?.version) return legacy.version;
  return null;
}

const root = resolvedWs("package-lock.json");
const vps = resolvedWs("deploy/vps/package-lock.json");

if (!root) throw new Error("ws не найден в package-lock.json");
if (!vps) throw new Error("ws не найден в deploy/vps/package-lock.json");

if (root !== vps) {
  console.error(`версии ws расходятся: корень ${root}, deploy/vps ${vps}`);
  console.error("обновите оба package-lock.json (npm install / npm ci) и закоммитьте вместе");
  process.exit(1);
}
console.log(`ok: ws ${root} в обоих lockfile`);
