#!/bin/bash
# Cron (root, каждые 5 минут, /etc/cron.d/coop-preview-cert): HTTP-01
# сертификаты preview-хостов *.abnocw.miew.ru и *.elisium.miew.ru
#   (dual-host P5: один фрагмент nginx держит ДВА server-блока на PR —
#   читаем ВСЕ server_name фрагмента);
#   новый хост (фрагмент есть, линии нет) — certbot certonly --webroot;
#   ACME-файл ложится в webroot СВОЕГО server-блока — по суффиксу хоста:
#     abnocw  -> <app>/www-grotto  (root блока «пивные гроты»)
#     elisium -> <app>/www-elyria  (root блока Элизии)
#   — certbot обязательно должен получить challenge с того же root, с
#   которого nginx отвечает на этот server_name; webroot в renewal-conf
#   каждой линии хранит правильный.
#   сирота (линия есть, фрагмент снесён) — certbot delete + rm зеркало,
#   по ОБОИМ суффиксам.
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
  # Все server_name фрагмента (в dual-host их два), безопасно читаем построчно.
  awk '$1=="server_name"{print $2}' "$frag" | tr -d ';' | while IFS= read -r host; do
    [ -n "$host" ] || continue
    case "$host" in
      *.abnocw.miew.ru) wwwdir="www-grotto" ;;
      *.elisium.miew.ru) wwwdir="www-elyria" ;;
      *) echo "станный server_name=$host в $frag — пропускаю" >&2; continue ;;
    esac
    if [ -d "$LIVE/$host" ]; then
      continue
    fi
    slug="$(basename "$frag" .conf)"; slug="${slug#preview-}"
    webroot="$BASE/$slug/$wwwdir"
    if [ ! -d "$webroot" ]; then
      echo "нет webroot $webroot для $host — пропускаю" >&2
      continue
    fi
    echo "== certonly $host (webroot $webroot)"
    certbot certonly --non-interactive --webroot -w "$webroot" \
      -d "$host" --deploy-hook "$HOOK" \
      || echo "certbot не выдал $host — смотрите вывод выше" >&2
  done
done

for conf in "$RENEW"/*.abnocw.miew.ru.conf "$RENEW"/*.elisium.miew.ru.conf; do
  host="$(basename "$conf" .conf)"
  case "$host" in
    *.abnocw.miew.ru) slug="${host%.abnocw.miew.ru}" ;;
    *.elisium.miew.ru) slug="${host%.elisium.miew.ru}" ;;
    *) continue ;;
  esac
  if [ ! -e "$FRAGD/preview-$slug.conf" ]; then
    echo "== сирота $host — удаляю линию и зеркало"
    certbot delete --cert-name "$host" --non-interactive || true
    rm -rf "$BASE/tls/$host"
  fi
done
