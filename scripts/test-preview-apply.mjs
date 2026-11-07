#!/usr/bin/env node
/** Guards of deploy/vps/preview-apply.sh: slug, dual-host fragment, env
 * contract (PUBLIC_HOSTS/ELYRIA_HOSTS/ALLOWED_ORIGINS), destroy isolation,
 * max 8, unit guards. No SSH. */
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
  mkdirSync(join(dir, "www-grotto"), { recursive: true });
  mkdirSync(join(dir, "www-elyria"), { recursive: true });
  writeFileSync(join(dir, "server.js"), "export default 1;\n");
  writeFileSync(join(dir, "server/protocol.js"), "export const EV = {};\n");
  writeFileSync(join(dir, "www-grotto/index.html"), "<html>grotto</html>\n");
  writeFileSync(join(dir, "www-elyria/index.html"), "<html>elyria</html>\n");
}

/** server-блок фрагмента по server_name (фрагмент держит по одному блоку на хост). */
function blockFor(fragText, host) {
  const blocks = fragText.split(/^server \{$/m).slice(1).map((b) => `server {${b}`);
  return blocks.find((b) => b.includes(`server_name ${host};`)) || "";
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
// Невалидный slug ломает и dual-host дефолты (HOST/HOST2 от slug) — до всего остального.
const denyBadHostSlug = run({ PREVIEW_SLUG: "FOO BAR", PREVIEW_ACTION: "validate" });
eq("deny uppercase+space slug", denyBadHostSlug.status === 0 ? "ok" : "fail", "fail");

const okVal = run({ PREVIEW_SLUG: "cursor-test", PREVIEW_ACTION: "validate" });
eq("validate good slug", okVal.status, 0);
eq("validate prints app", okVal.stdout.includes("/opt/coop-field-preview/cursor-test"), true);
eq("validate default host", okVal.stdout.includes("host=cursor-test.abnocw.miew.ru"), true);
eq("validate default host2", okVal.stdout.includes("host2=cursor-test.elisium.miew.ru"), true);
eq("validate prints both roots", okVal.stdout.includes("roots=/opt/coop-field-preview/cursor-test/www-grotto,/opt/coop-field-preview/cursor-test/www-elyria"), true);

// ── Валидация хостов в ОБОИХ суффикс-зонах ────────────────────────────────
const longHostAbnocw = run({
  PREVIEW_SLUG: "pr-41",
  PREVIEW_HOST: "cursor-product-roadmap-and-platform-42e0.abnocw.miew.ru",
  PREVIEW_ACTION: "validate",
});
eq("deny long server_name abnocw", longHostAbnocw.status === 0 ? "ok" : "fail", "fail");

const longHostElisium = run({
  PREVIEW_SLUG: "pr-41",
  PREVIEW_HOST: "pr-41.abnocw.miew.ru",
  PREVIEW_HOST2: "cursor-product-roadmap-and-platform-42e0.elisium.miew.ru",
  PREVIEW_ACTION: "validate",
});
eq("deny long server_name elisium", longHostElisium.status === 0 ? "ok" : "fail", "fail");

const prHostVal = run({
  PREVIEW_SLUG: "pr-41",
  PREVIEW_HOST: "pr-41.abnocw.miew.ru",
  PREVIEW_HOST2: "pr-41.elisium.miew.ru",
  PREVIEW_ACTION: "validate",
});
eq("validate pr hosts", prHostVal.status, 0);
eq("validate pr host printed", prHostVal.stdout.includes("host=pr-41.abnocw.miew.ru"), true);
eq("validate pr host2 printed", prHostVal.stdout.includes("host2=pr-41.elisium.miew.ru"), true);
// Hosts взаимозаменяемы позициями: суффикс решает зону, не порядок аргументов.
const swapped = run({
  PREVIEW_SLUG: "pr-41",
  PREVIEW_HOST: "pr-41.elisium.miew.ru",
  PREVIEW_HOST2: "pr-41.abnocw.miew.ru",
  PREVIEW_ACTION: "validate",
});
eq("hosts by suffix, not position", swapped.stdout.includes("host=pr-41.abnocw.miew.ru"), true);
eq("hosts by suffix, not position 2", swapped.stdout.includes("host2=pr-41.elisium.miew.ru"), true);

// Две зоны одного вида — отказ.
for (const same of [
  { PREVIEW_HOST: "pr-41.abnocw.miew.ru", PREVIEW_HOST2: "pr-42.abnocw.miew.ru" },
  { PREVIEW_HOST: "pr-41.elisium.miew.ru", PREVIEW_HOST2: "pr-42.elisium.miew.ru" },
]) {
  const r = run({ PREVIEW_SLUG: "pr-41", PREVIEW_ACTION: "validate", ...same });
  eq(`deny same-zone ${same.PREVIEW_HOST2}`, r.status === 0 ? "ok" : "fail", "fail");
}
// Чужой суффикс и мусор — отказ.
for (const bad of ["pr-41.example.com", "pr-41.abnocw.miew.ru.evil.ru", "PR-41.ABNOCW.MIEW.RU", "pr 41.abnocw.miew.ru"]) {
  const r = run({ PREVIEW_SLUG: "pr-41", PREVIEW_HOST: bad, PREVIEW_HOST2: "pr-41.elisium.miew.ru", PREVIEW_ACTION: "validate" });
  eq(`deny host ${bad}`, r.status === 0 ? "ok" : "fail", "fail");
}
const badSecond = run({ PREVIEW_SLUG: "pr-41", PREVIEW_HOST: "pr-41.abnocw.miew.ru", PREVIEW_HOST2: "pr-41.example.com", PREVIEW_ACTION: "validate" });
eq("deny second host foreign suffix", badSecond.status === 0 ? "ok" : "fail", "fail");

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
  PREVIEW_HOST: "alpha.abnocw.miew.ru",
  PREVIEW_HOST2: "alpha.elisium.miew.ru",
  PREVIEW_PORT: "41001",
  PREVIEW_ACTION: "apply",
  PREVIEW_SHA: "deadbeef",
};
const a = run({ ...base, PREVIEW_IN: join(t.incoming, "alpha") });
dump("apply alpha", a);
eq("apply alpha", a.status, 0);
eq("alpha grotto root", existsSync(join(t.previewRoot, "alpha/www-grotto/index.html")), true);
eq("alpha elyria root", existsSync(join(t.previewRoot, "alpha/www-elyria/index.html")), true);
eq("alpha nginx", existsSync(join(t.nginxD, "preview-alpha.conf")), true);
const alphaEnv = readFileSync(join(t.previewRoot, "alpha/env"), "utf8");
eq("alpha env not prod data", alphaEnv.includes("/opt/coop-field/data"), false);
eq("alpha env preview data", alphaEnv.includes(join(t.previewRoot, "alpha/data")), true);
eq(
  "alpha env origins four values",
  alphaEnv.includes(
    "ALLOWED_ORIGINS=http://alpha.abnocw.miew.ru,https://alpha.abnocw.miew.ru,http://alpha.elisium.miew.ru,https://alpha.elisium.miew.ru",
  ),
  true,
);
eq("alpha env public hosts", alphaEnv.includes("PUBLIC_HOSTS=alpha.abnocw.miew.ru"), true);
eq("alpha env elyria hosts", alphaEnv.includes("ELYRIA_HOSTS=alpha.elisium.miew.ru"), true);
eq(
  "apex cert without wildcard is not hung on preview vhost",
  readFileSync(join(t.nginxD, "preview-alpha.conf"), "utf8").includes("ssl_certificate"),
  false,
);
const alphaFrag = readFileSync(join(t.nginxD, "preview-alpha.conf"), "utf8");
eq("alpha fragment two server blocks", (alphaFrag.match(/^server \{$/gm) || []).length, 2);
eq(
  "alpha abnocw block root is www-grotto",
  blockFor(alphaFrag, "alpha.abnocw.miew.ru").includes(`root ${join(t.previewRoot, "alpha")}/www-grotto;`),
  true,
);
eq(
  "alpha elyria block root is www-elyria",
  blockFor(alphaFrag, "alpha.elisium.miew.ru").includes(`root ${join(t.previewRoot, "alpha")}/www-elyria;`),
  true,
);
eq(
  "grotto block has no elyria root",
  blockFor(alphaFrag, "alpha.abnocw.miew.ru").includes("www-elyria"),
  false,
);
eq(
  "elyria block has no grotto root",
  blockFor(alphaFrag, "alpha.elisium.miew.ru").includes("www-grotto"),
  false,
);
// ACME-challenge на СВОЁМ root в каждом блоке (webroot certbot = root блока).
eq(
  "both blocks own acme location",
  blockFor(alphaFrag, "alpha.abnocw.miew.ru").includes("location /.well-known/acme-challenge/") &&
    blockFor(alphaFrag, "alpha.elisium.miew.ru").includes("location /.well-known/acme-challenge/"),
  true,
);
// Полный набор проксируемых маршрутов в ОБОИХ блоках.
for (const loc of ["/health", "/auth", "/cfg", "/profiles", "/admin", "/ws"]) {
  eq(
    `both blocks proxy ${loc}`,
    blockFor(alphaFrag, "alpha.abnocw.miew.ru").includes(`location ${loc} `) &&
      blockFor(alphaFrag, "alpha.elisium.miew.ru").includes(`location ${loc} `),
    true,
  );
}
eq(
  "both blocks keep ws upgrade headers",
  blockFor(alphaFrag, "alpha.abnocw.miew.ru").includes("proxy_set_header Upgrade $http_upgrade;") &&
    blockFor(alphaFrag, "alpha.elisium.miew.ru").includes("proxy_set_header Upgrade $http_upgrade;"),
  true,
);
eq(
  "both blocks keep static immutable",
  blockFor(alphaFrag, "alpha.abnocw.miew.ru").includes("location /_next/static/") &&
    blockFor(alphaFrag, "alpha.elisium.miew.ru").includes("location /_next/static/"),
  true,
);

fillIncoming(t.incoming, "pr-41");
const prApply = run({
  ...base,
  PREVIEW_SLUG: "pr-41",
  PREVIEW_IN: join(t.incoming, "pr-41"),
  PREVIEW_PORT: "41041",
  PREVIEW_HOST: "pr-41.abnocw.miew.ru",
  PREVIEW_HOST2: "pr-41.elisium.miew.ru",
  PREVIEW_SHA: "deadbeefcafebabe",
});
dump("pr host apply", prApply);
eq("apply pr host", prApply.status, 0);
const prFrag = readFileSync(join(t.nginxD, "preview-pr-41.conf"), "utf8");
eq("nginx server_name is pr id (grotto)", prFrag.includes("server_name pr-41.abnocw.miew.ru;"), true);
eq("nginx server_name is pr id (elyria)", prFrag.includes("server_name pr-41.elisium.miew.ru;"), true);
eq("dir is pr-id (grotto)", existsSync(join(t.previewRoot, "pr-41/www-grotto/index.html")), true);
eq("dir is pr-id (elyria)", existsSync(join(t.previewRoot, "pr-41/www-elyria/index.html")), true);
chmodSync(join(t.nginxD, "preview-pr-41.conf"), 0o444);
const overwrite = run({
  ...base,
  PREVIEW_SLUG: "pr-41",
  PREVIEW_IN: join(t.incoming, "pr-41"),
  PREVIEW_PORT: "41041",
  PREVIEW_HOST: "pr-41.abnocw.miew.ru",
  PREVIEW_HOST2: "pr-41.elisium.miew.ru",
  PREVIEW_SHA: "overwrite1",
});
dump("overwrite read-only fragment", overwrite);
eq("overwrite read-only fragment", overwrite.status, 0);
const owFrag = readFileSync(join(t.nginxD, "preview-pr-41.conf"), "utf8");
eq("fragment replaced after unlink (grotto)", owFrag.includes("server_name pr-41.abnocw.miew.ru;"), true);
eq("fragment replaced after unlink (elyria)", owFrag.includes("server_name pr-41.elisium.miew.ru;"), true);
eq(
  "pr-41 env origins follow both hosts",
  readFileSync(join(t.previewRoot, "pr-41/env"), "utf8").includes(
    "ALLOWED_ORIGINS=http://pr-41.abnocw.miew.ru,https://pr-41.abnocw.miew.ru,http://pr-41.elisium.miew.ru,https://pr-41.elisium.miew.ru",
  ),
  true,
);
// Вход без www-grotto/index.html или www-elyria/index.html — отказ: контракт
// артефакта обязателен (оба корня обязательны).
{
  const brokenDir = join(t.incoming, "broken");
  const noElyria = { ...base, PREVIEW_IN: brokenDir, PREVIEW_SLUG: "broken", PREVIEW_HOST: "broken.abnocw.miew.ru", PREVIEW_HOST2: "broken.elisium.miew.ru", PREVIEW_PORT: "41009" };
  fillIncoming(t.incoming, "broken");
  rmSync(join(brokenDir, "www-elyria/index.html"));
  const r1 = run(noElyria);
  eq("refuse artifact without elyria index", r1.status === 0 ? "ok" : "fail", "fail");
  fillIncoming(t.incoming, "broken");
  rmSync(join(brokenDir, "www-grotto/index.html"));
  const r2 = run(noElyria);
  eq("refuse artifact without grotto index", r2.status === 0 ? "ok" : "fail", "fail");
}
// Легаси-env без ALLOWED_ORIGINS (какой был на VPS до фикса): re-apply добавляет
// новые ключи вместе с ОБЕИМИ хостами и не теряет ADMIN_PASS. HOST2 не передан —
// дефолт от slug (pr-41.elisium.miew.ru), как в deploy-конвейере.
writeFileSync(
  join(t.previewRoot, "pr-41/env"),
  "PORT=41041\nHOST=127.0.0.1\nDATA_DIR=/tmp/coop-legacy/data\nADMIN_PASS=zz\nREQUIRE_ORIGIN=0\n",
);
const noHost2 = { ...base };
delete noHost2.PREVIEW_HOST2;
const legacy = run({
  ...noHost2,
  PREVIEW_SLUG: "pr-41",
  PREVIEW_IN: join(t.incoming, "pr-41"),
  PREVIEW_PORT: "41041",
  PREVIEW_HOST: "cafebabe.abnocw.miew.ru",
  PREVIEW_SHA: "cafebabe1205719",
});
eq("apply over legacy env", legacy.status, 0);
const legacyEnv = readFileSync(join(t.previewRoot, "pr-41/env"), "utf8");
eq(
  "legacy env gained four origins",
  legacyEnv.includes(
    "ALLOWED_ORIGINS=http://cafebabe.abnocw.miew.ru,https://cafebabe.abnocw.miew.ru,http://pr-41.elisium.miew.ru,https://pr-41.elisium.miew.ru",
  ),
  true,
);
eq("legacy env gained public hosts", legacyEnv.includes("PUBLIC_HOSTS=cafebabe.abnocw.miew.ru"), true);
eq("legacy env gained elyria hosts", legacyEnv.includes("ELYRIA_HOSTS=pr-41.elisium.miew.ru"), true);
eq("legacy env kept admin pass", legacyEnv.includes("ADMIN_PASS=zz"), true);
eq("legacy env erased stale hosts", legacyEnv.includes("pr-41.abnocw.miew.ru") || legacyEnv.includes("alpha.elisium.miew.ru"), false);

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
eq("beta kept", existsSync(join(t.previewRoot, "beta/www-grotto/index.html")), true);
eq("beta nginx kept", existsSync(join(t.nginxD, "preview-beta.conf")), true);

// ── Cleanup-безопасность (B4): снос бьёт ТОЛЬКО свой pr-каталог ────────────
// Lookalike-соседи (префикс/суффикс/двойник имени) обязаны выжить:
// rm -rf -- "$APP" — единственное удаление каталога, путь точный, без
// глóбов и подсказок шире собственного slug.
for (const neighbor of ["bet", "betaevil", "beta2", "xbeta"]) {
  fillIncoming(t.incoming, neighbor);
  const r = run({
    ...base,
    PREVIEW_SLUG: neighbor,
    PREVIEW_IN: join(t.incoming, neighbor),
    PREVIEW_PORT: "41007",
  });
  eq(`apply lookalike ${neighbor}`, r.status, 0);
}
const goneBeta = run({
  ...base,
  PREVIEW_SLUG: "beta",
  PREVIEW_ACTION: "destroy",
});
eq("destroy beta (idempotent first pass)", goneBeta.status, 0);
eq("beta removed", existsSync(join(t.previewRoot, "beta")), false);
eq("beta nginx removed", existsSync(join(t.nginxD, "preview-beta.conf")), false);
for (const neighbor of ["bet", "betaevil", "beta2", "xbeta"]) {
  eq(`lookalike ${neighbor} data kept`, existsSync(join(t.previewRoot, neighbor, "www-grotto/index.html")), true);
  eq(`lookalike ${neighbor} nginx kept`, existsSync(join(t.nginxD, `preview-${neighbor}.conf`)), true);
  eq(`lookalike ${neighbor} env kept`, existsSync(join(t.previewRoot, neighbor, "env")), true);
}
// Повторный снос того же PR — идемпотентный: окружения уже нет, ошибок нет,
// ничего лишнего не задето.
const goneBeta2 = run({
  ...base,
  PREVIEW_SLUG: "beta",
  PREVIEW_ACTION: "destroy",
});
eq("destroy absent slug is idempotent", goneBeta2.status, 0);
for (const neighbor of ["bet", "betaevil", "beta2", "xbeta"]) {
  eq(`rerun keeps lookalike ${neighbor}`, existsSync(join(t.previewRoot, neighbor, "www-grotto/index.html")), true);
}
// Lookalike-окружения сносим сами: дальнейшие секции (лимит 8, сертификаты)
// считают каталоги staging'а — инвентарь возвращаем к до-тестовому составу,
// заодно ещё раз проверяем, что снос соседей не задел ничего чужого.
for (const neighbor of ["bet", "betaevil", "beta2", "xbeta"]) {
  const r = run({ ...base, PREVIEW_SLUG: neighbor, PREVIEW_ACTION: "destroy" });
  eq(`lookalike ${neighbor} self-cleanup`, r.status, 0);
  eq(`lookalike ${neighbor} gone`, existsSync(join(t.previewRoot, neighbor)), false);
  eq(`lookalike ${neighbor} nginx gone`, existsSync(join(t.nginxD, `preview-${neighbor}.conf`)), false);
}
// Статические гарантии сноса: никаких rm -rf с глóбами, никаких удалений
// корня preview или чужих путей — только точные переменные пути внутри
// своего окружения.
const cleanupText = readFileSync(script, "utf8");
eq(
  "apply has no rm with glob",
  /rm[[:space:]]+(-[a-zA-Z-]+[[:space:]]+)*-[a-zA-Z]*f[a-zA-Z]*[^\n]*\*/.test(cleanupText.replace(/rm -rf -- "\$APP"/g, "rm -rf EXACT")),
  false,
);
eq("apply never removes preview root itself", cleanupText.includes('rm -rf "$PREVIEW_ROOT"'), false);
eq("apply never removes prod root", cleanupText.includes('rm -rf -- "/opt/coop-field"'), false);
eq(
  "nginx removal scoped by exact fragment name",
  cleanupText.includes('rm -f "$FRAG"'),
  true,
);

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

// ── Сертификаты: per-host выбор по SAN, зоны не пересекаются ───────────────
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
makeCert(join(certDir, "wild-el"), "DNS:*.elisium.miew.ru,DNS:elisium.miew.ru");
fillIncoming(t.incoming, "tlsapex");
const apexTls = run({
  ...base,
  PREVIEW_SLUG: "tlsapex",
  PREVIEW_IN: join(t.incoming, "tlsapex"),
  PREVIEW_HOST: "tlsapex.abnocw.miew.ru",
  PREVIEW_HOST2: "tlsapex.elisium.miew.ru",
  PREVIEW_PORT: "41011",
  PREVIEW_TLS_WILD: join(certDir, "apex"),
});
dump("apex tls", apexTls);
eq("apply with apex-only cert", apexTls.status, 0);
const apexFrag = readFileSync(join(t.nginxD, "preview-tlsapex.conf"), "utf8");
eq(
  "apex-only cert skipped in both blocks",
  apexFrag.includes("ssl_certificate"),
  false,
);
eq(
  "no cert — no https jump",
  apexFrag.includes("return 301 https://"),
  false,
);
fillIncoming(t.incoming, "tlswild");
const wildTls = run({
  ...base,
  PREVIEW_SLUG: "tlswild",
  PREVIEW_IN: join(t.incoming, "tlswild"),
  PREVIEW_HOST: "tlswild.abnocw.miew.ru",
  PREVIEW_HOST2: "tlswild.elisium.miew.ru",
  PREVIEW_PORT: "41012",
  PREVIEW_TLS_WILD: join(certDir, "wild"),
});
dump("wild tls", wildTls);
eq("apply with abnocw wildcard cert", wildTls.status, 0);
const wildFrag = readFileSync(join(t.nginxD, "preview-tlswild.conf"), "utf8");
eq(
  "abnocw wildcard covers grotto block only",
  blockFor(wildFrag, "tlswild.abnocw.miew.ru").includes("ssl_certificate"),
  true,
);
eq(
  "abnocw wildcard does not cover elyria block",
  blockFor(wildFrag, "tlswild.elisium.miew.ru").includes("ssl_certificate"),
  false,
);
eq(
  "wildcard adds https redirect in grotto block",
  blockFor(wildFrag, "tlswild.abnocw.miew.ru").includes("return 301 https://"),
  true,
);
eq(
  "wildcard keeps acme path open in both blocks",
  wildFrag.includes("acme-challenge"),
  true,
);
// Зеркало зоны elisium (tls/elisium.miew.ru) подхватывается вторым блоком.
mkdirSync(join(t.previewRoot, "tls", "elisium.miew.ru"), { recursive: true });
makeCert(join(t.previewRoot, "tls", "elisium.miew.ru"), "DNS:*.elisium.miew.ru,DNS:elisium.miew.ru");
const wildTls2 = run({
  ...base,
  PREVIEW_SLUG: "tlswild",
  PREVIEW_IN: join(t.incoming, "tlswild"),
  PREVIEW_HOST: "tlswild.abnocw.miew.ru",
  PREVIEW_HOST2: "tlswild.elisium.miew.ru",
  PREVIEW_PORT: "41012",
  PREVIEW_TLS_WILD: join(certDir, "wild"),
  PREVIEW_SHA: "withzone",
});
dump("wild tls re-apply with zone mirror", wildTls2);
eq("re-apply with elyria zone mirror", wildTls2.status, 0);
const wildFrag2 = readFileSync(join(t.nginxD, "preview-tlswild.conf"), "utf8");
eq(
  "elyria block got zone-wildcard cert",
  blockFor(wildFrag2, "tlswild.elisium.miew.ru").includes(`ssl_certificate ${join(t.previewRoot, "tls", "elisium.miew.ru")}/fullchain.pem;`),
  true,
);
eq(
  "grotto block still on abnocw wildcard",
  blockFor(wildFrag2, "tlswild.abnocw.miew.ru").includes(`ssl_certificate ${join(certDir, "wild")}/fullchain.pem;`),
  true,
);

// Per-host зеркала tls/<host> (дефолт coop-preview-cert): каждый блок свой серт.
makeCert(join(t.previewRoot, "tls", "pr-41.abnocw.miew.ru"), "DNS:pr-41.abnocw.miew.ru");
makeCert(join(t.previewRoot, "tls", "pr-41.elisium.miew.ru"), "DNS:pr-41.elisium.miew.ru");
const perDual = run({
  ...base,
  PREVIEW_SLUG: "pr-41",
  PREVIEW_IN: join(t.incoming, "pr-41"),
  PREVIEW_PORT: "41041",
  PREVIEW_HOST: "pr-41.abnocw.miew.ru",
  PREVIEW_HOST2: "pr-41.elisium.miew.ru",
  PREVIEW_SHA: "perhost-dual",
});
dump("per-host dual tls", perDual);
eq("re-apply with per-host mirrors", perDual.status, 0);
const perFrag = readFileSync(join(t.nginxD, "preview-pr-41.conf"), "utf8");
eq(
  "grotto block got own per-host cert",
  blockFor(perFrag, "pr-41.abnocw.miew.ru").includes(
    `ssl_certificate ${join(t.previewRoot, "tls", "pr-41.abnocw.miew.ru")}/fullchain.pem;`,
  ),
  true,
);
eq(
  "elyria block got own per-host cert",
  blockFor(perFrag, "pr-41.elisium.miew.ru").includes(
    `ssl_certificate ${join(t.previewRoot, "tls", "pr-41.elisium.miew.ru")}/fullchain.pem;`,
  ),
  true,
);
eq(
  "per-host certs differ between blocks",
  blockFor(perFrag, "pr-41.abnocw.miew.ru").includes("pr-41.elisium.miew.ru/fullchain") ||
    blockFor(perFrag, "pr-41.elisium.miew.ru").includes("pr-41.abnocw.miew.ru/fullchain"),
  false,
);
// Один общий PREVIEW_TLS_PER с SAN обеих хостов — покрывает оба блока.
makeCert(join(certDir, "perboth"), "DNS:tlsper.abnocw.miew.ru,DNS:tlsper.elisium.miew.ru");
fillIncoming(t.incoming, "tlsper");
const perTls = run({
  ...base,
  PREVIEW_SLUG: "tlsper",
  PREVIEW_IN: join(t.incoming, "tlsper"),
  PREVIEW_HOST: "tlsper.abnocw.miew.ru",
  PREVIEW_HOST2: "tlsper.elisium.miew.ru",
  PREVIEW_PORT: "41013",
  PREVIEW_TLS_PER: join(certDir, "perboth"),
});
dump("perhost tls", perTls);
eq("apply with shared per-host cert", perTls.status, 0);
const perFrag2 = readFileSync(join(t.nginxD, "preview-tlsper.conf"), "utf8");
eq(
  "shared cert covers grotto block",
  blockFor(perFrag2, "tlsper.abnocw.miew.ru").includes("ssl_certificate"),
  true,
);
eq(
  "shared cert covers elyria block",
  blockFor(perFrag2, "tlsper.elisium.miew.ru").includes("ssl_certificate"),
  true,
);
eq(
  "shared cert adds https redirect",
  perFrag2.includes("return 301 https://"),
  true,
);

// ── Блокер root-RCE (PR #41): apply юниты не ставит ─────────────────────
// Статические проверки файлов конвейера: sudoers без cp юнита и
// daemon-reload, bootstrap без группы deploy. Комментарии файлов не
// смотри — только активные строки.
const active = (s) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
const sudoersText = active(readFileSync(join(here, "..", "deploy/vps/sudoers-coop-field-preview"), "utf8"));
eq("sudoers has no daemon-reload", sudoersText.includes("daemon-reload"), false);
eq("sudoers has no unit cp", sudoersText.includes("/usr/bin/cp"), false);
eq("sudoers keeps restart", sudoersText.includes("/usr/bin/systemctl restart coop-field-preview@*"), true);
eq("sudoers keeps enable --now", sudoersText.includes("/usr/bin/systemctl enable --now coop-field-preview@*"), true);
eq("sudoers keeps stop/disable/reset-failed for destroy", sudoersText.includes("/usr/bin/systemctl reset-failed coop-field-preview@*"), true);
eq("sudoers keeps nginx -t/reload", sudoersText.includes("/usr/sbin/nginx -t, /usr/bin/systemctl reload nginx"), true);
const applyText = readFileSync(script, "utf8");
eq("apply has no unit copy into /etc/systemd", applyText.includes("incoming-preview/coop-field-preview@.service\" /etc/systemd"), false);
eq("apply refuses when unit missing", applyText.includes("apply юниты не ставит"), true);
const bootstrapText = readFileSync(join(here, "..", "deploy/vps/preview-bootstrap.sh"), "utf8");
eq("bootstrap no usermod -aG deploy", active(bootstrapText).includes("usermod"), false);
eq("bootstrap still installs unit from its own dir", bootstrapText.includes("cp \"$HERE/coop-field-preview@.service\" /etc/systemd/system/coop-field-preview@.service"), true);
const nginxDocText = readFileSync(join(here, "..", "deploy/vps/nginx-preview.conf"), "utf8");
eq(
  "nginx doc /ws has X-Forwarded-For",
  /location \/ws[\s\S]*X-Forwarded-For \$proxy_add_x_forwarded_for/.test(nginxDocText),
  true,
);

// Полный apply без SKIP_SYSTEMD. «sudo» и «curl» подменяются шимами в PATH:
// фейковый sudo пишет лог вызовов (assert: только enable --now/restart,
// без cp юнита и daemon-reload), шим curl отвечает 200 на /health —
// настоящий curl на macOS в этом сандбоксе виснет на loopback-HTTP
// (0 байт при живом сервере), на CI ubuntu поведение шима и curl совпадают.
// Юнит в фейковом systemd-каталоге «уже установлен» bootstrap'ом; ядовитый
// юнит лежит в incoming — apply обязан его игнорировать.
const sudoLog = join(t.root, "sudo.log");
const fakeSudo = join(t.root, "fake-sudo.sh");
writeFileSync(fakeSudo, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${sudoLog}"\nexit 0\n`);
chmodSync(fakeSudo, 0o755);
const fakeBin = join(t.root, "bin");
mkdirSync(fakeBin, { recursive: true });
const fakeCurl = join(fakeBin, "curl");
writeFileSync(
  fakeCurl,
  `#!/bin/bash\nfor a in "$@"; do case "$a" in http://127.0.0.1:*) echo '{"ok":true}' ;; esac; done\nexit 0\n`,
);
chmodSync(fakeCurl, 0o755);
const shimPath = `${fakeBin}:${process.env.PATH}`;
const sysDir = join(t.root, "systemd");
mkdirSync(sysDir, { recursive: true });
const installedUnit = join(sysDir, "coop-field-preview@.service");
const installedUnitBody = "[Unit]\nDescription=installed by bootstrap once\n[Service]\nUser=deploy-preview\nExecStart=/opt/coop-field/.node/bin/node server.js\n";
writeFileSync(installedUnit, installedUnitBody);
mkdirSync(join(t.root, "incoming-preview"), { recursive: true });
writeFileSync(
  join(t.root, "incoming-preview/coop-field-preview@.service"),
  "[Unit]\nDescription=poison from PR\n[Service]\nUser=root\nExecStart=/bin/sh\n",
);
fillIncoming(t.incoming, "psec");
// node_modules «уже есть» (на VPS его кладёт первый apply): иначе sandbox
// побежит в несуществующий npm ci до systemd-фазы.
mkdirSync(join(t.previewRoot, "psec", "node_modules"), { recursive: true });
const full = run({
  ...base,
  PREVIEW_SLUG: "psec",
  PREVIEW_IN: join(t.incoming, "psec"),
  PREVIEW_PORT: "41699",
  PREVIEW_HOST: "psec.abnocw.miew.ru",
  PREVIEW_HOST2: "psec.elisium.miew.ru",
  PREVIEW_SHA: "psecdeadbeef",
  PREVIEW_SKIP_SYSTEMD: "0",
  PREVIEW_SKIP_NGINX: "1",
  PREVIEW_SYSTEMD_DIR: sysDir,
  PREVIEW_SUDO: fakeSudo,
  PATH: shimPath,
  // Верификация — отдельная фаза ниже (PREVIEW_ACTION=verify с шимами
  // dig/curl); в этом интеграционном прогоне она намеренно выключена:
  // https-запросы к несуществующему публичному имени из песочницы — мимо.
  PREVIEW_VERIFY: "0",
});
dump("apply psec full run", full);
eq("full apply (no skip) succeeds", full.status, 0);
eq("full apply prints health ok", full.stdout.includes("health ok"), true);
eq("verify off prints honest unverified marker", full.stdout.includes("PREVIEW-RESULT overall=unverified"), true);
const logText = readFileSync(sudoLog, "utf8");
eq("fake sudo got no daemon-reload", logText.includes("daemon-reload"), false);
eq("fake sudo got no unit cp", logText.includes("cp "), false);
eq("installed unit untouched by apply", readFileSync(installedUnit, "utf8"), installedUnitBody);
eq("enable --now recorded", logText.includes("/usr/bin/systemctl enable --now coop-field-preview@psec"), true);
eq("restart recorded", logText.includes("/usr/bin/systemctl restart coop-field-preview@psec"), true);
const psecFrag = readFileSync(join(t.nginxD, "preview-psec.conf"), "utf8");
eq(
  "generated /ws keeps X-Forwarded-For",
  psecFrag.includes("proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"),
  true,
);
eq(
  "full apply fragment has both hosts",
  psecFrag.includes("server_name psec.abnocw.miew.ru;") && psecFrag.includes("server_name psec.elisium.miew.ru;"),
  true,
);

// Юнит не установлен → apply отказывает ДО systemctl и ничего не пишет в
// systemd-каталог (даже при ядовитом юните в incoming).
const emptySys = join(t.root, "systemd-empty");
mkdirSync(emptySys, { recursive: true });
mkdirSync(join(t.previewRoot, "psec2", "node_modules"), { recursive: true });
const noUnit = run({
  ...base,
  PREVIEW_SLUG: "psec2",
  PREVIEW_IN: join(t.incoming, "psec"),
  PREVIEW_PORT: "41699",
  PREVIEW_SKIP_SYSTEMD: "0",
  PREVIEW_SKIP_NGINX: "1",
  PREVIEW_SYSTEMD_DIR: emptySys,
  PREVIEW_SUDO: fakeSudo,
  PATH: shimPath,
});
eq("apply refuses when unit missing", noUnit.status === 0 ? "ok" : "fail", "fail");
eq("refusal points to bootstrap", (noUnit.stderr || "").includes("preview-bootstrap.sh"), true);
eq("refusal wrote nothing into systemd dir", existsSync(join(emptySys, "coop-field-preview@.service")), false);

// ── Пост-деплой верификация и честные статусы (B4) ──────────────────────────
// Шимы инструментов: fake dig (список «резолвящихся» имён) и scripted curl
// (файлы сценариев get.<url> / head.<url>: строка 1 — код, остальное — тело).
// Никакого ssh и сети: скрипт обязан читать статусы из stdout (exit-код +
// PREVIEW-RESULT), а apply — выкладывать/не выкладывать по контракту.
const fakeTools = join(t.root, "verify-bin");
mkdirSync(fakeTools, { recursive: true });
const fakeDigSh = [
  "#!/bin/bash",
  'name="${@: -1}"',
  '[ -n "${FAKE_DNS_OK:-}" ] && [ -f "$FAKE_DNS_OK" ] && grep -qx "$name" "$FAKE_DNS_OK" && echo 127.0.0.127',
  "exit 0",
].join("\n");
writeFileSync(join(fakeTools, "dig"), fakeDigSh + "\n");
chmodSync(join(fakeTools, "dig"), 0o755);
// nslookup-шим: без него тестовая машина честно резолвит wildcard pr-*.abnocw
// через системный DNS — сцена needs-dns проверяла бы реальный интернет, а не
// код. Шим держит те же списки, что и dig (FAKE_DNS_OK).
const fakeNsSh = [
  "#!/bin/bash",
  'name="${@: -1}"',
  '[ -n "${FAKE_DNS_OK:-}" ] && [ -f "$FAKE_DNS_OK" ] && grep -qx "$name" "$FAKE_DNS_OK" || exit 1',
  'echo "Server:  127.0.0.127"',
  'echo "Address: 127.0.0.127#53"',
  'echo ""',
  'echo "Non-authoritative answer:"',
  'echo "Name:    $name"',
  'echo "Address: 127.0.0.127"',
  "exit 0",
].join("\n");
writeFileSync(join(fakeTools, "nslookup"), fakeNsSh + "\n");
chmodSync(join(fakeTools, "nslookup"), 0o755);
const fakeCurlSh = [
  "#!/bin/bash",
  'url="${@: -1}"',
  "out=\"\"",
  "prev=\"\"",
  "mode=get",
  'for a in "$@"; do',
  '  [ "$prev" = "-o" ] && out="$a"',
  '  prev="$a"',
  '  [ "$a" = "-I" ] && mode=head',
  "done",
  'key="$(printf "%s" "$url" | tr "/:?" "___")"',
  'f="${FAKE_HTTP_DIR:-/nonexistent}/$mode.$key"',
  '[ -f "$f" ] || exit 56',
  'code="$(sed -n "1p" "$f")"',
  '[ "$code" != "000" ] || exit 7',
  'if [ "$mode" = "head" ]; then',
  '  printf "HTTP/1.1 %s shim\\r\\n" "$code"',
  '  tail -n +2 "$f"',
  "else",
  '  if [ -n "$out" ]; then tail -n +2 "$f" > "$out"; else tail -n +2 "$f"; fi',
  '  printf "%s" "$code"',
  "fi",
  "exit 0",
].join("\n");
writeFileSync(join(fakeTools, "curl"), fakeCurlSh + "\n");
chmodSync(join(fakeTools, "curl"), 0o755);
const verifyPath = `${fakeTools}:${process.env.PATH}`;
const vDir = join(t.root, "verify-http");
mkdirSync(vDir, { recursive: true });
const dnsOk = join(t.root, "verify-dns.txt");
function httpScene(mode, url, code, body) {
  const key = url.replace(/[:/?]/g, "_");
  // Тело пишется байт-в-байт без доп-переводов: index-байты сверяются cmp'ом
  // в verify_one, лишний \n в сцене = ложный index-mismatch.
  writeFileSync(join(vDir, `${mode}.${key}`), String(code) + "\n" + (body === undefined ? "" : body));
}
function sceneGone(mode, url) {
  const key = url.replace(/[:/?]/g, "_");
  rmSync(join(vDir, `${mode}.${key}`), { force: true });
}
const PR41_G = "pr-41.abnocw.miew.ru";
const PR41_E = "pr-41.elisium.miew.ru";
const GROTTO_INDEX = "<html>grotto</html>\n";
const ELYRIA_INDEX = "<html>elyria</html>\n";
const HEALTH_OK = '{"ok":true,"rooms":0,"maxPlayers":50}';
const verifyBase = {
  ...base,
  PREVIEW_ACTION: "verify",
  PREVIEW_SKIP_NGINX: "1",
  PREVIEW_VERIFY_TRIES: "1",
  PREVIEW_VERIFY_SLEEP: "0",
  PREVIEW_HOST: PR41_G,
  PREVIEW_HOST2: PR41_E,
  PATH: verifyPath,
  FAKE_DNS_OK: dnsOk,
  FAKE_HTTP_DIR: vDir,
};

// Сцена 1: честный live — оба хоста резолвятся, https жив, редирект на месте,
// корни свои, health ок, /profiles раздельно (гроты 404, Элизия 200 ok).
writeFileSync(dnsOk, `${PR41_G}\n${PR41_E}\n`);
httpScene("get", `https://${PR41_G}/`, "200", GROTTO_INDEX);
httpScene("get", `https://${PR41_G}/health`, "200", HEALTH_OK);
httpScene("get", `https://${PR41_G}/profiles`, "404", '{"ok":false,"reason":"not_found"}');
httpScene("get", `https://${PR41_E}/`, "200", ELYRIA_INDEX);
httpScene("get", `https://${PR41_E}/health`, "200", HEALTH_OK);
httpScene("get", `https://${PR41_E}/profiles`, "200", '{"ok":true,"items":[],"total":0}');
httpScene("head", `http://${PR41_G}/`, "301", `location: https://${PR41_G}/`);
httpScene("head", `http://${PR41_E}/`, "301", `location: https://${PR41_E}/`);
const v1 = run({ ...verifyBase, PREVIEW_SLUG: "pr-41" });
dump("verify live dual", v1);
eq("verify dual live exit", v1.status, 0);
eq("verify dual live overall", v1.stdout.includes("PREVIEW-RESULT overall=live"), true);
eq("verify dual grotto ok", v1.stdout.includes("grotto=ok reasons=none"), true);
eq("verify dual elyria ok", v1.stdout.includes("elyria=ok reasons=none"), true);
eq("verify mode dual detected", v1.stdout.includes("mode=dual"), true);
eq("verify sha honest none (legacy artifact)", v1.stdout.includes("sha=none"), true);
eq(
  "verify prints timestamp",
  /verified_at=20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z/.test(v1.stdout),
  true,
);

// Сцена 2: Элизия частично падает (причём содержательная — другой index):
// grotto честно live-ish, elyria broken, overall partial-failure, exit 3.
httpScene("get", `https://${PR41_E}/`, "200", "<html>weird foreign page</html>\n");
const v2 = run({ ...verifyBase, PREVIEW_SLUG: "pr-41" });
dump("verify partial elyria", v2);
eq("partial-failure exit 3", v2.status, 3);
eq("partial-failure overall", v2.stdout.includes("PREVIEW-RESULT overall=partial-failure"), true);
eq("partial-failure grotto still ok", v2.stdout.includes("grotto=ok reasons=none"), true);
eq("partial-failure elyria broken with cause", v2.stdout.includes("elyria=broken reasons=index-mismatch"), true);
httpScene("get", `https://${PR41_E}/`, "200", ELYRIA_INDEX);

// Сцена 3: утечка /profiles на публичный хост (grotto 200 вместо 404) —
// гроты broken с точной причиной, Элизия ок, опять честный partial-failure.
httpScene("get", `https://${PR41_G}/profiles`, "200", '{"ok":true,"items":[]}');
const v3 = run({ ...verifyBase, PREVIEW_SLUG: "pr-41" });
eq("profiles leak is not live", v3.status, 3);
eq("profiles leak verdict", v3.stdout.includes("grotto=broken reasons=profiles-leak-200"), true);
httpScene("get", `https://${PR41_G}/profiles`, "404", '{"ok":false,"reason":"not_found"}');

// Сцена 4: http->https редирект пропал (443 жив, но 80 не перенаправляет) —
// отдельная честная причина redirect-off.
sceneGone("head", `http://${PR41_G}/`);
const v4 = run({ ...verifyBase, PREVIEW_SLUG: "pr-41" });
eq("redirect-off verdict", v4.stdout.includes(`grotto=broken reasons=redirect-off`), true);
eq("redirect-off partial", v4.status, 3);
httpScene("head", `http://${PR41_G}/`, "301", `location: https://${PR41_G}/`);

// Сцена 5: DNS не резолвится — обе стороны needs-dns, exit 6, ничто
// не притворяется живым.
writeFileSync(dnsOk, "");
const v5 = run({ ...verifyBase, PREVIEW_SLUG: "pr-41" });
eq("needs-dns exit 6", v5.status, 6);
eq("needs-dns overall", v5.stdout.includes("PREVIEW-RESULT overall=needs-dns"), true);
eq("needs-dns grotto reason", v5.stdout.includes("grotto=needs-dns reasons=dns"), true);
eq("needs-dns elyria reason", v5.stdout.includes("elyria=needs-dns reasons=dns"), true);
writeFileSync(dnsOk, `${PR41_G}\n${PR41_E}\n`);

// Сцена 6: сертификат ещё не выпущен (443 мёртв, 80 жив) — needs-tls, НЕ
// failed и НЕ live: выложено и работает по http, ждём root-cron (~5 мин).
for (const h of [PR41_G, PR41_E]) {
  sceneGone("get", `https://${h}/`);
  sceneGone("get", `https://${h}/health`);
  sceneGone("get", `https://${h}/profiles`);
  httpScene("get", `http://${h}/`, "200", h === PR41_G ? GROTTO_INDEX : ELYRIA_INDEX);
  httpScene("get", `http://${h}/health`, "200", HEALTH_OK);
  httpScene("get", `http://${h}/profiles`, h === PR41_G ? "404" : "200", h === PR41_G ? '{"ok":false,"reason":"not_found"}' : '{"ok":true,"items":[]}');
}
const v6 = run({ ...verifyBase, PREVIEW_SLUG: "pr-41" });
eq("needs-tls exit 5", v6.status, 5);
eq("needs-tls overall", v6.stdout.includes("PREVIEW-RESULT overall=needs-tls"), true);
eq("needs-tls both hosts pending", v6.stdout.includes("grotto=needs-tls reasons=tls-pending") && v6.stdout.includes("elyria=needs-tls reasons=tls-pending"), true);
for (const h of [PR41_G, PR41_E]) {
  sceneGone("get", `http://${h}/`);
  sceneGone("get", `http://${h}/health`);
  sceneGone(`get`, `http://${h}/profiles`);
  httpScene("get", `https://${h}/`, "200", h === PR41_G ? GROTTO_INDEX : ELYRIA_INDEX);
  httpScene("get", `https://${h}/health`, "200", HEALTH_OK);
}
httpScene("get", `https://${PR41_G}/profiles`, "404", '{"ok":false,"reason":"not_found"}');
httpScene("get", `https://${PR41_E}/profiles`, "200", '{"ok":true,"items":[],"total":0}');

// Сцена 7: bounded polling — конечные попытки с честным пересчётом причин
// в каждой; после последней — failed с последними причинами, а не success
// по расписанию sleep. Все ответы сети «пропали»: каждая попытка видит
// точные причины, счётчик попыток печатается, раннего live нет.
const v7 = run({
  ...verifyBase,
  PREVIEW_SLUG: "pr-41",
  PREVIEW_VERIFY_TRIES: "3",
  PREVIEW_VERIFY_SLEEP: "1",
  FAKE_HTTP_DIR: "/nonexistent-http-scenarios",
});
dump("polling exhausted", v7);
eq("polling exhausted exits failed", v7.status, 4);
eq("polling shows attempt 1", v7.stdout.includes("попытка 1/3"), true);
eq("polling shows attempt 2", v7.stdout.includes("попытка 2/3"), true);
eq("polling honest overall", v7.stdout.includes("PREVIEW-RESULT overall=failed"), true);
// Сцена 8: сцены на месте — первый же полный проход даёт live, попытка
// всего одна (ранний выход, никакого лишнего sleep).
const v8 = run({
  ...verifyBase,
  PREVIEW_SLUG: "pr-41",
  PREVIEW_VERIFY_TRIES: "5",
  PREVIEW_VERIFY_SLEEP: "1",
});
eq("healthy scene exits live fast", v8.status, 0);
eq("no extra attempts when live", v8.stdout.includes("попытка 1/"), false);
eq("live overall after polling", v8.stdout.includes("PREVIEW-RESULT overall=live"), true);

// Сцена 9: mirror-артефакт (старый коммит main без билд-вариантов): оба
// корня одинаковы, сайты одинаковые, /profiles 404 на обоих — это честный
// live в режиме mirror (дифференциации не требуется).
fillIncoming(t.incoming, "mirror1");
writeFileSync(join(t.incoming, "mirror1/www-elyria/index.html"), GROTTO_INDEX);
const m1 = run({
  ...base,
  PREVIEW_SLUG: "mirror1",
  PREVIEW_IN: join(t.incoming, "mirror1"),
  PREVIEW_HOST: "mirror1.abnocw.miew.ru",
  PREVIEW_HOST2: "mirror1.elisium.miew.ru",
  PREVIEW_PORT: "41067",
});
eq("apply mirror artifact", m1.status, 0);
eq("mirror mode recorded in env", readFileSync(join(t.previewRoot, "mirror1/env"), "utf8").includes("PREVIEW_SITES_MODE=mirror"), true);
writeFileSync(dnsOk, "mirror1.abnocw.miew.ru\nmirror1.elisium.miew.ru\n");
httpScene("get", "https://mirror1.abnocw.miew.ru/", "200", GROTTO_INDEX);
httpScene("get", "https://mirror1.abnocw.miew.ru/health", "200", HEALTH_OK);
httpScene("get", "https://mirror1.abnocw.miew.ru/profiles", "404", '{"ok":false,"reason":"not_found"}');
httpScene("get", "https://mirror1.elisium.miew.ru/", "200", GROTTO_INDEX);
httpScene("get", "https://mirror1.elisium.miew.ru/health", "200", HEALTH_OK);
httpScene("get", "https://mirror1.elisium.miew.ru/profiles", "404", '{"ok":false,"reason":"not_found"}');
httpScene("head", "http://mirror1.abnocw.miew.ru/", "301", "location: https://mirror1.abnocw.miew.ru/");
httpScene("head", "http://mirror1.elisium.miew.ru/", "301", "location: https://mirror1.elisium.miew.ru/");
const v9 = run({
  ...verifyBase,
  PREVIEW_SLUG: "mirror1",
  PREVIEW_HOST: "mirror1.abnocw.miew.ru",
  PREVIEW_HOST2: "mirror1.elisium.miew.ru",
});
dump("verify mirror live", v9);
eq("mirror live exit", v9.status, 0);
eq("mirror mode detected by verify", v9.stdout.includes("mode=mirror"), true);
eq("mirror live overall", v9.stdout.includes("PREVIEW-RESULT overall=live"), true);
// Инвентарь: лимит 8 честен, staging — не свалка; сносим отработавшие
// окружения сразу, чтобы следующие apply (marked, shastale) не упёрлись в
// лимит из-за тестовых данных.
const mirrorGone = run({ ...base, PREVIEW_SLUG: "mirror1", PREVIEW_ACTION: "destroy" });
eq("mirror1 self-cleanup after scene", mirrorGone.status, 0);
eq("mirror1 data gone after scene", existsSync(join(t.previewRoot, "mirror1")), false);
eq("mirror1 nginx gone after scene", existsSync(join(t.nginxD, "preview-mirror1.conf")), false);
writeFileSync(dnsOk, `${PR41_G}\n${PR41_E}\n`);

// Сцена 10: маркер сайта. Билд кладёт site.marker в корень; верификация
// сверяет байты по каждому хосту. Подмена маркера — честная причина.
fillIncoming(t.incoming, "marked");
writeFileSync(join(t.incoming, "marked/www-grotto/site.marker"), "grotto\n");
writeFileSync(join(t.incoming, "marked/www-elyria/site.marker"), "elyria\n");
const mk = run({
  ...base,
  PREVIEW_SLUG: "marked",
  PREVIEW_IN: join(t.incoming, "marked"),
  PREVIEW_HOST: "marked.abnocw.miew.ru",
  PREVIEW_HOST2: "marked.elisium.miew.ru",
  PREVIEW_PORT: "41068",
});
eq("apply marked artifact", mk.status, 0);
writeFileSync(dnsOk, "marked.abnocw.miew.ru\nmarked.elisium.miew.ru\n");
httpScene("get", "https://marked.abnocw.miew.ru/", "200", GROTTO_INDEX);
httpScene("get", "https://marked.abnocw.miew.ru/health", "200", HEALTH_OK);
httpScene("get", "https://marked.abnocw.miew.ru/profiles", "404", '{"ok":false,"reason":"not_found"}');
httpScene("get", "https://marked.abnocw.miew.ru/site.marker", "200", "elyria\n");
httpScene("get", "https://marked.elisium.miew.ru/", "200", ELYRIA_INDEX);
httpScene("get", "https://marked.elisium.miew.ru/health", "200", HEALTH_OK);
httpScene("get", "https://marked.elisium.miew.ru/profiles", "200", '{"ok":true,"items":[]}');
httpScene("get", "https://marked.elisium.miew.ru/site.marker", "200", "elyria\n");
httpScene("head", "http://marked.abnocw.miew.ru/", "301", "location: https://marked.abnocw.miew.ru/");
httpScene("head", "http://marked.elisium.miew.ru/", "301", "location: https://marked.elisium.miew.ru/");
const v10 = run({
  ...verifyBase,
  PREVIEW_SLUG: "marked",
  PREVIEW_HOST: "marked.abnocw.miew.ru",
  PREVIEW_HOST2: "marked.elisium.miew.ru",
});
eq("marker mismatch verdict", v10.stdout.includes("grotto=broken reasons=marker-mismatch"), true);
eq("marker mismatch partial", v10.status, 3);
httpScene("get", "https://marked.abnocw.miew.ru/site.marker", "200", "grotto\n");
const v10b = run({
  ...verifyBase,
  PREVIEW_SLUG: "marked",
  PREVIEW_HOST: "marked.abnocw.miew.ru",
  PREVIEW_HOST2: "marked.elisium.miew.ru",
});
eq("marker restored live", v10b.status, 0);
// Снос marked — лимит 8: следующий apply (shastale) не должен упереться в
// тестовые каталоги.
const markedGone = run({ ...base, PREVIEW_SLUG: "marked", PREVIEW_ACTION: "destroy" });
eq("marked self-cleanup after scene", markedGone.status, 0);
eq("marked data gone after scene", existsSync(join(t.previewRoot, "marked")), false);
eq("marked nginx gone after scene", existsSync(join(t.nginxD, "preview-marked.conf")), false);
writeFileSync(dnsOk, `${PR41_G}\n${PR41_E}\n`);

// Сцена 11: SHA-штамп артефакта. (а) Устаревший артефакт apply НЕ выкладывает
// вовсе; (b) если штамп на месте и расходится с PR head на verify —
// честный failed, никакой спекуляции «live».
{
  fillIncoming(t.incoming, "shastale");
  writeFileSync(join(t.incoming, "shastale/preview-sha"), "aaa111\n");
  const staleApply = run({
    ...base,
    PREVIEW_SLUG: "shastale",
    PREVIEW_IN: join(t.incoming, "shastale"),
    PREVIEW_HOST: "shastale.abnocw.miew.ru",
    PREVIEW_HOST2: "shastale.elisium.miew.ru",
    PREVIEW_PORT: "41069",
    PREVIEW_TRUSTED_SHA: "bbb222",
  });
  eq("stale artifact refused at apply", staleApply.status === 0 ? "live" : "refused", "refused");
  eq("stale artifact refusal says why", (staleApply.stderr || "").includes("устаревший дистрибутив"), true);
  eq("stale artifact not deployed", existsSync(join(t.previewRoot, "shastale")), false);
  const okApply = run({
    ...base,
    PREVIEW_SLUG: "shastale",
    PREVIEW_IN: join(t.incoming, "shastale"),
    PREVIEW_HOST: "shastale.abnocw.miew.ru",
    PREVIEW_HOST2: "shastale.elisium.miew.ru",
    PREVIEW_PORT: "41069",
    PREVIEW_TRUSTED_SHA: "aaa111",
  });
  eq("matching stamp deploys fine", okApply.status, 0);
  writeFileSync(dnsOk, "shastale.abnocw.miew.ru\nshastale.elisium.miew.ru\n");
  httpScene("get", "https://shastale.abnocw.miew.ru/", "200", GROTTO_INDEX);
  httpScene("get", "https://shastale.abnocw.miew.ru/health", "200", HEALTH_OK);
  httpScene("get", "https://shastale.abnocw.miew.ru/profiles", "404", '{"ok":false,"reason":"not_found"}');
  httpScene("get", "https://shastale.elisium.miew.ru/", "200", ELYRIA_INDEX);
  httpScene("get", "https://shastale.elisium.miew.ru/health", "200", HEALTH_OK);
  httpScene("get", "https://shastale.elisium.miew.ru/profiles", "200", '{"ok":true,"items":[]}');
  httpScene("head", "http://shastale.abnocw.miew.ru/", "301", "location: https://shastale.abnocw.miew.ru/");
  httpScene("head", "http://shastale.elisium.miew.ru/", "301", "location: https://shastale.elisium.miew.ru/");
  const v11 = run({
    ...verifyBase,
    PREVIEW_SLUG: "shastale",
    PREVIEW_HOST: "shastale.abnocw.miew.ru",
    PREVIEW_HOST2: "shastale.elisium.miew.ru",
    PREVIEW_TRUSTED_SHA: "bbb222",
  });
  eq("stale sha fails verify", v11.status, 4);
  eq("stale sha overall failed", v11.stdout.includes("PREVIEW-RESULT overall=failed"), true);
  eq("stale sha verdicts honest", v11.stdout.includes("sha-stale"), true);
  const v11b = run({
    ...verifyBase,
    PREVIEW_SLUG: "shastale",
    PREVIEW_HOST: "shastale.abnocw.miew.ru",
    PREVIEW_HOST2: "shastale.elisium.miew.ru",
    PREVIEW_TRUSTED_SHA: "aaa111",
  });
  eq("matching sha verifies live", v11b.status, 0);
}

// Сцена 12: PR head-свежесть против workflow_run: артефакт, собранный с
// ДРУГОГО SHA, чем актуальный head PR — apply обязан отказаться, PR-страница
// не имеет права врать про «сборку с head». (Покрыто сценой 11тем же
// механизмом PREVIEW_TRUSTED_SHA.)

// Сцена 13: verify на несуществующее окружение не выдумывает статусов.
{
  const v13 = run({
    ...verifyBase,
    PREVIEW_SLUG: "ghost",
    PREVIEW_HOST: "ghost.abnocw.miew.ru",
    PREVIEW_HOST2: "ghost.elisium.miew.ru",
  });
  eq("verify without app refuses", v13.status === 0 ? "live" : "refused", "refused");
  eq("verify refusal names missing root", (v13.stderr || "").includes("верифицировать нечего"), true);
}

// Сцена 14: снос с systemd не выходит за свой юнит: в логе sudo только
// stop/disable/reset-failed ТОЧНО своего инстанса и nginx-обслуживание;
// enable/restart сноса не делают. (Цель — shastale: он последним применён
// и гарантированно существует в staging'е.)
{
  const scopeLog = join(t.root, "scope-sudo.log");
  const scopeSudo = join(t.root, "scope-sudo.sh");
  writeFileSync(scopeSudo, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${scopeLog}"\nexit 0\n`);
  chmodSync(scopeSudo, 0o755);
  const goneScoped = run({
    ...base,
    PREVIEW_SLUG: "shastale",
    PREVIEW_ACTION: "destroy",
    PREVIEW_SKIP_SYSTEMD: "0",
    PREVIEW_SYSTEMD_DIR: sysDir,
    PREVIEW_SUDO: scopeSudo,
    PATH: shimPath,
    FAKE_DNS_OK: dnsOk,
  });
  eq("scoped destroy ok", goneScoped.status, 0);
  eq("shastale data removed", existsSync(join(t.previewRoot, "shastale")), false);
  const scopeLogText = readFileSync(scopeLog, "utf8");
  eq("destroy stops own unit only", scopeLogText.includes("/usr/bin/systemctl stop coop-field-preview@shastale"), true);
  eq("destroy disables own unit only", scopeLogText.includes("/usr/bin/systemctl disable coop-field-preview@shastale"), true);
  eq("destroy resets own unit only", scopeLogText.includes("/usr/bin/systemctl reset-failed coop-field-preview@shastale"), true);
  eq("destroy never enables units", scopeLogText.includes("enable"), false);
  eq("destroy never restarts units", scopeLogText.includes("restart"), false);
  eq(
    "no lookalike unit names touched",
    /coop-field-preview@(shastale1|shastaleevil|ashastale)/.test(scopeLogText),
    false,
  );
}

rmSync(t.root, { recursive: true, force: true });

if (failed) {
  console.error("preview apply: FAIL", failed);
  process.exit(1);
}
console.log("preview apply: зелёный");
