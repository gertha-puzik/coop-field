# Preview-окружения для пул-реквестов

Простыми словами: у каждой ветки свой маленький сайт и своя комната, чтобы
пробовать игру **не на живой Элизии**. Адрес:

`https://<имя-ветки-буквами>.abnocw.miew.ru`

## Решение владелицы (2026-11-06)

Preview живёт **на том же VPS, что прод** (`89.232.184.77`), не на отдельном
хосте. Изоляция — каталог, порт и данные:

| | Прод | Preview |
| --- | --- | --- |
| Когда | push в `main` | PR своего репо |
| Каталог | `/opt/coop-field` | `/opt/coop-field-preview/<slug>/` |
| Фронт | Vercel + `/opt/coop-field/www` | `/opt/coop-field-preview/<slug>/www` |
| Комната | systemd `coop-field`, порт 8787 | `coop-field-preview@slug`, порт `41000 + PR%1000` |
| Данные | `data/` прода | пустой `/opt/coop-field-preview/<slug>/data` |
| Сокет клиента | `wss://coop.89-…sslip.io` | `wss://<slug>.abnocw.miew.ru/ws` |
| Секреты | `ADMIN_PASS` юнита прода | случайный пароль редактора, **не** копия прода |

Прод-пайплайн (`deploy-frontend.yml`, `deploy-backend.yml`, URL
`abnocw` / `coop.…sslip.io`) **не меняем**. Агент на VPS не заходит.

## Что уже сделано

- В репо: slug (`scripts/preview-slug.mjs`, `npm run test:preview-slug`),
  `deploy/vps/preview-apply.sh`, юнит `coop-field-preview@.service`,
  фрагмент nginx, workflow `.github/workflows/preview.yml`.
- Сборка из **SHA коммита** PR, не из имени ветки.
- Открыли PR → создать или обновить то же окружение; закрыли / смержили →
  снести. Форк не деплоим. Один комментарий в PR, GitHub Deployment с URL.
- **DNS.** Wildcard `*.abnocw.miew.ru` указывает на `89.232.184.77`
  (проверено 2026-11-06: `cursor-test.abnocw.miew.ru` и `foo.abnocw.miew.ru`
  отдают тот же A, что прод). Запрос `*.abnocw…` целиком спрашивать не нужно —
  спрашивайте конкретное имя.

Пока нет секрета `PREVIEW_SSH_KEY`, джоба **зелёная** и пишет, чего не хватает
(DNS больше не в этом списке).

## Что осталось Сырь (один раз, от root / GitHub)

Агент эти команды **не выполняет**. Копировать на сервер самой.

1. **Каталоги**

```bash
sudo mkdir -p /opt/coop-field-preview /home/deploy/incoming-preview
sudo chown deploy:deploy /opt/coop-field-preview /home/deploy/incoming-preview
```

2. **sudoers для `deploy`.** `preview-apply.sh` вызывает `sudo systemctl` для
   `coop-field-preview@*` и копирует юнит — как прод уже делает `restart coop-field`.
   Нужны те же узкие правила на эти команды (не на nginx). Юнит из репо:

```bash
sudo cp /home/deploy/incoming-preview/coop-field-preview@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

3. **TLS на `*.abnocw.miew.ru`.** Сейчас `:443` отвечает сертификатом
   `abnocw.89-232-184-77.sslip.io`, а неизвестный Host уходит 301 на sslip.io.
   Нужен свой сертификат (Let’s Encrypt **DNS-01**, HTTP-01 для wildcard
   не подойдёт), затем прописать его в nginx-фрагменте preview.

```bash
sudo certbot certonly --manual --preferred-challenges dns \
  -d '*.abnocw.miew.ru' -d abnocw.miew.ru
```

4. **nginx от root.** Пользователь `deploy` sudo на nginx не имеет (как с
   `nginx-www.conf`). Включить шаблон `deploy/vps/nginx-preview.conf`
   (подстановка `__SLUG__` / `__PORT__` / `__ROOT__`) так, чтобы
   `*.abnocw.miew.ru` не падал в дефолтный vhost. После правки:
   `sudo nginx -t && sudo systemctl reload nginx`.

5. **Секрет GitHub** `PREVIEW_SSH_KEY`: Settings → Secrets and variables →
   Actions → New repository secret. Имя ровно `PREVIEW_SSH_KEY`. Значение —
   приватный ключ `deploy`, лучше отдельный, с записью только в
   `incoming-preview/` и `/opt/coop-field-preview/`. Прод-ключ `VPS_SSH_KEY`
   в чат и в этот секрет не копировать, если можно выпустить узкий.

6. **Не копировать** в preview `ADMIN_PASS` и `data/` прода.

После пунктов 1–5 новый коммит в PR сам получит ссылку в комментарии.

## Нормализация slug

`cursor/product-roadmap-and-platform-42e0` → `cursor-product-roadmap-and-platform-42e0`.
Только латиница, цифры, дефис, не длиннее 48 символов. Пустое → `pr`.

## Форки и приватный репозиторий

Владелица решила закрыть `gertha-puzik/coop-field`. Агент visibility не
переключает. Кнопка: GitHub → репозиторий → **Settings → General →
Danger Zone → Change repository visibility → Private**.

После этого Vercel и GitHub Actions продолжат работать, если у аккаунта
есть доступ; публичные клоны перестанут; форки снаружи и так не деплоим.

Джоба смотрит `head.repo.full_name == github.repository`. Чужой форк SSH
не получает. На приватном репо то же условие: секреты есть только у PR
из этого репозитория; `GITHUB_TOKEN` с `pull-requests: write` и
`deployments: write` пишет один комментарий и Deployment.

## Если preview ещё не открывается в браузере

Это ожидаемо, пока нет TLS, `PREVIEW_SSH_KEY` и nginx-vhost. DNS уже
смотрит на VPS. Код и workflow в репо готовы.
