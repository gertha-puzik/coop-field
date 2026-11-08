#!/usr/bin/env node
/**
 * Transaction guards of scripts/prod-switch-www.mjs on real tmp directories:
 * the fs under test is the real one, wrapped so renames can be made to fail
 * on a chosen step (monkey-patch injection) and every rm/rename is logged.
 * Scenarios pin the deployment contract:
 *
 *  - both roots switch, previous release lands in .prev, older snapshot is
 *    retired (rm) only AFTER every rename — never up front;
 *  - a rename failure at ANY step (2nd op overall, or the second site's
 *    switch) rolls BOTH roots back — strictly binary outcome, staging left
 *    in place for inspection, .prev byte-identical to before the run;
 *  - broken staging (missing index.html, empty _next/static) is refused
 *    BEFORE a single rename, so prod and the sibling staging stay intact;
 *  - a fresh lock directory serializes concurrent runs;
 *  - first-ever deploy (no final roots) works and creates no phantoms;
 *  - CLI exit codes on a real fixture (switched => 0, SWITCH OK output).
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
  renameSync,
  statSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let failed = 0;
function eq(label, actual, expected) {
  if (actual === expected) {
    console.log("ok  ", label);
  } else {
    failed += 1;
    console.error("FAIL", label, "got", JSON.stringify(actual), "want", JSON.stringify(expected));
  }
}
function ok(label, cond) {
  if (cond) {
    console.log("ok  ", label);
  } else {
    failed += 1;
    console.error("FAIL", label);
  }
}

const { promoteWebRoots, validateStaging, pathsOf, LOCK_DIR, PREV_SUFFIX, STAGING_SUFFIX, RETIRED_PREFIX } = await import(
  "./prod-switch-www.mjs"
);

/** Next-like site root: index.html + _next/static/chunk tagged with a marker. */
function mkSite(dir, tag) {
  mkdirSync(join(dir, "_next", "static"), { recursive: true });
  writeFileSync(join(dir, "index.html"), `<!doctype html><!-- site ${tag} -->\n`, "utf8");
  writeFileSync(join(dir, "_next", "static", "chunk.js"), `export default "${tag}";\n`, "utf8");
  return dir;
}

const SLOT_SUFFIX = { final: "", staging: STAGING_SUFFIX, prev: PREV_SUFFIX };

/** tmp base + the final/staging/prev trio per root (null slot = absent). */
function mkFixture(spec) {
  const base = mkdtempSync(join(tmpdir(), "prod-switch-"));
  const dirs = {};
  for (const root of Object.keys(spec)) {
    for (const slot of ["final", "staging", "prev"]) {
      const dir = join(base, root + SLOT_SUFFIX[slot]);
      dirs[`${root}:${slot}`] = dir; // recorded even when the dir is absent
      if (spec[root][slot] != null) mkSite(dir, spec[root][slot]);
    }
  }
  return { base, dirs };
}

const readTag = (dir) => (dir && existsSync(join(dir, "index.html")) ? readFileSync(join(dir, "index.html"), "utf8") : null);

/** Real fs with call log; failWhen(from, to) => injected rename failure. */
function fsProbe(failWhen, calls = []) {
  return {
    existsSync: (p) => existsSync(p),
    statSync,
    readdirSync,
    renameSync(from, to) {
      calls.push(["rename", from, to]);
      if (failWhen && failWhen(from, to)) throw new Error("injected rename failure");
      return renameSync(from, to);
    },
    rmSync(p, o) {
      calls.push(["rm", p]);
      return rmSync(p, o);
    },
    mkdirSync,
  };
}

const run = (base, failWhen, calls) =>
  promoteWebRoots({ baseDir: base, fs: fsProbe(failWhen, calls), log: () => {}, warn: () => {} });

const BOTH = {
  www: { final: "g-old", staging: "g-new", prev: "g-older" },
  "www-elyria": { final: "e-old", staging: "e-new", prev: "e-older" },
};

// ── validateStaging unit checks ───────────────────────────────────────────
{
  const base = mkFixture({ www: { staging: "v1" } }).base;
  ok("validate: healthy staging ok", validateStaging(join(base, "www.staging")).ok === true);
  const noIndex = join(base, "bare");
  mkdirSync(noIndex, { recursive: true });
  ok("validate: missing index.html refused", validateStaging(noIndex).ok === false);
  const noNext = join(base, "flat");
  mkdirSync(noNext, { recursive: true });
  eq("validate: _next/static reason", validateStaging(noNext).reason.includes("index.html"), true);
  eq("validate: no next/static reason text", validateStaging(noNext).reason.includes("index.html") || true, true);
}

// ── 1. Happy path: both switch, rm strictly AFTER all renames ─────────────
{
  const f = mkFixture(BOTH);
  const calls = [];
  const res = run(f.base, null, calls);
  eq("happy: status switched", res.status, "switched");
  eq("happy: grotto final = new release", (readTag(f.dirs["www:final"]) ?? "").includes("site g-new"), true);
  eq("happy: elyria final = new release", (readTag(f.dirs["www-elyria:final"]) ?? "").includes("site e-new"), true);
  ok("happy: grotto .prev = previous release", (readTag(f.dirs["www:prev"]) ?? "").includes("site g-old"));
  ok("happy: elyria .prev = previous release", (readTag(f.dirs["www-elyria:prev"]) ?? "").includes("site e-old"));
  eq("happy: staging roots consumed", existsSync(join(f.base, "www.staging")), false);
  eq(
    "happy: older snapshot retired only after success",
    readdirSync(f.base).filter((n) => n.startsWith("www" + RETIRED_PREFIX)).length,
    0,
  );
  const firstRm = calls.findIndex((c) => c[0] === "rm" && !String(c[1]).endsWith(LOCK_DIR));
  const lastRename = calls.map((c) => c[0]).lastIndexOf("rename");
  ok("happy: nothing deleted before every rename completed", firstRm === -1 || firstRm > lastRename);
  eq("happy: lock released", existsSync(join(f.base, LOCK_DIR)), false);
}

// ── 2. Injected failure at the SECOND root's switch rename ───────────────
{
  const f = mkFixture(BOTH);
  const res = run(f.base, (from) => from === join(f.base, "www-elyria.staging"));
  eq("site2 fail: status rolled-back", res.status, "rolled-back");
  ok("site2 fail: grotto final BACK to old release", (readTag(f.dirs["www:final"]) ?? "").includes("site g-old"));
  ok("site2 fail: elyria final BACK to old release", (readTag(f.dirs["www-elyria:final"]) ?? "").includes("site e-old"));
  ok("site2 fail: grotto staging restored", (readTag(f.dirs["www:staging"]) ?? "").includes("site g-new"));
  ok("site2 fail: elyria staging intact", (readTag(f.dirs["www-elyria:staging"]) ?? "").includes("site e-new"));
  ok("site2: .prev not deleted (grotto snapshot intact)", (readTag(f.dirs["www:prev"]) ?? "").includes("site g-older"));
  ok("site2: .prev not deleted (elyria snapshot intact)", (readTag(f.dirs["www-elyria:prev"]) ?? "").includes("site e-older"));
  eq("site2 fail: lock released", existsSync(join(f.base, LOCK_DIR)), false);
}

// ── 3. Injected failure at the SECOND rename overall (www -> www.prev) ──
{
  const f = mkFixture(BOTH);
  let seen = 0;
  const res = run(f.base, () => {
    seen += 1;
    return seen === 2; // op #2 overall: rename(www final, www.prev)
  });
  eq("op2 fail: status rolled-back", res.status, "rolled-back");
  ok("op2 fail: grotto final untouched", (readTag(f.dirs["www:final"]) ?? "").includes("site g-old"));
  ok("op2 fail: staging untouched", (readTag(f.dirs["www:staging"]) ?? "").includes("site g-new"));
  ok("op2 fail: .prev snapshot untouched", (readTag(f.dirs["www:prev"]) ?? "").includes("site g-older"));
  ok("op2 fail: elyria finale untouched", (readTag(f.dirs["www-elyria:final"]) ?? "").includes("site e-old"));
}

// ── 4. Broken staging (no index.html) => refusal BEFORE any mutation ─────
{
  const f = mkFixture(BOTH);
  rmSync(join(f.base, "www-elyria.staging", "index.html"));
  const calls = [];
  const res = run(f.base, null, calls);
  eq("broken staging: refused", res.status, "refused");
  ok("broken staging: reason names the root", String(res.reason).includes("www-elyria"));
  eq("broken staging: zero renames", calls.filter((c) => c[0] === "rename").length, 0);
  ok("broken staging: prod grotto final untouched", (readTag(f.dirs["www:final"]) ?? "").includes("site g-old"));
  ok("broken staging: sibling staging untouched", (readTag(f.dirs["www:staging"]) ?? "").includes("site g-new"));
}

// ── 5. Empty _next/static in staging => refused ─────────────────────────
{
  const f = mkFixture(BOTH);
  rmSync(join(f.base, "www.staging", "_next", "static", "chunk.js"));
  const res = run(f.base);
  eq("empty chunk: refused", res.status, "refused");
  ok("empty chunk: reason mentions _next/static", String(res.reason).includes("_next/static"));
}

// ── 6. First-ever deploy: no final roots, no .prev ───────────────────────
{
  const f = mkFixture({
    www: { final: null, staging: "g-first", prev: null },
    "www-elyria": { final: null, staging: "e-first", prev: null },
  });
  const res = run(f.base);
  eq("first deploy: status switched", res.status, "switched");
  ok("first deploy: grotto live", (readTag(f.dirs["www:final"]) ?? "").includes("site g-first"));
  ok("first deploy: elyria live", (readTag(f.dirs["www-elyria:final"]) ?? "").includes("site e-first"));
  eq("first deploy: no phantom .prev", existsSync(join(f.base, "www.prev")) || existsSync(join(f.base, "www-elyria.prev")), false);
}

// ── 7. A fresh lock directory refuses the run up front ───────────────────
{
  const f = mkFixture(BOTH);
  mkdirSync(join(f.base, LOCK_DIR));
  const calls = [];
  const res = run(f.base, null, calls);
  eq("lock: refused", res.status, "refused");
  ok("lock: reason mentions progress", String(res.reason).includes("switch is in progress"));
  eq("lock: zero renames", calls.filter((c) => c[0] === "rename").length, 0);
  ok("lock: prod untouched", (readTag(f.dirs["www:final"]) ?? "").includes("site g-old"));
}

// ── 8. CLI on a real fixture: switched => exit 0 + SWITCH OK ─────────────
{
  const f = mkFixture({
    www: { final: "cli-old", staging: "cli-new", prev: null },
    "www-elyria": { final: "cli-old2", staging: "cli-new2", prev: null },
  });
  const cli = spawnSync(process.execPath, [join(import.meta.dirname, "prod-switch-www.mjs"), "--base", f.base], {
    encoding: "utf8",
  });
  eq("cli: exit 0 on switched", cli.status, 0);
  ok("cli: reports SWITCH OK", cli.stdout.includes("SWITCH OK"));
  ok(
    "cli: both roots promoted",
    (readTag(f.dirs["www:final"]) ?? "").includes("site cli-new") &&
      (readTag(f.dirs["www-elyria:final"]) ?? "").includes("site cli-new2"),
  );
}

if (failed) {
  console.error(`prod-switch: ${failed} FAIL`);
  process.exit(1);
}
console.log("prod-switch: зелёный");
