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
#
# Честные статусы (B4): apply не считает окружение live только потому,
# что rsync прошёл. В конце apply (или отдельно PREVIEW_ACTION=verify)
# идёт пост-деплой верификация ОБЕИХ хостов локальными запросами с VPS
# (curl к публичным именам; никакого ssh изнутри скрипта). Bounded polling:
# конечное число попыток (PREVIEW_VERIFY_TRIES × PREVIEW_VERIFY_SLEEP),
# каждая попытка пересчитывает точные причины; «live» ставится только
# при полном проходе всех проверок на ОБОИХ хостах.
#   host verdicts: ok | needs-dns | needs-tls | broken(причины)
#   overall:  live | partial-failure | needs-tls | needs-dns | failed
#   exit-коды: 0=live 3=partial-failure 4=failed 5=needs-tls 6=needs-dns
#
# Режимы артефакта: корни www-grotto/ и www-elyria/ различаются — dual
# (продуктовые билд-варианты: строгая дифференциация /profiles — гроты
# 404, Элизия 200). Корни байт-в-байт совпадают — mirror (старые коммиты
# main без билд-вариантов: preview-build.yml зеркалит единый билд в оба
# корня; оба хоста честно отдают один и тот же сайт). Корень www/ без
# вариантных корней — legacy-single (порядок мерджа PR #49/#50 не
# гарантирован: пока продукт-PR не влита, такой артефакт — норма; это НЕ
# ослабление и НЕ фейк: честный один сайт на abnocw-хосте, второй хост не
# заявляется и не верифицируется, статус помечается legacy).
#
# apply:   PREVIEW_SLUG=… PREVIEW_PORT=… [PREVIEW_TRUSTED_SHA=…] [PREVIEW_HOST=… [PREVIEW_HOST2=…]] bash preview-apply.sh
# destroy: PREVIEW_SLUG=… PREVIEW_ACTION=destroy bash preview-apply.sh
# validate: PREVIEW_SLUG=… PREVIEW_ACTION=validate bash preview-apply.sh
# verify:  PREVIEW_SLUG=… PREVIEW_HOST=… PREVIEW_HOST2=… [PREVIEW_TRUSTED_SHA=…] PREVIEW_ACTION=verify bash preview-apply.sh
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
# Верификация: в настоящем apply включена (live только после неё); локальные
# тесты и ручной dry-run ставят PREVIEW_VERIFY=0; PREVIEW_ACTION=verify
# гоняет только её по уже выложенным корням, без повторной выкладки.
PREVIEW_VERIFY="${PREVIEW_VERIFY:-1}"
VERIFY_TRIES="${PREVIEW_VERIFY_TRIES:-10}"
VERIFY_SLEEP="${PREVIEW_VERIFY_SLEEP:-30}"

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
# ── Режим входа: dual (www-grotto+www-elyria) | legacy-single (только www/) ──
# Порядок мерджа PR #49/#50 не гарантирован: apply обязан понимать ОБА
# формата артефакта. Дуальные корни приоритетнее (если билд дал оба формата
# — это dual);www/ без вариантных корней — легаси-контракт. Для validate/
# destroy вход может не существовать — по умолчанию dual (контракт входа
# проверяет need() ниже), а verify печатает режим по корням ДЕПЛОЯ.
artifact_mode_of() {
  local base="$1"
  if [ -d "$base/www-grotto" ] && [ -d "$base/www-elyria" ]; then
    echo "dual"
  elif [ -d "$base/www" ] && [ ! -d "$base/www-grotto" ] && [ ! -d "$base/www-elyria" ]; then
    echo "legacy-single"
  else
    return 1
  fi
}
ARTIFACT_MODE="dual"
if MODE_DETECTED="$(artifact_mode_of "$IN")"; then
  ARTIFACT_MODE="$MODE_DETECTED"
fi
if [ "$ARTIFACT_MODE" = "legacy-single" ]; then
  # Легаси деплоится на ОДИН abnocw-хост (второй сайт не заявляем и не
  # верифицируем); HOST2 не участвует. Главное имя HOST обязано быть
  # abnocw-зоной: Элизия-суффикс для одно-сайтового артефакта — чужой хост,
  # отказ, а не тихая подмена хостом из HOST2.
  case "$HOST" in
    *.abnocw.miew.ru) [ -n "$GROTTO_HOST" ] || GROTTO_HOST="$HOST" ;;
    *) fail "legacy-single артефакт деплоится на один abnocw-хост (получили ${HOST})" ;;
  esac
else
  [ -n "$GROTTO_HOST" ] || fail "не передан abnocw-хост (гроты): нужен PREVIEW_HOST или PREVIEW_HOST2"
  [ -n "$ELYRIA_HOST" ] || fail "не передан elisium-хост (Элизия): нужен PREVIEW_HOST или PREVIEW_HOST2"
fi

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
  echo "ok slug=$SLUG app=$APP unit=$UNIT frag=$FRAG host=$GROTTO_HOST host2=$ELYRIA_HOST roots=$APP/www-grotto,$APP/www-elyria mode=$ARTIFACT_MODE"
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
        # §6: /cfg — credentialed admin-зона, auth rate-limits считаются по
        # клиентскому IP так же, как в /auth (прод-блоки уже так делают).
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
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
    # NB: /admin как ПРЕФИКС не проксируется: панель админа — статическая
    # страница варианта (GET /admin/ отдаётся try_files, как на прод-конфиге);
    # проксирование всего префикса ломало страницу 404. Единственное исключение
    # ниже — API-префикс «Игроки на поле» (/admin/players со слэш-суффиксом):
    # уходит в Node только он, страница /admin остаётся статикой.
    location /admin/players {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Cookie \$http_cookie;
    }
    # Менеджер спрайтов (server/sprites.js): те же правила «только реальные
    # API-префиксы» — админские CRUD /admin/sprites* уходят в Node, страница
    # /admin остаётся статикой варианта (как /admin/players выше).
    location /admin/sprites {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header Cookie \$http_cookie;
    }
    # Публичный каталог спрайтов ОБЕИМ сайтам (карусель выбора скина): без
    # прокси изолированный билд отдал бы try_files→index.html и карусель
    # молча деградировала на статичный список.
    location /sprites/catalog {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }
    # Файлы ЗАГРУЖЕННЫХ спрайтов (не-builtin): префикс ДЛИННЕЕ статики
    # /sprites/, поэтому nginx выбирает этот location, а базовые PNG
    # (www*/sprites/<id>.png) остаются на try_files своего root. Порядок в
    # конфиге для наглядности до статических location — у префиксов nginx и
    # так берёт самое длинное совпадение.
    location /sprites/file {
        proxy_pass http://127.0.0.1:$port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
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
  if [ "$ARTIFACT_MODE" = "legacy-single" ]; then
    # Легаси-артефакт: ОДИН server- block (abnocw) на корень www/.
    write_block "$GROTTO_HOST" "$APP/www" "$PORT" >> "$FRAG"
  else
    write_block "$GROTTO_HOST" "$APP/www-grotto" "$PORT" >> "$FRAG"
    write_block "$ELYRIA_HOST" "$APP/www-elyria" "$PORT" >> "$FRAG"
  fi
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

# ── Пост-деплой верификация (B4) ────────────────────────────────────────────
# Локальные запросы с самой VPS к публичным именам (никакого ssh изнутри):
# DNS обоих имён, HTTP→HTTPS redirect, валидность/покрытие TLS (curl сам
# проверяет цепочку и имя), 200 от корректного корня с байт-сверкой index,
# маркер сайта site.marker (если билд положил), /health комнаты,
# дифференциация /profiles и SHA-штамп артефакта.

resolve_host() {
  # Первый A-адрес имени или пусто. dig -> nslookup -> getent.
  local h="$1" ip=""
  if command -v dig >/dev/null 2>&1; then
    ip="$(dig +short "$h" 2>/dev/null | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
  fi
  if [ -z "$ip" ] && command -v nslookup >/dev/null 2>&1; then
    ip="$(nslookup "$h" 2>/dev/null | awk '/^Address[[:space:]]*:/{print $NF}' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
  fi
  if [ -z "$ip" ] && command -v getent >/dev/null 2>&1; then
    ip="$(getent hosts "$h" 2>/dev/null | awk '{print $1}' | head -n 1 || true)"
  fi
  printf '%s' "$ip"
}

fetch_code() {
  # $1 — url, $2 — файл для тела. Печатает HTTP-код («000» — соединения нет).
  local url="$1" out="$2" code="000"
  code="$(curl -sS --compressed --max-time 15 -o "$out" -w '%{http_code}' "$url" 2>/dev/null)" || code="000"
  printf '%s' "$code"
}

head_redirect() {
  # $1 — url. Печатает «301 https://host/...» (код + Location) или пусто.
  local url="$1" hdr="" code="" loc=""
  hdr="$(curl -sS -I --max-time 15 "$url" 2>/dev/null || true)"
  [ -n "$hdr" ] || return 0
  code="$(printf '%s\n' "$hdr" | awk 'NR==1{for(i=1;i<=NF;i++) if($i ~ /^[0-9][0-9][0-9]$/){print $i; exit}}')"
  loc="$(printf '%s\n' "$hdr" | awk 'tolower($1)=="location:"{sub(/^[Ll]ocation:[[:space:]]*/,""); print; exit}')"
  [ -n "$code" ] || return 0
  printf '%s %s' "$code" "$loc"
}

ws_code() {
  # WS-проба (§9.3): upgrade-рука GET /ws с заголовками RFC 6455
  # (Upgrade: websocket, Connection: Upgrade, случайный base64-16 байт
  # Sec-WebSocket-Key, Version: 13) и Origin соответствующего хоста.
  # Любой HTTP-ответ — 101 или честный denied (4xx: «точка жива и проверяет
  # origin») — значит WS-точка работает; health по голому HTTP не достаточен.
  # connection-refused/TLS-fail здесь НЕ должен проходить молча: без ответа —
  # 000 и причина ws-000. $1 — scheme, $2 — host.
  local scheme="$1" host="$2" out="" rc=0 key=""
  key="$(openssl rand -base64 16 2>/dev/null || printf 'dG9vbGl0b2dldGVzdDEyMzQ=')"
  out="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
      -H "Upgrade: websocket" \
      -H "Connection: Upgrade" \
      -H "Sec-WebSocket-Key: $key" \
      -H "Sec-WebSocket-Version: 13" \
      -H "Origin: ${scheme}://${host}" \
      "${scheme}://${host}/ws" 2>/dev/null)" || rc=$?
  case "$rc" in
    # 0 — реальный сервер ответил и закрыл; 28 — 101 Switching Protocols
    # пришёл, тела нет и не будет, curl ждёт до max-time: оба = «точка жива».
    0|28) printf '%s' "$out" ;;
    *) printf '000' ;;
  esac
}

api_code_post() {
  # Пустой POST до API-эндпоинта (register/login/cfg): живой сервер обязан
  # ответить содержательной клиентской ошибкой (400 на пустое тело,
  # 401/403 не-админу, 429 rate-limit — тоже честно), а не 404/молчанием.
  # $1 — полный url.
  local url="$1" out="" rc=0
  out="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' \
      -X POST -H "Content-Length: 0" "$url" 2>/dev/null)" || rc=$?
  if [ "$rc" = 0 ]; then printf '%s' "$out"; else printf '000'; fi
}

api_code_get() {
  # GET по API-ручке без тела (например /auth/me на публичном хосте):
  # живой гейт отвечает отказом, nullptr-ответ невозможен. $1 — url.
  local url="$1" out="" rc=0
  out="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null)" || rc=$?

  if [ "$rc" = 0 ]; then printf '%s' "$out"; else printf '000'; fi
}


verify_one() {
  # $1 — хост, $2 — www-grotto|www-elyria. Заполняет VERIFY_VERDICT и
  # VERIFY_REASONS (csv, пусто = чисто). Никаких внешних ssh — только curl
  # к публичному имени с этой же VPS.
  local host="$1" rootdir="$2" idx="" ip="" scheme="" code="" tmp="" tmpb=""
  local redir="" marker=""
  VERIFY_REASONS=""
  VERIFY_VERDICT="broken"
  idx="$APP/$rootdir/index.html"

  ip="$(resolve_host "$host")"
  if [ -z "$ip" ]; then
    VERIFY_REASONS="dns"
    VERIFY_VERDICT="needs-dns"
    return 0
  fi

  tmp="$(mktemp)"
  tmpb="$(mktemp)"

  # Приоритет https (как живой пользователь); недоступный 443 в окне
  # ожидания per-host сертификата — не ошибка: честный статус needs-tls,
  # все остальные проверки идут по http.
  scheme="https"
  code="$(fetch_code "https://$host/" "$tmp")"
  if [ "$code" != "200" ]; then
    scheme="http"
    code="$(fetch_code "http://$host/" "$tmp")"
    if [ "$code" != "200" ]; then
      rm -f "$tmp" "$tmpb"
      VERIFY_REASONS="http-${code}"
      return 0
    fi
    VERIFY_REASONS="tls-pending"
  else
    redir="$(head_redirect "http://$host/")"
    case "${redir%% *}" in
      301|308) : ;;
      "") VERIFY_REASONS="redirect-off" ;;
      *) VERIFY_REASONS="redirect-strange" ;;
    esac
  fi

  if ! cmp -s "$tmp" "$idx"; then
    VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}index-mismatch"
  fi
  rm -f "$tmp"

  marker="$APP/$rootdir/site.marker"
  if [ -f "$marker" ]; then
    code="$(fetch_code "$scheme://$host/site.marker" "$tmpb")"
    if [ "$code" != "200" ] || ! cmp -s "$tmpb" "$marker"; then
      VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}marker-mismatch"
    fi
  fi

  # WS-проба (§9.3): upgrade-рука к /ws в ЛЮБОМ режиме (dual|mirror|
  # legacy-single) — health по голому HTTP не достаточен. 000 (conn
  # refused/TLS-fail) не должен проходить молча: причина ws-000.
  code="$(ws_code "$scheme" "$host")"
  if [ "$code" = "000" ]; then
    VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}ws-000"
  fi

  # Функциональный smoke (§9.3b) — только честный dual: в mirror и legacy
  # движок без Host-политики (auth разрешён везде), эти пробы там не честят.
  if [ "$VERIFY_MODE" = "dual" ]; then
    if [ "$rootdir" = "www-grotto" ]; then
      # Публичный хост не отдаёт API Элизии: /auth/me обязан быть 4xx-отказом
      # гейта (404/403/401) или честным rate-limit — 200 = течь зоны.
      code="$(api_code_get "$scheme://$host/auth/me")"
      case "$code" in
        401|403|404|429) : ;;
        *) VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}elyria-api-leak-${code}" ;;
      esac
    else
      # Хост Элизии: register/login с пустым телом отвечают содержательно
      # (400/401/403/429), 404 = ручки нет; POST /cfg не-админу — 403
      # auth_required (200 = админка без авторизации).
      code="$(api_code_post "$scheme://$host/auth/register")"
      case "$code" in
        400|401|403|429) : ;;
        *) VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}auth-endpoint-${code}" ;;
      esac
      code="$(api_code_post "$scheme://$host/auth/login")"
      case "$code" in
        400|401|403|429) : ;;
        *) VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}auth-endpoint-${code}" ;;
      esac
      code="$(api_code_post "$scheme://$host/cfg")"
      case "$code" in
        401|403|429) : ;;
        *) VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}cfg-admin-${code}" ;;
      esac
    fi
  fi

  code="$(fetch_code "$scheme://$host/health" "$tmpb")"
  if [ "$code" != "200" ] || ! grep -q '"ok"[[:space:]]*:[[:space:]]*true' "$tmpb" 2>/dev/null; then
    VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}health-${code}"
  fi

  code="$(fetch_code "$scheme://$host/profiles" "$tmpb")"
  rm -f "$tmpb"
  if [ "$rootdir" != "www-elyria" ]; then
    # Публичный корень (www-grotto в dual/mirror, www в legacy) НЕ отдаёт
    # профили: гейт сервера (PUBLIC_HOSTS) или отсутствие роута — всегда
    # 404. Иное — течь зоны Элизии на публичный фронт.
    if [ "$code" != "404" ]; then
      VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}profiles-leak-${code}"
    fi
  else
    if [ "$VERIFY_MODE" = "dual" ]; then
      # Контракт продуктовых билд-вариантов: каталог профилей жив только
      # на Элизии; любой иной код — рассинхрон движка/гейта.
      if [ "$code" != "200" ]; then
        VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}profiles-${code}"
      fi
    else
      # mirror (единый движок старого коммита): профиля может не быть
      # (404 старого роутинга) или работать (200); любое из двух — честно.
      case "$code" in
        200|404) : ;;
        *) VERIFY_REASONS="${VERIFY_REASONS:+$VERIFY_REASONS,}profiles-${code}" ;;
      esac
    fi
  fi

  if [ -z "$VERIFY_REASONS" ]; then
    VERIFY_VERDICT="ok"
  elif [ "$VERIFY_REASONS" = "tls-pending" ]; then
    VERIFY_VERDICT="needs-tls"
  fi
  return 0
}

verify_all() {
  # Bounded polling: конечное число попыток, в каждой — полный пересчёт
  # причин. «Live» не ставится по sleep — только по факту полного прохода;
  # иначе наружу уходит последний честный снимок причин.
  local attempt="" grotto_v="" elyria_v="" grotto_r="" elyria_r="" ov="failed"

  # Режим ДЕПЛОЯ (не входа): legacy-окружение имеет один корень www/ и
  # не имеет вариантных; dual/mirror различаем cmp-ом index.html корней.
  if [ "$ARTIFACT_MODE" = "legacy-single" ]; then
    VERIFY_MODE="legacy-single"
  elif cmp -s "$APP/www-grotto/index.html" "$APP/www-elyria/index.html"; then
    VERIFY_MODE="mirror"
  else
    VERIFY_MODE="dual"
  fi

  grotto_v="broken"; grotto_r="none"; elyria_v="broken"; elyria_r="none"
  if [ "$ARTIFACT_MODE" = "legacy-single" ]; then
    # Легаси: ОДИН хост (abnocw, корень www/). Второго сайта нет и не
    # заявляем — partial-failure в этом режиме невозможен по построению.
    for attempt in $(seq 1 "$VERIFY_TRIES"); do
      verify_one "$GROTTO_HOST" "www"
      grotto_v="$VERIFY_VERDICT"; grotto_r="${VERIFY_REASONS:-none}"
      if [ "$grotto_v" = "ok" ]; then
        ov="live"
        break
      fi
      if [ "$attempt" -lt "$VERIFY_TRIES" ]; then
        echo "verify: попытка $attempt/$VERIFY_TRIES — abnocw=$grotto_v ($grotto_r); пересчёт через $VERIFY_SLEEP с"
        sleep "$VERIFY_SLEEP"
      fi
    done
    if [ "$ov" != "live" ]; then
      case "$grotto_v" in
        needs-dns) ov="needs-dns" ;;
        needs-tls) ov="needs-tls" ;;
        *) ov="failed" ;;
      esac
    fi
    elyria_v=""; elyria_r="none"
  else
    for attempt in $(seq 1 "$VERIFY_TRIES"); do
      verify_one "$GROTTO_HOST" "www-grotto"
      grotto_v="$VERIFY_VERDICT"; grotto_r="${VERIFY_REASONS:-none}"
      verify_one "$ELYRIA_HOST" "www-elyria"
      elyria_v="$VERIFY_VERDICT"; elyria_r="${VERIFY_REASONS:-none}"

      if [ "$grotto_v" = "ok" ] && [ "$elyria_v" = "ok" ]; then
        ov="live"
        break
      fi
      if [ "$attempt" -lt "$VERIFY_TRIES" ]; then
        echo "verify: попытка $attempt/$VERIFY_TRIES — гроты=$grotto_v ($grotto_r), Элизия=$elyria_v ($elyria_r); пересчёт через $VERIFY_SLEEP с"
        sleep "$VERIFY_SLEEP"
      fi
    done

    if [ "$ov" != "live" ]; then
      if [ "$grotto_v" = "ok" ] || [ "$elyria_v" = "ok" ]; then
        ov="partial-failure"
      elif [ "$grotto_v" = "needs-dns" ] || [ "$elyria_v" = "needs-dns" ]; then
        ov="needs-dns"
      elif [ "$grotto_v" = "needs-tls" ] && [ "$elyria_v" = "needs-tls" ]; then
        ov="needs-tls"
      else
        ov="failed"
      fi
    fi
  fi

  VERIFY_OVERALL="$ov"
  VERIFY_GROTTO_VERDICT="$grotto_v"; VERIFY_GROTTO_REASONS="$grotto_r"
  VERIFY_ELYRIA_VERDICT="$elyria_v"; VERIFY_ELYRIA_REASONS="$elyria_r"
  VERIFY_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # SHA-штамп: честность о происхождении выложенного кода. Штамп кладёт
  # preview-build.yml из head-SHA; PREVIEW_TRUSTED_SHA передаёт deploy из
  # workflow_run (не из чекаута PR). Нет штампа (легаси-артефакт) — выкладка
  # не ломается, но в отчёте честно пишется sha=none.
  VERIFY_SHA_STATE="none"
  if [ -f "$APP/preview-sha" ]; then
    VERIFY_SHA_STATE="$(tr -d '[:space:]' < "$APP/preview-sha")"
    if [ -n "${PREVIEW_TRUSTED_SHA:-}" ] && [ "x$VERIFY_SHA_STATE" != "x$PREVIEW_TRUSTED_SHA" ]; then
      VERIFY_SHA_STATE="stale:${VERIFY_SHA_STATE}"
      VERIFY_OVERALL="failed"
      VERIFY_GROTTO_VERDICT="sha-stale"; VERIFY_GROTTO_REASONS="артефакт не совпадает с SHA деплоя"
      if [ "$ARTIFACT_MODE" != "legacy-single" ]; then
        VERIFY_ELYRIA_VERDICT="sha-stale"; VERIFY_ELYRIA_REASONS="артефакт не совпадает с SHA деплоя"
      fi
    fi
  fi
}

print_result() {
  # Машиночитаемый блок для preview-deploy.yml (grep 'PREVIEW-RESULT').
  echo "PREVIEW-RESULT overall=$VERIFY_OVERALL"
  echo "PREVIEW-RESULT grotto=$VERIFY_GROTTO_VERDICT reasons=${VERIFY_GROTTO_REASONS:-none} url=https://$GROTTO_HOST"
  if [ -z "$VERIFY_ELYRIA_VERDICT" ] && [ "$VERIFY_MODE" = "legacy-single" ]; then
    # Легаси-превью: ОДИН хост; второй сайт не заявлен и не проверен.
    # Это честный нормальный режим до мерджа продуктового PR #49,
    # а не «частичный отказ»: partial-failure тут никогда не пишется.
    echo "PREVIEW-RESULT note=legacy single-site preview (dual-host появится после мерджа PR #49)"
  else
    echo "PREVIEW-RESULT elyria=$VERIFY_ELYRIA_VERDICT reasons=${VERIFY_ELYRIA_REASONS:-none} url=https://$ELYRIA_HOST"
  fi
  echo "PREVIEW-RESULT mode=$VERIFY_MODE sha=${VERIFY_SHA_STATE:-none} verified_at=$VERIFY_AT"
}

verify_exit_code() {
  case "$VERIFY_OVERALL" in
    live) return 0 ;;
    needs-tls) return 5 ;;
    needs-dns) return 6 ;;
    partial-failure) return 3 ;;
    *) return 4 ;;
  esac
}

if [ "$ACTION" = "verify" ]; then
  # Режим выводим из корней ДЕПЛОЯ: verify может зваться и без входа.
  ARTIFACT_MODE="dual"
  if [ -f "$APP/www/index.html" ] && [ ! -d "$APP/www-grotto" ] && [ ! -d "$APP/www-elyria" ]; then
    ARTIFACT_MODE="legacy-single"
  fi
  if [ "$ARTIFACT_MODE" = "legacy-single" ]; then
    [ -f "$APP/www/index.html" ] || fail "нет $APP/www/index.html — верифицировать нечего"
  else
    [ -f "$APP/www-grotto/index.html" ] || fail "нет $APP/www-grotto/index.html — верифицировать нечего"
    [ -f "$APP/www-elyria/index.html" ] || fail "нет $APP/www-elyria/index.html — верифицировать нечего"
  fi
  PREVIEW_TRUSTED_SHA="${PREVIEW_TRUSTED_SHA:-$SHA}"
  verify_all
  print_result
  verify_exit_code
  exit $?
fi

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
  echo "preview $SLUG удалён (unit, каталог превью, nginx-фрагмент всех его server-блоков). прод не трогали."
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
if [ "$ARTIFACT_MODE" = "legacy-single" ]; then
  need www/index.html
else
  need www-grotto/index.html
  need www-elyria/index.html
fi

# SHA-штамп артефакта: билд клал в preview-sha SHA, из которого собрал
# дистрибутив. Если deploy несёт другой SHA (workflow_run с фиксированным
# head-SHA), выкладывать устаревший артефакт нельзя — PR-страница соврала
# бы про «сборку с head». Штампа нет (легаси-артефакт) — выкладываем, но
# verify честно пометит sha=none в отчёте.
if [ -n "${PREVIEW_TRUSTED_SHA:-}" ] && [ -f "$IN/preview-sha" ]; then
  stale_sha="$(tr -d '[:space:]' < "$IN/preview-sha")"
  if [ -n "$stale_sha" ] && [ "x$stale_sha" != "x$PREVIEW_TRUSTED_SHA" ]; then
    fail "артефакт собран с $stale_sha, а деплой несёт $PREVIEW_TRUSTED_SHA — устаревший дистрибутив не выкладываем"
  fi
fi

mkdir -p "$APP/data"
if [ "$ARTIFACT_MODE" = "legacy-single" ]; then
  mkdir -p "$APP/www"
else
  mkdir -p "$APP/www-grotto" "$APP/www-elyria"
fi
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
if [ -f "$IN/preview-sha" ]; then
  cp -a "$IN/preview-sha" "$APP/preview-sha"
else
  rm -f "$APP/preview-sha"
fi
# metadata.json — заявка нового билда о режиме; артефакты СТАРОГО main-билда
# его не несут, apply остаётся обратно-совместимым: режим уже выведен из
# директорий, метаданные копируем если есть (verify/deploy читают из $APP).
if [ -f "$IN/metadata.json" ]; then
  cp -a "$IN/metadata.json" "$APP/metadata.json"
else
  rm -f "$APP/metadata.json"
fi
if [ "$ARTIFACT_MODE" = "legacy-single" ]; then
  # Легаси: один корень www/; вариантные корни прошлого dual-деплоя этого
  # же слага убираем — дерево обязано отражать ВЫЛОЖЕННЫЙ артефакт, иначе
  # verify по корням сочтёт окружение dual'ем.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$IN/www/" "$APP/www/"
  else
    rm -rf "$APP/www"
    mkdir -p "$APP/www"
    cp -a "$IN/www/." "$APP/www/"
  fi
  rm -rf "$APP/www-grotto" "$APP/www-elyria"
else
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$IN/www-grotto/" "$APP/www-grotto/"
    rsync -a --delete "$IN/www-elyria/" "$APP/www-elyria/"
  else
    rm -rf "$APP/www-grotto" "$APP/www-elyria"
    mkdir -p "$APP/www-grotto" "$APP/www-elyria"
    cp -a "$IN/www-grotto/." "$APP/www-grotto/"
    cp -a "$IN/www-elyria/." "$APP/www-elyria/"
  fi
  # Смена режима в обратную сторону: старый www/ тоже не должен висеть.
  rm -rf "$APP/www"
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
# BSD sed (локальный запуск тестов на mac). PREVIEW_SITES_MODE (dual|mirror)
# сообщает верификации (и админу), что лежит в корнях: раздельные билд-
# варианты продуктовых веток или честное зеркало одного билда старого main.
if [ "$ARTIFACT_MODE" = "legacy-single" ]; then
  # Легаси: allowlist и Host-политика для ОДНОГО abnocw-хоста;
  # ELYRIA_HOSTS не пишем вовсе (старый движок артефакта его не знает),
  # grep -v ниже гарантирует, что ключ от прошлого dual-окружения удалён.
  SITES_MODE="legacy-single"
  AO="http://$GROTTO_HOST,https://$GROTTO_HOST"
  grep -v -E '^(PORT|ALLOWED_ORIGINS|PUBLIC_HOSTS|ELYRIA_HOSTS|PREVIEW_SHA|PREVIEW_SITES_MODE|COOP_INSTANCE_CLASS)=' "$APP/env" > "$APP/env.n" || true
  printf 'PORT=%s\nALLOWED_ORIGINS=%s\nPUBLIC_HOSTS=%s\nPREVIEW_SHA=%s\nPREVIEW_SITES_MODE=%s\nCOOP_INSTANCE_CLASS=preview\n' \
    "$PORT" "$AO" "$GROTTO_HOST" "$SHA" "$SITES_MODE" >> "$APP/env.n"
else
  SITES_MODE="dual"
  cmp -s "$APP/www-grotto/index.html" "$APP/www-elyria/index.html" && SITES_MODE="mirror"
  AO="http://$GROTTO_HOST,https://$GROTTO_HOST,http://$ELYRIA_HOST,https://$ELYRIA_HOST"
  grep -v -E '^(PORT|ALLOWED_ORIGINS|PUBLIC_HOSTS|ELYRIA_HOSTS|PREVIEW_SHA|PREVIEW_SITES_MODE|COOP_INSTANCE_CLASS)=' "$APP/env" > "$APP/env.n" || true
  printf 'PORT=%s\nALLOWED_ORIGINS=%s\nPUBLIC_HOSTS=%s\nELYRIA_HOSTS=%s\nPREVIEW_SHA=%s\nPREVIEW_SITES_MODE=%s\nCOOP_INSTANCE_CLASS=preview\n' \
    "$PORT" "$AO" "$GROTTO_HOST" "$ELYRIA_HOST" "$SHA" "$SITES_MODE" >> "$APP/env.n"
fi
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

# Честный финальный статус: apply прошёл ≠ live. live ставит только
# верификация обоих хостов (см. verify_all). needs-tls/needs-dns — не
# «сломано», а точное имя ближайшей внешней причины (серт-cron / DNS).
if [ "$PREVIEW_VERIFY" = "1" ] && [ "$SKIP_SYSTEMD" != "1" ]; then
  verify_all
  print_result
  case "$VERIFY_OVERALL" in
    live) exit 0 ;;
    needs-tls) echo "verify: выложено, ждём per-host сертификат (root-cron ~5 мин) — статус needs-tls" >&2; exit 5 ;;
    needs-dns) echo "verify: имена не резолвятся — needs-dns" >&2; exit 6 ;;
    partial-failure) echo "verify: один хост жив, другой нет — partial-failure (детали в PREVIEW-RESULT)" >&2; exit 3 ;;
    *) if [ "$ARTIFACT_MODE" = "legacy-single" ]; then
         echo "verify: хост $GROTTO_HOST не прошёл — failed (детали в PREVIEW-RESULT)" >&2
       else
         echo "verify: оба хоста не прошли — failed (детали в PREVIEW-RESULT)" >&2
       fi; exit 4 ;;
  esac
fi
echo "PREVIEW-RESULT overall=unverified"
echo "preview $SLUG применён без верификации (PREVIEW_VERIFY=0 или dry-run)"
