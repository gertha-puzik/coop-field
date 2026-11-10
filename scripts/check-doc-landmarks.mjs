#!/usr/bin/env node
/**
 * Гейт актуальности док-подсказок (W7a). Ноль зависимостей — node:fs/node:path.
 * Запускается в CI сразу после «Синхронизация протокола и доков» (npm run check:landmarks).
 *
 * Числа «сколько строк в модуле», записанные в картах кода (AGENTS.md, docs/ARCHITECTURE.md
 * §2), обязаны совпадать с фактическими строками файлов (`wc -l`): дрейф = агент идёт
 * по мёртвым якорям (диапазоны поясов, «const loop :NNNN», размеры выносов). Правило —
 * ARCHITECTURE §8: доверяй wc -l, а не таблице, и обнови таблицу в том же PR.
 *
 * Данные — массив троек ниже [док, исходный файл, label]:
 *   label — подстрока в строке дока; сверяемое число стоит сразу за label,
 *   отделено не более чем 4 символами не-цифр (форматы «label (4477)» и «label 4477»).
 *   Расширять список можно только парами, чей label однозначен в документе:
 *   исторические секции (§7 «этап 2 DONE» — итоги волн) повторяют имена без
 *   полного префикса и под гейт не попадают.
 *
 * Запуск: node scripts/check-doc-landmarks.mjs. На node < 22 — честный SKIP
 * (в CI гейт исполняется на node 22; поведение старых локальных нод — не контракт).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  console.log(
    `SKIP: гейт док-ландмарков требует node >= 22 (здесь ${process.versions.node}) — запущено в CI на node 22, там гейт настоящий.`
  );
  process.exit(0);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** [док-файл, исходный файл, label у записанного числа]. Только топ-модули
 *  код-карты; размер каждого обязан быть записан в доке в том же PR, что и правка файла. */
const LANDMARKS = [
  // AGENTS.md, код-карта (файл под гвардом — числа вносит родительская сессия)
  ["AGENTS.md", "src/components/sim/simulator.tsx", "src/components/sim/simulator.tsx"],
  ["AGENTS.md", "src/components/sim/simulator/hooks/use-network.ts", "use-network"],
  ["AGENTS.md", "src/components/sim/simulator/hooks/use-canvas-layers.ts", "use-canvas-layers"],
  ["AGENTS.md", "src/components/sim/simulator/pointer-tools.ts", "pointer-tools"],
  ["AGENTS.md", "src/components/sim/simulator/sim-model.ts", "sim-model"],
  ["AGENTS.md", "src/components/sim/simulator/components/chrome.tsx", "chrome"],
  ["AGENTS.md", "src/components/sim/simulator/components/field-stage.tsx", "field-stage"],
  ["AGENTS.md", "src/components/menu/wander-gate.tsx", "src/components/menu/wander-gate.tsx"],
  // docs/ARCHITECTURE.md §2 «Карта модулей as-is»
  ["docs/ARCHITECTURE.md", "src/components/sim/simulator.tsx", "src/components/sim/simulator.tsx"],
  ["docs/ARCHITECTURE.md", "src/components/sim/simulator/hooks/use-network.ts", "hooks/use-network.ts"],
  ["docs/ARCHITECTURE.md", "src/components/sim/simulator/hooks/use-canvas-layers.ts", "hooks/use-canvas-layers.ts"],
  ["docs/ARCHITECTURE.md", "src/components/sim/simulator/pointer-tools.ts", "pointer-tools.ts"],
  ["docs/ARCHITECTURE.md", "src/components/sim/simulator/sim-model.ts", "sim-model.ts"],
  ["docs/ARCHITECTURE.md", "src/components/sim/simulator/components/chrome.tsx", "components/chrome.tsx"],
  ["docs/ARCHITECTURE.md", "src/components/sim/simulator/components/field-stage.tsx", "components/field-stage.tsx"],
  ["docs/ARCHITECTURE.md", "src/lib/sim/combat-log.ts", "combat-log.ts"],
  ["docs/ARCHITECTURE.md", "src/lib/sim/atmosphere.ts", "atmosphere.ts"],
  ["docs/ARCHITECTURE.md", "src/components/sim/settings-panel.tsx", "settings-panel.tsx"],
  // Серверные wc -l. Метка однозначна в своём документе: в AGENTS.md это
  // токен код-карты («config 443»), в ARCHITECTURE §2 — ячейка таблицы
  // («server/config.js` | 443»). Файлы короче 100 строк сюда не входят:
  // искатель ниже ждёт 3–5 цифр, как у клиентских пар. Исторические секции
  // без полного пути и чужие документы (AI-CONTEXT, PLATFORM) не сканируются.
  ["AGENTS.md", "server/config.js", ": config "],
  ["AGENTS.md", "server/protocol.js", "protocol "],
  ["AGENTS.md", "server/testmap.js", "testmap "],
  ["AGENTS.md", "server/world.js", "world "],
  ["AGENTS.md", "server/room.js", "room "],
  ["AGENTS.md", "server/movement.js", "movement "],
  ["AGENTS.md", "server/combat.js", "combat "],
  ["AGENTS.md", "server/dummy-rab.js", "dummy-rab "],
  ["AGENTS.md", "server/atmo.js", "atmo "],
  ["AGENTS.md", "server/persist.js", "persist "],
  ["AGENTS.md", "server/net.js", "net "],
  ["AGENTS.md", "server/accounts.js", "accounts "],
  ["AGENTS.md", "server/auth.js", "auth "],
  ["AGENTS.md", "server/profiles.js", "profiles "],
  ["AGENTS.md", "server/runtime-config.js", "runtime-config "],
  ["AGENTS.md", "server/cfg-registry.js", "cfg-registry "],
  ["AGENTS.md", "server/room-config.js", "room-config "],
  ["AGENTS.md", "server/sprites.js", ", sprites "],
  ["AGENTS.md", "server/my-sprites.js", "my-sprites "],
  ["AGENTS.md", "server/avatars.js", "avatars "],
  ["docs/ARCHITECTURE.md", "server/config.js", "server/config.js` | "],
  ["docs/ARCHITECTURE.md", "server/protocol.js", "server/protocol.js` | "],
  ["docs/ARCHITECTURE.md", "server/testmap.js", "server/testmap.js` | "],
  ["docs/ARCHITECTURE.md", "server/world.js", "server/world.js` | "],
  ["docs/ARCHITECTURE.md", "server/room.js", "server/room.js` | "],
  ["docs/ARCHITECTURE.md", "server/movement.js", "server/movement.js` | "],
  ["docs/ARCHITECTURE.md", "server/combat.js", "server/combat.js` | "],
  ["docs/ARCHITECTURE.md", "server/dummy-rab.js", "server/dummy-rab.js` | "],
  ["docs/ARCHITECTURE.md", "server/atmo.js", "server/atmo.js` | "],
  ["docs/ARCHITECTURE.md", "server/persist.js", "server/persist.js` | "],
  ["docs/ARCHITECTURE.md", "server/net.js", "server/net.js` | "],
  ["docs/ARCHITECTURE.md", "server/accounts.js", "server/accounts.js` | "],
  ["docs/ARCHITECTURE.md", "server/auth.js", "server/auth.js` | "],
  ["docs/ARCHITECTURE.md", "server/profiles.js", "server/profiles.js` | "],
  ["docs/ARCHITECTURE.md", "server/runtime-config.js", "server/runtime-config.js` | "],
  ["docs/ARCHITECTURE.md", "server/cfg-registry.js", "server/cfg-registry.js` | "],
  ["docs/ARCHITECTURE.md", "server/room-config.js", "server/room-config.js` | "],
  ["docs/ARCHITECTURE.md", "server/sprites.js", "server/sprites.js` | "],
  ["docs/ARCHITECTURE.md", "server/my-sprites.js", "server/my-sprites.js` | "],
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** строк как `wc -l`: файл оканчивается \n → число переводов строки. */
function countLines(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

const problems = [];
let matched = 0;

for (const [docRel, fileRel, label] of LANDMARKS) {
  const docLines = readFileSync(path.join(ROOT, docRel), "utf8").split("\n");
  const actual = countLines(path.join(ROOT, fileRel));
  const re = new RegExp(escapeRe(label) + "\\D{0,4}(\\d{3,5})", "g");
  const hits = [];
  docLines.forEach((line, i) => {
    for (const m of line.matchAll(re)) hits.push([i + 1, Number(m[1])]);
  });
  if (hits.length === 0) {
    problems.push(
      `${docRel}: у «${label}» не найдено записанного числа (${fileRel} = ${actual} строк) — строка удалена или переименована; гейт W7a требует записанного размера.`
    );
    continue;
  }
  let ok = true;
  for (const [ln, recorded] of hits) {
    if (recorded !== actual) {
      ok = false;
      problems.push(
        `${docRel}:${ln} — «${label}» записано ${recorded}, фактически ${actual} (${fileRel}); обнови карту в том же PR (AGENTS.md код-карта / ARCHITECTURE §2, §8).`
      );
    }
  }
  if (ok) matched++;
}

if (problems.length) {
  console.error(`Док-подсказки: расхождений — ${problems.length} (сверено landmarks: ${LANDMARKS.length}).`);
  for (const p of problems) console.error("  — " + p);
  console.error("  Куда смотреть: карты кода AGENTS.md и docs/ARCHITECTURE.md §2 против `wc -l` файлов;");
  console.error("  правило — ARCHITECTURE §8: доверяй wc -l и обнови таблицу в том же PR.");
  process.exit(1);
}

console.log(
  `OK: ${matched} landmarks match — числа код-карт (AGENTS.md, ARCHITECTURE §2) равны фактическим wc -l.`
);
