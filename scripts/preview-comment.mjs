#!/usr/bin/env node
/**
 * The ONE marker comment of a preview PR: deployment badges, thread comment
 * and the PR-header preview link.
 *
 * Extracted verbatim from the "Deployment и один комментарий" inline shell of
 * .github/workflows/preview-deploy.yml so the logic lives in testable code
 * instead of a YAML string. One bad shell character there (the stray `)` of
 * 2026-11) killed the step AFTER a successful rollout: overall=live, red run,
 * and a stale failure marker stuck on the PR. This module makes that class
 * of bug impossible (the workflow block is now a single `node` invocation)
 * and adds contracts the shell could not express:
 *
 *  - exactly ONE marker comment per PR: found by the marker prefix (paginated
 *    — a marker older than the first page is still found) and UPDATED in
 *    place, never duplicated;
 *  - every PREVIEW-RESULT status — live, destroyed, needs-tls, needs-dns,
 *    needs-secret, needs-bootstrap, partial-failure, failed — plus the
 *    unknown fallback renders an honest human verdict;
 *  - failure isolation: deployment badges and the PR header are BEST-EFFORT
 *    (a failure warns, it never fails the step and never masks anything);
 *    only the marker comment itself is fatal — a deploy problem is already
 *    recorded by the ship step, so nothing here can overwrite it.
 *
 * IMPORTANT: preview-deploy.yml is a workflow_run pipeline — GitHub always
 * executes THAT file from the default branch (main). This script is checked
 * out from main there, so both land on the VPS-side pipeline only after the
 * PR is merged (docs/DEPLOY-CHECKLIST.md).
 *
 * No new npm deps: GitHub REST via global fetch (node >= 18); the test suite
 * scripts/test-preview-comment.mjs injects fetch/log stubs. The PR-header
 * transform is reused from scripts/preview-pr-link.mjs (single tested
 * implementation of the marker block).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withPreviewHeader } from "./preview-pr-link.mjs";

export const PREVIEW_COMMENT_MARKER = "<!-- coop-field-preview -->";

/** date -u '+%Y-%m-%d %H:%M UTC' equivalent (always UTC). */
export function fmtClock(now) {
  const d = now instanceof Date ? now : new Date(now);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

const legacyNote = "legacy single-site; dual-host появится после мерджа PR #49.\n";

/**
 * Deployment-state mapping, carried over from the shell case block:
 * only success/in_progress/failure are POSTed as deployment statuses
 * (destroyed/pending-setup fallbacks never create badge records — the
 * marker comment covers them instead).
 */
export function deploymentStateOf(status) {
  switch (status) {
    case "live": return "success";
    case "needs-tls": return "in_progress";
    case "partial-failure":
    case "needs-dns":
    case "failed": return "failure";
    default: return null; // destroyed, needs-secret, needs-bootstrap, unknown
  }
}

const not = (v, fb) => (v == null || v === "" ? fb : v);

/**
 * Marker-comment body for every status. Pure; ports the shell case tables
 * verbatim (dual + legacy-single wording included).
 */
export function commentBody(ctx) {
  const url = ctx.url ?? "";
  const url2 = ctx.url2 ?? "";
  const leg = ctx.mode === "legacy-single" ? legacyNote : "";
  const when = not(ctx.vtime, fmtClock(ctx.now ?? new Date()));
  const sha7 = String(ctx.sha ?? "").slice(0, 7);
  const grotto = (fb) => not(ctx.grotto, fb);
  const elyria = (fb) => not(ctx.elyria ?? "none", fb);
  const m = `${PREVIEW_COMMENT_MARKER}\n${leg}`;
  switch (ctx.status) {
    case "destroyed":
      return `${m}Окружение \`pr-${ctx.pr}\` снесено: оба сайта и данные preview убраны с VPS.`;
    case "live":
      return ctx.mode === "legacy-single"
        ? `${m}Beer Grottoes:\n${url} — live. Верификация хоста (DNS, редирект, TLS, корень, health, WS-проба): прошла ${when}.\nСборка с коммита \`${sha7}\` (не из имени ветки). Данные прода не используются.`
        : `${PREVIEW_COMMENT_MARKER}\nBeer Grottoes:\n${url} — live. Верификация: ${when}.\nElyria Eides:\n${url2} — live. Верификация: ${when}.\nСборка с коммита \`${sha7}\` (не из имени ветки). Оба сайта и комната — из этого SHA, данные прода не используются.\nHTTPS: per-host сертификат на КАЖДЫЙ хост — root-cron на VPS выдаёт их в течение ~5 минут; до этого первый прогон открывается по чистому http (это ожидаемо, не поломка).`;
    case "partial-failure":
      return `${m}Beer Grottoes:\n${url} — ${grotto("unknown")}.\nElyria Eides:\n${url2} — ${elyria("unknown")}.\nЧастичная неудача: один сайт не прошёл верификацию, второй честно живёт по своему статусу.\nПричины: ${not(ctx.reasons, "unknown")}. Коммит \`${sha7}\`, проверено ${when}.\nЛог: ${ctx.runUrl}.`;
    case "needs-tls":
      return `${m}Beer Grottoes:\n${url} — выложено, https-сертификат ещё не готов.\nElyria Eides:\n${url2} — выложено, тот же сертификат-конвейер.\nroot-cron на VPS выпускает per-host сертификаты каждые ~5 минут; по http сайты уже отвечает. Ссылку можно открывать, как только статус станет live (следующий push или через повторную проверку). Причины последней проверки: ${not(ctx.reasons, "none")}. Проверено ${when}.`;
    case "needs-dns":
      return `${m}Beer Grottoes:\n${url} — не резолвится.\nElyria Eides:\n${url2} — не резолвится.\nСервер честно отказывается звать несуществующее имя live: нужен wildcard pr-*.abnocw.phainonsmilk.ru / pr-*.elysiae.phainonsmilk.ru (см. docs/PREVIEW-ENVIRONMENTS.md). Причины: ${not(ctx.reasons, "dns")}. Проверено ${when}.`;
    case "failed":
      return `${m}Beer Grottoes:\n${url} — не выложен или не прошёл верификацию (${grotto("?")}).\nElyria Eides:\n${url2} — не выложен или не прошёл верификацию (${elyria("?")}).\nПричины: ${not(ctx.reasons, "unknown")}. Коммит \`${sha7}\`, проверено ${when}.\nЛог: ${ctx.runUrl}.`;
    case "needs-secret":
      return `${m}Beer Grottoes:\n${url} — не выложен: нет секрета \`PREVIEW_SSH_KEY\`.\nElyria Eides:\n${url2} — не выложен: тот же секрет, один шаг Сырь — [docs/PREVIEW-ENVIRONMENTS.md](https://github.com/${ctx.repo}/blob/${ctx.sha}/docs/PREVIEW-ENVIRONMENTS.md).`;
    case "needs-bootstrap":
      return `${m}Beer Grottoes:\n${url} — SSH есть, на VPS ещё нет bootstrap.\nElyria Eides:\n${url2} — то же окружение. От root один раз:\n\`\`\`\nsudo bash /home/deploy-preview/incoming-preview/preview-bootstrap.sh\n\`\`\`\nПосле этого следующий push в PR выложит оба сайта.`;
    default:
      // Unknown/empty status (ship step crashed before writing outputs).
      return `${m}Beer Grottoes:\n${url} — не выложен (ошибка джобы).\nElyria Eides:\n${url2} — не выложен (то же окружение). Если нет каталога \`/opt/coop-field-preview\`, на VPS от root:\n\`sudo bash /home/deploy-preview/incoming-preview/preview-bootstrap.sh\``;
  }
}

/**
 * The one-line header block for the PR body (preview link at the very top).
 * Ports the shell HDR tables verbatim; speculative hrefs stay forbidden —
 * links appear only in the live wording, exactly as before.
 */
export function headerLine(ctx) {
  const url = ctx.url ?? "";
  const url2 = ctx.url2 ?? "";
  const when = not(ctx.vtime, fmtClock(ctx.now ?? new Date()));
  const sha7 = String(ctx.sha ?? "").slice(0, 7);
  const legacy = ctx.mode === "legacy-single";
  const status = not(ctx.status, "unknown");
  switch (legacy ? "legacy" : "dual") {
    case "legacy":
      switch (ctx.status) {
        case "live":
          return `> 🚀 **Beer Grottoes:** [${url}](${url}) — live, сборка с коммита \`${sha7}\` (legacy single-site; dual-host появится после мерджа PR #49). Верифицировано ${when}.`;
        case "needs-tls":
          return `> 🚀 **Beer Grottoes:** ${url} — выложено, ждём https-сертификат (~5 мин, root-cron; http уже работает). Legacy single-site до мерджа PR #49.`;
        case "destroyed":
          return `> 🚀 **Preview:** снесён — PR закрыт, сайт и окружение убраны с VPS.`;
        case "needs-secret":
          return `> 🚀 **Beer Grottoes:** ${url} — не выложен: не задан секрет \`PREVIEW_SSH_KEY\` (docs/PREVIEW-ENVIRONMENTS.md). Legacy single-site до мерджа PR #49.`;
        case "needs-bootstrap":
          return `> 🚀 **Beer Grottoes:** ${url} — ждёт один bootstrap на VPS от root. Legacy single-site до мерджа PR #49.`;
        default:
          return `> 🚀 **Beer Grottoes:** ${url} — не выложен или не верифицирован (статус: ${status}). Legacy single-site до мерджа PR #49.`;
      }
    default:
      switch (ctx.status) {
        case "live":
          return `> 🚀 **Beer Grottoes:** [${url}](${url}) — сборка с коммита \`${sha7}\`, данные прода не используются.\n> 🚀 **Elyria Eides:** [${url2}](${url2}) — тот же коммит и та же комната. Верифицировано ${when}.`;
        case "needs-tls":
          return `> 🚀 **Beer Grottoes:** ${url} — выложено, ждём https-сертификат (~5 мин, root-cron на VPS; http уже работает).\n> 🚀 **Elyria Eides:** ${url2} — выложено, тот же конвейер сертификатов.`;
        case "destroyed":
          return `> 🚀 **Preview:** снесён — PR закрыт, оба сайта (${url} и ${url2}) и окружение убраны с VPS.`;
        case "needs-secret":
          return `> 🚀 **Beer Grottoes:** ${url} — не выложен: не задан секрет \`PREVIEW_SSH_KEY\` (docs/PREVIEW-ENVIRONMENTS.md).\n> 🚀 **Elyria Eides:** ${url2} — появится тем же шагом вместе с гротами.`;
        case "needs-bootstrap":
          return `> 🚀 **Beer Grottoes:** ${url} — ждёт один bootstrap на VPS от root.\n> 🚀 **Elyria Eides:** ${url2} — появится тем же bootstrap'ом.`;
        default:
          return `> 🚀 **Beer Grottoes:** ${url} — не выложен или не верифицирован (статус: ${status}).\n> 🚀 **Elyria Eides:** ${url2} — то же окружение.`;
      }
  }
}

const ghHeaders = (token, json) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(json ? { "Content-Type": "application/json" } : {}),
});

/**
 * Marker-comment id, newest match wins; walks ALL comment pages so a marker
 * pushed deep into the thread by an old run is still found instead of
 * duplicated. Returns 0/null when the PR has no marker comment yet.
 */
export async function findMarkerCommentId(ctx, deps) {
  const fetchImpl = deps.fetch ?? fetch;
  let best = 0;
  const maxPages = deps.maxPages ?? 20;
  for (let page = 1; page <= maxPages; page += 1) {
    const res = await fetchImpl(
      `https://api.github.com/repos/${ctx.repo}/issues/${ctx.pr}/comments?per_page=100&page=${page}`,
      { headers: ghHeaders(ctx.token) },
    );
    if (!res.ok) throw new Error(`list PR comments failed: ${res.status}`);
    const rows = await res.json();
    for (const c of rows) {
      if (typeof c.body === "string" && c.body.startsWith(PREVIEW_COMMENT_MARKER) && c.id > best) best = c.id;
    }
    if (!Array.isArray(rows) || rows.length < 100) return best;
  }
  return best;
}

/**
 * Whole step: badges (best-effort) -> marker comment (fatal) -> PR header
 * (best-effort). Never throws for badge/header problems — it reports them
 * via the returned result so the caller (and the test) can see everything,
 * and throws only when the marker comment itself could not be published.
 */
export async function publishPreviewComment(ctx, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch;
  const warn = deps.warn ?? console.warn;
  const out = { badgePosted: false, headerUpdated: false, commentId: 0, updated: false, warnings: [] };

  // 1) Deployment status badge — deliberate best-effort (the shell `|| true`):
  //    a broken badge must not fail run reporting nor mask a deploy problem.
  const state = deploymentStateOf(ctx.status);
  if (state) {
    try {
      const dep = await fetchImpl(`https://api.github.com/repos/${ctx.repo}/deployments`, {
        method: "POST",
        headers: ghHeaders(ctx.token, true),
        body: JSON.stringify({
          ref: ctx.sha,
          environment: ctx.envName ?? `preview-pr-${ctx.pr}`,
          auto_merge: false,
          description: `preview ${ctx.slug}: гроты ${ctx.url}, Элизия ${ctx.url2}`,
        }),
      });
      if (!dep.ok) throw new Error(`create deployment: ${dep.status}`);
      const depId = (await dep.json()).id;
      if (depId) {
        const st = await fetchImpl(`https://api.github.com/repos/${ctx.repo}/deployments/${depId}/statuses`, {
          method: "POST",
          headers: ghHeaders(ctx.token, true),
          body: JSON.stringify({ state, environment_url: ctx.url, log_url: ctx.runUrl }),
        });
        if (!st.ok) throw new Error(`deployment status: ${st.status}`);
        out.badgePosted = true;
      }
    } catch (e) {
      const w = `::warning::deployment badge failed (non-fatal): ${e.message}`;
      out.warnings.push(w);
      warn(w);
    }
  }

  // 2) The ONE marker comment: update in place, create on first run. Fatal on
  //    purpose — a stale marker lying about a live preview is the worst
  //    outcome this step can produce.
  const body = commentBody(ctx);
  const cid = await findMarkerCommentId(ctx, deps);
  if (cid) {
    const res = await fetchImpl(`https://api.github.com/repos/${ctx.repo}/issues/comments/${cid}`, {
      method: "PATCH",
      headers: ghHeaders(ctx.token, true),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`update marker comment ${cid} failed: ${res.status}`);
    out.commentId = cid;
    out.updated = true;
  } else {
    const res = await fetchImpl(`https://api.github.com/repos/${ctx.repo}/issues/${ctx.pr}/comments`, {
      method: "POST",
      headers: ghHeaders(ctx.token, true),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`create marker comment failed: ${res.status}`);
    out.commentId = (await res.json()).id ?? 0;
  }

  // 3) PR-header preview link — best-effort (shell: `|| echo ::warning::`).
  //    Same transform as preview-pr-link.mjs apply; single marker block.
  try {
    const cur = await fetchImpl(`https://api.github.com/repos/${ctx.repo}/pulls/${ctx.pr}`, {
      headers: ghHeaders(ctx.token),
    });
    if (!cur.ok) throw new Error(`get PR body: ${cur.status}`);
    const next = withPreviewHeader((await cur.json()).body ?? "", headerLine(ctx));
    const res = await fetchImpl(`https://api.github.com/repos/${ctx.repo}/pulls/${ctx.pr}`, {
      method: "PATCH",
      headers: ghHeaders(ctx.token, true),
      body: JSON.stringify({ body: next }),
    });
    if (!res.ok) throw new Error(`patch PR body: ${res.status}`);
    out.headerUpdated = true;
  } catch (e) {
    const w = `::warning::PR header not updated — the live link stays in the marker comment: ${e.message}`;
    out.warnings.push(w);
    warn(w);
  }
  return out;
}

// Exact main-module check: a bare name-suffix test would also fire when this
// module is imported by scripts/test-preview-comment.mjs (its path ends with
// the same suffix); path equality cannot lie. realpath BOTH sides — argv[1]
// and import.meta.url differ textually when the worktree is a symlink.
const invoked = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
})();
if (invoked) {
  const env = (name, fb = "") => process.env[name] ?? fb;
  const token = env("GH_TOKEN", env("GITHUB_TOKEN"));
  const ctx = {
    repo: env("PREVIEW_REPO"),
    pr: env("PREVIEW_PR"),
    status: env("PREVIEW_STATUS"),
    mode: env("PREVIEW_MODE", "dual"),
    url: env("PREVIEW_URL"),
    url2: env("PREVIEW_URL2"),
    sha: env("PREVIEW_SHA"),
    slug: env("PREVIEW_SLUG"),
    grotto: env("PREVIEW_GROTTO"),
    elyria: env("PREVIEW_ELYRIA"),
    reasons: env("PREVIEW_REASONS"),
    vtime: env("PREVIEW_VTIME"),
    runUrl: env("PREVIEW_RUN_URL"),
    envName: env("PREVIEW_ENV"),
    now: new Date(),
    token,
  };
  const missing = ["repo", "pr", "status", "url", "sha", "token"].filter((k) => !ctx[k]);
  if (missing.length) {
    console.error(`preview-comment: missing env: ${missing.join(", ")}`);
    process.exit(2);
  }
  try {
    const r = await publishPreviewComment(ctx);
    console.log(
      `preview-comment: ${r.updated ? "updated" : "created"} #${r.commentId}; badge=${r.badgePosted}; header=${r.headerUpdated}; status=${ctx.status}`,
    );
  } catch (e) {
    console.error(`preview-comment FAILED (marker comment not published): ${e.message}`);
    process.exit(1);
  }
}
