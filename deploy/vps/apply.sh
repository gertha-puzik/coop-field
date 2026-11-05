#!/bin/bash
# Обновляет комнату на VPS из каталога incoming и перезапускает сервис.
# Перезапуск нужен при смене server.js, package*.json или самого apply.sh.
# Факт последнего успешного перезапуска фиксируется маркером $APP/.last-restart:
# неудачный деплой не оставляет расхождение «файлы новые — сервис старый»,
# следующая выкладка тех же файлов повторит перезапуск сама.
# Изменили переменные окружения юнита на сервере — удалите маркер:
#   rm /opt/coop-field/.last-restart
# Запускается пользователем deploy по SSH из GitHub Actions.
set -euo pipefail

IN="${INCOMING:-$HOME/incoming}"
APP=/opt/coop-field
STAMP="$APP/.last-restart"
# $APP/www — статический фронт. Этот скрипт его не копирует и не удаляет.
# nginx не перечитывается.
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

# Порт комнаты берём из юнита systemd (Environment=PORT=...), а не зашиваем:
# образец юнита — deploy/vps/coop-field.service. Если переменной нет — 8787.
health_port() {
  systemctl show coop-field --property=Environment 2>/dev/null |
    tr ' ' '\n' | sed -n 's/^PORT=\([0-9][0-9]*\)$/\1/p' | tail -n 1
}
HEALTH_PORT="$(health_port)"
[ -n "$HEALTH_PORT" ] || HEALTH_PORT=8787

# Состояние, под которое перезапускались в прошлый раз: хэши всех файлов,
# влияющих на запуск. Сюда же входит сам apply.sh — его правка тоже повод
# перезапустить сервис.
state_sha() {
  {
    sha "$IN/server.js"
    sha "$IN/package.json"
    sha "$IN/package-lock.json"
    if [ -f "$IN/apply.sh" ]; then sha "$IN/apply.sh"; else echo no-apply; fi
  } | sha256sum | awk '{print $1}'
}

lock_changed=0
if [ ! -f "$APP/package-lock.json" ] || [ "$(sha "$IN/package-lock.json")" != "$(sha "$APP/package-lock.json")" ]; then
  lock_changed=1
fi

# Зависимости ставятся ДО записи новых файлов: при обрыве npm ci в каталоге
# приложения остаются прежние server.js и package*.json, следующий запуск
# повторит попытку с согласованного состояния.
node_modules_new=""
if [ "$lock_changed" -eq 1 ]; then
  tmp="$(mktemp -d)"
  cp "$IN/package.json" "$IN/package-lock.json" "$tmp/"
  (
    cd "$tmp"
    "$NPM" ci --omit=dev
  )
  node_modules_new="$tmp/node_modules"
fi

install -m 0644 "$IN/server.js" "$APP/server.js"
install -m 0644 "$IN/package.json" "$APP/package.json"
install -m 0644 "$IN/package-lock.json" "$APP/package-lock.json"

if [ -d "$IN/scripts" ]; then
  mkdir -p "$APP/scripts"
  cp -a "$IN/scripts/." "$APP/scripts/"
fi

if [ -n "$node_modules_new" ]; then
  rm -rf "$APP/node_modules"
  mv "$node_modules_new" "$APP/node_modules"
  rm -rf "${node_modules_new%/node_modules}"
  chown -R deploy:deploy "$APP/node_modules"
fi

chown deploy:deploy "$APP/server.js" "$APP/package.json" "$APP/package-lock.json"
if [ -d "$APP/scripts" ]; then
  chown -R deploy:deploy "$APP/scripts"
fi

want="$(state_sha)"
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$want" ]; then
  echo "сервер без изменений, перезапуск не нужен"
  exit 0
fi

sudo /usr/bin/systemctl restart coop-field

# Холодный старт под swap-давлением занимает >30 с (замер 2026-11-05: баннер
# слушания появился через 32 с после рестарта, прод жив и здоров). Окно
# health — до 2 минут, тик 2 с; прежних 20×0.3 с не хватало, и деплой
# краснел на вполне рабочем сервере.
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$HEALTH_PORT/health" >/tmp/coop-health.json; then
    ok=1
    break
  fi
  sleep 2
done

if [ "$ok" -ne 1 ]; then
  echo "проверка /health не прошла (порт $HEALTH_PORT)" >&2
  sudo /usr/bin/systemctl --no-pager status coop-field >&2 || true
  exit 1
fi

# Маркер пишем только после успешного health: неудачный рестарт
# на следующем деплое повторится сам.
printf '%s\n' "$want" > "$STAMP"

cat /tmp/coop-health.json
echo
