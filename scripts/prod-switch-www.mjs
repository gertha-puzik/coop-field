#!/usr/bin/env node
/**
 * Transactional promotion of the production web roots (www + www-elyria).
 *
 * deploy-frontend.yml rsyncs BOTH variant roots into *.staging directories on
 * the VPS first; this script then performs the actual switch. It replaces the
 * old remote-shell "atomic promotion" whose rollback story was not strictly
 * binary: `rm -rf www.prev` ran BEFORE the switch, and a hard cut (dead ssh,
 * set -e exit) between the two `mv` pairs could leave www switched while
 * www-elyria stayed on the previous release — or touch neither. Contract of
 * this implementation (pinned by scripts/test-prod-switch.mjs):
 *
 *  1. Preconditions first, mutations later: BOTH staging roots must pass
 *     validation (index.html + non-empty _next/static). Refusal happens
 *     before a single rename, so a broken build never reaches production.
 *  2. .prev snapshots are NEVER deleted up front: the previous release is
 *     moved into .prev, the older .prev only into a `.retired-<stamp>`
 *     holding pen, and retired snapshots are rm -rf'd ONLY after BOTH roots
 *     switched. One snapshot back is always recoverable.
 *  3. Any failure (injected or real) rolls back BOTH roots through the
 *     journal of completed renames — the result is strictly binary:
 *     both roots on the new release, or both on the previous one.
 *  4. Rollback trouble is reported loudly as INCONSISTENT (exit 2) with the
 *     full journal; silencing it would be worse than failing.
 *  5. A lock directory serializes concurrent runs (manual + CI); a stale
 *     lock (dead holder) is taken over with a warning.
 *
 * Runs on the VPS as the deploy user (cwd = /opt/coop-field, node at
 * /opt/coop-field/.node/bin/node per deploy/vps/coop-field.service). The
 * tool is main-owned like every VPS-side deploy script (PR-only changes).
 * No new npm deps: plain node:fs; fs + clock are injectable for the tests.
 */
import { existsSync, renameSync, rmSync, mkdirSync, statSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_ROOTS = ["www", "www-elyria"];
export const STAGING_SUFFIX = ".staging";
export const PREV_SUFFIX = ".prev";
export const RETIRED_PREFIX = ".retired-";
export const LOCK_DIR = ".www-switch.lock";
export const STALE_LOCK_MS = 30 * 60 * 1000;

const realFs = { existsSync, renameSync, rmSync, mkdirSync, statSync, readdirSync };

export function pathsOf(baseDir, root) {
  return {
    final: join(baseDir, root),
    staging: join(baseDir, root + STAGING_SUFFIX),
    prev: join(baseDir, root + PREV_SUFFIX),
  };
}

/** Fresh holding-pen name for the retired snapshot; stamp keeps it unique. */
function retiredPath(baseDir, root, stamp) {
  return join(baseDir, `${root}${RETIRED_PREFIX}${stamp}`);
}

/**
 * Staging validation — the minimum without which promotion is pointless
 * (a Next static export without index.html or with an empty _next/static
 * would make nginx serve 404s for every chunk). Pure read, no mutation.
 */
export function validateStaging(dir, fs = realFs) {
  if (!fs.existsSync(dir)) return { ok: false, reason: "staging directory is missing" };
  const index = join(dir, "index.html");
  if (!fs.existsSync(index)) return { ok: false, reason: `no index.html in ${dir}` };
  const statics = join(dir, "_next", "static");
  if (!fs.existsSync(statics) || !fs.statSync(statics).isDirectory()) {
    return { ok: false, reason: `no _next/static in ${dir}` };
  }
  if (fs.readdirSync(statics).length === 0) {
    return { ok: false, reason: `_next/static is empty in ${dir}` };
  }
  return { ok: true };
}

/**
 * One transaction for BOTH roots. Never throws; returns a result object:
 *   switched      — exit 0
 *   rolled-back   — exit 1  (failure rolled back to the previous release)
 *   refused       — exit 3  (preconditions failed, nothing was touched)
 *   inconsistent  — exit 2  (rollback itself failed — manual action needed)
 */
export function promoteWebRoots(opts = {}) {
  const fs = opts.fs ?? realFs;
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? STALE_LOCK_MS;
  const baseDir = resolve(opts.baseDir ?? process.cwd());
  const roots = opts.roots ?? DEFAULT_ROOTS;
  const log = opts.log ?? (() => {});
  const warn = opts.warn ?? (() => {});
  const lockDir = join(baseDir, LOCK_DIR);

  // Lock --------------------------------------------------------------
  let locked = false;
  try {
    fs.mkdirSync(lockDir, { recursive: false });
    locked = true;
  } catch (e) {
    let ageMs = -1;
    try {
      ageMs = now() - fs.statSync(lockDir).mtimeMs;
    } catch {
      /* unreadable lock -> treat as busy */
    }
    if (ageMs > staleMs) {
      warn(`stale lock detected (${Math.round(ageMs / 60000)} min old) — taking over`);
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch (e2) {
        warn(`stale lock removal failed: ${e2.message}`);
      }
      try {
        fs.mkdirSync(lockDir, { recursive: false });
        locked = true;
      } catch (e3) {
        return { status: "refused", reason: `lock busy: ${e3.message}`, warnings: [] };
      }
    } else {
      return {
        status: "refused",
        reason: `another switch is in progress (${LOCK_DIR} present, age ${Math.max(ageMs, 0)} ms)`,
        warnings: [],
      };
    }
  }

  const warnOut = [];
  const warnings = (w) => {
    warnOut.push(w);
    warn(w);
  };
  const finish = (result) => {
    if (locked) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch (e) {
        warnOut.push(`lock release failed: ${e.message}`);
        warn(`lock release failed: ${e.message}`);
      }
    }
    return { baseDir, roots, ...result, warnings: warnOut };
  };

  // Preconditions: validate BOTH staging roots before touching anything ──
  for (const root of roots) {
    const p = pathsOf(baseDir, root);
    const v = validateStaging(p.staging, fs);
    if (!v.ok) {
      log(`REFUSED: staging ${root}: ${v.reason}`);
      return finish({ status: "refused", reason: `${root}: ${v.reason}` });
    }
  }

  // Switch phase: journal every completed rename ─────────────────────────
  const journal = [];
  const retired = [];
  const stamp = String(now());
  let failure = null;
  try {
    for (const root of roots) {
      const p = pathsOf(baseDir, root);
      // 2. .prev is not deleted up front: only moved into the holding pen.
      if (fs.existsSync(p.prev)) {
        const pen = retiredPath(baseDir, root, stamp);
        fs.renameSync(p.prev, pen);
        journal.push({ from: p.prev, to: pen });
        retired.push(pen);
      }
      // 3. Previous release steps aside (stays recoverable until success).
      if (fs.existsSync(p.final)) {
        fs.renameSync(p.final, p.prev);
        journal.push({ from: p.final, to: p.prev });
      }
      // 4. The switch itself: staging becomes the live root.
      fs.renameSync(p.staging, p.final);
      journal.push({ from: p.staging, to: p.final });
    }
  } catch (e) {
    failure = e;
  }

  if (failure) {
    // Rollback: replay the journal backwards. Guarded renames only: an entry
    // counts as undone when the target is back at its source.
    const rollbackErrors = [];
    for (let i = journal.length - 1; i >= 0; i -= 1) {
      const op = journal[i];
      try {
        if (fs.existsSync(op.to) && !fs.existsSync(op.from)) {
          fs.renameSync(op.to, op.from);
        }
      } catch (e) {
        rollbackErrors.push(`${op.to} -> ${op.from}: ${e.message}`);
      }
    }
    // The binary outcome must hold: both finals alive and serving the
    // previous release; .prev holding exactly what it held before the run.
    const finalStates = roots.map((r) => `${r}: ${fs.existsSync(pathsOf(baseDir, r).final) ? "present" : "MISSING"}`);
    if (rollbackErrors.length > 0) {
      log(`INCONSISTENT: rollback errors [${rollbackErrors.join("; ")}]; finals [${finalStates.join(", ")}]`);
      return finish({
        status: "inconsistent",
        reason: failure.message,
        journal,
        rollbackErrors,
        manualAction: `cd ${baseDir} and restore from the *.${PREV_SUFFIX} snapshots (see journal)`,
      });
    }
    log(`ROLLED BACK: ${failure.message}`);
    log("both roots serve the previous release; staging left in place for inspection; .prev snapshots untouched");
    return finish({
      status: "rolled-back",
      reason: failure.message,
      journal,
      finalStates,
    });
  }

  // Success: retire the old snapshots — only now, after BOTH roots switched.
  for (const pen of retired) {
    try {
      fs.rmSync(pen, { recursive: true, force: true });
    } catch (e) {
      warnings(`retired snapshot ${pen} could not be removed: ${e.message} (manual cleanup needed)`);
    }
  }
  const prevStates = roots.map((r) => `${r}${PREV_SUFFIX}: ${fs.existsSync(pathsOf(baseDir, r).prev) ? "kept" : "none"}`);
  log(`SWITCH OK: [${roots.join(", ")}] on the new release; snapshots: [${prevStates.join(", ")}]`);
  return finish({ status: "switched", prevStates, retired });
}

// CLI ---------------------------------------------------------------------
const invoked = (() => {
  try {
    if (!process.argv[1]) return false;
    // realpath BOTH sides: worktrees often sit behind symlinks, so argv[1]
    // (resolved by node) and import.meta.url can differ textually otherwise.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (invoked) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args[i + 1] ?? null;
  };
  const roots = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root") roots.push(args[i + 1]);
  }
  const res = promoteWebRoots({
    baseDir: opt("--base") ?? process.cwd(),
    roots: roots.length ? roots : DEFAULT_ROOTS,
    staleMs: Number(opt("--stale-ms")) || STALE_LOCK_MS,
    log: (m) => console.log(m),
    warn: (m) => console.error(`::warning::${m}`),
  });
  const exit = { switched: 0, "rolled-back": 1, refused: 3, inconsistent: 2 }[res.status];
  if (res.status !== "switched") {
    console.error(`prod-switch-www: ${res.status.toUpperCase()} — ${res.reason}`);
  }
  process.exit(exit ?? 2);
}
