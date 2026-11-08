# Preview-окружения для пул-реквестов (dual-host)

Простыми словами: у каждой ветки — свой маленький двойной сайт и своя комната,
чтобы пробовать игру **не на живой Элизии**. С фазы P5 у PR ДВА адреса (один
инстанс комнаты, один порт, два веб-корня):

```text
https://pr-<номер PR>.abnocw.miew.ru   — «Пивные гроты», публичный билд (www-grotto)
https://pr-<номер PR>.elisium.miew.ru  — Элизия, вход по регистрации (www-elyria)
```

Например для PR #45: `https://pr-45.abnocw.miew.ru` и
`https://pr-45.elisium.miew.ru`. Каталог, systemd-юнит имена сайтов —
`pr-<номер PR>`: не меняется от пуша к пушу, короткий (длинный slug ветки
ломал nginx `server_names_hash_bucket_size: 64`). Ранний вариант имени из
8 hex SHA отменён 2026-11-07 — URL менялся с каждым коммитом.

Комната: `wss://<тот-же-хост>/ws` на каждом из двух сайтов (браузер сам
повышает `ws://` до `wss://` на https-страницах). Оба хоста проксируются в
ОДИН node-инстанс PR (один порт `41000 + PR%1000`): что разрешено на каждом
хосте, решает сервер по env `PUBLIC_HOSTS` (гроты) и `ELYRIA_HOSTS`
(Элизия) — это его доменная политика, nginx маршруты обоих блоков
одинаковые.

Сертификат per-host: первые минуты после деплоя оба хоста могут отвечать по
чистому http — до `~5 минут`, пока корневой cron на VPS не выпустит
сертификат. В первом прогоне elisium-хост открывается по
`http://pr-N.elisium.miew.ru` — и это ожидаемое состояние, а не поломка:
статусы в комментарии PR мы пишем честно, по одной строке на каждый хост.

## Решение владелицы (2026-11-06)

Preview живёт **на том же VPS, что прод** (`89.232.184.77`). Изоляция —
каталог, пользователь, порт и данные. Прод-пайплайн и URL **не меняем**.

| | Прод | Preview |
| --- | --- | --- |
| Когда | push в `main` | PR своего репо |
| SSH | `deploy` + `VPS_SSH_KEY` | **`deploy-preview`** + `PREVIEW_SSH_KEY` |
| Каталог | `/opt/coop-field` | `/opt/coop-field-preview/pr-<N>/` |
| Юнит | `coop-field` | `coop-field-preview@pr-<N>` (один на PR) |
| Сайты | `abnocw.miew.ru`, `elisium.miew.ru` | `pr-<N>.abnocw.miew.ru` (www-grotto), `pr-<N>.elisium.miew.ru` (www-elyria) |
| Порт | 8787 | `41000 + PR%1000` (один на оба сайта) |
| Данные | `data/` прода | пустой `…/<slug>/data` |
| nginx | vhost sslip.io / апексы | `/etc/nginx/preview.d/preview-<slug>.conf` — ОДИН файл с ДВУМЯ server-блоками |
| Секреты | `ADMIN_PASS` юнита прода | случайный пароль, **не** копия прода |

Лимит: **не больше 8** живых preview (счёт по каталогам; один PR = один
каталог, хоть у него и два сайта). Девятый PR получит отказ, пока не закроют
старый.

## Артефакт сборки: two-state — dual или legacy-single

`preview-build.yml` собирает из head-SHA PR тот формат, который ветка
честно может дать (детект — `scripts/preview-build-lib.mjs` по
`package.json` чекаута, не по ветке):

- **dual** (есть `scripts.build:variants`): оба варианта фронтенда, корни
  ровно в `www-grotto/` и `www-elyria/`, с обрезкой чужих маршрутов;
- **legacy-single** (скрипта нет — main-линейные и инфра-PR): одна сборка
  `npm run build` (статик-экспорт `out/`) кладётся в единый корень `www/`.
  Это честный одно-сайтовый превью-артефакт: деплой поднимает ОДИН хост
  `pr-<N>.abnocw.miew.ru`, второй сайт не заявляется и не верифицируется
  (пометка «dual-host появится после мерджа продуктового PR»), это не
  `partial-failure`.

```text
preview-dist/                # dual-форма:
  server.js
  server/            # общий код комнаты — ОДИН инстанс на PR
  scripts/
  package.json
  package-lock.json
  www-grotto/        # публичный билд
    index.html
  www-elyria/        # билд Элизии
    index.html
  preview-sha        # head-SHA, гейт деплоя (там же и в legacy)
  metadata.json      # { mode: dual | legacy-single, sha, branch, pr } — режим ЯВНЫЙ
```

В legacy-форме вместо `www-grotto/`+`www-elyria/` — корень `www/`.
Оба `index.html` dual-формы проверяются как обязательные: сборка без
любого из корней — провалена, выкладки не будет; в legacy обязателен
`www/index.html`. Свежая упаковка без `metadata.json` не проходит
`pack-check` (режим обязан быть явным), а деплой, получив артефакт старого
формата без меты, честно выводит режим по корневым каталогам — молчаливых
угадываний нет. Недоверие `npm exit 0` не практикуется: валидации в либе.

## Два workflow и секреты (после security-фикса PR #41)

Раньше один `.github/workflows/preview.yml` на `pull_request` и собирал
PR, и ходил на VPS с секретом `PREVIEW_SSH_KEY`. Это была дыра: автор ветки
может править workflow-файл в своём PR (GitHub исполняет его из merge-рефа
PR) и вывести секрет в лог. Теперь конвейер разрезан надвое:

- **`preview-build.yml`** — событие `pull_request opened/synchronize/
  reopened/closed`. Секретов НЕ видит вообще (ни `PREVIEW_SSH_KEY`, ни
  чего-либо ещё из Secrets). Чекаутит head-SHA PR, собирает оба варианта
  (`npm run build:variants`), гоняет preview-гейты (`test:preview-slug`,
  `test:preview-apply`, `test:preview-pr-link`, `test:write-openssh-key`) и
  пакует артефакт `preview-dist` с двумя корнями. Если сборка упала —
  оставляет один комментарий о провале со ссылкой на лог (без секретов).
  На `closed` ничего не собирает (быстрый пустой ранн).
- **`preview-deploy.yml`** — события: `workflow_run` (завершился
  `Preview PR (build)`) и `pull_request: [closed]` (снос после merge/close —
  после закрытия PR новых сборок нет, workflow_run уже не придёт). Файл живёт
  **на `main`**: для `workflow_run` GitHub исполняет его всегда из
  дефолт-ветки, PR его не подменяет; для `closed` джоба берёт номер/SHA прямо
  из события. Секрет `PREVIEW_SSH_KEY` доступен ТОЛЬКО этой джобе. Она
  выкачивает артефакт того ранна сборки, считает оба хоста из номера PR
  (`preview-slug.mjs`: `site-host` + `site-host-elyria`, один слаг и один
  порт), заливает оба корня на VPS и запускает apply.

Правила доверия в deploy-джобе:

- деплой-скрипты (`deploy/vps/preview-apply.sh`, юнит, sudoers,
  nginx-фрагменты) и утилиты (`preview-slug.mjs`, `preview-pr-link.mjs`,
  `write-openssh-key.sh`) чекаутятся **из `main`** — автор PR их не меняет
  до мерджа;
- из артефакта PR на VPS едет только код комнаты/статика/пакеты — их код и
  раньше работал на VPS под пользователем `deploy-preview` в своём
  каталоге; прод и root для него недостижимы;
- номер и состояние PR берутся из GitHub API по SHA, а не из данных PR;
- **форки не деплоятся**: у build-джобы guard `head.repo.full_name`, у
  deploy — `workflow_run.head_repository.full_name`;
- юнит и sudoers ставит **только `preview-bootstrap.sh` от root**:
  `preview-apply.sh` юниты не копирует и `daemon-reload` не зовёт —
  раньше это позволяло PR положить в `/etc/systemd/system` юнит с
  `User=root` (второй блокер обзора, вместе с утечкой секрета).

Комментарий со ссылками, Deployment и шапка PR обновляются как раньше: один
маркер-комментарий `<!-- coop-field-preview -->` на PR (со статусами
**отдельными строками на каждый хост** — статусы у двух сайтов одинаковые,
один apply покрывает оба) и блок в описании между
`<!-- coop-field-preview-link -->` маркерами, с ОБЕИМИ ссылками.

## Само-deploy ограничение: не волнуйтесь, если видите одну ссылку

Изменения **привилегированных** частей конвейера (`preview-deploy.yml`,
сколько хостов считать; `preview-apply.sh` с двумя блоками; артефакт с двумя
корнями) активируются **только после мерджа в `main`**: build-джоба PR
исполняет `preview-build.yml` из самого PR, но деплой всегда идёт по
workflow-файлу и скриптам из `main`. Поэтому продуктовый PR, который сам
вносит dual-host, на **первом** прогоне может получить preview по старой
односайтовой схеме или без второй ссылки — это норма, а не поломка. После
мерджа инфраструктурных правок в `main` (`build:variants` + dual-host apply)
следующий пуш того же PR выложит оба сайта; lag не требует ручных действий.

## nginx: один фрагмент, два server-блока

`preview-apply.sh` пишет на каждый PR ОДИН файл `/etc/nginx/preview.d/
preview-<slug>.conf` с ДВУМЯ server-блоками:

| server_name | root | смысл |
| --- | --- | --- |
| `pr-N.abnocw.miew.ru` | `…/pr-N/www-grotto` | публичные гроты |
| `pr-N.elisium.miew.ru` | `…/pr-N/www-elyria` | Элизия |

У каждого блока одинаковый полный набор локаций: `try_files`,
immutable-статика `/_next/static/`, проксирование `/health /auth /cfg
/profiles /admin /ws` на `127.0.0.1:41000+PR%1000` (для `/ws` — Upgrade- и
Connection-заголовки, read timeout 3600), и у каждого — своя
ACME-challenge-локация на СВОЁМ root (важно: webroot для certbot обязан
совпадать с root конкретного server_name, иначе challenge не отдается).
`nginx -t` перед reload, с бэкапом и откатом. Сервер (не nginx) различает
хосты по env `PUBLIC_HOSTS` / `ELYRIA_HOSTS` и по заголовку Host.

Trusted proxy и клиентский IP (§6): бэкенд доверяет `X-Forwarded-For`
ТОЛЬКО когда TCP-сокет пришёл с loopback (реверс-прокси на той же машине,
`server/auth.js`), и берёт ПОСЛЕДНЮЮ запись — nginx обязан
**перезаписывать** заголовок, а не сохранять клиентский, поэтому каждый
проксируемый vhost (прод и превью) обязан отправлять:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Без этого (или при слепом preserve) auth rate-лимиты видят loopback и
выключены — фрагменты `preview-apply.sh` (/auth, /cfg, /profiles, /admin,
/ws) и прод-блоки nginx уже это делают; новые локации обязаны продолжать.


Origin сокета: `preview-apply.sh` держит в env юнита
`ALLOWED_ORIGINS=http://<гроты>,https://<гроты>,http://<элизия>,https://<элизия>`
(все четыре значения) и обновляет на каждый apply: сервер
(`server/config.js`) пускает `ws://` только с этих Origin. Плюс тот же env
несёт `PUBLIC_HOSTS=<abnocw-хост>` и `ELYRIA_HOSTS=<elisium-хост>` —
серверная Host-политика (какие комнаты и API открыты каждому хосту).

## Снос после merge/close

Merge и закрытие — одно событие `pull_request: closed` (в deploy-workflow это
отдельный триггер рядом с `workflow_run`: после закрытия PR новых сборок нет,
`workflow_run` больше не придёт). Для закрытых PR артефакт не собирается
(build-джоба на `closed` пустая и секретов не видит). Deploy-джоба из события
берёт номер PR и SHA напрямую и вызывает `PREVIEW_ACTION=destroy`. Скрипт:

- останавливает **только** `coop-field-preview@<этот-slug>`;
- удаляет **только** `/opt/coop-field-preview/<slug>/` (оба корня и data);
- удаляет **только** nginx-фрагмент этого slug (оба server-блока), затем
  `nginx -t` и reload (если `-t` падает — фрагмент возвращает, reload нет);
- не трогает другие slug, юнит `coop-field`, `/opt/coop-field`, порты
  80/443/8787.

Чужой slug (`../`, слэш, имя юнита прода) скрипт отвергает до любых `rm`.

## Честные статусы деплоя и пост-верификация (без ssh изнутри apply)

Правило (B4): **live ≠ «rsync прошёл»**. `preview-apply.sh` после выкладки
сам (на VPS, локальными `dig`/`curl` к публичным именам, никакого ssh)
проверяет каждый хост и печатает `PREVIEW-RESULT`-строки; workflow читает
их и публикует точный статус. `live` ставится только после независимой
верификации ОБЕИХ хостов.

Проверки на host (дважды: `pr-N.abnocw.miew.ru` → корень `www-grotto`,
`pr-N.elisium.miew.ru` → корень `www-elyria`):

1. DNS: имя резолвится (fallback-цепочка dig→nslookup→getent);
2. HTTP→HTTPS редирект (80 жив, 301 на https-имя);
3. TLS: https-корень отвечает 200 и тело байт-в-байт равно локальному
   `index.html` этого хоста (не соседа!) — иначе `index-mismatch`;
4. `/health`: JSON `{ok,rooms,maxPlayers}` c `ok:true`;
5. дифференциация: `www-grotto`… гроты: `/profiles` обязан быть 404
   (публичный хост), Элизия: `/profiles` 200 `ok`. Утечка наружу —
   `profiles-leak-200`, пропавшая дифференциация у Элизии — `profiles-404`;
6. `site.marker` (если билд положил): байты совпадают с вариантом хоста —
   иначе `marker-mismatch`;
7. WS-проба: upgrade-рука `GET /ws` с заголовками RFC 6455
   (`Upgrade: websocket`, `Connection: Upgrade`, случайный base64-16 байт
   `Sec-WebSocket-Key`, `Version: 13`, `Origin` хоста) — точка сокета
   обязана ответить; молчание сети (000: conn refused / TLS-fail) — причина
   `ws-000`, `live` без живой WS-точки не ставится (голого health-HTTP
   недостаточно);
8. функциональный смоук (только честный dual): гроты — `/auth/me` обязан
   быть 401/403/404/429 (200 = течь API Элизии, причина
   `elyria-api-leak-<code>`); Элизия — `POST /auth/register` и
   `POST /auth/login` пустым телом отвечают 400/401/403/429 (не 404),
   `POST /cfg` не-админу 403 (200 = админка открыта, `cfg-admin-open`);
9. SHA: `preview-sha` в артефакте (штампит `preview-build.yml`) против
   head PR (`PREVIEW_TRUSTED_SHA` в deploy-запросе): расхождение —
   `sha-stale`; артефакт старой сборки apply не выкладывает вовсе.

Bounded polling: `PREVIEW_VERIFY_TRIES=4` × `PREVIEW_VERIFY_SLEEP=15`
(деплой-вызов) — конечные попытки с пересчётом причин в каждой, а не
слепой sleep до успеха. После последней попытки — статус с последними
причинами.

Статусы (overall / per-host) и их exit-коды:

| overall | grotto/elyria | exit | смысл |
| --- | --- | --- | --- |
| `live` | `ok` | 0 | оба хоста прошли ВСЕ проверки |
| `needs-dns` | `needs-dns` | 6 | оба имени не резолвятся (wildcard-DNS) |
| `needs-tls` | `needs-tls` | 5 | выложено, http жив, серты от root-cron ещё не готовы (~5 мин) |
| `partial-failure` | `ok`/`broken`/`needs-tls`/`needs-dns` | 3 | один сайт честно жив/мёртв, другой нет |
| `failed` | `broken`/`…` | 4 | оба не прошли или SHA-стейл |
| `unverified` | — | 0 | только dry-прогон с `PREVIEW_VERIFY=0` (тесты), в деплое не используется |
| `needs-bootstrap` | — | 0 | нет `/opt/coop-field-preview` (ставит root один раз) |
| `destroyed` | — | 0 | снос закрытого PR, идемпотентный, только свой slug |
| `needs-secret` | — | 0 | не задан `PREVIEW_SSH_KEY` |

`building`/`deploying` — это прогресс GitHub Actions run'а (run идёт),
они не публикуются как результат. PR-комментарий (маркер
`<!-- coop-field-preview -->`, ОДИН на PR, обновляется): оба адреса,
реальный статус каждого хоста, SHA, `verified_at` (время последней
верификации), причина (`reasons=...`) если отказ. Спекулятивные ссылки
до `live`/`needs-tls` не публикуются.

### Почему упал run 42414900091 (PR #49, старый деплой из main)

`preview-deploy.yml` в **main** (односайтовая эпоха) ждал артефакт с
каталогом `preview-dist/www/` и делал `rsync ... $SSH_HOST:incoming-preview/$SLUG/www/`.
Продуктовая ветка PR #49 собрала артефакт нового формата
(`www-grotto/` + `www-elyria/`), каталога `www/` в нём нет — rsync
завершился с `exit code 23` (partial transfer: исходные файлы пропали
во время передачи). Дословно из `gh run view 42414900091 --log-failed`,
шаг «Выкладка или снос preview»:

```
rsync: [sender] change_dir "/home/runner/work/coop-field/coop-field/preview-dist/www" failed: No such file or directory (2)
rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1356) [sender=3.2.7]
##[error]Process completed with exit code 23.
```

Это не баг кода, а рассинхрон эпох: деплой-скрипт main'а не знал о
dual-root-артефакте. После мерджа ЭТОГО инфра-PR в main и наката его на
продуктовые PR (следующий push) format артефакта и деплоя согласованы;
кейс задокументирован как ожидаемая расплата за
«привилегированный код всегда только из main».

С 2026-11-08 конвейер two-state закрывает этот класс рассинхронов
навсегда: сборка пакует в артефакт ЯВНЫЙ `metadata.json {mode, sha}`,
деплой (всегда из main) распознаёт ОБА формата — по метаданным, а у
артефактов старой эпохи без меты честно по корневым каталогам
(`www-grotto+www-elyria` → dual, `www/` → legacy-single). Порядок мерджа
продуктового и инфраструктурного PR теперь безопасен в любой
комбинации: любой PR из любой эпохи деплоится тем реестром правил,
который в момент деплоя жив на main.

## Что уже сделано (2026-11-07, Europe/Samara)

Ключ `PREVIEW_SSH_KEY` работает (Cursor и GitHub Actions). Bootstrap на VPS
выполнен. Каталог `/opt/coop-field-preview/pr-<N>/`, юнит
`coop-field-preview@pr-<N>`. DNS: wildcard `*.abnocw.miew.ru` и
`*.elisium.miew.ru` оба смотрят на `89.232.184.77` — видевших записей
владельца не требуется. Прод и `root` этим ключом не открываются.
Однострочный PEM собирает `scripts/write-openssh-key.sh`.

Публичный ключ на сервере:

`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP3lCRPoSMCGUI+QwAH/QXRseJaEtmjQTnBReETsztsA coop-field-preview`

## Один шаг Сырь (нужен root)

На VPS **от root**, без клона:

```bash
sudo bash /home/deploy-preview/incoming-preview/preview-bootstrap.sh
```

Скрипт: каталоги, узкий sudoers (только preview-юнит и `nginx -t`/`reload`),
include nginx, шаблон юнита. Новый SSH-ключ **не создаёт**, если
`authorized_keys` уже есть — текущий `PREVIEW_SSH_KEY` не перезаписывать.

Bootstrap **уже выполнен** (2026-11-07). Следующий push после мерджа
инфраструктуры dual-host в `main` выложит ОБА сайта
(`https://pr-<номер>.abnocw.miew.ru` + `https://pr-<номер>.elisium.miew.ru`,
порт `41000+PR%1000`). Форки не деплоим. Сборка из SHA коммита.

## TLS: per-host HTTP-01 по обоим суффиксам (без DNS-API)

Wildcard нельзя выпустить без ключа к DNS-зоне, поэтому у каждого preview-
хоста свой сертификат, автоматически, по обоим доменам:

- `/etc/cron.d/coop-preview-cert` (каждые 5 минут, root) гоняет
  `/usr/local/sbin/coop-preview-cert` (= `deploy/vps/preview-cert-scan.sh`):
  читает ВСЕ `server_name` из nginx-фрагментов PR, и для каждого хоста
  выбирает webroot ПО СУФФИКСУ: `abnocw` → `<app>/www-grotto`,
  `elisium` → `<app>/www-elyria` (webroot = root соответствующего
  server-блока), затем `certbot certonly --webroot`; ACME-файл ложится в
  тот корень, с которого этот server_name отвечает.
- Renew — штатный `certbot.timer` (webroot и deploy-hook сохранены в
  renewal-conf линии). Сироты (PR закрыт, фрагмент снесён) — та же cron-джоба
  подчищает по ОБОИМ суффиксам: `certbot delete` + зеркало.
- Certbot-хук `/usr/local/sbin/coop-preview-tls-sync` (= `deploy/vps/preview-tls-sync.sh`)
  зеркалит пару в `/opt/coop-field-preview/tls/<host>/` (live/letsencrypt
  читает только root, а `preview-apply.sh` проверяет SAN от
  deploy-preview), добавляет 443 + http→https в server-блок ЭТОГО хоста
  (idempotent, с откатом по `nginx -t`) и перезагружает nginx. Следующий
  apply уже сам пишет ssl: зеркало-то существует.
- Первый apply нового PR бывает на http: фрагмент написан до выпуска
  сертификатов. Через ≤5 минут cron выдаёт серты обоим хостам, хук поднимает
  443 у каждого; но до следующего re-apply (следующий push в PR) ssl-строки
  пишет сам apply.
- Существующие сертификаты sslip.io и апексов скрипт не трогает.

Не копировать в preview `ADMIN_PASS` и `data/` прода.

## Форки и приватный репозиторий

Оба guard'а: у build-джобы `head.repo.full_name == github.repository`, у
deploy-джобы `workflow_run.head_repository.full_name == github.repository`.
На приватном репо форков практически нет, но belt-and-suspenders остаются.
Секреты из PR-триггернутых джоб больше недоступны ВООБЩЕ (их видит только
`preview-deploy.yml`, который PR не модифицирует, потому что исполняется с
`main`). Кнопка Private: Settings → General → Danger Zone → Change
repository visibility → Private.
