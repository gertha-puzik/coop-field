#!/bin/bash
# Cron (root, каждые 5 минут, /etc/cron.d/coop-preview-cert): HTTP-01
# сертификаты preview-хостов *.abnocw.miew.ru.
#   новый хост (фрагмент nginx есть, линии нет) — certbot certonly --webroot;
#   ACME-файл ложится в <app>/www/.well-known/ и раздаётся уже существующим
#   location из фрагмента — nginx менять не надо.
#   сирота (линия есть, фрагмент снесён) — certbot delete + rm зеркало.
# Renew будущих линий гоняет штатный certbot.timer (twice daily): webroot-путь
# и deploy-hook хранятся в renewal-conf каждой линии.
# Выход пишет journal (тег coop-preview-cert), без почты.
set -uo pipefail

FRAGD="/etc/nginx/preview.d"
LIVE="/etc/letsencrypt/live"
RENEW="/etc/letsencrypt/renewal"
BASE="/opt/coop-field-preview"
HOOK="/usr/local/sbin/coop-preview-tls-sync"

shopt -s nullglob

for frag in "$FRAGD"/preview-*.conf; do
  host="$(awk '$1=="server_name"{print $2; exit}' "$frag" | tr -d ';')"
  [ -n "$host" ] || continue
  case "$host" in
    *abnocw.miew.ru) ;;
    *) echo "станный server_name=$host в $frag — пропускаю" >&2; continue ;;
  esac
  if [ -d "$LIVE/$host" ]; then
    continue
  fi
  slug="$(basename "$frag" .conf)"; slug="${slug#preview-}"
  webroot="$BASE/$slug/www"
  if [ ! -d "$webroot" ]; then
    echo "нет webroot $webroot для $host — пропускаю" >&2
    continue
  fi
  echo "== certonly $host (webroot $webroot)"
  certbot certonly --non-interactive --webroot -w "$webroot" \
    -d "$host" --deploy-hook "$HOOK" \
    || echo "certbot не выдал $host — смотрите вывод выше" >&2
done

for conf in "$RENEW"/*.abnocw.miew.ru.conf; do
  host="$(basename "$conf" .conf)"
  slug="${host%.abnocw.miew.ru}"
  if [ ! -e "$FRAGD/preview-$slug.conf" ]; then
    echo "== сирота $host — удаляю линию и зеркало"
    certbot delete --cert-name "$host" --non-interactive || true
    rm -rf "$BASE/tls/$host"
  fi
done
