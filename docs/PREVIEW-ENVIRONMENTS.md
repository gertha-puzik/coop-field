# Preview-окружения для пул-реквестов

Простыми словами: у каждой ветки свой маленький сайт и своя комната, чтобы
пробовать игру **не на живой Элизии**. Адрес:

`https://<имя-ветки-буквами>.abnocw.miew.ru`

Прод (`abnocw` / `coop.89-232-184-77.sslip.io`) этот процесс **не трогает**.

## Что уже лежит в репозитории

- Нормализация имени: `scripts/preview-slug.mjs` (проверка `npm run test:preview-slug`)
- Скрипт на VPS: `deploy/vps/preview-apply.sh` — каталог `/opt/coop-field-preview/<slug>/`,
  свой порт, свои `data/`, случайный пароль редактора. Прод `/opt/coop-field` не копирует.
- systemd: `deploy/vps/coop-field-preview@.service`
- nginx-фрагмент: `deploy/vps/nginx-preview.conf`
- GitHub Actions: `.github/workflows/preview.yml`
  - открыли PR → создать (или обновить то же окружение)
  - новый коммит → пересобрать **из SHA коммита**
  - закрыли / смержили → снести
  - **форк не деплоим** (чужой код с правами на VPS не запускается)
  - один комментарий в PR, не спам; GitHub Deployment с URL

Пока нет секрета и DNS, джоба **зелёная** и пишет, чего не хватает.

## Что должна подтвердить Сырь (агент на VPS не заходит)

1. **DNS.** Wildcard `*.abnocw.miew.ru` → IP `89.232.184.77`.
   Проверка: `dig cursor-test.abnocw.miew.ru` должен показать тот же A, что у сайта.
2. **TLS.** Сертификат на `*.abnocw.miew.ru` (Let’s Encrypt DNS-01). Без него
   будет только http, браузер ругнётся.
3. **Секрет GitHub** `PREVIEW_SSH_KEY` — отдельный ключ пользователя `deploy`,
   не прод-секрет в чат. Лучше отдельный ключ, которому можно писать только
   `incoming-preview/` и `/opt/coop-field-preview/`.
4. **nginx один раз от root:** include фрагментов `preview-*.conf` или копировать
   шаблон `deploy/vps/nginx-preview.conf`, подставляя `__SLUG__` / `__PORT__` /
   `__ROOT__`. Пользователь `deploy` sudo на nginx не имеет — как с
   `nginx-www.conf`.
5. **systemd-юнит** `coop-field-preview@.service` в `/etc/systemd/system/`
   (скрипт копирует, если есть sudo).
6. **Каталоги:** `mkdir -p /opt/coop-field-preview && chown deploy:deploy ...`
7. **Не включать** в preview `ADMIN_PASS` прода и не копировать `data/` прода.

После этого новый PR сам получит ссылку в комментарии.

## Как устроено внутри

| | Прод | Preview |
| --- | --- | --- |
| Когда | push в `main` | PR своего репо |
| Фронт | Vercel + `/opt/coop-field/www` | `/opt/coop-field-preview/<slug>/www` |
| Комната | systemd `coop-field`, порт 8787 | `coop-field-preview@slug`, порт `41000 + PR%1000` |
| Данные | `data/` прода | пустой `.../preview/<slug>/data` |
| Сокет клиента | `wss://coop.89-…sslip.io` | `wss://<slug>.abnocw.miew.ru/ws` |

Сборка всегда с `github.event.pull_request.head.sha`, даже если ветку переименовали.

## Нормализация slug

`cursor/product-roadmap-and-platform-42e0` → `cursor-product-roadmap-and-platform-42e0`.
Только латиница, цифры, дефис, не длиннее 48 символов. Пустое → `pr`.

## Форки

Джоба смотрит `head.repo.full_name == github.repository`. Чужой форк не
получает SSH. Так и должно быть.

## Если preview нельзя проверить end-to-end

Это нормально, пока пункты 1–6 не подтверждены. В репо уже есть скрипты,
workflow, тест slug и документация. Живой URL появится после шагов Сырь.
