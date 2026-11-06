#!/usr/bin/env node
/** Guards of deploy/vps/preview-apply.sh: slug, destroy isolation, max 8. No SSH. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "deploy/vps/preview-apply.sh");
let failed = 0;

function eq(label, actual, expected) {
  if (actual === expected) {
    console.log("ok  ", label);
  } else {
    failed += 1;
    console.error("FAIL", label, "got", actual, "want", expected);
  }
}

function run(env, extra = {}) {
  return spawnSync("bash", [script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15000,
    ...extra,
  });
}

function dump(label, r) {
  if (r.status !== 0) {
    console.error(label, "status", r.status, "stderr", r.stderr, "stdout", r.stdout);
  }
}

function staging() {
  const root = mkdtempSync(join(tmpdir(), "coop-preview-"));
  const previewRoot = join(root, "preview");
  const nginxD = join(root, "nginx");
  const incoming = join(root, "incoming");
  mkdirSync(previewRoot);
  mkdirSync(nginxD);
  return { root, previewRoot, nginxD, incoming };
}

function fillIncoming(incoming, slug) {
  const dir = join(incoming, slug);
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(join(dir, "www"), { recursive: true });
  writeFileSync(join(dir, "server.js"), "export default 1;\n");
  writeFileSync(join(dir, "server/protocol.js"), "export const EV = {};\n");
  writeFileSync(join(dir, "www/index.html"), "<html>ok</html>\n");
}

const deny = [
  "",
  "..",
  "../coop-field",
  "foo/bar",
  "foo;rm",
  "-evil",
  "A".repeat(60).toLowerCase() + "x",
];
for (const slug of deny) {
  const r = run({ PREVIEW_SLUG: slug, PREVIEW_ACTION: "validate" });
  eq(`deny ${slug || "<empty>"}`, r.status === 0 ? "ok" : "fail", "fail");
}

const okVal = run({ PREVIEW_SLUG: "cursor-test", PREVIEW_ACTION: "validate" });
eq("validate good slug", okVal.status, 0);
eq("validate prints app", okVal.stdout.includes("/opt/coop-field-preview/cursor-test"), true);

const t = staging();
fillIncoming(t.incoming, "alpha");
fillIncoming(t.incoming, "beta");
const base = {
  PREVIEW_ROOT: t.previewRoot,
  PREVIEW_NGINX_D: t.nginxD,
  PREVIEW_SKIP_SYSTEMD: "1",
  PREVIEW_SKIP_NGINX: "1",
  PREVIEW_NODE: process.execPath,
  HOME: t.root,
  PREVIEW_IN: join(t.incoming, "alpha"),
  PREVIEW_SLUG: "alpha",
  PREVIEW_PORT: "41001",
  PREVIEW_ACTION: "apply",
  PREVIEW_SHA: "deadbeef",
};
const a = run({ ...base, PREVIEW_IN: join(t.incoming, "alpha") });
dump("apply alpha", a);
eq("apply alpha", a.status, 0);
eq("alpha dir", existsSync(join(t.previewRoot, "alpha/www/index.html")), true);
eq("alpha nginx", existsSync(join(t.nginxD, "preview-alpha.conf")), true);
eq("alpha env not prod data", readFileSync(join(t.previewRoot, "alpha/env"), "utf8").includes("/opt/coop-field/data"), false);
eq("alpha env preview data", readFileSync(join(t.previewRoot, "alpha/env"), "utf8").includes(join(t.previewRoot, "alpha/data")), true);

const b = run({
  ...base,
  PREVIEW_SLUG: "beta",
  PREVIEW_IN: join(t.incoming, "beta"),
  PREVIEW_PORT: "41002",
});
eq("apply beta", b.status, 0);

const gone = run({
  ...base,
  PREVIEW_SLUG: "alpha",
  PREVIEW_ACTION: "destroy",
});
eq("destroy alpha", gone.status, 0);
eq("alpha removed", existsSync(join(t.previewRoot, "alpha")), false);
eq("alpha nginx removed", existsSync(join(t.nginxD, "preview-alpha.conf")), false);
eq("beta kept", existsSync(join(t.previewRoot, "beta/www/index.html")), true);
eq("beta nginx kept", existsSync(join(t.nginxD, "preview-beta.conf")), true);

const badPort = run({ ...base, PREVIEW_SLUG: "gamma", PREVIEW_PORT: "8787", PREVIEW_IN: join(t.incoming, "alpha") });
eq("refuse prod port", badPort.status === 0 ? "ok" : "fail", "fail");

for (let i = 0; i < 8; i += 1) {
  mkdirSync(join(t.previewRoot, `slot${i}`));
}
fillIncoming(t.incoming, "ninth");
const ninth = run({
  ...base,
  PREVIEW_SLUG: "ninth",
  PREVIEW_IN: join(t.incoming, "ninth"),
  PREVIEW_PORT: "41009",
});
eq("refuse 9th preview", ninth.status === 0 ? "ok" : "fail", "fail");
eq("ninth not created", existsSync(join(t.previewRoot, "ninth")), false);

rmSync(t.root, { recursive: true, force: true });

if (failed) {
  console.error("preview apply: FAIL", failed);
  process.exit(1);
}
console.log("preview apply: зелёный");
