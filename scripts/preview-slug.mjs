/**
 * DNS-safe slug for preview hosts: https://<slug>.abnocw.miew.ru
 * Branch names, unicode, dots, slashes → hyphen; length ≤48 (DNS label 63).
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

export function previewHost(slug) {
  return `${previewSlug(slug)}.abnocw.miew.ru`;
}

export function previewPort(prNumber) {
  const n = Math.abs(Number(prNumber) || 0);
  return 41000 + (n % 1000);
}

export function previewRoot(slug) {
  return `/opt/coop-field-preview/${previewSlug(slug)}`;
}

const invoked = process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("preview-slug.mjs");
if (invoked && process.argv[2]) {
  process.stdout.write(previewSlug(process.argv[2]) + "\n");
}
