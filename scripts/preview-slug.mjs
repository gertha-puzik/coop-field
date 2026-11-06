/**
 * Preview identity vs public host.
 * Directory/unit/public site: pr-<number> — stable across pushes, known at
 * destroy time, short enough for nginx server_names_hash_bucket_size 64
 * (the old branch slug was not). The interim 8-hex-SHA site name is retired:
 * readable beats per-commit URL churn (owner decision, 2026-11-07).
 */
export function previewSlug(input) {
  const raw = String(input || "")
    .trim()
    .replace(/^refs\/heads\//, "")
    .toLowerCase();
  const ascii = raw.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const slug = ascii
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "pr";
}

export function previewId(prNumber) {
  const n = Math.abs(parseInt(String(prNumber), 10) || 0);
  return `pr-${n}`;
}

export function previewSiteHost(prNumber) {
  const label = previewId(prNumber);
  return `${label}.abnocw.miew.ru`;
}

export function previewHost(slug) {
  return `${previewSlug(slug)}.abnocw.miew.ru`;
}

export function previewPort(prNumber) {
  const n = Math.abs(Number(prNumber) || 0);
  return 41000 + (n % 1000);
}

export function previewRoot(idOrSlug) {
  const id = String(idOrSlug || "");
  if (/^pr-\d+$/.test(id)) return `/opt/coop-field-preview/${id}`;
  return `/opt/coop-field-preview/${previewSlug(id)}`;
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("preview-slug.mjs");
if (invoked && process.argv[2]) {
  const cmd = process.argv[2];
  const arg = process.argv[3];
  if (cmd === "id") process.stdout.write(previewId(arg) + "\n");
  else if (cmd === "site-host") process.stdout.write(previewSiteHost(arg) + "\n");
  else process.stdout.write(previewSlug(cmd) + "\n");
}
