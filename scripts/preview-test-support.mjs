#!/usr/bin/env node
/** Общие фикстуры, шимы и доменные секции preview-тестов деплой-конвейера.
 * Вынос из test-preview-apply.mjs (резка по доменам под лимит arch:check
 * в 800 строк). Здесь — инфраструктура ассертов (eq/run/dump), staging-
 * фикстура dual-артефакта, генератор openssl-сертификатов, шимы верификации
 * (dig/nslookup/curl по сценариям FAKE_HTTP_DIR) и доменные секции:
 * slug/host-гварды, TLS-матрица, systemd-безопасность (root-RCE-блокер).
 * Тела секций — вербатим из старого теста; чеки и их метки не менялись. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
export const script = join(here, "..", "deploy/vps/preview-apply.sh");

let failed = 0;

export function failedCount() {
  return failed;
}

export function eq(label, actual, expected) {
  if (actual === expected) {
    console.log("ok  ", label);
  } else {
    failed += 1;
    console.error("FAIL", label, "got", actual, "want", expected);
  }
}

export function run(env, extra = {}) {
  return spawnSync("bash", [script], {
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 15000,
    ...extra,
  });
}

export function dump(label, r) {
  if (r.status !== 0) {
    console.error(label, "status", r.status, "stderr", r.stderr, "stdout", r.stdout);
  }
}

export function staging() {
  const root = mkdtempSync(join(tmpdir(), "coop-preview-"));
  const previewRoot = join(root, "preview");
  const nginxD = join(root, "nginx");
  const incoming = join(root, "incoming");
  mkdirSync(previewRoot);
  mkdirSync(nginxD);
  return { root, previewRoot, nginxD, incoming };
}

export function fillIncoming(incoming, slug) {
  const dir = join(incoming, slug);
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(join(dir, "www-grotto"), { recursive: true });
  mkdirSync(join(dir, "www-elyria"), { recursive: true });
  writeFileSync(join(dir, "server.js"), "export default 1;\n");
  writeFileSync(join(dir, "server/protocol.js"), "export const EV = {};\n");
  writeFileSync(join(dir, "www-grotto/index.html"), "<html>grotto</html>\n");
  writeFileSync(join(dir, "www-elyria/index.html"), "<html>elyria</html>\n");
}

/** Легаси-фикстура (вход-контракт legacy-single): один www-корень. */
export function fillIncomingLegacy(incoming, slug) {
  const dir = join(incoming, slug);
  mkdirSync(join(dir, "server"), { recursive: true });
  mkdirSync(join(dir, "www"), { recursive: true });
  writeFileSync(join(dir, "server.js"), "export default 1;\n");
  writeFileSync(join(dir, "server/protocol.js"), "export const EV = {};\n");
  writeFileSync(join(dir, "www/index.html"), "<html>grotto</html>\n");
  return dir;
}

/** server-блок фрагмента по server_name (фрагмент держит по одному блоку на хост). */
export function blockFor(fragText, host) {
  const blocks = fragText.split(/^server \{$/m).slice(1).map((b) => `server {{${b}`);
  return blocks.find((b) => b.includes(`server_name ${host};`)) || "";
}

export function httpScene(vDir, mode, url, code, body) {
  const key = url.replace(/[:/?]/g, "_");
  // Тело пишется байт-в-байт без доп-переводов: index-байты сверяются cmp'ом
  // в verify_one, лишний \n в сцене = ложный index-mismatch.
  writeFileSync(join(vDir, `${mode}.${key}`), String(code) + "\n" + (body === undefined ? "" : body));
}

export function sceneGone(vDir, mode, url) {
  const key = url.replace(/[:/?]/g, "_");
  rmSync(join(vDir, `${mode}.${key}`), { force: true });
}

/** Сцена WS-пробы (§9.3): upgrade-рука GET /ws отвечает 101 — точка сокета
 * обязана быть живой; health по голому HTTP не достаточен (conn refused/
 * TLS-fail не должны проходить молча — шим без сцены темнит 000). */
export function wsScene(vDir, host, scheme = "https") {
  httpScene(vDir, "get", `${scheme}://${host}/ws`, "101", "");
}

/** Сцены функционального смоука §9.3b (проверяются только в dual-режиме):
 * grotto-класс — /auth/me 404 (API Элизии не живут на публичном хосте,
 * 200 = течь зоны); elyria-класс — register/login 400 на пустое тело (не
 * 404), POST /cfg не-админу 403. Шим ключевает сцену по URL, не по методу. */
export function smokeScenes(vDir, host, kind, scheme = "https") {
  if (kind === "grotto") {
    httpScene(vDir, "get", `${scheme}://${host}/auth/me`, "404", '{"ok":false}');
  } else {
    httpScene(vDir, "get", `${scheme}://${host}/auth/register`, "400", '{"ok":false}');
    httpScene(vDir, "get", `${scheme}://${host}/auth/login`, "400", '{"ok":false}');
    httpScene(vDir, "get", `${scheme}://${host}/cfg`, "403", '{"ok":false}');
  }
}

export const GROTTO_INDEX = "<html>grotto</html>\n";
export const ELYRIA_INDEX = "<html>elyria</html>\n";
export const HEALTH_OK = '{"ok":true,"rooms":0,"maxPlayers":50}';

// ── Доменные секции (тела вербатим из test-preview-apply.mjs) ─────────────

/** Гварды slug/хостов: deny-наборы, обе суффикс-зоны, позиции взаимозаменяемы. */
export function sectionSlugHostGuards() {
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
  eq("validate default host", okVal.stdout.includes("host=cursor-test.abnocw.phainonsmilk.ru"), true);
  eq("validate default host2", okVal.stdout.includes("host2=cursor-test.elysiae.phainonsmilk.ru"), true);
  eq("validate prints both roots", okVal.stdout.includes("roots=/opt/coop-field-preview/cursor-test/www-grotto,/opt/coop-field-preview/cursor-test/www-elyria"), true);

  // ── Валидация хостов в ОБОИХ суффикс-зонах ────────────────────────────────
  const longHostAbnocw = run({
    PREVIEW_SLUG: "pr-41",
    PREVIEW_HOST: "cursor-product-roadmap-and-platform-42e0.abnocw.phainonsmilk.ru",
    PREVIEW_ACTION: "validate",
  });
  eq("deny long server_name abnocw", longHostAbnocw.status === 0 ? "ok" : "fail", "fail");

  const longHostElisium = run({
    PREVIEW_SLUG: "pr-41",
    PREVIEW_HOST: "pr-41.abnocw.phainonsmilk.ru",
    PREVIEW_HOST2: "cursor-product-roadmap-and-platform-42e0.elysiae.phainonsmilk.ru",
    PREVIEW_ACTION: "validate",
  });
  eq("deny long server_name elisium", longHostElisium.status === 0 ? "ok" : "fail", "fail");

  const prHostVal = run({
    PREVIEW_SLUG: "pr-41",
    PREVIEW_HOST: "pr-41.abnocw.phainonsmilk.ru",
    PREVIEW_HOST2: "pr-41.elysiae.phainonsmilk.ru",
    PREVIEW_ACTION: "validate",
  });
  eq("validate pr hosts", prHostVal.status, 0);
  eq("validate pr host printed", prHostVal.stdout.includes("host=pr-41.abnocw.phainonsmilk.ru"), true);
  eq("validate pr host2 printed", prHostVal.stdout.includes("host2=pr-41.elysiae.phainonsmilk.ru"), true);
  // Hosts взаимозаменяемы позициями: суффикс решает зону, не порядок аргументов.
  const swapped = run({
    PREVIEW_SLUG: "pr-41",
    PREVIEW_HOST: "pr-41.elysiae.phainonsmilk.ru",
    PREVIEW_HOST2: "pr-41.abnocw.phainonsmilk.ru",
    PREVIEW_ACTION: "validate",
  });
  eq("hosts by suffix, not position", swapped.stdout.includes("host=pr-41.abnocw.phainonsmilk.ru"), true);
  eq("hosts by suffix, not position 2", swapped.stdout.includes("host2=pr-41.elysiae.phainonsmilk.ru"), true);

  // Две зоны одного вида — отказ.
  for (const same of [
    { PREVIEW_HOST: "pr-41.abnocw.phainonsmilk.ru", PREVIEW_HOST2: "pr-42.abnocw.phainonsmilk.ru" },
    { PREVIEW_HOST: "pr-41.elysiae.phainonsmilk.ru", PREVIEW_HOST2: "pr-42.elysiae.phainonsmilk.ru" },
  ]) {
    const r = run({ PREVIEW_SLUG: "pr-41", PREVIEW_ACTION: "validate", ...same });
    eq(`deny same-zone ${same.PREVIEW_HOST2}`, r.status === 0 ? "ok" : "fail", "fail");
  }
  // Чужой суффикс и мусор — отказ.
  for (const bad of ["pr-41.example.com", "pr-41.abnocw.phainonsmilk.ru.evil.ru", "PR-41.ABNOCW.MIEW.RU", "pr 41.abnocw.phainonsmilk.ru"]) {
    const r = run({ PREVIEW_SLUG: "pr-41", PREVIEW_HOST: bad, PREVIEW_HOST2: "pr-41.elysiae.phainonsmilk.ru", PREVIEW_ACTION: "validate" });
    eq(`deny host ${bad}`, r.status === 0 ? "ok" : "fail", "fail");
  }
  const badSecond = run({ PREVIEW_SLUG: "pr-41", PREVIEW_HOST: "pr-41.abnocw.phainonsmilk.ru", PREVIEW_HOST2: "pr-41.example.com", PREVIEW_ACTION: "validate" });
  eq("deny second host foreign suffix", badSecond.status === 0 ? "ok" : "fail", "fail");
}

/** TLS-матрица: apex-only / wildcard abnocw / зеркало зоны / per-host зеркала / общий SAN. */
export function sectionTlsMatrix(t, base) {
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
        "/CN=abnocw.phainonsmilk.ru",
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
  makeCert(join(certDir, "apex"), "DNS:abnocw.phainonsmilk.ru");
  makeCert(join(certDir, "wild"), "DNS:*.abnocw.phainonsmilk.ru,DNS:abnocw.phainonsmilk.ru");
  makeCert(join(certDir, "wild-el"), "DNS:*.elysiae.phainonsmilk.ru,DNS:phainonsmilk.ru");
  fillIncoming(t.incoming, "tlsapex");
  const apexTls = run({
    ...base,
    PREVIEW_SLUG: "tlsapex",
    PREVIEW_IN: join(t.incoming, "tlsapex"),
    PREVIEW_HOST: "tlsapex.abnocw.phainonsmilk.ru",
    PREVIEW_HOST2: "tlsapex.elysiae.phainonsmilk.ru",
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
    PREVIEW_HOST: "tlswild.abnocw.phainonsmilk.ru",
    PREVIEW_HOST2: "tlswild.elysiae.phainonsmilk.ru",
    PREVIEW_PORT: "41012",
    PREVIEW_TLS_WILD: join(certDir, "wild"),
  });
  dump("wild tls", wildTls);
  eq("apply with abnocw wildcard cert", wildTls.status, 0);
  const wildFrag = readFileSync(join(t.nginxD, "preview-tlswild.conf"), "utf8");
  eq(
    "abnocw wildcard covers grotto block only",
    blockFor(wildFrag, "tlswild.abnocw.phainonsmilk.ru").includes("ssl_certificate"),
    true,
  );
  eq(
    "abnocw wildcard does not cover elyria block",
    blockFor(wildFrag, "tlswild.elysiae.phainonsmilk.ru").includes("ssl_certificate"),
    false,
  );
  eq(
    "wildcard adds https redirect in grotto block",
    blockFor(wildFrag, "tlswild.abnocw.phainonsmilk.ru").includes("return 301 https://"),
    true,
  );
  eq(
    "wildcard keeps acme path open in both blocks",
    wildFrag.includes("acme-challenge"),
    true,
  );
  // Зеркало зоны elisium (tls/phainonsmilk.ru) подхватывается вторым блоком.
  mkdirSync(join(t.previewRoot, "tls", "phainonsmilk.ru"), { recursive: true });
  makeCert(join(t.previewRoot, "tls", "elysiae.phainonsmilk.ru"), "DNS:*.elysiae.phainonsmilk.ru,DNS:phainonsmilk.ru");
  const wildTls2 = run({
    ...base,
    PREVIEW_SLUG: "tlswild",
    PREVIEW_IN: join(t.incoming, "tlswild"),
    PREVIEW_HOST: "tlswild.abnocw.phainonsmilk.ru",
    PREVIEW_HOST2: "tlswild.elysiae.phainonsmilk.ru",
    PREVIEW_PORT: "41012",
    PREVIEW_TLS_WILD: join(certDir, "wild"),
    PREVIEW_SHA: "withzone",
  });
  dump("wild tls re-apply with zone mirror", wildTls2);
  eq("re-apply with elyria zone mirror", wildTls2.status, 0);
  const wildFrag2 = readFileSync(join(t.nginxD, "preview-tlswild.conf"), "utf8");
  eq(
    "elyria block got zone-wildcard cert",
    blockFor(wildFrag2, "tlswild.elysiae.phainonsmilk.ru").includes(`ssl_certificate ${join(t.previewRoot, "tls", "elysiae.phainonsmilk.ru")}/fullchain.pem;`),
    true,
  );
  eq(
    "grotto block still on abnocw wildcard",
    blockFor(wildFrag2, "tlswild.abnocw.phainonsmilk.ru").includes(`ssl_certificate ${join(certDir, "wild")}/fullchain.pem;`),
    true,
  );

  // Per-host зеркала tls/<host> (дефолт coop-preview-cert): каждый блок свой серт.
  makeCert(join(t.previewRoot, "tls", "pr-41.abnocw.phainonsmilk.ru"), "DNS:pr-41.abnocw.phainonsmilk.ru");
  makeCert(join(t.previewRoot, "tls", "pr-41.elysiae.phainonsmilk.ru"), "DNS:pr-41.elysiae.phainonsmilk.ru");
  const perDual = run({
    ...base,
    PREVIEW_SLUG: "pr-41",
    PREVIEW_IN: join(t.incoming, "pr-41"),
    PREVIEW_PORT: "41041",
    PREVIEW_HOST: "pr-41.abnocw.phainonsmilk.ru",
    PREVIEW_HOST2: "pr-41.elysiae.phainonsmilk.ru",
    PREVIEW_SHA: "perhost-dual",
  });
  dump("per-host dual tls", perDual);
  eq("re-apply with per-host mirrors", perDual.status, 0);
  const perFrag = readFileSync(join(t.nginxD, "preview-pr-41.conf"), "utf8");
  eq(
    "grotto block got own per-host cert",
    blockFor(perFrag, "pr-41.abnocw.phainonsmilk.ru").includes(
      `ssl_certificate ${join(t.previewRoot, "tls", "pr-41.abnocw.phainonsmilk.ru")}/fullchain.pem;`,
    ),
    true,
  );
  eq(
    "elyria block got own per-host cert",
    blockFor(perFrag, "pr-41.elysiae.phainonsmilk.ru").includes(
      `ssl_certificate ${join(t.previewRoot, "tls", "pr-41.elysiae.phainonsmilk.ru")}/fullchain.pem;`,
    ),
    true,
  );
  eq(
    "per-host certs differ between blocks",
    blockFor(perFrag, "pr-41.abnocw.phainonsmilk.ru").includes("pr-41.elysiae.phainonsmilk.ru/fullchain") ||
      blockFor(perFrag, "pr-41.elysiae.phainonsmilk.ru").includes("pr-41.abnocw.phainonsmilk.ru/fullchain"),
    false,
  );
  // Один общий PREVIEW_TLS_PER с SAN обеих хостов — покрывает оба блока.
  makeCert(join(certDir, "perboth"), "DNS:tlsper.abnocw.phainonsmilk.ru,DNS:tlsper.elysiae.phainonsmilk.ru");
  fillIncoming(t.incoming, "tlsper");
  const perTls = run({
    ...base,
    PREVIEW_SLUG: "tlsper",
    PREVIEW_IN: join(t.incoming, "tlsper"),
    PREVIEW_HOST: "tlsper.abnocw.phainonsmilk.ru",
    PREVIEW_HOST2: "tlsper.elysiae.phainonsmilk.ru",
    PREVIEW_PORT: "41013",
    PREVIEW_TLS_PER: join(certDir, "perboth"),
  });
  dump("perhost tls", perTls);
  eq("apply with shared per-host cert", perTls.status, 0);
  const perFrag2 = readFileSync(join(t.nginxD, "preview-tlsper.conf"), "utf8");
  eq(
    "shared cert covers grotto block",
    blockFor(perFrag2, "tlsper.abnocw.phainonsmilk.ru").includes("ssl_certificate"),
    true,
  );
  eq(
    "shared cert covers elyria block",
    blockFor(perFrag2, "tlsper.elysiae.phainonsmilk.ru").includes("ssl_certificate"),
    true,
  );
  eq(
    "shared cert adds https redirect",
    perFrag2.includes("return 301 https://"),
    true,
  );
}

/** Root-RCE-блокер: статические asserts sudoers/bootstrap/nginx + полный
 *  apply на шимах sudo/curl (ядовитый юнит в incoming игнорируется) и отказ
 *  при отсутствующем юните. Возвращает {sysDir, shimPath} для сцены сноса. */
export function sectionSystemdSecurity(t, base) {
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
    PREVIEW_HOST: "psec.abnocw.phainonsmilk.ru",
    PREVIEW_HOST2: "psec.elysiae.phainonsmilk.ru",
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
    psecFrag.includes("server_name psec.abnocw.phainonsmilk.ru;") && psecFrag.includes("server_name psec.elysiae.phainonsmilk.ru;"),
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
    return { sysDir: sysDir, shimPath: shimPath };
}

/** Шимы верификации: fake dig/nslookup (список FAKE_DNS_OK) + scripted curl
 *  (файлы сцен get.<url>/head.<url>: строка 1 — код, остальное — тело). */
/** Сцена 11b: legacy single-site вход-контракт (порядок мерджа PR #49/#50
 * не гарантирован: до продуктового PR артефакт честно одно-сайтовый; НЕ фейк и
 * НЕ ослабление — второй хост не заявляем и не верифицируем). Смена формата
 * артефакта на живом слаге + полный легаси verify-цикл, включая §9.3а WS-пробу
 * и честный отказ по чужой зоне хоста. Тело проверено на ветке: см. git log. */
export function sectionLegacyContract(P) {
  const { t, base, verifyBase, vDir, dnsOk, pr41G, pr41E } = P;
{
  // Инвентарь: janitor перед легаси-сценой — отработавшие окружения сносим
  // (сами же тесты учат: staging — не свалка), иначе legone упрётся в лимит 8.
  for (const spent of ["tlsapex", "psec2"]) {
    const r = run({ ...base, PREVIEW_SLUG: spent, PREVIEW_ACTION: "destroy" });
    eq(`janitor cleanup ${spent} before legacy scene`, r.status, 0);
    eq(`janitor ${spent} gone`, existsSync(join(t.previewRoot, spent)), false);
  }
}
{
  const LEG = "legone.abnocw.phainonsmilk.ru";
  fillIncoming(t.incoming, "legone");
  const dualFirst = run({
    ...base,
    PREVIEW_SLUG: "legone",
    PREVIEW_IN: join(t.incoming, "legone"),
    PREVIEW_HOST: LEG,
    PREVIEW_HOST2: "legone.elysiae.phainonsmilk.ru",
    PREVIEW_PORT: "41071",
  });
  eq("legone starts as dual (variant roots)", dualFirst.status, 0);
  eq("legone dual grotto root live", existsSync(join(t.previewRoot, "legone/www-grotto/index.html")), true);
  // Легаси-вход поверх ТОГО ЖЕ слага: www/ без вариантных корней (форма
  // артефакта старого main-билда до продуктового PR).
  fillIncomingLegacy(t.incoming, "legone-legacy");
  writeFileSync(join(t.incoming, "legone-legacy/metadata.json"), '{"mode":"legacy-single","sha":"fff999"}\n');
  const legacyOver = run({
    ...base,
    PREVIEW_SLUG: "legone",
    PREVIEW_IN: join(t.incoming, "legone-legacy"),
    PREVIEW_HOST: LEG,
    PREVIEW_PORT: "41071",
  });
  dump("legone legacy over dual", legacyOver);
  eq("legacy apply over dual slug succeeds", legacyOver.status, 0);
  eq("legacy single root deployed", existsSync(join(t.previewRoot, "legone/www/index.html")), true);
  eq("legacy wipes variant grotto root", existsSync(join(t.previewRoot, "legone/www-grotto")), false);
  eq("legacy wipes variant elyria root", existsSync(join(t.previewRoot, "legone/www-elyria")), false);
  eq("legacy metadata copied to app", readFileSync(join(t.previewRoot, "legone/metadata.json"), "utf8").includes("legacy-single"), true);
  const legEnv = readFileSync(join(t.previewRoot, "legone/env"), "utf8");
  eq("legacy env sites mode honest", legEnv.includes("PREVIEW_SITES_MODE=legacy-single"), true);
  eq("legacy env has no elyria hosts key", legEnv.includes("ELYRIA_HOSTS="), false);
  eq("legacy env single public host", legEnv.includes("PUBLIC_HOSTS=legone.abnocw.phainonsmilk.ru"), true);
  eq("legacy env origins single host", legEnv.includes(`ALLOWED_ORIGINS=http://${LEG},https://${LEG}`), true);
  const legFrag = readFileSync(join(t.nginxD, "preview-legone.conf"), "utf8");
  eq("legacy fragment single server block", legFrag.includes(`server_name ${LEG};`), true);
  eq("legacy fragment has no Elysiae zone block", legFrag.includes(".elysiae.phainonsmilk.ru"), false);
  eq("legacy fragment roots app www", /root [^\n]*\/legone\/www;/.test(legFrag), true);
  // Легаси-артефакт с главным именем чужой зоны — отказ, выкладки нет.
  const legBad = run({
    ...base,
    PREVIEW_SLUG: "legbad",
    PREVIEW_IN: join(t.incoming, "legone-legacy"),
    PREVIEW_HOST: "legbad.elysiae.phainonsmilk.ru",
    PREVIEW_HOST2: "legbad.abnocw.phainonsmilk.ru",
    PREVIEW_PORT: "41072",
  });
  dump("legbad foreign-zone legacy", legBad);
  eq("legacy refuses foreign-zone host", legBad.status === 0 ? "ok" : "fail", "fail");
  eq("legacy refusal names single-site rule", (legBad.stderr || "").includes("один abnocw-хост"), true);
  eq("legbad never deployed", existsSync(join(t.previewRoot, "legbad")), false);
  // Полный честный verify легаси: ОДИН хост, WS-проба, health, profiles.
  writeFileSync(dnsOk, `${LEG}\n`);
  httpScene(vDir, "get", `https://${LEG}/`, "200", GROTTO_INDEX);
  httpScene(vDir, "get", `https://${LEG}/health`, "200", HEALTH_OK);
  httpScene(vDir, "get", `https://${LEG}/profiles`, "404", '{"ok":false,"reason":"not_found"}');
  wsScene(vDir, LEG);
  httpScene(vDir, "head", `http://${LEG}/`, "301", `location: https://${LEG}/`);
  const legV = run({
    ...verifyBase,
    PREVIEW_SLUG: "legone",
    PREVIEW_HOST: LEG,
    PREVIEW_HOST2: "legone.elysiae.phainonsmilk.ru",
  });
  dump("verify legacy live", legV);
  eq("legacy verify live exit", legV.status, 0);
  eq("legacy verify overall live", legV.stdout.includes("PREVIEW-RESULT overall=live"), true);
  eq("legacy verify grotto ok", legV.stdout.includes("grotto=ok reasons=none"), true);
  eq("legacy verify mode legacy-single", legV.stdout.includes("mode=legacy-single"), true);
  eq("legacy verify honest note", legV.stdout.includes("note=legacy single-site preview (dual-host появится после мерджа PR #49)"), true);
  eq("legacy verify no elyria claim", legV.stdout.includes("elyria="), false);
  eq("legacy verify sha honest none", legV.stdout.includes("sha=none"), true);
  // §9.3а: WS-точка мертва (connection-refused/TLS-fail сортов 000) — не
  // молчит: grotto broken с точной причиной ws-000, overall failed, exit 4.
  sceneGone(vDir, "get", `https://${LEG}/ws`);
  const legWsDead = run({
    ...verifyBase,
    PREVIEW_SLUG: "legone",
    PREVIEW_HOST: LEG,
    PREVIEW_HOST2: "legone.elysiae.phainonsmilk.ru",
  });
  dump("verify legacy ws dead", legWsDead);
  eq("legacy ws-dead not live (exit 4)", legWsDead.status, 4);
  eq("legacy ws-dead reason named", legWsDead.stdout.includes("grotto=broken reasons=ws-000"), true);
  eq("legacy ws-dead overall failed", legWsDead.stdout.includes("PREVIEW-RESULT overall=failed"), true);
  wsScene(vDir, LEG);
  // DNS не резолвится — needs-dns как в dual, exit 6, без спекуляций live.
  writeFileSync(dnsOk, "");
  const legDns = run({
    ...verifyBase,
    PREVIEW_SLUG: "legone",
    PREVIEW_HOST: LEG,
    PREVIEW_HOST2: "legone.elysiae.phainonsmilk.ru",
  });
  eq("legacy needs-dns exit 6", legDns.status, 6);
  eq("legacy needs-dns honest", legDns.stdout.includes("grotto=needs-dns reasons=dns"), true);
  writeFileSync(dnsOk, `${pr41G}\n${pr41E}\n`);
  // Инвентарь: слаг отработал — снос, финальные сцены идут чисто.
  const legoneGone = run({ ...base, PREVIEW_SLUG: "legone", PREVIEW_ACTION: "destroy" });
  eq("legone self-cleanup after scene", legoneGone.status, 0);
  eq("legone data gone after scene", existsSync(join(t.previewRoot, "legone")), false);
}
}

export function makeVerifyShims(root) {
  const fakeTools = join(root, "verify-bin");
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
  // getent-шим: на linux-раннерах getent существует системно — без шима он
  // реактивно резолвит wildcard pr-*.abnocw.phainonsmilk.ru через /etc/resolv.conf,
  // и сцены needs-dns видят «DNS есть» (ран #42434980408/#42434980453).
  // macOS getent нет вовсе — поэтому локально сцены зелёные, CI падал.
  // Политика та же, что у dig/nslookup: имя в FAKE_DNS_OK → 127.0.0.127,
  // иначе пусто (needs-dns).
  const fakeGetentSh = [
    "#!/bin/bash",
    'name="${@: -1}"',
    '[ -n "${FAKE_DNS_OK:-}" ] && [ -f "$FAKE_DNS_OK" ] && grep -qx "$name" "$FAKE_DNS_OK" || exit 2',
    'echo "127.0.0.127	$name"',
    "exit 0",
  ].join("\n");
  writeFileSync(join(fakeTools, "getent"), fakeGetentSh + "\n");
  chmodSync(join(fakeTools, "getent"), 0o755);
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
    return verifyPath;
}
