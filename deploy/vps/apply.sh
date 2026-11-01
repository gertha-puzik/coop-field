#!/bin/bash
# Обновляет комнату на VPS из каталога incoming и перезапускает сервис,
# только если изменились server.js или зависимости.
# Запускается пользователем deploy по SSH из GitHub Actions.
set -euo pipefail

IN="${INCOMING:-$HOME/incoming}"
APP=/opt/coop-field
export PATH="$APP/.node/bin:$PATH"
NPM="$APP/.node/bin/npm"

need() {
  if [ ! -f "$IN/$1" ]; then
    echo "нет файла $IN/$1" >&2
    exit 1
  fi
}

need server.js
need package.json
need package-lock.json

sha() {
  sha256sum "$1" | awk '{print $1}'
}

server_changed=0
if [ ! -f "$APP/server.js" ] || [ "$(sha "$IN/server.js")" != "$(sha "$APP/server.js")" ]; then
  server_changed=1
fi

lock_changed=0
if [ ! -f "$APP/package-lock.json" ] || [ "$(sha "$IN/package-lock.json")" != "$(sha "$APP/package-lock.json")" ]; then
  lock_changed=1
fi

install -m 0644 "$IN/server.js" "$APP/server.js"
install -m 0644 "$IN/package.json" "$APP/package.json"
install -m 0644 "$IN/package-lock.json" "$APP/package-lock.json"

if [ -d "$IN/scripts" ]; then
  mkdir -p "$APP/scripts"
  cp -a "$IN/scripts/." "$APP/scripts/"
fi

if [ "$lock_changed" -eq 1 ]; then
  tmp="$(mktemp -d)"
  cp "$APP/package.json" "$APP/package-lock.json" "$tmp/"
  (
    cd "$tmp"
    "$NPM" ci --omit=dev
  )
  rm -rf "$APP/node_modules"
  mv "$tmp/node_modules" "$APP/node_modules"
  rm -rf "$tmp"
  chown -R deploy:deploy "$APP/node_modules"
fi

chown deploy:deploy "$APP/server.js" "$APP/package.json" "$APP/package-lock.json"
if [ -d "$APP/scripts" ]; then
  chown -R deploy:deploy "$APP/scripts"
fi

if [ "$server_changed" -eq 0 ] && [ "$lock_changed" -eq 0 ]; then
  echo "сервер без изменений, перезапуск не нужен"
  exit 0
fi

sudo /usr/bin/systemctl restart coop-field

ok=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -fsS http://127.0.0.1:8787/health >/tmp/coop-health.json; then
    ok=1
    break
  fi
  sleep 0.3
done

if [ "$ok" -ne 1 ]; then
  echo "проверка /health не прошла" >&2
  sudo /usr/bin/systemctl --no-pager status coop-field >&2 || true
  exit 1
fi

cat /tmp/coop-health.json
echo
