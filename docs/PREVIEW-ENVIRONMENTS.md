# Preview-окружения для пул-реквестов

Простыми словами: у каждой ветки свой маленький сайт и своя комната, чтобы
пробовать игру **не на живой Элизии**. Пока нет wildcard TLS, адрес:

`http://<8 символов SHA коммита>.abnocw.miew.ru`

Например `http://b0f9fa41.abnocw.miew.ru`. Каталог и systemd — `pr-<номер PR>`
(не меняются с каждым пушем, снос при close знает номер). Имя сайта короткое:
длинный slug ветки ломал nginx (`server_names_hash_bucket_size: 64`).

Комната: `ws://<тот-же-хост>/ws`. HTTPS появится после DNS-01 на
`*.abnocw.miew.ru`. Сертификат апекса `abnocw.miew.ru` на поддомен не вешаем.

## Решение владелицы (2026-11-06)

Preview живёт **на том же VPS, что прод** (`89.232.184.77`). Изоляция —
каталог, пользователь, порт и данные. Прод-пайплайн и URL **не меняем**.

| | Прод | Preview |
| --- | --- | --- |
| Когда | push в `main` | PR своего репо |
| SSH | `deploy` + `VPS_SSH_KEY` | **`deploy-preview`** + `PREVIEW_SSH_KEY` |
| Каталог | `/opt/coop-field` | `/opt/coop-field-preview/pr-<N>/` |
| Юнит | `coop-field` | `coop-field-preview@pr-<N>` |
| Сайт | sslip.io / апекс | `http://<8 hex SHA>.abnocw.miew.ru` |
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

## Что уже сделано (2026-11-07, Europe/Samara)

Ключ `PREVIEW_SSH_KEY` работает (Cursor и GitHub Actions). Bootstrap на VPS
выполнен. Каталог `/opt/coop-field-preview/pr-<N>/`, юнит
`coop-field-preview@pr-<N>`, сайт `http://<8 hex SHA>.abnocw.miew.ru`.
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

Bootstrap **уже выполнен** (2026-11-07). Следующий push выкладывает
`http://<8 hex SHA>.abnocw.miew.ru` (каталог `pr-<номер>`, порт `41000+PR%1000`).
Форки не деплоим. Сборка из SHA коммита.

TLS: HTTP-01 на звёздочку нельзя. DNS-01 на `*.abnocw.miew.ru` — отдельно.
Существующие сертификаты sslip.io и апекса скрипт не трогает.

Не копировать в preview `ADMIN_PASS` и `data/` прода.

## Форки и приватный репозиторий

Джоба: `head.repo.full_name == github.repository`. На приватном репо секреты
есть у PR из этого репозитория. Кнопка Private: Settings → General →
Danger Zone → Change repository visibility → Private.
