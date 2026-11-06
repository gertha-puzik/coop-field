#!/bin/bash
# Ставит или сносит ОДНО preview-окружение.
# Прод (/opt/coop-field, юнит coop-field, порт 8787, data/ прода) не трогает.
# apply:  PREVIEW_SLUG=… PREVIEW_PORT=… bash preview-apply.sh
# destroy: PREVIEW_SLUG=… PREVIEW_ACTION=destroy bash preview-apply.sh
# validate: PREVIEW_SLUG=… PREVIEW_ACTION=validate bash preview-apply.sh
set -euo pipefail

PREVIEW_MAX="${PREVIEW_MAX:-8}"
PREVIEW_ROOT="${PREVIEW_ROOT:-/opt/coop-field-preview}"
PROD_ROOT="/opt/coop-field"
NGINX_D="${PREVIEW_NGINX_D:-/etc/nginx/preview.d}"
SKIP_SYSTEMD="${PREVIEW_SKIP_SYSTEMD:-0}"
SKIP_NGINX="${PREVIEW_SKIP_NGINX:-0}"
NODE="${PREVIEW_NODE:-$PROD_ROOT/.node/bin/node}"
NPM="${PREVIEW_NPM:-$PROD_ROOT/.node/bin/npm}"

SLUG="${PREVIEW_SLUG:-}"
PORT="${PREVIEW_PORT:-}"
ACTION="${PREVIEW_ACTION:-apply}"
SHA="${PREVIEW_SHA:-unknown}"
IN="${PREVIEW_IN:-$HOME/incoming-preview/$SLUG}"
HOST="${PREVIEW_HOST:-$SLUG.abnocw.miew.ru}"

fail() { echo "$*" >&2; exit 1; }

valid_slug() {
  local s="$1"
  [[ "$s" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]] || return 1
  case "$s" in
    *..*|*"/"*|*"\\"*|*" "*) return 1 ;;
  esac
  return 0
}

valid_slug "$SLUG" || fail "slug не прошёл нормализацию: ${SLUG:-<пусто>}"

valid_host() {
  local h="$1"
  local label="${h%.abnocw.miew.ru}"
  [ "$h" = "$label.abnocw.miew.ru" ] || return 1
  # Длинный server_name бьёт nginx server_names_hash_bucket_size 64.
  [[ "$label" =~ ^[a-z0-9][a-z0-9-]{0,23}$ ]]
}

valid_host "$HOST" || fail "host не прошёл нормализацию: ${HOST:-<пусто>}"

APP="$PREVIEW_ROOT/$SLUG"
UNIT="coop-field-preview@${SLUG}"
FRAG="$NGINX_D/preview-$SLUG.conf"

[[ "$APP" == "$PREVIEW_ROOT/$SLUG" ]] || fail "внутренний путь сломан"
[[ "$APP" != "$PROD_ROOT" ]] || fail "отказ: путь совпал с продом"
[[ "$APP" != "$PREVIEW_ROOT" ]] || fail "отказ: нельзя сносить корень preview"
[[ "$APP" != "/" ]] || fail "отказ: корень FS"
[[ "$UNIT" == coop-field-preview@* ]] || fail "отказ: юнит не preview"
[[ "$UNIT" != "coop-field" && "$UNIT" != "coop-field.service" ]] || fail "отказ: юнит прода"

if [[ "$APP" == "$PROD_ROOT"/* ]]; then
  fail "отказ: путь внутри прода $PROD_ROOT"
fi

if [ "$ACTION" = "validate" ]; then
  echo "ok slug=$SLUG app=$APP unit=$UNIT frag=$FRAG host=$HOST"
  exit 0
fi

other_preview_count() {
  if [ ! -d "$PREVIEW_ROOT" ]; then
    echo 0
    return
  fi
  find "$PREVIEW_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name "$SLUG" 2>/dev/null | wc -l
}

nginx_test_reload() {
  if [ "$SKIP_NGINX" = 1 ]; then
    return 0
  fi
  if sudo /usr/sbin/nginx -t; then
    sudo /usr/bin/systemctl reload nginx
  else
    fail "nginx -t не прошёл — reload не делали"
  fi
}

# Apex abnocw.miew.ru без DNS:\*.abnocw.miew.ru на поддомен не вешаем:
# браузер получит чужой CN (сейчас sslip.io) или имя апекса.
cert_covers_host() {
  local dir="$1"
  local pem="$dir/fullchain.pem"
  local sans
  [ -f "$pem" ] && [ -f "$dir/privkey.pem" ] || return 1
  sans="$(openssl x509 -in "$pem" -noout -ext subjectAltName 2>/dev/null || true)"
  printf '%s' "$sans" | grep -q "DNS:\\*\\.abnocw\\.miew\\.ru" && return 0
  printf '%s' "$sans" | grep -q "DNS:${HOST}" && return 0
  return 1
}

write_nginx_fragment() {
  local ssl_listen="" ssl_certs="" cert=""
  local wild="${PREVIEW_TLS_WILD:-/etc/letsencrypt/live/abnocw.miew.ru}"
  local per="${PREVIEW_TLS_PER:-/etc/letsencrypt/live/$HOST}"
  if cert_covers_host "$wild"; then
    cert="$wild"
  elif cert_covers_host "$per"; then
    cert="$per"
  fi
  if [ -n "$cert" ]; then
    ssl_listen="    listen 443 ssl;"
    ssl_certs="    ssl_certificate $cert/fullchain.pem;
    ssl_certificate_key $cert/privkey.pem;"
  fi
  mkdir -p "$NGINX_D"
  cat > "$FRAG" <<EOF
server {
    listen 80;
${ssl_listen}
    server_name $HOST;
${ssl_certs}
    root $APP/www;
    index index.html;
    charset utf-8;

    location /.well-known/acme-challenge/ {
        try_files \$uri =404;
    }
    location / {
        try_files \$uri \$uri/ /index.html;
    }
    location /_next/static/ {
        try_files \$uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location /health {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
    }
    location /auth {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    location /cfg {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Cookie \$http_cookie;
    }
    location /ws {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header Origin \$http_origin;
        proxy_read_timeout 3600s;
    }
}
EOF
}

destroy_nginx_fragment() {
  local bak=""
  if [ -f "$FRAG" ]; then
    bak="$(mktemp)"
    cp "$FRAG" "$bak"
    rm -f "$FRAG"
  fi
  if [ "$SKIP_NGINX" = 1 ]; then
    rm -f "$bak"
    return 0
  fi
  if sudo /usr/sbin/nginx -t; then
    sudo /usr/bin/systemctl reload nginx
    rm -f "$bak"
  else
    if [ -n "$bak" ]; then
      cp "$bak" "$FRAG"
      rm -f "$bak"
    fi
    fail "nginx -t после удаления $FRAG не прошёл — фрагмент вернули, reload нет"
  fi
}

if [ "$ACTION" = "destroy" ]; then
  if [ "$SKIP_SYSTEMD" != 1 ]; then
    sudo /usr/bin/systemctl stop "$UNIT" 2>/dev/null || true
    sudo /usr/bin/systemctl disable "$UNIT" 2>/dev/null || true
    sudo /usr/bin/systemctl reset-failed "$UNIT" 2>/dev/null || true
  fi
  if [ -e "$APP" ]; then
    rm -rf -- "$APP"
  fi
  destroy_nginx_fragment
  echo "preview $SLUG удалён (unit, каталог, nginx). прод не трогали."
  exit 0
fi

if [ "$ACTION" != "apply" ]; then
  fail "неизвестное действие $ACTION"
fi

if [ ! -d "$PREVIEW_ROOT" ] || [ ! -w "$PREVIEW_ROOT" ]; then
  fail "нет записи в $PREVIEW_ROOT — от root на VPS: sudo bash /home/deploy-preview/incoming-preview/preview-bootstrap.sh"
fi

if [ -z "$PORT" ]; then
  fail "нужен PREVIEW_PORT"
fi
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 41000 ] || [ "$PORT" -gt 41999 ]; then
  fail "порт $PORT вне диапазона preview 41000-41999 (прод 8787 не берём)"
fi

others="$(other_preview_count)"
if [ ! -d "$APP" ] && [ "$others" -ge "$PREVIEW_MAX" ]; then
  fail "лимит ${PREVIEW_MAX} preview уже занят — закройте старый PR, новый не ставим"
fi

if [ "$SKIP_SYSTEMD" != 1 ] && [ ! -x "$NODE" ]; then
  fail "нет node $NODE — preview читает бинарь прода, не копирует его"
fi

need() {
  if [ ! -e "$IN/$1" ]; then
    fail "нет $IN/$1"
  fi
}
need server.js
need server/protocol.js
need www/index.html

mkdir -p "$APP/data" "$APP/www"
cp -a "$IN/server.js" "$APP/server.js"
rm -rf "$APP/server"
cp -a "$IN/server" "$APP/server"
if [ -d "$IN/scripts" ]; then
  rm -rf "$APP/scripts"
  cp -a "$IN/scripts" "$APP/scripts"
fi
if [ -f "$IN/package.json" ]; then
  cp -a "$IN/package.json" "$APP/package.json"
  cp -a "$IN/package-lock.json" "$APP/package-lock.json" 2>/dev/null || true
fi
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$IN/www/" "$APP/www/"
else
  rm -rf "$APP/www"
  mkdir -p "$APP/www"
  cp -a "$IN/www/." "$APP/www/"
fi

if [ ! -f "$APP/env" ]; then
  PASS="$(openssl rand -hex 16 2>/dev/null || od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  cat > "$APP/env" <<EOF
PORT=$PORT
HOST=127.0.0.1
DATA_DIR=$APP/data
ADMIN_PASS=$PASS
REQUIRE_ORIGIN=0
EOF
fi
sed -i "s/^PORT=.*/PORT=$PORT/" "$APP/env"
grep -v '^PREVIEW_SHA=' "$APP/env" > "$APP/env.n" || true
printf 'PREVIEW_SHA=%s\n' "$SHA" >> "$APP/env.n"
mv "$APP/env.n" "$APP/env"
if grep -Eq "^DATA_DIR=$PROD_ROOT(/|$)" "$APP/env"; then
  fail "отказ: DATA_DIR указывает на прод"
fi

if [ "$SKIP_SYSTEMD" != 1 ] && [ ! -d "$APP/node_modules" ]; then
  if [ -d "$PROD_ROOT/node_modules" ]; then
    ln -s "$PROD_ROOT/node_modules" "$APP/node_modules"
  else
    ( cd "$APP" && "$NPM" ci --omit=dev )
  fi
fi

if [ "$(id -u)" -eq 0 ]; then
  chown -R deploy-preview:deploy-preview "$APP" 2>/dev/null || chown -R deploy:deploy "$APP" 2>/dev/null || true
else
  chown -R "$(id -u):$(id -g)" "$APP" 2>/dev/null || true
fi

nginx_write_reload() {
  local bak=""
  if [ -f "$FRAG" ]; then
    bak="$(mktemp)"
    cp "$FRAG" "$bak"
  fi
  write_nginx_fragment
  if [ "$SKIP_NGINX" = 1 ]; then
    rm -f "$bak"
    return 0
  fi
  if sudo /usr/sbin/nginx -t; then
    sudo /usr/bin/systemctl reload nginx
    rm -f "$bak"
    return 0
  fi
  if [ -n "$bak" ]; then
    cp "$bak" "$FRAG"
  else
    rm -f "$FRAG"
  fi
  rm -f "$bak"
  fail "nginx -t не прошёл — фрагмент вернули, reload нет"
}

nginx_write_reload

if [ "$SKIP_SYSTEMD" != 1 ]; then
  if [ -f "$HOME/incoming-preview/coop-field-preview@.service" ]; then
    sudo /usr/bin/cp "$HOME/incoming-preview/coop-field-preview@.service" /etc/systemd/system/coop-field-preview@.service
    sudo /usr/bin/systemctl daemon-reload
  fi
  sudo /usr/bin/systemctl enable --now "$UNIT"
  sudo /usr/bin/systemctl restart "$UNIT"
  ok=0
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/tmp/coop-preview-health.json; then
      ok=1
      break
    fi
    sleep 2
  done
  if [ "$ok" -ne 1 ]; then
    echo "preview /health не отвечает на $PORT" >&2
    sudo /usr/bin/systemctl --no-pager status "$UNIT" >&2 || true
    exit 1
  fi
  echo "preview $SLUG sha=$SHA port=$PORT health ok"
  cat /tmp/coop-preview-health.json
  echo
else
  echo "preview $SLUG sha=$SHA port=$PORT apply dry (systemd/nginx reload skipped)"
fi
