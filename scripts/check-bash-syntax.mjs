#!/usr/bin/env node
/**
 * CI gate: `bash -n` every shell surface this repo ships.
 *
 * Targets:
 *  - the `run:` blocks of .github/workflows/*.yml (the 2026-11 preview deploy
 *    failed AFTER a successful rollout because of ONE stray `)` inside such a
 *    block — bash -n catches that class before merge);
 *  - the standalone bash scripts of scripts/ and deploy/vps/.
 *
 * run-block handling: YAML block scalars (`run: |`) are extracted raw by
 * indentation (no YAML parser dependency), `${{ ... }}` workflow expansions
 * are replaced with a plain token (they appear inside quotes and as
 * arguments), and the result is fed to `bash -n`. No new deps.
 *
 * Usage: node scripts/check-bash-syntax.mjs [file...]  — explicit files are
 * checked instead of the discovered set (used by the regression probe on a
 * deliberately broken fixture; handy for local pre-commit checks too).
 */
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXPANSION_RE = /\$\{\{[\s\S]*?\}\}/g;
const RUN_LINE_RE = /^(\s*)((?:-\s*)?run):\s*(.*)$/;

/** Extract (step name, script) pairs from raw workflow YAML text. */
export function extractRunBlocks(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let step = "(top)";
  for (let i = 0; i < lines.length; i++) {
    const nameMatch = lines[i].match(/^\s*-\s*name:\s*(.*)$/);
    if (nameMatch) step = nameMatch[1].trim() || "(unnamed)";
    const run = lines[i].match(RUN_LINE_RE);
    if (!run) continue;
    const keyIndent = run[1].length;
    const rest = run[3].trim();
    if (rest === "" ) continue;
    if (!/^[|>][-+]?$/.test(rest)) {
      blocks.push({ step, script: rest }); // one-line `run: cmd`
      continue;
    }
    const folded = rest.startsWith(">");
    const body = [];
    let contentIndent = null;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "") {
        body.push("");
        continue;
      }
      const li = line.match(/^ */)[0].length;
      if (li <= keyIndent) break;
      if (contentIndent === null) contentIndent = li;
      body.push(line.slice(contentIndent));
    }
    while (body.length && body[body.length - 1] === "") body.pop();
    blocks.push({ step, script: folded ? body.join(" ") : body.join("\n") });
  }
  return blocks;
}

/** `run:` scripts after workflow-expansion substitution — safe for bash -n. */
export function toBashScript(yamlScript) {
  return `${yamlScript.replace(EXPANSION_RE, "GH_EXPR")}\n`;
}

function bashCheck(tmpDir, label, script) {
  const path = join(tmpDir, "block.sh");
  writeFileSync(path, script, "utf8");
  const res = spawnSync("bash", ["-n", path], { encoding: "utf8" });
  return { label, ok: res.status === 0, stderr: (res.stderr || "").trim() };
}

const isYaml = (p) => [".yml", ".yaml"].includes(extname(p).toLowerCase());

/** Default discovered targets (repo set); explicit argv overrides it. */
export function defaultTargets(listFiles) {
  const files = [];
  const wfDir = ".github/workflows";
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir)) if (isYaml(f)) files.push(join(wfDir, f));
  }
  for (const dir of ["scripts", "deploy/vps"]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".sh")) files.push(join(dir, f));
  }
  return files.sort();
}

function main() {
  const argvFiles = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const targets = argvFiles.length ? argvFiles : defaultTargets();
  const tmpDir = mkdtempSync(join(tmpdir(), "bash-syntax-"));
  const results = [];
  try {
    for (const file of targets) {
      if (!existsSync(file)) {
        results.push({ label: file, ok: false, stderr: "file not found" });
        continue;
      }
      const text = readFileSync(file, "utf8");
      if (isYaml(file)) {
        for (const b of extractRunBlocks(text)) {
          results.push(bashCheck(tmpDir, `${file} # ${b.step}`, toBashScript(b.script)));
        }
      } else {
        results.push(bashCheck(tmpDir, file, `${text}\n`));
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  let bad = 0;
  for (const r of results) {
    if (r.ok) {
      console.log("ok  ", r.label);
    } else {
      bad += 1;
      console.error(`FAIL ${r.label}`);
      console.error(String(r.stderr ? r.stderr.split("\n")[0] : "bash -n failed"));
    }
  }
  console.log(`bash-syntax: ${results.length - bad}/${results.length} ok`);
  process.exitCode = bad ? 1 : 0;
}

// Realpath-equality pattern: importing this
// module from a future test must not fire the CLI main.
const invoked = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (invoked) main();
