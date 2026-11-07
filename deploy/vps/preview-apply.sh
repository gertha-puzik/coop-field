#!/bin/bash
# Ставит или сносит ОДНО preview-окружение.
# Прод (/opt/coop-field, юнит coop-field, порт 8787, data/ прода) не трогает.
# Юнит-файл НЕ ставит и НЕ обновляет (фикс root-RCE): юнит один раз ставит
# preview-bootstrap.sh от root; apply только включает/перезапускает УЖЕ
# установленный юнит. Раньше cp юнита из incoming + daemon-reload позволяли
# PR-коду исполнить произвольный юнит от root.
#
# Dual-host (P5): одно окружение = ДВА сайта и ДВА веб-корня:
#   pr-<номер>.abnocw.miew.ru  -> $APP/www-grotto  (публичные «Пивные гротты»)
#   pr-<номер>.elisium.miew.ru -> $APP/www-elyria  (Элизия Эйдес)
# Инстанс комнаты на PR остаётся один (один порт): оба server-блока nginx
# проксируют на один и тот же 127.0.0.1:$PORT; что именно разрешено на
# каждом хосте, решает сервер по env PUBLIC_HOSTS/ELYRIA_HOSTS (фаза P1) —
# nginx маршруты у блоков одинаковые намеренно.
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
# Швы для локальных тестов: на VPS — sudo и настоящий /etc/systemd/system
# (sudoers-набор совпадает побайтово с тем, что вызывает скрипт).
SUDO="${PREVIEW_SUDO:-sudo}"
SYSTEMD_DIR="${PREVIEW_SYSTEMD_DIR:-/etc/systemd/system}"

SLUG="${PREVIEW_SLUG:-}"
PORT="${PREVIEW_PORT:-}"
ACTION="${PREVIEW_ACTION:-apply}"
SHA="${PREVIEW_SHA:-unknown}"
IN="${PREVIEW_IN:-$HOME/incoming-preview/$SLUG}"
HOST="${PREVIEW_HOST:-$SLUG.abnocw.miew.ru}"
HOST2="${PREVIEW_HOST2:-$SLUG.elisium.miew.ru}"

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
  # Оба preview-суффикса, правила метки одинаковые: строчные a-z0-9-,
  # начинается с буквы/цифры, до 24 символов.
  local h="$1"
  local label=""
  case "$h" in
    *.abnocw.miew.ru)
      label="${h%.abnocw.miew.ru}"
      [ "$h" = "$label.abnocw.miew.ru" ] || return 1
      ;;
    *.elisium.miew.ru)
      label="${h%.elisium.miew.ru}"
      [ "$h" = "$label.elisium.miew.ru" ] || return 1
      ;;
    *)
      return 1
      ;;
  esac
  # Длинный server_name бьёт nginx server_names_hash_bucket_size 64.
  [[ "$label" =~ ^[a-z0-9][a-z0-9-]{0,23}$ ]]
}

valid_host "$HOST" || fail "host не прошёл нормализацию: ${HOST:-<пусто>}"
valid_host "$HOST2" || fail "второй host не прошёл нормализацию: ${HOST2:-<пусто>}"

# Зонное распределение: ровно ОДИН хост на суффикс — abnocw отдаёт www-grotto
# (гроты), elisium — www-elyria (Элизия). Хосты приходят снаружи (deploy
# считает их из номера PR через preview-slug.mjs); перепутанные или
# дублирующие зоны — отказ, фрагмент с 443-хостами не собираем.
GROTTO_HOST=""
ELYRIA_HOST=""
for h in "$HOST" "$HOST2"; do
  case "$h" in
    *.abnocw.miew.ru)
      [ -z "$GROTTO_HOST" ] || fail "два abnocw-хоста: нужен ровно один (${HOST} + ${HOST2})"
      GROTTO_HOST="$h"
      ;;
    *.elisium.miew.ru)
      [ -z "$ELYRIA_HOST" ] || fail "два elisium-хоста: нужен ровно один (${HOST} + ${HOST2})"
      ELYRIA_HOST="$h"
      ;;
  esac
done
[ -n "$GROTTO_HOST" ] || fail "не передан abnocw-хост (гроты): нужен PREVIEW_HOST или PREVIEW_HOST2"
[ -n "$ELYRIA_HOST" ] || fail "не передан elisium-хост (Элизия): нужен PREVIEW_HOST или PREVIEW_HOST2"

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
  echo "ok slug=$SLUG app=$APP unit=$UNIT frag=$FRAG host=$GROTTO_HOST host2=$ELYRIA_HOST roots=$APP/www-grotto,$APP/www-elyria"
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
  if "$SUDO" /usr/sbin/nginx -t; then
    "$SUDO" /usr/bin/systemctl reload nginx
  else
    fail "nginx -t не прошёл — reload не делали"
  fi
}

cert_covers_host() {
  # $1 — хост, $2 — каталог с fullchain/privkey. SAN-текст читаем -text
  # (-ext только у openssl 3, -text работает и на BSD/LibreSSL).
  local host="$1" dir="$2" pem="" sans="" wild=""
  pem="$dir/fullchain.pem"
  [ -f "$pem" ] && [ -f "$dir/privkey.pem" ] || return 1
  case "$host" in
    *.abnocw.miew.ru) wild="DNS:\\*\\.abnocw\\.miew\\.ru" ;;
    *.elisium.miew.ru) wild="DNS:\\*\\.elisium\\.miew\\.ru" ;;
    *) return 1 ;;
  esac
  sans="$(openssl x509 -in "$pem" -noout -text 2>/dev/null || true)"
  printf '%s' "$sans" | grep -q "$wild" && return 0
  printf '%s' "$sans" | grep -q "DNS:${host}"
}

cert_dir_for_host() {
  # Печатает первый каталог с сертификатом, покрывающим $1, либо пусто.
  # Приоритет: per-host зеркало (${PREVIEW_TLS_PER:-tls/<host>} — штатный
  # HTTP-01 поток coop-preview-cert) — потом зеркало зоны
  # tls/abnocw.miew.ru|tls/elisium.miew.ru (wildcard DNS-01) — в конце
  # легаси-слот PREVIEW_TLS_WILD (один SAN-набор теоретически мог бы покрыть
  # обе зоны сразу).
  local host="$1"
  local wild="${PREVIEW_TLS_WILD:-$PREVIEW_ROOT/tls/wild}"
  local per="${PREVIEW_TLS_PER:-$PREVIEW_ROOT/tls/$host}"
  local zone=""
  case "$host" in
    *.abnocw.miew.ru) zone="abnocw" ;;
    *.elisium.miew.ru) zone="elisium" ;;
    *) return 1 ;;
  esac
  local d=""
  for d in "$per" "$PREVIEW_ROOT/tls/${zone}.miew.ru" "$wild"; do
    if cert_covers_host "$host" "$d"; then
      printf '%s\n' "$d"
      return 0
    fi
  done
  return 1
}

# Зеркала сертификатов (/opt/.../tls/<host>) обновляет root-скрипт
# coop-preview-tls-sync (certbot deploy-hook): /etc/letsencrypt/live читает
# только root, а cert_covers_host здесь гоняется от deploy-preview.
# Per-host линии выпускает coop-preview-cert (cron, HTTP-01 из webroot
# www-grotto / www-elyria — по суффиксу хоста).
write_block() (
  # $1 — server_name, $2 — root (абсолютный путь веб-корня), $3 — порт.
  # Subshell: ssl-переменные не утекают между блоками.
  local host="$1" root="$2" port="$3"
  local cert=""
  cert="$(cert_dir_for_host "$host")" || cert=""
  local ssl_listen="" ssl_certs="" https_jump=""
  if [ -n "$cert" ]; then
    ssl_listen="    listen 443 ssl;"
    ssl_certs="    ssl_certificate $cert/fullchain.pem;
    ssl_certificate_key $cert/privkey.pem;"
    # http -> https включается только вместе с сертификатом (есть куда вести).
    # ACME-path исключён, на случай per-host HTTP-01; wildcard идёт DNS-01.
    https_jump="    set \$cf_r 0;
    if (\$scheme = http) { set \$cf_r 1; }
    if (\$request_uri ~ \"^/\\.well-known/acme-challenge/\") { set \$cf_r 0; }
    if (\$cf_r = 1) { return 301 https://\$host\$request_uri; }"
  fi
  cat <<EOF
server {
    listen 80;
${ssl_listen}
    server_name $host;
${ssl_certs}
    root $root;
    index index.html;
    charset utf-8;

${https_jump}
    location /.well-known/acme-challenge/ {
        try_files \$uri =404;
    }
    location / {
        try_files \$uri \$uri.html \$uri/ /index.html;
    }
    location /_next/static/ {
        try_files \$uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
    location /health {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
    }
    location /auth {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    location /cfg {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Cookie \$http_cookie;
    }
    location /profiles {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Cookie \$http_cookie;
    }
    location /admin {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Cookie \$http_cookie;
    }
    location /ws {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header Origin \$http_origin;
        # X-Forwarded-For нужен серверу для auth rate-limit по IP клиента.
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_read_timeout 3600s;
    }
}
EOF
)

write_nginx_fragment() {
  mkdir -p "$NGINX_D"
  # Certbot/root-cron может оставить фрагмент от root. Каталог наш —
  # unlink чужого файла можно, перезаписать через cat > нельзя.
  rm -f "$FRAG"
  write_block "$GROTTO_HOST" "$APP/www-grotto" "$PORT" >> "$FRAG"
  write_block "$ELYRIA_HOST" "$APP/www-elyria" "$PORT" >> "$FRAG"
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
  if "$SUDO" /usr/sbin/nginx -t; then
    "$SUDO" /usr/bin/systemctl reload nginx
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
    "$SUDO" /usr/bin/systemctl stop "$UNIT" 2>/dev/null || true
    "$SUDO" /usr/bin/systemctl disable "$UNIT" 2>/dev/null || true
    "$SUDO" /usr/bin/systemctl reset-failed "$UNIT" 2>/dev/null || true
  fi
  if [ -e "$APP" ]; then
    rm -rf -- "$APP"
  fi
  destroy_nginx_fragment
  echo "preview $SLUG удалён (unit, каталог с обоими корнями, nginx-фрагмент с обоими server-блоками). прод не трогали."
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
need www-grotto/index.html
need www-elyria/index.html

mkdir -p "$APP/data" "$APP/www-grotto" "$APP/www-elyria"
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
  rsync -a --delete "$IN/www-grotto/" "$APP/www-grotto/"
  rsync -a --delete "$IN/www-elyria/" "$APP/www-elyria/"
else
  rm -rf "$APP/www-grotto" "$APP/www-elyria"
  mkdir -p "$APP/www-grotto" "$APP/www-elyria"
  cp -a "$IN/www-grotto/." "$APP/www-grotto/"
  cp -a "$IN/www-elyria/." "$APP/www-elyria/"
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
# Порт, Origin-allowlist и оба хоста обновляем на каждый apply: хосты приходят
# снаружи и могут смениться (формат URL, ручной re-apply), а Origin сокета из
# server/config.js (allowlist по ALLOWED_ORIGINS) и Host-политика сервера
# (PUBLIC_HOSTS/ELYRIA_HOSTS, фаза P1) обязаны идти за ними. Все scheme —
# чтобы http жил до выпуска сертификата и не отваливался после перехода
# на https. grep -v + mv вместо sed -i: одинаково работает на GNU (VPS/CI) и
# BSD sed (локальный запуск тестов на mac).
AO="http://$GROTTO_HOST,https://$GROTTO_HOST,http://$ELYRIA_HOST,https://$ELYRIA_HOST"
grep -v -E '^(PORT|ALLOWED_ORIGINS|PUBLIC_HOSTS|ELYRIA_HOSTS|PREVIEW_SHA)=' "$APP/env" > "$APP/env.n" || true
printf 'PORT=%s\nALLOWED_ORIGINS=%s\nPUBLIC_HOSTS=%s\nELYRIA_HOSTS=%s\nPREVIEW_SHA=%s\n' \
  "$PORT" "$AO" "$GROTTO_HOST" "$ELYRIA_HOST" "$SHA" >> "$APP/env.n"
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
  if "$SUDO" /usr/sbin/nginx -t; then
    "$SUDO" /usr/bin/systemctl reload nginx
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
  # Юнит обязан уже стоять (ставится только bootstrap'ом от root).
  # Никакого cp юнита и daemon-reload здесь быть не должно.
  if [ ! -f "$SYSTEMD_DIR/coop-field-preview@.service" ]; then
    fail "юнит coop-field-preview@.service не установлен в $SYSTEMD_DIR — один раз от root: bash /home/deploy-preview/incoming-preview/preview-bootstrap.sh (apply юниты не ставит)"
  fi
  "$SUDO" /usr/bin/systemctl enable --now "$UNIT"
  "$SUDO" /usr/bin/systemctl restart "$UNIT"
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
    "$SUDO" /usr/bin/systemctl --no-pager status "$UNIT" >&2 || true
    exit 1
  fi
  echo "preview $SLUG sha=$SHA port=$PORT health ok"
  cat /tmp/coop-preview-health.json
  echo
else
  echo "preview $SLUG sha=$SHA port=$PORT apply dry (systemd/nginx reload skipped)"
fi
