#!/bin/bash
# Ставит ОДНО preview-окружение из incoming-preview/<slug>/ на VPS.
# Прод (/opt/coop-field, порт 8787, DATA_DIR прода) не трогает.
# Запуск: PREVIEW_SLUG=... PREVIEW_PORT=... bash preview-apply.sh
# Удаление: PREVIEW_SLUG=... PREVIEW_ACTION=destroy bash preview-apply.sh
set -euo pipefail

SLUG="${PREVIEW_SLUG:-}"
PORT="${PREVIEW_PORT:-}"
ACTION="${PREVIEW_ACTION:-apply}"
SHA="${PREVIEW_SHA:-unknown}"
IN="${PREVIEW_IN:-$HOME/incoming-preview/$SLUG}"
APP="/opt/coop-field-preview/$SLUG"
NODE="${PREVIEW_NODE:-/opt/coop-field/.node/bin/node}"
NPM="${PREVIEW_NPM:-/opt/coop-field/.node/bin/npm}"
UNIT="coop-field-preview@${SLUG}"

if [ -z "$SLUG" ]; then
  echo "нужен PREVIEW_SLUG" >&2
  exit 1
fi
if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]]; then
  echo "slug не прошёл нормализацию: $SLUG" >&2
  exit 1
fi

if [ "$ACTION" = "destroy" ]; then
  sudo /usr/bin/systemctl stop "$UNIT" 2>/dev/null || true
  sudo /usr/bin/systemctl disable "$UNIT" 2>/dev/null || true
  rm -rf "$APP"
  if [ -f "/etc/nginx/sites-enabled/preview-$SLUG.conf" ]; then
    echo "nginx fragment preview-$SLUG.conf ещё на месте — снять может root (см. docs/PREVIEW-ENVIRONMENTS.md)"
  fi
  echo "preview $SLUG удалён (каталог и unit). nginx — владелица, если нет sudo."
  exit 0
fi

if [ -z "$PORT" ]; then
  echo "нужен PREVIEW_PORT" >&2
  exit 1
fi
if [ ! -x "$NODE" ]; then
  echo "нет node $NODE — preview пользуется бинарём прода, не копирует его" >&2
  exit 1
fi

need() {
  if [ ! -e "$IN/$1" ]; then
    echo "нет $IN/$1" >&2
    exit 1
  fi
}
need server.js
need server/protocol.js
need www/index.html

mkdir -p "$APP/data" "$APP/www"
# Код комнаты — слепок SHA, не имя ветки.
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
rsync -a --delete "$IN/www/" "$APP/www/"

if [ ! -f "$APP/env" ]; then
  PASS="$(head -c 16 /dev/urandom | xxd -p)"
  cat > "$APP/env" <<EOF
PORT=$PORT
HOST=127.0.0.1
DATA_DIR=$APP/data
ADMIN_PASS=$PASS
REQUIRE_ORIGIN=0
EOF
fi
# Порт мог смениться при коллизии — переписываем только PORT.
sed -i "s/^PORT=.*/PORT=$PORT/" "$APP/env"
printf 'PREVIEW_SHA=%s\n' "$SHA" >> "$APP/env.tmp" || true
grep -v '^PREVIEW_SHA=' "$APP/env" > "$APP/env.n" || true
printf 'PREVIEW_SHA=%s\n' "$SHA" >> "$APP/env.n"
mv "$APP/env.n" "$APP/env"

if [ ! -d "$APP/node_modules" ]; then
  if [ -d /opt/coop-field/node_modules ]; then
    ln -s /opt/coop-field/node_modules "$APP/node_modules"
  else
    ( cd "$APP" && "$NPM" ci --omit=dev )
  fi
fi

chown -R deploy:deploy "$APP"

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
