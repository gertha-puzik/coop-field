#!/usr/bin/env node
/** Guards of deploy/vps/preview-apply.sh: slug, destroy isolation, max 8. No SSH. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
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
eq("validate default host", okVal.stdout.includes("host=cursor-test.abnocw.miew.ru"), true);

const longHost = run({
  PREVIEW_SLUG: "pr-41",
  PREVIEW_HOST: "cursor-product-roadmap-and-platform-42e0.abnocw.miew.ru",
  PREVIEW_ACTION: "validate",
});
eq("deny long server_name", longHost.status === 0 ? "ok" : "fail", "fail");

const prHostVal = run({
  PREVIEW_SLUG: "pr-41",
  PREVIEW_HOST: "pr-41.abnocw.miew.ru",
  PREVIEW_ACTION: "validate",
});
eq("validate pr host", prHostVal.status, 0);
eq("validate pr host printed", prHostVal.stdout.includes("host=pr-41.abnocw.miew.ru"), true);

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
eq(
  "alpha env origins follow host",
  readFileSync(join(t.previewRoot, "alpha/env"), "utf8").includes("ALLOWED_ORIGINS=http://alpha.abnocw.miew.ru,https://alpha.abnocw.miew.ru"),
  true,
);
eq(
  "apex cert without wildcard is not hung on preview vhost",
  readFileSync(join(t.nginxD, "preview-alpha.conf"), "utf8").includes("ssl_certificate"),
  false,
);
fillIncoming(t.incoming, "pr-41");
const prApply = run({
  ...base,
  PREVIEW_SLUG: "pr-41",
  PREVIEW_IN: join(t.incoming, "pr-41"),
  PREVIEW_PORT: "41041",
  PREVIEW_HOST: "pr-41.abnocw.miew.ru",
  PREVIEW_SHA: "deadbeefcafebabe",
});
dump("pr host apply", prApply);
eq("apply pr host", prApply.status, 0);
eq(
  "nginx server_name is pr id",
  readFileSync(join(t.nginxD, "preview-pr-41.conf"), "utf8").includes("server_name pr-41.abnocw.miew.ru;"),
  true,
);
eq("dir is pr-id", existsSync(join(t.previewRoot, "pr-41/www/index.html")), true);
chmodSync(join(t.nginxD, "preview-pr-41.conf"), 0o444);
const overwrite = run({
  ...base,
  PREVIEW_SLUG: "pr-41",
  PREVIEW_IN: join(t.incoming, "pr-41"),
  PREVIEW_PORT: "41041",
  PREVIEW_HOST: "pr-41.abnocw.miew.ru",
  PREVIEW_SHA: "overwrite1",
});
dump("overwrite read-only fragment", overwrite);
eq("overwrite read-only fragment", overwrite.status, 0);
eq(
  "fragment replaced after unlink",
  readFileSync(join(t.nginxD, "preview-pr-41.conf"), "utf8").includes("server_name pr-41.abnocw.miew.ru;"),
  true,
);
eq(
  "pr-41 env origins follow host",
  readFileSync(join(t.previewRoot, "pr-41/env"), "utf8").includes("ALLOWED_ORIGINS=http://pr-41.abnocw.miew.ru,https://pr-41.abnocw.miew.ru"),
  true,
);
// Легаси-env без ALLOWED_ORIGINS (какой был на VPS до фикса): re-apply добавляет
// ключ вместе с новым хостом и не теряет ADMIN_PASS.
writeFileSync(
  join(t.previewRoot, "pr-41/env"),
  "PORT=41041\nHOST=127.0.0.1\nDATA_DIR=/tmp/coop-legacy/data\nADMIN_PASS=zz\nREQUIRE_ORIGIN=0\n",
);
const legacy = run({
  ...base,
  PREVIEW_SLUG: "pr-41",
  PREVIEW_IN: join(t.incoming, "pr-41"),
  PREVIEW_PORT: "41041",
  PREVIEW_HOST: "cafebabe.abnocw.miew.ru",
  PREVIEW_SHA: "cafebabe1205719",
});
eq("apply over legacy env", legacy.status, 0);
const legacyEnv = readFileSync(join(t.previewRoot, "pr-41/env"), "utf8");
eq("legacy env gained origins", legacyEnv.includes("ALLOWED_ORIGINS=http://cafebabe.abnocw.miew.ru,https://cafebabe.abnocw.miew.ru"), true);
eq("legacy env kept admin pass", legacyEnv.includes("ADMIN_PASS=zz"), true);
eq("legacy env erased stale origins", legacyEnv.includes("pr-41.abnocw.miew.ru"), false);

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
for (let i = 0; i < 8; i += 1) {
  rmSync(join(t.previewRoot, `slot${i}`), { recursive: true, force: true });
}

const certDir = join(t.root, "certs");
mkdirSync(certDir, { recursive: true });
function makeCert(dir, san) {
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-keyout",
      join(dir, "privkey.pem"),
      "-out",
      join(dir, "fullchain.pem"),
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=abnocw.miew.ru",
      "-addext",
      `subjectAltName=${san}`,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error("openssl cert", r.stderr);
    process.exit(1);
  }
}
makeCert(join(certDir, "apex"), "DNS:abnocw.miew.ru");
makeCert(join(certDir, "wild"), "DNS:*.abnocw.miew.ru,DNS:abnocw.miew.ru");
fillIncoming(t.incoming, "tlsapex");
const apexTls = run({
  ...base,
  PREVIEW_SLUG: "tlsapex",
  PREVIEW_IN: join(t.incoming, "tlsapex"),
  PREVIEW_PORT: "41011",
  PREVIEW_TLS_WILD: join(certDir, "apex"),
});
dump("apex tls", apexTls);
eq("apply with apex-only cert", apexTls.status, 0);
eq(
  "apex-only cert skipped",
  readFileSync(join(t.nginxD, "preview-tlsapex.conf"), "utf8").includes("ssl_certificate"),
  false,
);
eq(
  "no cert — no https jump",
  readFileSync(join(t.nginxD, "preview-tlsapex.conf"), "utf8").includes("return 301 https://"),
  false,
);
fillIncoming(t.incoming, "tlswild");
const wildTls = run({
  ...base,
  PREVIEW_SLUG: "tlswild",
  PREVIEW_IN: join(t.incoming, "tlswild"),
  PREVIEW_PORT: "41012",
  PREVIEW_TLS_WILD: join(certDir, "wild"),
});
dump("wild tls", wildTls);
eq("apply with wildcard cert", wildTls.status, 0);
eq(
  "wildcard cert used",
  readFileSync(join(t.nginxD, "preview-tlswild.conf"), "utf8").includes("ssl_certificate"),
  true,
);
eq(
  "wildcard adds https redirect",
  readFileSync(join(t.nginxD, "preview-tlswild.conf"), "utf8").includes("return 301 https://"),
  true,
);
eq(
  "wildcard keeps acme path open",
  readFileSync(join(t.nginxD, "preview-tlswild.conf"), "utf8").includes("acme-challenge"),
  true,
);

// per-host линия (HTTP-01 coop-preview-cert): зеркало tls/<host> подхватывается
// дефолтом PREVIEW_TLS_PER.
makeCert(join(certDir, "perhost"), "DNS:tlsper.abnocw.miew.ru");
fillIncoming(t.incoming, "tlsper");
const perTls = run({
  ...base,
  PREVIEW_SLUG: "tlsper",
  PREVIEW_IN: join(t.incoming, "tlsper"),
  PREVIEW_PORT: "41013",
  PREVIEW_TLS_PER: join(certDir, "perhost"),
});
dump("perhost tls", perTls);
eq("apply with per-host cert", perTls.status, 0);
eq(
  "per-host cert used",
  readFileSync(join(t.nginxD, "preview-tlsper.conf"), "utf8").includes("ssl_certificate"),
  true,
);
eq(
  "per-host adds https redirect",
  readFileSync(join(t.nginxD, "preview-tlsper.conf"), "utf8").includes("return 301 https://"),
  true,
);

rmSync(t.root, { recursive: true, force: true });

if (failed) {
  console.error("preview apply: FAIL", failed);
  process.exit(1);
}
console.log("preview apply: зелёный");
