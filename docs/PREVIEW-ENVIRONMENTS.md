# Preview-окружения для пул-реквестов

Простыми словами: у каждой ветки свой маленький сайт и своя комната, чтобы
пробовать игру **не на живой Элизии**. Адрес:

`https://pr-<номер PR>.abnocw.miew.ru`

Например `https://pr-41.abnocw.miew.ru`. Каталог, systemd и имя сайта — `pr-<номер PR>`:
не меняется от пуша к пушу, короткий (длинный slug ветки ломал nginx
`server_names_hash_bucket_size: 64`). Ранний вариант имени из 8 hex SHA
отменён 2026-11-07 — URL менялся с каждым коммитом.

Комната: `wss://<тот-же-хост>/ws` (браузер сам повышает `ws://` до `wss://`
на https-страницах). Сертификат per-host: первые минуты после деплоя может
отвечать http — до `~5 минут`, пока корневой cron на VPS выпустит сертификат.

## Решение владелицы (2026-11-06)

Preview живёт **на том же VPS, что прод** (`89.232.184.77`). Изоляция —
каталог, пользователь, порт и данные. Прод-пайплайн и URL **не меняем**.

| | Прод | Preview |
| --- | --- | --- |
| Когда | push в `main` | PR своего репо |
| SSH | `deploy` + `VPS_SSH_KEY` | **`deploy-preview`** + `PREVIEW_SSH_KEY` |
| Каталог | `/opt/coop-field` | `/opt/coop-field-preview/pr-<N>/` |
| Юнит | `coop-field` | `coop-field-preview@pr-<N>` |
| Сайт | sslip.io / апекс | `http://pr-<N>.abnocw.miew.ru` |
| Порт | 8787 | `41000 + PR%1000` |
| Данные | `data/` прода | пустой `…/<slug>/data` |
| nginx | vhost sslip.io / `abnocw.miew.ru` | `/etc/nginx/preview.d/preview-<slug>.conf` |
| Секреты | `ADMIN_PASS` юнита прода | случайный пароль, **не** копия прода |

Лимит: **не больше 8** живых preview. Девятый PR получит отказ, пока не
закроют старый.

## Снос после merge/close

Workflow `.github/workflows/preview.yml` на событие `closed` (это и закрытие,
и merge) вызывает `PREVIEW_ACTION=destroy`. Скрипт:

- останавливает **только** `coop-field-preview@<этот-slug>`;
- удаляет **только** `/opt/coop-field-preview/<slug>/`;
- удаляет **только** nginx-фрагмент этого slug, затем `nginx -t` и reload
  (если `-t` падает — фрагмент возвращает, reload нет);
- не трогает другие slug, юнит `coop-field`, `/opt/coop-field`, порты 80/443/8787.

Чужой slug (`../`, слэш, имя юнита прода) скрипт отвергает до любых `rm`.

## Origin сокета и ссылка в шапке PR

`preview-apply.sh` держит в env юнита `ALLOWED_ORIGINS=http://<хост>,https://<хост>`
и обновляет на каждый apply вместе с хостом: сервер (`server/config.js`) пускает
`ws://` только с этих Origin. Без строки браузер с preview-страницы ловит отказ
сокета — выглядит как «бекенд не работает», хотя `/health` отвечает.

Ссылка на окружение стоит первым блоком в описании PR между маркерами
`<!-- coop-field-preview-link -->`: workflow обновляет её на каждый прогон
(`scripts/preview-pr-link.mjs`, гейт `test:preview-pr-link`) — живой URL,
«не выложен» или «снесён». Комментарий с маркером `<!-- coop-field-preview -->`
и Deployment `preview-pr-<N>` остаются как раньше.

## Что уже сделано (2026-11-07, Europe/Samara)

Ключ `PREVIEW_SSH_KEY` работает (Cursor и GitHub Actions). Bootstrap на VPS
выполнен. Каталог `/opt/coop-field-preview/pr-<N>/`, юнит
`coop-field-preview@pr-<N>`, сайт `http://pr-<N>.abnocw.miew.ru`.
Прод и `root` этим ключом не открываются. Однострочный PEM собирает
`scripts/write-openssh-key.sh`.

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

Bootstrap **уже выполнен** (2026-11-07). Следующий push выложит
`https://pr-<номер>.abnocw.miew.ru` (порт `41000+PR%1000`).
Форки не деплоим. Сборка из SHA коммита.

## TLS: per-host HTTP-01 (без DNS-API)

Wildcard нельзя выпустить без ключа к DNS-зоне, поэтому у каждого preview
свой сертификат, автоматически:

- `/etc/cron.d/coop-preview-cert` (каждые 5 минут, root) гоняет
  `/usr/local/sbin/coop-preview-cert` (= `deploy/vps/preview-cert-scan.sh`):
  находит новые хосты по nginx-фрагментам и делает
  `certbot certonly --webroot` из `www/` превью — location
  `/.well-known/acme-challenge/` уже есть в каждом фрагменте.
- Renew — штатный `certbot.timer` (webroot и deploy-hook сохранены в
  renewal-conf линии). Сироты (PR закрыт, фрагмент снесён) — та же cron-джоба
  подчищает: `certbot delete` + зеркало.
- Certbot-хук `/usr/local/sbin/coop-preview-tls-sync` (= `deploy/vps/preview-tls-sync.sh`)
  зеркалит пару в `/opt/coop-field-preview/tls/<host>/` (live/letsencrypt
  читает только root, а `preview-apply.sh` проверяет SAN от deploy-preview),
  добавляет 443 + http→https в существующий фрагмент (idempotent, с откатом
  по `nginx -t`) и перезагружает nginx. Следующий apply уже сам пишет ssl.
- Первый apply нового PR бывает на http: фрагмент написан до выпуска
  сертификата. Через ≤5 минут cron выдаёт серт, хук поднимает 443; но до
  следующего re-apply (следующий push в PR) ssl-строки пишет сам apply.
- Существующие сертификаты sslip.io и апекса скрипт не трогает.

Не копировать в preview `ADMIN_PASS` и `data/` прода.

## Форки и приватный репозиторий

Джоба: `head.repo.full_name == github.repository`. На приватном репо секреты
есть у PR из этого репозитория. Кнопка Private: Settings → General →
Danger Zone → Change repository visibility → Private.
