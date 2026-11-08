#!/bin/bash
# Certbot deploy-hook для per-host preview-сертификатов (HTTP-01).
# Привязывается при issue (coop-preview-cert) и сохраняется в renewal-conf:
# каждый renew гоняет его сам. Вручную: coop-preview-tls-sync <lineage-имя>.
#
# 1) зеркало live -> /opt/coop-field-preview/tls/<host>/: /etc/letsencrypt/live
#    читает только root, а preview-apply.sh (deploy-preview) проверяет SAN
#    через cert_covers_host. fullchain 644 (читать SAN), privkey 600 root.
# 2) если nginx-фрагмент preview ещё без 443 у ЭТОГО хоста — добавляет
#    listen/ssl/редирект ТОЛЬКО в server-блок этого server_name (idempotent),
#    с nginx -t и откатом. Фрагмент dual-host: два блока (гроты/abnocw и
#    Элизия/elisium), серт одного хоста не должен вешаться на второй —
#    иначе первый же выпущенный сертификат ляжет на оба server_name, а
#    второй пропустит апгрейд («443 уже есть»).
#    Следующий apply уже сам напишет ssl: зеркало-то существует.
# 3) reload nginx: сертификаты кэшируются на момент чтения конфига.
set -euo pipefail

BASE="/opt/coop-field-preview"
NGINX_D="/etc/nginx/preview.d"

HOST="$(basename "${1:-${RENEWED_LINEAGE:-}}")"
[ -n "$HOST" ] && [ "$HOST" != "${RENEWED_LINEAGE:-SAME}" ] || true
case "$HOST" in
  *.abnocw.phainonsmilk.ru|*.elysiae.phainonsmilk.ru) ;;
  *) echo "coop-preview-tls-sync: $HOST не preview-хост — зеркалю только *.abnocw.phainonsmilk.ru и *.elysiae.phainonsmilk.ru" >&2; exit 0 ;;
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

# --- 2) апгрейд блока этого хоста до https (idempotent) --------------------
FRAG="$NGINX_D/preview-${HOST%%.*}.conf"

# Блок $1 во фрагменте $2 без listen 443? exit 0 — нужен апгрейд,
# 1 — у этого host-блока уже 443, 2 — блока/файла нет вовсе.
# Важно: вариант «не найдено» решает флаг-переменная в END, а не ранний
# exit — END-блок awk выполняется ПОСЛЕ exit и заменил бы статус.
host_block_lacks_443() {
  [ -f "$2" ] || exit 2
  awk -v host="$1" '
    BEGIN { inblk = 0; nm = ""; l443 = 0; result = 2 }
    /^server[[:space:]]*\{/ { inblk = 1; nm = ""; l443 = 0; next }
    inblk && /listen 443 ssl;/ { l443 = 1 }
    inblk && /^[[:space:]]*server_name[[:space:]]/ {
      sub(/;$/, "", $2)
      if ($2 == host) nm = host
    }
    inblk && /^}/ {
      if (nm != "" && result == 2) { result = (l443 ? 1 : 0) }
      inblk = 0; nm = ""; l443 = 0
    }
    END { exit result }
  ' "$2"
}

# insert идёт ПОСЛЕ server_name (директивы внутри server{} не чувствительны
# к порядку) — так awk решает «чей это блок» ещё до вставки.
patch_frag() {
  awk -v host="$HOST" -v cert="$DST" '
    BEGIN { tgt = 0 }
    /^server[[:space:]]*\{/ { tgt = 0; print; next }
    /^[[:space:]]*server_name[[:space:]]/ {
      print
      if ($2 == host ";") {
        tgt = 1
        print "    listen 443 ssl;"
        print "    ssl_certificate " cert "/fullchain.pem;"
        print "    ssl_certificate_key " cert "/privkey.pem;"
      }
      next
    }
    /^[[:space:]]*charset utf-8;/ {
      print
      if (tgt) {
        print ""
        print "    # http -> https (кооптурил coop-preview-tls-sync: серт выдан)"
        print "    set $cf_r 0;"
        print "    if ($scheme = http) { set $cf_r 1; }"
        print "    if ($request_uri ~ \"^/\\.well-known/acme-challenge/\") { set $cf_r 0; }"
        print "    if ($cf_r = 1) { return 301 https://$host$request_uri; }"
      }
      next
    }
    { print }
  ' "$FRAG" > "$FRAG.new"
  mv "$FRAG.new" "$FRAG"
  # mv меняет владельца файла на root — вернуть владельца каталога
  # (deploy-preview), иначе следующий apply не сможет переписать фрагмент.
  chown --reference="$NGINX_D" "$FRAG" 2>/dev/null || true
}

if host_block_lacks_443 "$HOST" "$FRAG"; then
  OLD="$(cat "$FRAG")"
  patch_frag
  if ! nginx -t >/dev/null 2>&1; then
    printf '%s\n' "$OLD" > "$FRAG"
    echo "coop-preview-tls-sync: nginx -t упал после апгрейда $FRAG — откатил, блок $HOST без ssl" >&2
    exit 1
  fi
  echo "coop-preview-tls-sync: блок $HOST в $FRAG получил 443 + редирект"
fi

# --- 3) reload ------------------------------------------------------------
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
else
  echo "coop-preview-tls-sync: nginx -t не прошёл — reload пропущен" >&2
  exit 1
fi
echo "coop-preview-tls-sync: nginx перезагружен"
