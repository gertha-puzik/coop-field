#!/bin/bash
# Один раз от root на том же VPS, что прод. Не трогает /opt/coop-field кроме чтения,
# не трогает юнит coop-field, не копирует data/ и ADMIN_PASS прода.
# Делает пользователя deploy-preview, каталоги, sudoers, nginx include, юнит, ключ SSH.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "нужен root" >&2
  exit 1
fi

USER_NAME="${PREVIEW_SSH_USER:-deploy-preview}"
ROOT="/opt/coop-field-preview"
PROD="/opt/coop-field"
IN_HOME="/home/$USER_NAME"
INCOMING="$IN_HOME/incoming-preview"
NGINX_D="/etc/nginx/preview.d"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "=== инвентарь до правок (имена, без секретов) ==="
echo "-- nginx sites --"
ls -1 /etc/nginx/sites-enabled 2>/dev/null || true
echo "-- systemd coop* --"
systemctl list-units --type=service --all 'coop*' --no-legend 2>/dev/null || true
echo "-- listeners --"
ss -lntp 2>/dev/null | awk 'NR==1 || /:(80|443|8787|3780|410)/' || netstat -lntp 2>/dev/null | head
echo "-- letsencrypt live names --"
ls -1 /etc/letsencrypt/live 2>/dev/null || echo "(нет /etc/letsencrypt/live)"
echo "-- certbot dns plugins / ini names --"
ls /etc/letsencrypt 2>/dev/null | head
find /root /home -maxdepth 3 -iname '*cloudflare*' -o -iname '*dns*ini' 2>/dev/null | grep -v proc | head || true
echo "-- other www roots (paths only) --"
grep -R --include='*.conf' -h '^\s*root ' /etc/nginx 2>/dev/null | sort -u | head
echo "=== конец инвентаря ==="

id "$USER_NAME" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$USER_NAME"
# Группу deploy юзеру НЕ даём: авто-вливание в неё (usermod -aG deploy)
# открывало preview-пользователю запись в файлы прода при g+w — риск из
# security-обзора; экономия прав не нужна, каталог preview свой.

mkdir -p "$ROOT" "$INCOMING" "$NGINX_D" "$IN_HOME/.ssh"
chown -R "$USER_NAME:$USER_NAME" "$ROOT" "$INCOMING" "$NGINX_D" "$IN_HOME/.ssh"
chmod 755 "$ROOT" "$NGINX_D"
chmod 700 "$IN_HOME/.ssh"

KEY="$IN_HOME/.ssh/coop-field-preview"
AUTH="$IN_HOME/.ssh/authorized_keys"
# Если ключ уже лежит в authorized_keys (Cursor/GitHub PREVIEW_SSH_KEY),
# новый не создаём — иначе секрет в чате и в Actions перестанет совпадать.
if [ -s "$AUTH" ]; then
  echo "authorized_keys уже есть — новый ключ не создаём, PREVIEW_SSH_KEY не меняйте."
elif [ ! -f "$KEY" ]; then
  sudo -u "$USER_NAME" ssh-keygen -t ed25519 -f "$KEY" -C "coop-field-preview-github" -N ""
fi
PUB="$KEY.pub"
if [ -f "$PUB" ]; then
  touch "$AUTH"
  grep -qxF "$(cat "$PUB")" "$AUTH" || cat "$PUB" >> "$AUTH"
  chown "$USER_NAME:$USER_NAME" "$AUTH"
  chmod 600 "$AUTH"
fi

# Единственное место, где юнит попадает в /etc/systemd/system: bootstrap от
# root. deploy-конвейер (preview-apply.sh от deploy-preview) юнит не ставит.
if [ -f "$HERE/coop-field-preview@.service" ]; then
  cp "$HERE/coop-field-preview@.service" /etc/systemd/system/coop-field-preview@.service
  systemctl daemon-reload
fi

SUDOERS_SRC="$HERE/sudoers-coop-field-preview"
SUDOERS_DST="/etc/sudoers.d/coop-field-preview"
if [ -f "$SUDOERS_SRC" ]; then
  TMP="$(mktemp)"
  cp "$SUDOERS_SRC" "$TMP"
  if visudo -cf "$TMP"; then
    cp "$TMP" "$SUDOERS_DST"
    chmod 0440 "$SUDOERS_DST"
  else
    echo "sudoers не прошёл visudo -cf — не ставили" >&2
    rm -f "$TMP"
    exit 1
  fi
  rm -f "$TMP"
fi

KEEP="$NGINX_D/zz-keep.conf"
if [ ! -f "$KEEP" ]; then
  printf '# keep glob non-empty\n' > "$KEEP"
fi
INCLUDE_DST="/etc/nginx/sites-enabled/coop-field-previews.conf"
if [ -f "$HERE/nginx-preview-include.conf" ]; then
  cp "$HERE/nginx-preview-include.conf" "$INCLUDE_DST"
fi

echo "-- nginx -t before reload --"
if nginx -t; then
  systemctl reload nginx
  echo "nginx reload ok"
else
  echo "nginx -t упал — reload НЕ делали, include откатываем" >&2
  rm -f "$INCLUDE_DST"
  exit 1
fi

# Прод-юнит не трогаем. Только статус.
echo "-- прод coop-field (только статус) --"
systemctl is-active coop-field || true

echo
echo "bootstrap готов."
if [ -s "$AUTH" ]; then
  echo "Публичные ключи deploy-preview (можно в чат):"
  awk '{print $1, $2, $3}' "$AUTH"
fi
if [ -f "$KEY" ]; then
  echo "Приватный файл на сервере: $KEY"
  echo "Если PREVIEW_SSH_KEY в Cursor/GitHub уже задан и authorized_keys совпадает — не перезаписывайте секрет."
else
  echo "Приватный ключ на сервере не создавали: вход идёт ключом из Secrets."
fi
echo
echo "TLS /etc/letsencrypt/live/abnocw.phainonsmilk.ru:"
WILD_PEM="/etc/letsencrypt/live/abnocw.phainonsmilk.ru/fullchain.pem"
if [ -f "$WILD_PEM" ] && openssl x509 -in "$WILD_PEM" -noout -ext subjectAltName 2>/dev/null | grep -q 'DNS:\*\.abnocw\.phainonsmilk\.ru'; then
  echo "  wildcard SAN есть — preview-apply повесит :443"
else
  echo "  wildcard SAN нет (апекс abnocw.phainonsmilk.ru на поддомен не ставим)."
  echo "  preview слушает :80, пока не будет DNS-01 на *.abnocw.phainonsmilk.ru"
fi
