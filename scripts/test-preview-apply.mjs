#!/usr/bin/env node
/** Guards of deploy/vps/preview-apply.sh: slug, dual-host fragment, env
 * contract (PUBLIC_HOSTS/ELYRIA_HOSTS/ALLOWED_ORIGINS), destroy isolation,
 * max 8, unit guards. No SSH.
 * Резка по доменам: инфраструктура ассертов/фикстур/шимов и доменные секции
 * (slug-гварды, TLS-матрица, systemd-безопасность) живут в
 * preview-test-support.mjs; здесь — orchestrate apply/destroy-сцен и все
 * пост-деплой верификационные сцены честных статусов. Чек-метки не менялись. */
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import {
  eq,
  failedCount,
  run,
  dump,
  staging,
  fillIncoming,
  blockFor,
  sectionSlugHostGuards,
  sectionLegacyContract,
  sectionTlsMatrix,
  sectionSystemdSecurity,
  makeVerifyShims,
  httpScene,
  sceneGone,
  wsScene,
  smokeScenes,
  fillIncomingLegacy,
  script,
  GROTTO_INDEX,
  ELYRIA_INDEX,
  HEALTH_OK,
} from "./preview-test-support.mjs";

// slug/host-гварды: deny-наборы, хосты обеих зон, взаимозаменяемость
// позиций — доменная секция в preview-test-support.mjs.
sectionSlugHostGuards();

// ── Импровизированный VPS: staging-каталоги, dual-артефакты «во входящих» ──
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
// Полный набор проксируемых маршрутов в ОБОИХ блоках. /admin как ПРЕФИКС
// здесь быть НЕ должно: страница — статика варианта (www-elyria/admin);
// из /admin в Node уходит ТОЛЬКО API-префикс «Игроки на поле» (/admin/players
// со слэш-суффиксом), он и перечислен отдельной точной локацией.
for (const loc of ["/health", "/auth", "/cfg", "/profiles", "/admin/players", "/ws"]) {
  eq(
    `both blocks proxy ${loc}`,
    blockFor(alphaFrag, "alpha.abnocw.miew.ru").includes(`location ${loc} `) &&
      blockFor(alphaFrag, "alpha.elisium.miew.ru").includes(`location ${loc} `),
    true,
  );
}
// Страница панели остаётся статикой: цельного «location /admin » в блоке нет,
// значит /admin и /admin/ отдаются try_files от root варианта (как на проде).
eq(
  "no whole /admin location (page stays static)",
  /location \/admin \{/.test(alphaFrag),
  false,
);
eq(
  "admin page falls to try_files, api prefix is exact",
  !/location \/admin \{/.test(blockFor(alphaFrag, "alpha.elisium.miew.ru")) &&
    blockFor(alphaFrag, "alpha.elisium.miew.ru").includes("location /admin/players {"),
  true,
);
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

// TLS-матрица сертификатов (apex/wild/zone-зеркало/per-host/общий SAN) —
// доменная секция в preview-test-support.mjs.
sectionTlsMatrix(t, base);

// systemd-безопасность (root-RCE-блокер: sudoers/bootstrap/nginx-doc asserts,
// полный apply на шимах, отказ без юнита) — доменная секция в
// preview-test-support.mjs; системные ручки (sysDir/shimPath) нужны сцене 14.
const psecStage = sectionSystemdSecurity(t, base);

// ── Пост-деплой верификация и честные статусы (B4) ──────────────────────────
// Шимы инструментов: fake dig/nslookup + scripted curl (сценарии-файлы).
const verifyPath = makeVerifyShims(t.root);
const vDir = join(t.root, "verify-http");
mkdirSync(vDir, { recursive: true });
const dnsOk = join(t.root, "verify-dns.txt");
const PR41_G = "pr-41.abnocw.miew.ru";
const PR41_E = "pr-41.elisium.miew.ru";

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
httpScene(vDir, "get", `https://${PR41_G}/`, "200", GROTTO_INDEX);
httpScene(vDir, "get", `https://${PR41_G}/health`, "200", HEALTH_OK);
httpScene(vDir, "get", `https://${PR41_G}/profiles`, "404", '{"ok":false,"reason":"not_found"}');
httpScene(vDir, "get", `https://${PR41_E}/`, "200", ELYRIA_INDEX);
httpScene(vDir, "get", `https://${PR41_E}/health`, "200", HEALTH_OK);
httpScene(vDir, "get", `https://${PR41_E}/profiles`, "200", '{"ok":true,"items":[],"total":0}');
httpScene(vDir, "head", `http://${PR41_G}/`, "301", `location: https://${PR41_G}/`);
httpScene(vDir, "head", `http://${PR41_E}/`, "301", `location: https://${PR41_E}/`);
// §9.3: WS-проба обязана видеть живую upgrade-точку (101 на руку RFC 6455);
// §9.3b: функциональный смоук обеих Host-зон dual-артефакта.
wsScene(vDir, PR41_G);
wsScene(vDir, PR41_E);
smokeScenes(vDir, PR41_G, "grotto");
smokeScenes(vDir, PR41_E, "elyria");
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
httpScene(vDir, "get", `https://${PR41_E}/`, "200", "<html>weird foreign page</html>\n");
const v2 = run({ ...verifyBase, PREVIEW_SLUG: "pr-41" });
dump("verify partial elyria", v2);
eq("partial-failure exit 3", v2.status, 3);
eq("partial-failure overall", v2.stdout.includes("PREVIEW-RESULT overall=partial-failure"), true);
eq("partial-failure grotto still ok", v2.stdout.includes("grotto=ok reasons=none"), true);
eq("partial-failure elyria broken with cause", v2.stdout.includes("elyria=broken reasons=index-mismatch"), true);
httpScene(vDir, "get", `https://${PR41_E}/`, "200", ELYRIA_INDEX);

// Сцена 3: утечка /profiles на публичный хост (grotto 200 вместо 404) —
// гроты broken с точной причиной, Элизия ок, опять честный partial-failure.
httpScene(vDir, "get", `https://${PR41_G}/profiles`, "200", '{"ok":true,"items":[]}');
const v3 = run({ ...verifyBase, PREVIEW_SLUG: "pr-41" });
eq("profiles leak is not live", v3.status, 3);
eq("profiles leak verdict", v3.stdout.includes("grotto=broken reasons=profiles-leak-200"), true);
httpScene(vDir, "get", `https://${PR41_G}/profiles`, "404", '{"ok":false,"reason":"not_found"}');

// Сцена 4: http->https редирект пропал (443 жив, но 80 не перенаправляет) —
// отдельная честная причина redirect-off.
sceneGone(vDir, "head", `http://${PR41_G}/`);
const v4 = run({ ...verifyBase, PREVIEW_SLUG: "pr-41" });
eq("redirect-off verdict", v4.stdout.includes(`grotto=broken reasons=redirect-off`), true);
eq("redirect-off partial", v4.status, 3);
httpScene(vDir, "head", `http://${PR41_G}/`, "301", `location: https://${PR41_G}/`);

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
  sceneGone(vDir, "get", `https://${h}/`);
  sceneGone(vDir, "get", `https://${h}/health`);
  sceneGone(vDir, "get", `https://${h}/profiles`);
  httpScene(vDir, "get", `http://${h}/`, "200", h === PR41_G ? GROTTO_INDEX : ELYRIA_INDEX);
  httpScene(vDir, "get", `http://${h}/health`, "200", HEALTH_OK);
  httpScene(vDir, "get", `http://${h}/profiles`, h === PR41_G ? "404" : "200", h === PR41_G ? '{"ok":false,"reason":"not_found"}' : '{"ok":true,"items":[]}');
  wsScene(vDir, h, "http");
  smokeScenes(vDir, h, h === PR41_G ? "grotto" : "elyria", "http");
}
const v6 = run({ ...verifyBase, PREVIEW_SLUG: "pr-41" });
eq("needs-tls exit 5", v6.status, 5);
eq("needs-tls overall", v6.stdout.includes("PREVIEW-RESULT overall=needs-tls"), true);
eq("needs-tls both hosts pending", v6.stdout.includes("grotto=needs-tls reasons=tls-pending") && v6.stdout.includes("elyria=needs-tls reasons=tls-pending"), true);
for (const h of [PR41_G, PR41_E]) {
  sceneGone(vDir, "get", `http://${h}/`);
  sceneGone(vDir, "get", `http://${h}/health`);
  sceneGone(vDir, `get`, `http://${h}/profiles`);
  httpScene(vDir, "get", `https://${h}/`, "200", h === PR41_G ? GROTTO_INDEX : ELYRIA_INDEX);
  httpScene(vDir, "get", `https://${h}/health`, "200", HEALTH_OK);
}
httpScene(vDir, "get", `https://${PR41_G}/profiles`, "404", '{"ok":false,"reason":"not_found"}');
httpScene(vDir, "get", `https://${PR41_E}/profiles`, "200", '{"ok":true,"items":[],"total":0}');

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
httpScene(vDir, "get", "https://mirror1.abnocw.miew.ru/", "200", GROTTO_INDEX);
httpScene(vDir, "get", "https://mirror1.abnocw.miew.ru/health", "200", HEALTH_OK);
httpScene(vDir, "get", "https://mirror1.abnocw.miew.ru/profiles", "404", '{"ok":false,"reason":"not_found"}');
httpScene(vDir, "get", "https://mirror1.elisium.miew.ru/", "200", GROTTO_INDEX);
httpScene(vDir, "get", "https://mirror1.elisium.miew.ru/health", "200", HEALTH_OK);
httpScene(vDir, "get", "https://mirror1.elisium.miew.ru/profiles", "404", '{"ok":false,"reason":"not_found"}');
httpScene(vDir, "head", "http://mirror1.abnocw.miew.ru/", "301", "location: https://mirror1.abnocw.miew.ru/");
httpScene(vDir, "head", "http://mirror1.elisium.miew.ru/", "301", "location: https://mirror1.elisium.miew.ru/");
//mirror: единый движок без Host-политики — WS жив на обоих, смоук не честится.
wsScene(vDir, "mirror1.abnocw.miew.ru");
wsScene(vDir, "mirror1.elisium.miew.ru");
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
httpScene(vDir, "get", "https://marked.abnocw.miew.ru/", "200", GROTTO_INDEX);
httpScene(vDir, "get", "https://marked.abnocw.miew.ru/health", "200", HEALTH_OK);
httpScene(vDir, "get", "https://marked.abnocw.miew.ru/profiles", "404", '{"ok":false,"reason":"not_found"}');
httpScene(vDir, "get", "https://marked.abnocw.miew.ru/site.marker", "200", "elyria\n");
httpScene(vDir, "get", "https://marked.elisium.miew.ru/", "200", ELYRIA_INDEX);
httpScene(vDir, "get", "https://marked.elisium.miew.ru/health", "200", HEALTH_OK);
httpScene(vDir, "get", "https://marked.elisium.miew.ru/profiles", "200", '{"ok":true,"items":[]}');
httpScene(vDir, "get", "https://marked.elisium.miew.ru/site.marker", "200", "elyria\n");
httpScene(vDir, "head", "http://marked.abnocw.miew.ru/", "301", "location: https://marked.abnocw.miew.ru/");
httpScene(vDir, "head", "http://marked.elisium.miew.ru/", "301", "location: https://marked.elisium.miew.ru/");
wsScene(vDir, "marked.abnocw.miew.ru");
wsScene(vDir, "marked.elisium.miew.ru");
smokeScenes(vDir, "marked.abnocw.miew.ru", "grotto");
smokeScenes(vDir, "marked.elisium.miew.ru", "elyria");
const v10 = run({
  ...verifyBase,
  PREVIEW_SLUG: "marked",
  PREVIEW_HOST: "marked.abnocw.miew.ru",
  PREVIEW_HOST2: "marked.elisium.miew.ru",
});
eq("marker mismatch verdict", v10.stdout.includes("grotto=broken reasons=marker-mismatch"), true);
eq("marker mismatch partial", v10.status, 3);
httpScene(vDir, "get", "https://marked.abnocw.miew.ru/site.marker", "200", "grotto\n");
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
  httpScene(vDir, "get", "https://shastale.abnocw.miew.ru/", "200", GROTTO_INDEX);
  httpScene(vDir, "get", "https://shastale.abnocw.miew.ru/health", "200", HEALTH_OK);
  httpScene(vDir, "get", "https://shastale.abnocw.miew.ru/profiles", "404", '{"ok":false,"reason":"not_found"}');
  httpScene(vDir, "get", "https://shastale.elisium.miew.ru/", "200", ELYRIA_INDEX);
  httpScene(vDir, "get", "https://shastale.elisium.miew.ru/health", "200", HEALTH_OK);
  httpScene(vDir, "get", "https://shastale.elisium.miew.ru/profiles", "200", '{"ok":true,"items":[]}');
  httpScene(vDir, "head", "http://shastale.abnocw.miew.ru/", "301", "location: https://shastale.abnocw.miew.ru/");
  httpScene(vDir, "head", "http://shastale.elisium.miew.ru/", "301", "location: https://shastale.elisium.miew.ru/");
  wsScene(vDir, "shastale.abnocw.miew.ru");
  wsScene(vDir, "shastale.elisium.miew.ru");
  smokeScenes(vDir, "shastale.abnocw.miew.ru", "grotto");
  smokeScenes(vDir, "shastale.elisium.miew.ru", "elyria");
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

// Сцена 11b: legacy single-site вход-контракт — доменная секция в
// preview-test-support.mjs (смена режима на слаге, легаси-verify, WS-проба).
sectionLegacyContract({ t, base, verifyBase, vDir, dnsOk, pr41G: PR41_G, pr41E: PR41_E });

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
    PREVIEW_SYSTEMD_DIR: psecStage.sysDir,
    PREVIEW_SUDO: scopeSudo,
    PATH: psecStage.shimPath,
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

const failed = failedCount();
if (failed) {
  console.error("preview apply: FAIL", failed);
  process.exit(1);
}
console.log("preview apply: зелёный");
