# Coop field — общее поле на canvas abnocw

Агентам (Cursor, z.ai и остальным): сначала [AGENTS.md](AGENTS.md). Там карта кода, контракт комнаты и как уезжает прод.

Фронт — симулятор из [abnocw](https://github.com/ggaymelini/abnocw) (canvas, спрайты, панель настроек).
Комната — тот же WebSocket, что и раньше: до 30 котов, ходьба WASD, сервер — авторитет клеток.
Если свободных клеток нет, сервер не ставит двоих в одну: приходит `noplace` и текст в `info`.
Ходьба WASD смотрит на физическую клавишу, поэтому на русской раскладке это те же клавиши (ц ф ы в).
Если браузер не сообщает код клавиши, срабатывает и сама буква.

Скин меняется сразу для всех в комнате: клиент шлёт `["sprite", { sprite }]`,
остальные получают `update cat` с новым `sprite` и той же клеткой.

Удар (клавиша I) по соседу уходит на сервер событием `strike` и возвращается всей комнате как `fight`
(кто, кого, часть, урон). Строка пишется в боевой лог и у бьющего, и у того, кого ударили.
Когти, зубы и нокаут по сети не синхронизируются. Локальные манекены остаются, только пока вы одни в комнате.

Чат комнаты — панель над полем. Enter ставит курсор в строку, Esc возвращает на поле.
Клиент шлёт `["chat", { text }]`, сервер отдаёт всем в комнате `["chat", { seq, id, login, color, text, ts }]`.
Новичок получает последние 40 строк событием `chatlog`. Пустое сообщение отбрасывается,
длиннее 200 символов обрезается, чаще чем раз в 450 мс — отказ.

## Локально

```bash
npm install
# терминал 1 — комната
npm start
# терминал 2 — Next UI
npm run dev
```

Откройте http://localhost:3000/?room=demo и ту же ссылку во второй вкладке.
Имя: `?name=Сырь`. Прод-сокет: `wss://coop.89-232-184-77.sslip.io`.

Проверка комнаты без браузера (сервер уже на 3780 или `WS_URL`):

```bash
npm run test:ws
```

## Деплой

Источник выкладки — GitHub-репозиторий [gertha-puzik/coop-field](https://github.com/gertha-puzik/coop-field), ветка `main`.
Пуш в `main` запускает GitHub Actions. Коммиты только в Cursor на Vercel и VPS сами не уезжают: их нужно отправить в этот GitHub-репозиторий.

| Workflow | Куда | Когда |
|----------|------|--------|
| «Фронтенд на Vercel и VPS» | проект Vercel `coop-field` (команда `polexka`) и каталог `/opt/coop-field/www` на `89.232.184.77` | изменения `src/`, `public/`, Next-конфига или зависимостей фронта |
| «Сервер комнаты на VPS» | `89.232.184.77`, `/opt/coop-field`, сервис `coop-field` | изменения `server.js`, `scripts/` или `deploy/vps/` |

Фронт — статический Next (`output: "export"`). Секрет репозитория `VERCEL_TOKEN`.
Тот же workflow собирает `out/` в Actions и заливает его пользователем `deploy` в `/opt/coop-field/www`. Next на VPS не ставится, сервис `coop-field` из-за этой заливки не перезапускается. `--delete` у фронта действует только внутри `www/`, у комнаты — только у `incoming/scripts/`.

Сайты: `https://coop-field.vercel.app` и `https://coop.89-232-184-77.sslip.io`. Прод-сокет: `wss://coop.89-232-184-77.sslip.io`. С хоста комнаты клиент сам берёт этот сокет, без `?ws=`.

Комнату Vercel не держит: Actions заходит по SSH пользователем `deploy` и вызывает `deploy/vps/apply.sh`.
Секрет `VPS_SSH_KEY` — приватный ключ этого пользователя. Если `server.js` и lockfile зависимостей не менялись, сервис не перезапускается.

### Один раз на VPS, от root

У `deploy` есть только `systemctl restart` и `status` сервиса `coop-field`. Nginx он не перечитывает. Пока фрагмент ниже не вставлен, `https://coop.89-232-184-77.sslip.io` по-прежнему отдаёт комната из своего `public/`, а новый каталог снаружи не виден.

```bash
sudo mkdir -p /opt/coop-field/www
sudo chown deploy:deploy /opt/coop-field/www
sudo chmod 755 /opt/coop-field /opt/coop-field/www
```

В уже существующий `server` nginx для `coop.89-232-184-77.sslip.io` вставить [`deploy/vps/nginx-www.conf`](deploy/vps/nginx-www.conf) вместо location, который проксирует весь HTTP на комнату. `listen` и сертификаты не менять. Сначала дождаться файла `/opt/coop-field/www/index.html` (push в `main` или ручной запуск workflow), затем:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

После этого корень сайта — статика из `www`, WebSocket на `/` и `/health` остаются на комнате `127.0.0.1:8787`.
