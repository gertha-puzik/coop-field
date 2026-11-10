#!/usr/bin/env node
// Гейт архитектуры репо (W1 «вход и ворота»): лимит размера файлов + import-границы слоёв.
// Ноль npm-зависимостей — только node:fs/node:path. Запускается как `npm run arch:check`
// и в CI (ci.yml). Не зелёный → красный CI → PR не должен мержиться.
//
// КАК РАСШИРЯТЬ:
//   1) таблица RULES ниже — единственное место конфигурации;
//   2) новый тип правила = новая функция-валидатор (ctx уже собрал файлы и импорты);
//   3) allowlist — только для легаси, с волной, которая его разрезает.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Правила гейта — расширять только здесь.
 *
 * sizeLimit        — потолок строк для исходников: новые god-файлы запрещены,
 *                    существующие размечены в SIZE_ALLOWLIST с волной «выписки».
 * SIZE_ALLOWLIST   — легаси выше лимита; выпадут в волнах W3–W5:
 *                    server.js → server/ (W4), simulator.tsx и settings-panel.tsx,
 *                    settings.ts и test-field.ts → разрезы движка (W5),
 *                    test-ws.mjs → сценарии по реестру протокола (W3).
 * importBoundaries — «файлы из dir не импортируют из forbiddenDir».
 *                    Сегодняшняя правда репо: src/lib не тянет components — гейт это фиксирует.
 */
const RULES = {
  sizeLimit: {
    maxLines: 800,
    extensions: [".ts", ".tsx", ".js", ".mjs"],
    // Каталоги вне проверки: зависимости, артефакты сборки, данные, спрайты, деплой VPS.
    // www-grotto/www-elyria — вариантные статические корни P6 (контракт
    // build:variants с preview-build.yml): после сборки лежат в корне репо.
    skipDirs: ["node_modules", ".git", ".next", "out", "public", "data", ".vercel", "incoming", "deploy", "www-grotto", "www-elyria"],
  },
  // Формат: { file: "<путь от корня>", why: "<какой волной разрезается>" }.
  SIZE_ALLOWLIST: [
    { file: "src/components/sim/simulator.tsx", why: "разрез на модули и хуки — волна W5" },
    { file: "src/components/sim/settings-panel.tsx", why: "разрез по табам — волна W5" },
    { file: "src/lib/sim/settings.ts", why: "выносы lib/sim/* — волна W5" },
    { file: "src/lib/sim/test-field.ts", why: "выносы lib/sim/* — волна W5" },
    { file: "scripts/test-ws.mjs", why: "сценарии по реестру протокола — волна W3" },
    // S1–S5 аудита Z.AI (2026-11-08): сценарии Bootstrap-CLI/гейтов раздули
    // файл за лимит; разрез — вынос песочниц-спавнера/проб в scripts/testlib,
    // волна следующих правок окна безопасности.
    { file: "scripts/test-auth.mjs", why: "S1–S5 аудита Z.AI: вынос песочниц-спавнера в testlib" },
    // Контент-волна профиля (ДР+аватар, 2026-11-10) поверх #84/#98: сумма
    // волн вынесла файлы за лимит; разрез — отдельная волна рефактора профиля.
    { file: "src/components/players/player-profile.tsx", why: "контент-волна профиля (2026-11-10): разрез карточка/редактор — рефактор-волна профиля" },
    { file: "src/components/players/player-profile-ui.tsx", why: "контент-волна профиля (2026-11-10): Portrait/AvatarField в свои модули — рефактор-волна профиля" },
    // Deep-link-фикс каталога (2026-11-10, «список мигает перед профилем»):
    // hold карточного ожидания + лоадер; каталог был у лимита ещё до правки.
    { file: "src/components/players/players-catalog.tsx", why: "deep-link-фикс каталога (2026-11-10): строки-таблицы/плитки в свои модули — рефактор-волна каталога" },
  ],
  // Формат: { from: "<префикс каталога>", forbidden: "<префикс каталога-цели import-ов>" }.
  importBoundaries: [
    {
      from: "src/lib/",
      forbidden: "src/components/",
      why: "логика (lib) не должна зависеть от UI (components)",
    },
    {
      from: "src/lib/net/",
      forbidden: "src/components/",
      why: "транспорт не должен знать про react-компоненты",
    },
  ],
  // A1 (аудит Z.AI 2026-11-08, вторая часть): канон варианта — src/lib/site.ts.
  // Весь модуль флаговый (SITE-константа + isGrotto/isElyria): межмодульный
  // импорт НЕ сворачивается минифаером Next, мёртвая ветка чужого варианта
  // остаётся в бандле — так в grotto-чанки уезжал elisium (находка A1).
  // Правило: импорт site.ts (или '@/lib/site') разрешён ТОЛЬКО самому site.ts.
  // Всем остальным — инлайн-сравнение process.env.NEXT_PUBLIC_SITE === 'elyria'
  // в собственном модуле (канон уже в players-catalog.tsx, wander-gate.tsx,
  // simulator.tsx и др.): тогда сборщик фолдит условие и вырезает мёртвую
  // ветку целиком. Формат: { file: "<путь>", why: "<выход при нарушении>" }.
  isolatedImports: [
    { file: "src/lib/site.ts", why: "импортируй флаг инлайном: const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria' — см. докстринг site.ts (DCE-свёртка)" },
  ],
};

// ---------- обход дерева ----------
function listSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (RULES.sizeLimit.skipDirs.includes(e.name)) continue;
        walk(path.join(dir, e.name));
      } else if (RULES.sizeLimit.extensions.includes(path.extname(e.name))) {
        out.push(path.join(dir, e.name));
      }
    }
  };
  walk(ROOT);
  return out;
}

const norm = (p) => p.split(path.sep).join("/").replace(/^\.\//, "");
const relToRoot = (abs) => norm(path.relative(ROOT, abs));

// ---------- правило 1: лимит размера ----------
function checkSize(files) {
  const violations = [];
  const allowlisted = new Map(RULES.SIZE_ALLOWLIST.map((a) => [a.file, a.why]));
  for (const abs of files) {
    const rel = relToRoot(abs);
    const lines = readFileSync(abs, "utf8").split("\n").length;
    if (lines <= RULES.sizeLimit.maxLines) continue;
    if (allowlisted.has(rel)) continue; // легаси: разрез уже запланирован волной
    violations.push({
      file: rel,
      detail: `${lines} строк (лимит ${RULES.sizeLimit.maxLines})`,
      message:
        `  Куда смотреть: новые god-файлы в репо запрещены; реж по доменам, план —\n` +
        `  docs/ARCHITECTURE.md, раздел «Целевая структура»; правило — AGENTS.md, «Правила».\n` +
        `  Если это осознанное исключение — добавь запись в SIZE_ALLOWLIST в scripts/check-architecture.mjs\n` +
        `  с волной, которая файл разрежет.`,
    });
  }
  return violations;
}

// ---------- правило 2: import-границы ----------
// Достаём спекификаторы: статический `... from "..."`, динамический `import("...")`, `import "..."`.
const IMPORT_RE = /(?:\bfrom\s*["']|\bimport\s*\(\s*["']|\bimport\s+["'])([^"']+)["']/g;

function importTargets(abs) {
  const text = readFileSync(abs, "utf8");
  const targets = [];
  let m;
  while ((m = IMPORT_RE.exec(text)) !== null) targets.push(m[1]);
  return targets;
}

/** Спецификатор → путь от корня репо; null = внешний пакет (react, ws, ...). */
function resolveImport(spec, fromAbs) {
  if (spec.startsWith("@/")) return norm(path.join("src", spec.slice(2)));
  if (spec.startsWith(".")) return relToRoot(path.resolve(path.dirname(fromAbs), spec));
  return null;
}

function checkImportBoundaries(files) {
  const violations = [];
  for (const abs of files) {
    const rel = relToRoot(abs);
    const rule = RULES.importBoundaries.find((r) => rel.startsWith(r.from));
    if (!rule) continue;
    for (const spec of importTargets(abs)) {
      const target = resolveImport(spec, abs);
      if (target === null) continue;
      if (target.startsWith(rule.forbidden)) {
        violations.push({
          file: rel,
          detail: `импортирует ${spec}`,
          message:
            `  Граница: ${rule.from} не должен зависеть от ${rule.forbidden} — ${rule.why}.\n` +
            `  Куда смотреть: docs/ARCHITECTURE.md, раздел «Слои и границы». Нужный тип/константу\n` +
            `  вынеси ниже по слоям (в src/lib), а не тяни из UI.`,
        });
        break; // одно нарушение на файл достаточно
      }
    }
  }
  return violations;
}

// ---------- правило 3: изолированные модули (A1) ----------
// Импорт файла-канона разрешён только ему самому: см. RULES.isolatedImports.
function checkIsolatedImports(files) {
  const violations = [];
  for (const rule of RULES.isolatedImports) {
    for (const abs of files) {
      const rel = relToRoot(abs);
      if (rel === rule.file) continue; // сам канон волен
      for (const spec of importTargets(abs)) {
        const target = resolveImport(spec, abs);
        if (target === null) continue;
        const stem = rule.file.replace(/\.ts$/, "");
        if (target === rule.file || target === stem) {
          violations.push({
            file: rel,
            detail: `импортирует ${spec} (канон ${rule.file})`,
            message:
              `  Изоляция A1: файл-канон варианта нельзя импортировать — экспорт НЕ сворачивается\n` +
              `  минифаером, мёртвая ветка чужого варианта уедет в бандл (утечка между сборками).\n` +
              `  Выход: ${rule.why}`,
          });
          break; // одно нарушение на файл достаточно
        }
      }
    }
  }
  return violations;
}

// ---------- применение ----------
const files = listSourceFiles();
const violations = [...checkSize(files), ...checkImportBoundaries(files), ...checkIsolatedImports(files)];

if (violations.length) {
  console.error(`Архитектурный гейт: нарушений — ${violations.length}.`);
  for (const v of violations) {
    console.error(`\nФайл: ${v.file} — ${v.detail}\n${v.message}`);
  }
  process.exit(1);
}

console.log(
  `arch:check — зелёный: исходников ${files.length}, лимит ${RULES.sizeLimit.maxLines} строк,` +
    ` import-границ ${RULES.importBoundaries.length}, изолированных канонов ${RULES.isolatedImports.length}; нарушений нет.`
);
