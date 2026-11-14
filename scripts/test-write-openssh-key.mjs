#!/usr/bin/env node
/** Reconstructs collapsed OpenSSH PEM the same way GitHub/Cursor secrets arrive. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "write-openssh-key.sh");
const root = mkdtempSync(join(tmpdir(), "coop-openssh-"));
let failed = 0;

function eq(label, actual, expected) {
  if (actual === expected) {
    console.log("ok  ", label);
  } else {
    failed += 1;
    console.error("FAIL", label, "got", actual, "want", expected);
  }
}

const gen = spawnSync("ssh-keygen", ["-t", "ed25519", "-f", join(root, "id"), "-N", "", "-C", "test-key"], {
  encoding: "utf8",
});
if (gen.status !== 0) {
  console.error("ssh-keygen failed", gen.stderr);
  process.exit(1);
}
const original = readFileSync(join(root, "id"), "utf8");
const pub = readFileSync(join(root, "id.pub"), "utf8").trim();

function writeKey(raw, dest) {
  return spawnSync("bash", [script, dest], {
    env: { ...process.env, SSH_KEY: raw },
    encoding: "utf8",
  });
}

function pubOf(path) {
  const r = spawnSync("ssh-keygen", ["-y", "-f", path], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : `fail:${r.stderr}`;
}

const oneLine = original.trim().replace(/\n/g, " ");
const destLine = join(root, "from-line");
const a = writeKey(oneLine, destLine);
eq("one-line exit", a.status, 0);
eq("one-line pub", pubOf(destLine).split(" ").slice(0, 2).join(" "), pub.split(" ").slice(0, 2).join(" "));

const destNl = join(root, "from-nl");
const b = writeKey(original.trim().replace(/\n/g, "\\n"), destNl);
eq("literal-n exit", b.status, 0);
eq("literal-n pub", pubOf(destNl).split(" ").slice(0, 2).join(" "), pub.split(" ").slice(0, 2).join(" "));

const destOk = join(root, "from-ok");
const c = writeKey(original, destOk);
eq("multiline exit", c.status, 0);
eq("multiline pub", pubOf(destOk).split(" ").slice(0, 2).join(" "), pub.split(" ").slice(0, 2).join(" "));

const destBad = join(root, "from-bad");
const d = writeKey("not-a-key", destBad);
eq("garbage fails", d.status === 0 ? "ok" : "fail", "fail");

writeFileSync(join(root, "id_empty"), "");
rmSync(root, { recursive: true, force: true });

if (failed) {
  console.error("write-openssh-key: FAIL", failed);
  process.exit(1);
}
console.log("write-openssh-key: зелёный");
