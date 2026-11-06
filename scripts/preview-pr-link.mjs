/**
 * Keeps the live preview URL at the very top of the PR body.
 *
 * The "Deployment и один комментарий" workflow step feeds the one-line state
 * text; the block lives between invisible markers, so repeated runs replace it
 * in place instead of stacking copies. Runs without the markers (first time)
 * prepend the block above the description. Tested by test-preview-pr-link.mjs
 * (pure transform, no network); CLI mode talks to the GitHub REST API itself.
 */
import { readFileSync } from "node:fs";

export const PREVIEW_HEADER_BEGIN = "<!-- coop-field-preview-link -->";
export const PREVIEW_HEADER_END = "<!-- /coop-field-preview-link -->";

export function withPreviewHeader(body, block) {
  const src = String(body ?? "");
  const repl = `${PREVIEW_HEADER_BEGIN}\n${String(block ?? "").trim()}\n${PREVIEW_HEADER_END}`;
  const at = src.indexOf(PREVIEW_HEADER_BEGIN);
  if (at === -1) {
    return src ? `${repl}\n\n${src}` : repl;
  }
  const end = src.indexOf(PREVIEW_HEADER_END, at);
  if (end === -1) {
    return `${src.slice(0, at)}${repl}\n${src.slice(at + PREVIEW_HEADER_BEGIN.length)}`;
  }
  return `${src.slice(0, at)}${repl}${src.slice(end + PREVIEW_HEADER_END.length)}`;
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("preview-pr-link.mjs");
if (invoked && process.argv[2] === "apply") {
  const args = process.argv.slice(3);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? "" : args[i + 1] ?? "";
  };
  const repo = opt("--repo");
  const pr = opt("--pr");
  const file = opt("--file");
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  if (!repo || !pr || !file || !token) {
    console.error("usage: preview-pr-link.mjs apply --repo owner/repo --pr N --file hdr.md (needs GH_TOKEN)");
    process.exit(2);
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const cur = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, { headers });
  if (!cur.ok) {
    console.error("get PR body failed:", cur.status);
    process.exit(1);
  }
  const body = (await cur.json()).body ?? "";
  const next = withPreviewHeader(body, readFileSync(file, "utf8"));
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${pr}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ body: next }),
  });
  if (!res.ok) {
    console.error("patch PR body failed:", res.status);
    process.exit(1);
  }
  console.log("шапка PR: preview-ссылка обновлена");
}
