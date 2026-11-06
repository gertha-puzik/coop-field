/**
 * Preview identity vs public host.
 * Directory/unit: pr-<number> (stable across commits, destroy on close).
 * Public site: first 8 hex of the commit SHA — short enough for nginx
 * server_names_hash_bucket_size 64 (the old branch slug was not).
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

export function previewShaLabel(sha) {
  const hex = String(sha || "")
    .toLowerCase()
    .replace(/[^a-f0-9]/g, "");
  if (hex.length < 7) return "";
  return hex.slice(0, 8);
}

export function previewPublicHost(sha) {
  const label = previewShaLabel(sha);
  return label ? `${label}.abnocw.miew.ru` : "";
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
  else if (cmd === "host") process.stdout.write(previewPublicHost(arg) + "\n");
  else if (cmd === "label") process.stdout.write(previewShaLabel(arg) + "\n");
  else process.stdout.write(previewSlug(cmd) + "\n");
}
