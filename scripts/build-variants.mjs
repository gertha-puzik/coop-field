#!/usr/bin/env node
/**
 * Orchestrates the two site variants of the static export cleanly.
 *
 * Owner report 2026-11-08: sequential variant builds without wiping `.next`
 * and `out/` left stale chunk maps in the shared build dir, and turbopack's
 * static-export mode does not emit async chunks referenced by runtime maps
 * (a stream of 404s for /profiles code, atmosphere, and Babylon). This
 * wrapper makes the pipeline explicit and self-checking:
 *
 *   wipe .next + out → NEXT_PUBLIC_SITE=grotto next build → prune grotto
 *   wipe .next + out → NEXT_PUBLIC_SITE=elyria next build → prune elyria
 *   → check-variants (isolation + chunk integrity gate; red = refuse).
 *
 * Contract consumers (CI preview build, local `npm run build:variants`)
 * keep calling the same npm script; only the internals changed.
 *
 * No functional code is compiled here — see scripts/prune-export.mjs for the
 * per-variant route pruning and scripts/check-variants.mjs for the gate.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const die = (msg) => {
  console.error(`build-variants: ${msg}`);
  process.exit(1);
};

const run = (label, cmd, args, env = {}) => {
  console.log(`build-variants: ${label}`);
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (r.status !== 0) die(`${label} failed (exit ${r.status ?? "signal"})`);
};

const wipe = () => {
  rmSync(path.join(ROOT, ".next"), { recursive: true, force: true });
  rmSync(path.join(ROOT, "out"), { recursive: true, force: true });
};

const buildVariant = (variant) => {
  // Wipe BEFORE every variant build: chunk maps from the previous variant
  // must never leak into the next build's output (stale 404 references).
  wipe();
  run(
    `next build (${variant})`,
    "npm",
    ["run", `build:${variant}`],
    { NEXT_PUBLIC_SITE: variant }
  );
  run(
    `prune-export (${variant})`,
    process.execPath,
    [path.join("scripts", "prune-export.mjs"), variant]
  );
};

buildVariant("grotto");
buildVariant("elyria");

run(
  "isolation gate",
  process.execPath,
  [path.join("scripts", "check-variants.mjs")]
);

console.log("build-variants: OK — both variants built, pruned and gated.");
