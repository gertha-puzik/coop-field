#!/usr/bin/env node
/**
 * Контракт preview-артефакта — тестируемое сердце preview-build.yml и
 * preview-deploy.yml (логика НЕ размазана по YAML-шеллу). Ноль npm-зависимостей:
 * только node:fs/node:path. Спека: preview-build исполняется ИЗ merge-рефа
 * PR, build:variants в package.json появится только с продукт-PR #49; до
 * тех пор каждая ветка (включая инфра-PR) честно собирает legacy-single.
 *
 * Два режима артефакта:
 *   dual          — корни www-grotto/ + www-elyria/ (билд-варианты продукта),
 *                   строгие маркеры сайтов, корни НЕ идентичны;
 *   legacy-single — единый www/ (обычный `npm run build`, статик-экспорт out/).
 * metadata.json в корне артефакта: { mode, sha, branch, pr } — режим явный.
 *
 * Потребители:
 *   - preview-build.yml (merge-реф PR): detect → build → pack-* → upload;
 *   - preview-deploy.yml (всегда из main): artifact-mode + artifact-sha
 *     перед rsync; порядок мерджа PR #49/50 не гарантирован, поэтому деплой
 *     понимает ОБА формата (и artifacts без metadata.json от старых веток —
 *     режим выводится из директорий, но НИКОГДА не молча).
 *
 * Чеки контракта (чистые функции) гоняются scripts/test-preview-build-contract.mjs
 * на синтетических деревьях (mkdtemp); exit 0 npm не доверяется — валидации в либе.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const MODE_DUAL = "dual";
export const MODE_LEGACY = "legacy-single";
export const DUAL_ROOTS = ["www-grotto", "www-elyria"];
export const LEGACY_ROOT = "www";
/** Признак Элизии в корневом index.html: заголовки/маркеры сайта Элизии.
 *  Гроты (публичный фронт) НЕ содержат ни одного из них; Элизия обязана
 *  содержать хотя бы один — иначе dual-сборка склеилась в один сайт. */
export const ELISION_MARKERS = ["Элизия", "Elyria", "elisium", "Elysia"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function die(message) {
  console.error(String(message));
  process.exit(1);
}

/** package.json репо (строгий JSON; мусор в файле — падение с диагнозом). */
export function readPackageJson(repoDir) {
  const pkgPath = join(repoDir, "package.json");
  if (!existsSync(pkgPath)) die(`нет ${pkgPath} — чекаут сломан, сборка невозможна`);
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (e) {
    die(`package.json не парсится (${pkgPath}): ${e.message}`);
  }
}

/** Режим сборки по содержимому package.json ветки: «dual» требует скрипт
 *  build:variants (продукт-PR #49 добавляет его вместе с dual-сборкой);
 *  любая ветка без него (main-линейка, инфра-PR) — честный legacy-single.
 *  Наличие/отсутствие src/ на выбор режима НЕ влияет: детект контрактен,
 *  а не эвристичен. */
export function detectBuildMode(repoDir) {
  const pkg = readPackageJson(repoDir);
  const s = pkg && typeof pkg === "object" ? pkg.scripts : null;
  const has = s && typeof s["build:variants"] === "string" && s["build:variants"].trim() !== "";
  return has ? MODE_DUAL : MODE_LEGACY;
}

/** В каталоге есть хоть один файл (глубина ≤3): «_next не пуст». */
function dirHasFiles(dir, depth = 3) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) return true;
    if (depth > 1 && dirHasFiles(join(dir, e.name), depth - 1)) return true;
  }
  return false;
}

function readIndex(rootDir) {
  const p = join(rootDir, "index.html");
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** Dual-корни: оба обязательны, index.html на месте, _next статик не пуст,
 *  маркеры сайтов раздельные (гроты БЕЗ признака Элизии, Элизия С ним),
 *  корни НЕ идентичны (байт-сравнение index.html). identicalRoots:"allow"
 *  — легальный honest-mirror (легаси-артефакт, зеркалированный в оба корня
 *  старым конвейером; сцене apply тогда ставится mode=mirror). */
export function validateDualRoots(distDir, opts = {}) {
  const errors = [];
  const text = {};
  for (const name of DUAL_ROOTS) {
    const dir = join(distDir, name);
    const idx = readIndex(dir);
    if (idx === null) {
      errors.push(`${name}/index.html отсутствует — dual-артефакт обязан нести оба корня`);
      text[name] = null;
      continue;
    }
    if (!dirHasFiles(join(dir, "_next"))) errors.push(`${name}/_next пуст — статики вариантов нет`);
    text[name] = idx;
  }
  if (text["www-grotto"] !== null && text["www-elyria"] !== null) {
    if (text["www-grotto"] === text["www-elyria"]) {
      if (opts.identicalRoots !== "allow") {
        errors.push("корни www-grotto и www-elyria идентичны байт-в-байт — dual невозможен");
      }
      // allow + идентичные: honest-mirror — один и тот же сайт отражён в оба
      // корня (легаси-артефакт старого main); маркерная дифференциация НЕ
      // требуется — применяющий пометит PREVIEW_SITES_MODE=mirror.
    } else {
      if (ELISION_MARKERS.some((m) => text["www-grotto"].includes(m))) {
        errors.push("www-grotto/index.html содержит признак Элизии — варианты перепутаны/склеены");
      }
      if (!ELISION_MARKERS.some((m) => text["www-elyria"].includes(m))) {
        errors.push("www-elyria/index.html без признака Элизии — это гроты, а не Элизия");
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Легаси-корень: www/ + index.html + _next не пуст; «маркер одного сайта» —
 *  структурный (живой корневой html), содержательной дифференциации в
 *  односайтовом билде НЕТ и не требуется: legacy-single не притворяется dual. */
export function validateLegacy(distDir) {
  const errors = [];
  const dir = join(distDir, LEGACY_ROOT);
  const idx = readIndex(dir);
  if (idx === null) {
    errors.push("www/index.html отсутствует — legacy-артефакт обязан нести корень www/");
    return { ok: false, errors };
  }
  if (!idx.includes("<html")) errors.push("www/index.html не похож на живой html — маркер одного сайта не найден");
  if (!dirHasFiles(join(dir, "_next"))) errors.push("www/_next пуст — статики нет");
  return { ok: errors.length === 0, errors };
}

/** Режим УЖЕ собранного артефакта — два потребителя, поэтому две политики:
 *  metadata.json есть → верим только ему (режим обязан совпадать с деревом);
 *  metadata.json нет (артефакты старых main-веток) → честно выводим из
 *  директорий (www-grotto+www-elyria → dual; www/ → legacy-single);
 *  ничего не распознано → громкий отказ, НЕ молчаливый. */
export function detectArtifactMode(distDir) {
  const dualRoots = DUAL_ROOTS.every((d) => existsSync(join(distDir, d)));
  const legacyRoot = existsSync(join(distDir, LEGACY_ROOT));
  const metaPath = join(distDir, "metadata.json");
  if (existsSync(metaPath)) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch (e) {
      die(`metadata.json не парсится (${metaPath}): ${e.message}`);
    }
    if (meta.mode !== MODE_DUAL && meta.mode !== MODE_LEGACY) {
      die(`metadata.json mode="${meta.mode}" не распознан (ожидался ${MODE_DUAL} или ${MODE_LEGACY})`);
    }
    if (meta.mode === MODE_DUAL && !dualRoots) die(`metadata декларирует dual, но корней ${DUAL_ROOTS.join("+")} в артефакте нет`);
    if (meta.mode === MODE_LEGACY && !legacyRoot) die(`metadata декларирует legacy-single, но корня ${LEGACY_ROOT}/ в артефакте нет`);
    return meta.mode;
  }
  if (dualRoots) return MODE_DUAL;
  if (legacyRoot) return MODE_LEGACY;
  die(`не распознан режим артефакта: нет metadata.json, нет ни ${DUAL_ROOTS.join("/ ни ")}, ни ${LEGACY_ROOT}/`);
}

/** Строгий self-check СБОРКИ (не деплоя): свежий артефакт обязан нести
 *  ЯВНЫЙ metadata.json с заявленным режимом — отсутствие metadata в
 * legacy-упаковке = сломанный pack, а не «наследие лета». Плюс копия
 *  набора файлов, который уезжает на VPS. */
export function assertPackedArtifact(distDir, mode) {
  const metaPath = join(distDir, "metadata.json");
  if (!existsSync(metaPath)) die(`pack-контракт нарушен: в артефакте нет metadata.json (режим ${mode} обязан быть явным)`);
  let meta;
  try {
    meta = JSON.parse(readFileSync(metaPath, "utf8"));
  } catch (e) {
    die(`pack-контракт нарушен: metadata.json не парсится: ${e.message}`);
  }
  if (meta.mode !== mode) die(`metadata.mode="${meta.mode}" != заявленного "${mode}"`);
  if (!meta.sha) die("metadata.sha пуст — SHA-штамп обязателен в обоих режимах");
  for (const f of ["server.js", join("server", "protocol.js"), "package.json", "preview-sha"]) {
    if (!existsSync(join(distDir, f))) die(`pack-контракт нарушен: нет ${join(distDir, f)}`);
  }
  if (mode === MODE_DUAL) {
    for (const d of DUAL_ROOTS) if (!existsSync(join(distDir, d, "index.html"))) die(`pack-контракт нарушен: нет ${d}/index.html`);
  } else if (!existsSync(join(distDir, LEGACY_ROOT, "index.html"))) {
    die(`pack-контракт нарушен: нет ${LEGACY_ROOT}/index.html`);
  }
  return meta;
}

/** SHA-гейт артефакта на стороне деплоя (до rsync на VPS): preview-sha
 *  обязан совпадать с SHA, с которым пришёл workflow_run; metadata.sha —
 *  совпадать с preview-sha. Штампа нет (легаси-артефакт старой ветки) —
 *  выкладка не блокируется, verify на VPS честно ответит sha=none. */
export function verifyArtifactSha(distDir, trustedSha) {
  const shaPath = join(distDir, "preview-sha");
  let stamped = null;
  if (existsSync(shaPath)) {
    stamped = readFileSync(shaPath, "utf8").trim();
    if (!stamped) die("preview-sha пуст — сборка не заполнила штамп");
    if (trustedSha && stamped !== trustedSha) {
      die(`артефакт собран с ${stamped.slice(0, 12)}, а деплой несёт ${String(trustedSha).slice(0, 12)} — устаревший дистрибутив не выкладываем`);
    }
  }
  const metaPath = join(distDir, "metadata.json");
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    if (meta.sha && stamped && meta.sha !== stamped) {
      die(`metadata.sha (${meta.sha.slice(0, 12)}) расходится с preview-sha (${stamped.slice(0, 12)}) — артефакт повреждён`);
    }
  }
  return stamped || "none";
}

function writeMetadata(distDir, mode, ctx) {
  if (!ctx.sha) die("pack: не передан head-SHA — штамп обязателен (гейт артефакта)");
  writeFileSync(join(distDir, "metadata.json"), `${JSON.stringify({ mode, sha: ctx.sha, branch: ctx.branch || "", pr: ctx.pr || "" }, null, 2)}\n`);
}

function copyRuntime(distDir, repoDir) {
  for (const f of ["server.js", "package.json"]) {
    if (!existsSync(join(repoDir, f))) die(`pack: в чекауте нет ${f}`);
    cpSync(join(repoDir, f), join(distDir, f));
  }
  if (!existsSync(join(repoDir, "server", "protocol.js"))) die("pack: в чекауте нет server/protocol.js — серверный код обязан ехать целиком");
  cpSync(join(repoDir, "server"), join(distDir, "server"), { recursive: true });
  if (existsSync(join(repoDir, "scripts"))) cpSync(join(repoDir, "scripts"), join(distDir, "scripts"), { recursive: true });
  if (existsSync(join(repoDir, "package-lock.json"))) cpSync(join(repoDir, "package-lock.json"), join(distDir, "package-lock.json"));
}

/** Упаковка dual-артефакта: валидирует корни билд-вариантов (маркеры,
 *  раздельность), кладёт server-код/пакеты/юниты рантайма, штампует
 *  preview-sha и ЯВНЫЙ metadata.json. Осечки валидации — громкий отказ. */
export function packDual(repoDir, distDir, ctx, opts = {}) {
  const v = validateDualRoots(repoDir, opts);
  if (!v.ok) die(`dual-валидация не прошла:\n  - ${v.errors.join("\n  - ")}`);
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });
  for (const d of DUAL_ROOTS) cpSync(join(repoDir, d), join(distDir, d), { recursive: true });
  copyRuntime(distDir, repoDir);
  writeFileSync(join(distDir, "preview-sha"), `${ctx.sha}\n`);
  writeMetadata(distDir, MODE_DUAL, ctx);
  return assertPackedArtifact(distDir, MODE_DUAL);
}

/** Упаковка legacy-артефакта: одна сборка (`npm run build` из out/) в www/,
 *  тот же рантайм, тот же SHA-гейт и ЯВНЫЙ metadata {mode:'legacy-single'}. */
export function packLegacy(repoDir, distDir, ctx) {
  const staticRoot = join(repoDir, ctx.staticRoot || "out");
  const idx = readIndex(staticRoot);
  if (idx === null) die(`нет ${staticRoot}/index.html — npm run build не произвёл статику`);
  rmSync(distDir, { recursive: true, force: true });
  mkdirSync(join(distDir, LEGACY_ROOT), { recursive: true });
  cpSync(staticRoot, join(distDir, LEGACY_ROOT), { recursive: true });
  const v = validateLegacy(distDir);
  if (!v.ok) {
    rmSync(distDir, { recursive: true, force: true });
    die(`legacy-валидация не прошла:\n  - ${v.errors.join("\n  - ")}`);
  }
  copyRuntime(distDir, repoDir);
  writeFileSync(join(distDir, "preview-sha"), `${ctx.sha}\n`);
  writeMetadata(distDir, MODE_LEGACY, ctx);
  return assertPackedArtifact(distDir, MODE_LEGACY);
}

export { join, root as libRoot };

// ── CLI (preview-build.yml / preview-deploy.yml вызывают эти подкоманды) ─────
/** Репо-источник для pack-* — cwd воркера (в воркфлоу это корень чекаута).
 *  Явный путь-аргумент остаётся только у detect — деплой зовёт пак из
 *  корня чекаута main, тесты — из синтетических деревьев (mkdtemp). */
function parseCtx(argv) {
  const ctx = {};
  for (const a of argv) {
    const m = /^--(sha|branch|pr|static-root)=(.*)$/.exec(a);
    if (m) ctx[m[1] === "static-root" ? "staticRoot" : m[1]] = m[2];
  }
  return ctx;
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("preview-build-lib.mjs");
if (invoked && process.argv[2]) {
  const cmd = process.argv[2];
  const target = cmd === "detect" ? process.argv[3] || process.cwd() : process.argv[3];
  const ctx = parseCtx(process.argv.slice(3));
  if (cmd === "detect") {
    const mode = detectBuildMode(target);
    console.log(mode);
  } else if (cmd === "pack-dual") {
    const meta = packDual(process.cwd(), target, ctx);
    console.log(`preview mode: dual (sha=${meta.sha.slice(0, 12)}, branch=${meta.branch || "?"}, pr=${meta.pr || "?"})`);
  } else if (cmd === "pack-legacy") {
    const meta = packLegacy(process.cwd(), target, ctx);
    console.log(`preview mode: legacy-single (build:variants отсутствует; dual-превью появится после мерджа PR #49; sha=${meta.sha.slice(0, 12)})`);
  } else if (cmd === "artifact-mode") {
    console.log(detectArtifactMode(target));
  } else if (cmd === "pack-check") {
    if (!process.argv[4]) die("pack-check <distDir> <режим>: режим обязателен");
    if (process.argv[4] !== MODE_DUAL && process.argv[4] !== MODE_LEGACY) die(`pack-check: неизвестный режим ${process.argv[4]}`);
    assertPackedArtifact(target, process.argv[4]);
    console.log(`packed artifact ok (${process.argv[4]})`);
  } else if (cmd === "artifact-sha") {
    console.log(verifyArtifactSha(target, process.argv[4]));
  } else {
    die(`неизвестная подкоманда: ${cmd} (ожидаются detect|pack-dual|pack-legacy|artifact-mode|artifact-sha)`);
  }
}
