#!/bin/bash
# Пишет OpenSSH private key в $1.
# Секреты Cursor/GitHub часто склеивают PEM в одну строку (переносы → пробелы
# или литералы \n). ssh отказывается от такого файла («error in libcrypto»).
# Многострочный PEM оставляем как есть. Ключ не печатаем и не кладём в argv.
set -euo pipefail

dest="${1:?нужен путь к файлу ключа}"
if [ -n "${SSH_KEY-}" ]; then
  export WRITE_OPENSSH_RAW="$SSH_KEY"
else
  export WRITE_OPENSSH_RAW
  WRITE_OPENSSH_RAW="$(cat)"
fi

python3 - "$dest" <<'PY'
import os, pathlib, sys, textwrap
dest = sys.argv[1]
raw = os.environ.get("WRITE_OPENSSH_RAW") or ""
raw = raw.replace("\\n", "\n").replace("\r", "").strip()
begin = "-----BEGIN OPENSSH PRIVATE KEY-----"
end = "-----END OPENSSH PRIVATE KEY-----"
if not raw.startswith(begin) or not raw.endswith(end):
    sys.stderr.write("ключ не OPENSSH PRIVATE KEY\n")
    sys.exit(1)
body = raw[len(begin):-len(end)]
b64 = "".join(body.split())
if not b64:
    sys.stderr.write("пустое тело ключа\n")
    sys.exit(1)
pem = begin + "\n" + "\n".join(textwrap.wrap(b64, 70)) + "\n" + end + "\n"
path = pathlib.Path(dest)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(pem)
path.chmod(0o600)
PY
unset WRITE_OPENSSH_RAW
