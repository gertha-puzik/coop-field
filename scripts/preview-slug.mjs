/**
 * Preview identity vs public hosts.
 * Directory/unit/public site: pr-<number> — stable across pushes, known at
 * destroy time, short enough for nginx server_names_hash_bucket_size 64
 * (the old branch slug was not). The interim 8-hex-SHA site name is retired:
 * readable beats per-commit URL churn (owner decision, 2026-11-07).
 *
 * Dual-host preview (P5): каждый PR получает ДВА сайта — публичные «Пивные
 * гротты» pr-<number>.abnocw.phainonsmilk.ru (root www-grotto) и Элизия
 * pr-<number>.elysiae.phainonsmilk.ru (root www-elyria). Инстанс комнаты на PR
 * остаётся один: оба хоста ходят в один и тот же порт, разделение
 * возможностей — по Host-политике на сервере (env PUBLIC_HOSTS/ELYRIA_HOSTS).
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

/** Оба сайта PR: [pr-N.abnocw.phainonsmilk.ru, pr-N.elysiae.phainonsmilk.ru]. Порядок
 * фиксирован: элемент 0 — гроты (главный хост), элемент 1 — Элизия. */
export function previewSiteHosts(prNumber) {
  const label = previewId(prNumber);
  return [`${label}.abnocw.phainonsmilk.ru`, `${label}.elysiae.phainonsmilk.ru`];
}

/** @deprecated Со времён single-host. Возвращает только ПЕРВЫЙ хост (гроты);
 * для dual-host используй previewSiteHosts(). Оставлен для совместимости
 * (main до мерджа P5 зовёт CLI site-host для единственного URL). */
export function previewSiteHost(prNumber) {
  return previewSiteHosts(prNumber)[0];
}

export function previewHost(slug) {
  return `${previewSlug(slug)}.abnocw.phainonsmilk.ru`;
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
  else if (cmd === "site-hosts") process.stdout.write(previewSiteHosts(arg).join("\n") + "\n");
  else if (cmd === "site-host-elyria") process.stdout.write(previewSiteHosts(arg)[1] + "\n");
  else process.stdout.write(previewSlug(cmd) + "\n");
}
