#!/usr/bin/env node
/** Контракт preview-артефакта (dual | legacy-single) — scripts/preview-build-lib.mjs.
 * Только синтетические деревья (mkdtemp): реальных сборок нет. die()-пути либы
 * (громкие отказы) прогоняются через CLI-спавны — процесс теста не умирает.
 *
 * Спека владельца: package.json с build:variants → dual; без → legacy
 * (инфра-PR без src/ не падает); отсутствующий статик-корень → fail;
 * идентичные корни: mirror-режим легально / dual-режим fail; «a build from
 * the wrong SHA is rejected»; metadata.json отсутствует — режим честно
 * выводится из директорий (не молчаливый fail), но свежая упаковка БЕЗ
 * metadata не проходит строгий pack-check (legacy режим обязан быть явным);
 * странные/левые маркеры сайта → fail; легаси без www/ → fail. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { eq, failedCount } from "./preview-test-support.mjs";
import {
  detectBuildMode,
  validateDualRoots,
  validateLegacy,
  MODE_DUAL,
  MODE_LEGACY,
} from "./preview-build-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "preview-build-lib.mjs");
const sandbox = mkdtempSync(join(tmpdir(), "coop-build-contract-"));

function cli(args, cwd) {
  const r = spawnSync(process.execPath, [lib, ...args], { encoding: "utf8", cwd: cwd || sandbox });
  return { status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** Мини-репозиторий: package.json (+/- build:variants), серверный рантайм,
 *  опционально — src/, dual-корни билд-вариантов, out-статика легаси. */
function makeRepo(name, { variants, src, dualRoots, out, sameRoots, noIndex } = {}) {
  const repo = join(sandbox, name);
  mkdirSync(repo);
  const scripts = { build: "echo build" };
  if (variants) scripts["build:variants"] = "echo variants";
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name, scripts }, null, 2));
  writeFileSync(join(repo, "server.js"), "export default 1;\n");
  mkdirSync(join(repo, "server"), { recursive: true });
  writeFileSync(join(repo, "server/protocol.js"), "export const EV = {};\n");
  if (src) {
    mkdirSync(join(repo, "src", "app"), { recursive: true });
    writeFileSync(join(repo, "src/app/page.tsx"), "export default () => null;\n");
  }
  if (dualRoots) {
    for (const [dir, html] of [
      ["www-grotto", "<html>Пивные гроты</html>"],
      ["www-elyria", "<html>Элизия Эйдес</html>"],
    ]) {
      mkdirSync(join(repo, dir, "_next", "static"), { recursive: true });
      writeFileSync(join(repo, dir, "index.html"), sameRoots ? "<html>Пивные гроты</html>" : html);
      writeFileSync(join(repo, dir, "_next", "static", "chunk.js"), "1");
    }
  }
  if (out) {
    mkdirSync(join(repo, "out", "_next", "static"), { recursive: true });
    if (!noIndex) writeFileSync(join(repo, "out", "index.html"), "<html>grotto</html>");
    writeFileSync(join(repo, "out", "_next", "static", "chunk.js"), "1");
  }
  return repo;
}

function copyDist(name, from) {
  const d = join(sandbox, name);
  rmSync(d, { recursive: true, force: true });
  cpSync(from, d, { recursive: true });
  return d;
}

// ─── 1. Детект режима по package.json ───────────────────────────────────────
eq("package.json с build:variants → dual", detectBuildMode(makeRepo("repo-dual", { variants: true })), MODE_DUAL);
eq("package.json без build:variants → legacy-single", detectBuildMode(makeRepo("repo-legacy", {})), MODE_LEGACY);
// Инфра-PR: в чекауте даже нет src/ — детект не падает и честно отвечает
// legacy («infrastructure-only PR does not fail because build:variants is absent»).
const infraTree = makeRepo("repo-infra", { src: false });
eq("инфра-PR (dir без src) → legacy", detectBuildMode(infraTree), MODE_LEGACY);
eq("CLI detect dual печатает режим", cli(["detect", "repo-dual"]).out, MODE_DUAL);
eq("CLI detect legacy печатает режим", cli(["detect", "repo-legacy"]).out, MODE_LEGACY);
eq("CLI detect инфа-PR: зелёный, не падает", cli(["detect", "repo-infra"]).status, 0);
eq("CLI detect: сломанный package.json — громкий отказ", cli(["detect", "repo-nope"]).status, 1);

// ─── 2. Валидация dual-корней (маркеры, _next, раздельность) ────────────────
{
  const repo = makeRepo("roots-dual-check", { dualRoots: true });
  const v = validateDualRoots(repo);
  eq("dual корни: оба на месте, маркеры раздельные", v.ok, true);
  eq("dual корни: ошибок нет", v.errors.length, 0);
  eq("отсутствует www-grotto → fail", validateDualRoots(makeRepo("roots-no-grotto", { out: true })).ok, false);
  eq("отсутствует www-elyria → fail", validateDualRoots(makeRepo("roots-no-elyria", {})).ok, false);
}
{
  const repo = makeRepo("roots-empty-next");
  mkdirSync(join(repo, "www-grotto"), { recursive: true });
  mkdirSync(join(repo, "www-elyria"), { recursive: true });
  writeFileSync(join(repo, "www-grotto/index.html"), "<html>Пивные гроты</html>");
  writeFileSync(join(repo, "www-elyria/index.html"), "<html>Элизия Эйдес</html>");
  const v = validateDualRoots(repo);
  eq("корни без _next → fail", v.ok, false);
  eq("причина названа (_next)", v.errors.some((e) => e.includes("_next")), true);
}
{
  const repo = makeRepo("roots-weird-markers", { dualRoots: true });
  writeFileSync(join(repo, "www-grotto/index.html"), "<html>Пивные гроты + Элизия</html>");
  const v = validateDualRoots(repo);
  eq("grotto-html с признаком Элизии → fail (левый маркер)", v.ok, false);
  eq("причина названа (перепутаны/склеены)", v.errors.some((e) => e.includes("перепутаны")), true);
  const repo2 = makeRepo("roots-elyria-unmarked", { dualRoots: true });
  writeFileSync(join(repo2, "www-elyria/index.html"), "<html>Пивные гроты</html>");
  eq("elyria-html без признака Элизии → fail", validateDualRoots(repo2).ok, false);
  const same = makeRepo("roots-identical", { dualRoots: true, sameRoots: true });
  eq("идентичные корни в dual-режиме → fail", validateDualRoots(same).ok, false);
  eq("идентичные корни в mirror-режиме → легально", validateDualRoots(same, { identicalRoots: "allow" }).ok, true);
}

// ─── 3. Валидация legacy-корня ──────────────────────────────────────────────
{
  const repo = makeRepo("legacy-ok", { out: true });
  mkdirSync(join(repo, "www"), { recursive: true });
  cpSync(join(repo, "out"), join(repo, "www"), { recursive: true });
  eq("legacy: www/ + index + _next — ok", validateLegacy(repo).ok, true);
  eq("legacy без www/ → fail", validateLegacy(makeRepo("legacy-nowww", { out: true })).ok, false);
  const bad = makeRepo("legacy-bad");
  mkdirSync(join(bad, "www"), { recursive: true });
  writeFileSync(join(bad, "www/index.html"), "gibberish");
  eq("legacy: html без маркера одного сайта → fail", validateLegacy(bad).ok, false);
  const noNext = makeRepo("legacy-no-next");
  mkdirSync(join(noNext, "www"), { recursive: true });
  writeFileSync(join(noNext, "www/index.html"), "<html>grotto</html>");
  eq("legacy: пустой _next → fail", validateLegacy(noNext).ok, false);
}

// ─── 4. Упаковка dual / legacy через CLI (die-пути не убивают процесс) ───────
{
  const repo = makeRepo("pack-dual-repo", { variants: true, dualRoots: true });
  const dist = join(sandbox, "dist-dual");
  const r = cli(["pack-dual", dist, "--sha=feedfacecafe1234", "--branch=feature/x", "--pr=49"], repo);
  eq("pack-dual: exit 0", r.status, 0);
  const meta = JSON.parse(readFileSync(join(dist, "metadata.json"), "utf8"));
  eq("pack-dual: metadata.mode явный", meta.mode, MODE_DUAL);
  eq("pack-dual: metadata.sha это head-SHA точно", meta.sha, "feedfacecafe1234");
  eq("pack-dual: metadata.branch/pr на месте", `${meta.branch}/${meta.pr}`, "feature/x/49");
  eq("pack-dual: preview-sha совпадает с SHA", readFileSync(join(dist, "preview-sha"), "utf8").trim(), "feedfacecafe1234");
  eq("pack-dual: оба корня уехали", existsSync(join(dist, "www-grotto/index.html")) && existsSync(join(dist, "www-elyria/index.html")), true);
  eq("pack-dual: server.js + protocol + package на месте", existsSync(join(dist, "server.js")) && existsSync(join(dist, "server/protocol.js")) && existsSync(join(dist, "package.json")), true);
  eq("artifact-mode распознаёт dual по metadata", cli(["artifact-mode", dist]).out, MODE_DUAL);
  eq("pack-check dual ок", cli(["pack-check", dist, MODE_DUAL]).status, 0);
  const identical = makeRepo("pack-dual-identical", { variants: true, dualRoots: true, sameRoots: true });
  const bad = cli(["pack-dual", join(sandbox, "dist-ident"), "--sha=aa", "--pr=1"], identical);
  eq("pack-dual отказывается от идентичных корней", bad.status, 1);
  eq("отказ объясняет причину", bad.err.includes("идентичны"), true);
}
{
  const repo = makeRepo("pack-legacy-repo", { out: true });
  const dist = join(sandbox, "dist-legacy");
  const r = cli(["pack-legacy", dist, "--sha=beadfeed00001111", "--branch=infra-only", "--pr=50"], repo);
  eq("pack-legacy: exit 0", r.status, 0);
  const meta = JSON.parse(readFileSync(join(dist, "metadata.json"), "utf8"));
  eq("pack-legacy: metadata.mode='legacy-single' обязателен", meta.mode, MODE_LEGACY);
  eq("pack-legacy: metadata.sha это head-SHA точно", meta.sha, "beadfeed00001111");
  eq("pack-legacy: www/ собран из out/", existsSync(join(dist, "www/index.html")) && existsSync(join(dist, "www/_next/static/chunk.js")), true);
  eq("pack-legacy: рантайм + штамп на месте", existsSync(join(dist, "server.js")) && existsSync(join(dist, "server/protocol.js")) && existsSync(join(dist, "package.json")) && existsSync(join(dist, "preview-sha")), true);
  eq("artifact-sha: совпадающий SHA — зелёный", cli(["artifact-sha", dist, "beadfeed00001111"]).status, 0);
  eq("a build from the wrong SHA is rejected", cli(["artifact-sha", dist, "another99887766"]).status, 1);
  eq("artifact-mode распознаёт legacy по metadata", cli(["artifact-mode", dist]).out, MODE_LEGACY);
}

// ─── 5. Деплой-детект: metadata, директории, громкие отказы ─────────────────
{
  const dist = join(sandbox, "dist-legacy");
  const noMeta = copyDist("dist-legacy-nometa", dist);
  rmSync(join(noMeta, "metadata.json"));
  eq("metadata отсутствует: режим из директорий (www/) — легаси", cli(["artifact-mode", noMeta]).out, MODE_LEGACY);
  eq("pack-check без metadata.json → fail (legacy обязан быть явным)", cli(["pack-check", noMeta, MODE_LEGACY]).status, 1);

  const dualNoMeta = copyDist("dist-dual-nometa", join(sandbox, "dist-dual"));
  rmSync(join(dualNoMeta, "metadata.json"));
  eq("metadata отсутствует: www-grotto+www-elyria честно → dual", cli(["artifact-mode", dualNoMeta]).out, MODE_DUAL);

  const weird = copyDist("dist-weird-mode", dist);
  writeFileSync(join(weird, "metadata.json"), '{"mode":"feste","sha":"x"}');
  eq("metadata с чужим mode → громкий отказ", cli(["artifact-mode", weird]).status, 1);

  const lieDual = copyDist("dist-lie-dual", dist);
  writeFileSync(join(lieDual, "metadata.json"), '{"mode":"dual","sha":"x"}');
  eq("metadata декларирует dual без корней → отказ", cli(["artifact-mode", lieDual]).status, 1);

  const corrupt = copyDist("dist-corrupt-sha", dist);
  const cm = JSON.parse(readFileSync(join(corrupt, "metadata.json"), "utf8"));
  cm.sha = "dead0000beef1111";
  writeFileSync(join(corrupt, "metadata.json"), JSON.stringify(cm));
  eq("metadata.sha != preview-sha — артефакт повреждён", cli(["artifact-sha", corrupt, "beadfeed00001111"]).status, 1);

  const junk = join(sandbox, "dist-junk");
  mkdirSync(junk, { recursive: true });
  eq("ни metadata, ни корней — громкий отказ, не молчание", cli(["artifact-mode", junk]).status, 1);

  // легаси-артефакт старой main-ветки: штампа нет — не блокируем (деплой
  // ответит sha=none), гейт — только РАСХОЖДЕНИЕ штампа с workflow_run SHA.
  const noStamp = copyDist("dist-nostamp", dist);
  rmSync(join(noStamp, "preview-sha"));
  eq("легаси без preview-sha: sha=none, не молчаливый fail", cli(["artifact-sha", noStamp, "anything"]).out, "none");
}

rmSync(sandbox, { recursive: true, force: true });

const failed = failedCount();
if (failed) {
  console.error("preview build contract: FAIL", failed);
  process.exit(1);
}
console.log("preview build contract: зелёный");
