#!/usr/bin/env node
/**
 * Unit guards for scripts/preview-comment.mjs (preview-deploy.yml marker
 * comment step) against fetch stubs — no network, no gh CLI. The incident
 * that motivated the extraction (2026-11): a stray `)` in the inline shell
 * made the step die AFTER a successful rollout, so a stale failure marker
 * stayed on the PR. These tests pin the behavior the shell could not:
 *
 *  - create the marker comment when the PR has none;
 *  - find it (paginated — older than page 1 too) and UPDATE it, never
 *    duplicate it;
 *  - honest bodies for every PREVIEW-RESULT status (live, destroyed,
 *    needs-tls, needs-dns, needs-secret, needs-bootstrap, partial-failure,
 *    failed) + the unknown fallback;
 *  - deploy failure (status=failed) still publishes the marker and posts a
 *    FAILURE deployment badge;
 *  - badge API errors must NOT fail the step (deliberate `|| true` from the
 *    shell), and marker-comment errors MUST fail it (no stale markers);
 *  - PR-header update reuses the preview-pr-link.mjs marker block; its
 *    failure is a warning, not a step failure.
 */

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

const { commentBody, headerLine, deploymentStateOf, findMarkerCommentId, publishPreviewComment, PREVIEW_COMMENT_MARKER } =
  await import("./preview-comment.mjs");

const CTX_BASE = {
  repo: "acme/coop",
  pr: "41",
  status: "live",
  mode: "dual",
  url: "https://pr-41.abnocw.miew.ru",
  url2: "https://pr-41.elisium.miew.ru",
  sha: "501a936deadbeef",
  slug: "pr-41",
  grotto: "ok",
  elyria: "ok",
  reasons: "",
  vtime: "2026-11-08 10:00 UTC",
  runUrl: "https://github.com/acme/coop/actions/runs/123",
  envName: "preview-pr-41",
  now: new Date("2026-11-08T12:34:56Z"),
  token: "T0K",
};
const ctx = (over = {}) => ({ ...CTX_BASE, ...over });

/** Minimal Response-like stub + route list + call recorder. */
function mkFetch(routes) {
  const calls = [];
  const api = async (url, opts = {}) => {
    calls.push({ method: opts.method ?? "GET", url, body: opts.body ? JSON.parse(opts.body) : null });
    const route = routes.find((r) => r.match(url, opts));
    if (!route) throw new Error(`no stub route for ${opts.method ?? "GET"} ${url}`);
    return route.reply();
  };
  return { calls, fetch: api };
}
const resp = (status, obj) => ({ ok: status < 300, status, json: async () => obj });

// ── Deployment state mapping (carried over 1:1 from the shell gate) ──────
eq("state: live -> success", deploymentStateOf("live"), "success");
eq("state: needs-tls -> in_progress", deploymentStateOf("needs-tls"), "in_progress");
eq("state: partial-failure -> failure", deploymentStateOf("partial-failure"), "failure");
eq("state: needs-dns -> failure", deploymentStateOf("needs-dns"), "failure");
eq("state: failed -> failure", deploymentStateOf("failed"), "failure");
eq("state: destroyed -> no badge", deploymentStateOf("destroyed"), null);
eq("state: needs-secret -> no badge", deploymentStateOf("needs-secret"), null);
eq("state: needs-bootstrap -> no badge", deploymentStateOf("needs-bootstrap"), null);
eq("state: unknown -> no badge", deploymentStateOf(""), null);

// ── Every status renders an honest, distinct body ─────────────────────────
const truthful = [
  ["live", "— live"],
  ["destroyed", "снесено"],
  ["needs-tls", "сертификат ещё не готов"],
  ["needs-dns", "не резолвится"],
  ["needs-secret", "PREVIEW_SSH_KEY"],
  ["needs-bootstrap", "bootstrap"],
  ["partial-failure", "Частичная неудача"],
  ["failed", "не выложен или не прошёл верификацию"],
];
for (const [status, needle] of truthful) {
  const body = commentBody(ctx({ status }));
  ok(`body ${status}: marker + verdict`, body.startsWith(PREVIEW_COMMENT_MARKER) && body.includes(needle));
  // The destroyed wording (verbatim port) does not name the hosts — only this
  // status is exempt from the both-hosts requirement.
  if (status !== "destroyed") {
    ok(`body ${status}: both hosts named`, body.includes("abnocw.miew.ru") && body.includes("elisium.miew.ru"));
  }
}
ok("body unknown: job-error fallback", commentBody(ctx({ status: "" })).includes("ошибка джобы"));
ok("body legacy-single: PR #49 note", commentBody(ctx({ mode: "legacy-single", status: "live" })).includes("legacy single-site"));
ok("body live dual: no PR #49 note", !commentBody(ctx({ status: "live" })).includes("PR #49"));
ok("body failed: runs log url", commentBody(ctx({ status: "failed" })).includes("/actions/runs/123"));
ok("body partial: grotto/elyria verdicts", commentBody(ctx({ status: "partial-failure", grotto: "ok", elyria: "fail" })).includes("ok") && commentBody(ctx({ status: "partial-failure", grotto: "ok", elyria: "fail" })).includes("fail"));

// ── Header block: live links both hosts, pre-live NEVER publishes hrefs ──
{
  const hdrLive = headerLine(ctx({ status: "live" }));
  ok("header live dual: grotto href", hdrLive.includes("[https://pr-41.abnocw.miew.ru](https://pr-41.abnocw.miew.ru)"));
  ok("header live dual: elyria href", hdrLive.includes("[https://pr-41.elisium.miew.ru](https://pr-41.elisium.miew.ru)"));
}
for (const status of ["needs-tls", "needs-secret", "needs-bootstrap", "failed", "partial-failure", ""]) {
  const h = headerLine(ctx({ status }));
  ok(`header ${status || "unknown"}: no speculative href`, !h.includes("](http"));
}
ok("header destroyed dual: both hosts named", headerLine(ctx({ status: "destroyed" })).includes("pr-41.elisium.miew.ru"));
ok("header legacy live: PR #49 note", headerLine(ctx({ mode: "legacy-single", status: "live" })).includes("legacy single-site"));
ok("header legacy unknown: capital note", headerLine(ctx({ mode: "legacy-single", status: "" })).includes("Legacy single-site"));

// ── Scenario: first run CREATES the marker comment, badge + header live ───
{
  const stub = mkFetch([
    { match: (u, o) => u.endsWith("/issues/41/comments?per_page=100&page=1") && (o.method ?? "GET") === "GET", reply: () => resp(200, []) },
    { match: (u, o) => u.endsWith("/deployments") && o.method === "POST", reply: () => resp(201, { id: 555 }) },
    { match: (u, o) => u.endsWith("/deployments/555/statuses") && o.method === "POST", reply: () => resp(201, {}) },
    { match: (u, o) => u.endsWith("/issues/41/comments") && o.method === "POST", reply: () => resp(201, { id: 999 }) },
    { match: (u, o) => u.endsWith("/pulls/41") && (o.method ?? "GET") === "GET", reply: () => resp(200, { body: "PR description text" }) },
    { match: (u, o) => u.endsWith("/pulls/41") && o.method === "PATCH", reply: () => resp(200, {}) },
  ]);
  const res = await publishPreviewComment(ctx({ status: "live" }), { fetch: stub.fetch, warn: () => {} });
  const post = stub.calls.find((c) => c.method === "POST" && c.url.endsWith("/issues/41/comments"));
  const badge = stub.calls.find((c) => c.method === "POST" && c.url.endsWith("/deployments"));
  const statusPost = stub.calls.find((c) => c.method === "POST" && c.url.endsWith("/deployments/555/statuses"));
  const hdrPatch = stub.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/pulls/41"));
  ok("create: marker comment posted", post != null && post.body.body.startsWith(PREVIEW_COMMENT_MARKER) && res.commentId === 999 && !res.updated);
  ok("create: badge deployment recorded", badge != null && badge.body.ref === "501a936deadbeef" && badge.body.auto_merge === false && res.badgePosted);
  ok("create: badge status live", statusPost != null && statusPost.body.state === "success" && statusPost.body.environment_url === ctx().url);
  ok("create: header patch carries block", hdrPatch != null && hdrPatch.body.body.includes("pr-41.elisium.miew.ru") && res.headerUpdated);
}

// ── Scenario: marker already exists -> PATCH, zero duplicate POSTs ────────
{
  const stub = mkFetch([
    // Older marker deep in the pack: found late, still updated (pagination).
    { match: (u, o) => u.includes("&page=1") && (o.method ?? "GET") === "GET" && u.includes("comments?"), reply: () => resp(200, Array.from({ length: 100 }, (_, i) => ({ id: 9900 + i, body: `chat ${i}` }))) },
    { match: (u, o) => u.includes("&page=2") && (o.method ?? "GET") === "GET", reply: () => resp(200, [{ id: 202, body: `${PREVIEW_COMMENT_MARKER}\nstale build failure text` }]) },
    { match: (u, o) => u.endsWith("/issues/comments/202") && o.method === "PATCH", reply: () => resp(200, { id: 202 }) },
    { match: (u, o) => u.endsWith("/pulls/41") && (o.method ?? "GET") === "GET", reply: () => resp(200, { body: "PR description text" }) },
    { match: (u, o) => u.endsWith("/pulls/41") && o.method === "PATCH", reply: () => resp(200, {}) },
  ]);
  const res = await publishPreviewComment(ctx({ status: "live" }), { fetch: stub.fetch, warn: () => {} });
  const patch = stub.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/issues/comments/202"));
  const dupes = stub.calls.filter((c) => c.method === "POST" && c.url.endsWith("/issues/41/comments"));
  ok("update: found via pagination (page 2)", stub.calls.some((c) => c.url.includes("page=2")));
  ok("update: patched the existing marker", patch != null && patch.body.body.startsWith(PREVIEW_COMMENT_MARKER) && res.updated && res.commentId === 202);
  eq("update: no duplicate comment created", dupes.length, 0);
  ok("update: stale text replaced", patch.body.body.includes("— live"));
  ok("update: no badge for destroyed", (await publishPreviewComment(ctx({ status: "destroyed" }), {
    fetch: mkFetch([
      { match: (u, o) => u.includes("comments?") && (o.method ?? "GET") === "GET", reply: () => resp(200, []) },
      { match: (u) => u.endsWith("/issues/41/comments"), reply: () => resp(201, { id: 1 }) },
      { match: (u, o) => u.endsWith("/pulls/41") && (o.method ?? "GET") === "GET", reply: () => resp(200, { body: "" }) },
      { match: (u, o) => u.endsWith("/pulls/41") && o.method === "PATCH", reply: () => resp(200, {}) },
    ]).fetch,
    warn: () => {},
  })).badgePosted === false);
}

// ── Scenario: deploy failed AFTER rollout -> marker stays honest ─────────
{
  const stub = mkFetch([
    { match: (u, o) => u.includes("comments?") && (o.method ?? "GET") === "GET", reply: () => resp(200, [{ id: 77, body: `${PREVIEW_COMMENT_MARKER}\nold` }]) },
    { match: (u, o) => u.endsWith("/deployments") && o.method === "POST", reply: () => resp(201, { id: 556 }) },
    { match: (u, o) => u.endsWith("/deployments/556/statuses") && o.method === "POST", reply: () => resp(201, {}) },
    { match: (u, o) => u.endsWith("/issues/comments/77") && o.method === "PATCH", reply: () => resp(200, { id: 77 }) },
    { match: (u, o) => u.endsWith("/pulls/41") && (o.method ?? "GET") === "GET", reply: () => resp(200, { body: "PR description text" }) },
    { match: (u, o) => u.endsWith("/pulls/41") && o.method === "PATCH", reply: () => resp(200, {}) },
  ]);
  const res = await publishPreviewComment(ctx({ status: "failed", reasons: "verify:grotto", grotto: "?", elyria: "?" }), { fetch: stub.fetch, warn: () => {} });
  const patch = stub.calls.find((c) => c.method === "PATCH" && c.url.endsWith("/issues/comments/77"));
  const badge = stub.calls.find((c) => c.method === "POST" && c.url.endsWith("/deployments/556/statuses"));
  ok("failure: comment patched", patch != null && res.updated);
  ok("failure: body is the failed wording", patch.body.body.includes("не выложен или не прошёл верификацию"));
  ok("failure: badge state failure", badge != null && badge.body.state === "failure" && res.badgePosted);
}

// ── Failure isolation: badge API down must not fail the step ─────────────
{
  const badBadge = mkFetch([
    { match: (u, o) => u.includes("comments?") && (o.method ?? "GET") === "GET", reply: () => resp(200, []) },
    { match: (u, o) => u.endsWith("/deployments") && o.method === "POST", reply: () => resp(500, {}) },
    { match: (u, o) => u.endsWith("/issues/41/comments") && o.method === "POST", reply: () => resp(201, { id: 313 }) },
    { match: (u, o) => u.endsWith("/pulls/41") && (o.method ?? "GET") === "GET", reply: () => resp(200, { body: "" }) },
    { match: (u, o) => u.endsWith("/pulls/41") && o.method === "PATCH", reply: () => resp(200, {}) },
  ]);
  const warnings = [];
  const res = await publishPreviewComment(ctx(), { fetch: badBadge.fetch, warn: (w) => warnings.push(w) });
  ok("badge 500: step survives", res.commentId === 313 && res.badgePosted === false);
  ok("badge 500: warning emitted", warnings.length === 1 && warnings[0].includes("::warning::"));
  ok("badge 500: comment still posted", badBadge.calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/41/comments")));
}

// ── Failure isolation: header failure warns, comment failure FAILS ───────
{
  const stub = mkFetch([
    { match: (u, o) => u.includes("comments?") && (o.method ?? "GET") === "GET", reply: () => resp(200, [{ id: 5, body: `${PREVIEW_COMMENT_MARKER}\nx` }]) },
    { match: (u, o) => u.endsWith("/issues/comments/5") && o.method === "PATCH", reply: () => resp(200, { id: 5 }) },
    { match: (u, o) => u.endsWith("/pulls/41") && (o.method ?? "GET") === "GET", reply: () => resp(500, {}) },
  ]);
  const warnings = [];
  const res = await publishPreviewComment(ctx(), { fetch: stub.fetch, warn: (w) => warnings.push(w) });
  ok("header 500: comment still updated", res.updated && res.commentId === 5);
  ok("header 500: warning, non-fatal", res.headerUpdated === false && warnings.some((w) => w.includes("PR header not updated")));

  const broken = mkFetch([
    { match: (u, o) => u.includes("comments?") && (o.method ?? "GET") === "GET", reply: () => resp(200, []) },
    { match: (u, o) => u.endsWith("/issues/41/comments") && o.method === "POST", reply: () => resp(500, {}) },
  ]);
  const errText = await publishPreviewComment(ctx(), { fetch: broken.fetch, warn: () => {} }).then(
    () => "resolved",
    (e) => String(e.message),
  );
  ok("comment 500: step MUST fail (no stale marker)", errText.includes("marker comment"));
}

if (failed) {
  console.error(`preview-comment: ${failed} FAIL`);
  process.exit(1);
}
console.log("preview-comment: зелёный");
