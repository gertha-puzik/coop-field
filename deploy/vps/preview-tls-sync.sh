#!/bin/bash
# Certbot deploy-hook для per-host preview-сертификатов (HTTP-01).
# Привязывается при issue (coop-preview-cert) и сохраняется в renewal-conf:
# каждый renew гоняет его сам. Вручную: coop-preview-tls-sync <lineage-имя>.
#
# 1) зеркало live -> /opt/coop-field-preview/tls/<host>/: /etc/letsencrypt/live
#    читает только root, а preview-apply.sh (deploy-preview) проверяет SAN
#    через cert_covers_host. fullchain 644 (читать SAN), privkey 600 root.
# 2) если nginx-фрагмент preview ещё без 443 — добавляет listen/ssl/редирект
#    (idempotent), с nginx -t и откатом. Следующий apply уже сам напишет ssl:
#    зеркало-то существует.
# 3) reload nginx: сертификаты кэшируются на момент чтения конфига.
set -euo pipefail

BASE="/opt/coop-field-preview"
NGINX_D="/etc/nginx/preview.d"

HOST="$(basename "${1:-${RENEWED_LINEAGE:-}}")"
[ -n "$HOST" ] && [ "$HOST" != "${RENEWED_LINEAGE:-SAME}" ] || true
case "$HOST" in
  *.abnocw.miew.ru) ;;
  *) echo "coop-preview-tls-sync: $HOST не preview-хост — зеркалю только *.abnocw.miew.ru" >&2; exit 0 ;;
esac

SRC="/etc/letsencrypt/live/$HOST"
DST="$BASE/tls/$HOST"

[ -f "$SRC/fullchain.pem" ] && [ -f "$SRC/privkey.pem" ] || {
  echo "coop-preview-tls-sync: нет $SRC — нечего зеркалить" >&2
  exit 1
}

mkdir -p "$DST"
install -m 644 -o root -g root "$SRC/fullchain.pem" "$DST/fullchain.pem"
install -m 600 -o root -g root "$SRC/privkey.pem" "$DST/privkey.pem"
echo "coop-preview-tls-sync: зеркало $HOST обновлено"

# --- 2) апгрейд фрагмента до https (idempotent) ---------------------------
FRAG="$NGINX_D/preview-${HOST%%.*}.conf"
if [ -f "$FRAG" ] && ! grep -q "listen 443 ssl;" "$FRAG"; then
  OLD="$(cat "$FRAG")"
  awk -v cert="$DST" '
    /^server[[:space:]]*\{/ {
      print
      print "    listen 443 ssl;"
      print "    ssl_certificate " cert "/fullchain.pem;"
      print "    ssl_certificate_key " cert "/privkey.pem;"
      next
    }
    /^[[:space:]]*charset utf-8;/ {
      print
      print ""
      print "    # http -> https (кооптурил coop-preview-tls-sync: серт выдан)"
      print "    set $cf_r 0;"
      print "    if ($scheme = http) { set $cf_r 1; }"
      print "    if ($request_uri ~ \"^/\\.well-known/acme-challenge/\") { set $cf_r 0; }"
      print "    if ($cf_r = 1) { return 301 https://$host$request_uri; }"
      next
    }
    { print }
  ' "$FRAG" > "$FRAG.new"
  mv "$FRAG.new" "$FRAG"
  # mv меняет владельца файла на root — вернуть владельца каталога
  # (deploy-preview), иначе следующий apply не сможет переписать фрагмент.
  chown --reference="$NGINX_D" "$FRAG" 2>/dev/null || true
  if ! nginx -t >/dev/null 2>&1; then
    printf '%s\n' "$OLD" > "$FRAG"
    echo "coop-preview-tls-sync: nginx -t упал после апгрейда $FRAG — откатил, фрагмент без ssl" >&2
    exit 1
  fi
  echo "coop-preview-tls-sync: $FRAG получил 443 + редирект"
fi

# --- 3) reload ------------------------------------------------------------
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
else
  echo "coop-preview-tls-sync: nginx -t не прошёл — reload пропущен" >&2
  exit 1
fi
echo "coop-preview-tls-sync: nginx перезагружен"
