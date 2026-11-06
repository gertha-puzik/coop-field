# Preview-окружения для пул-реквестов

Простыми словами: у каждой ветки свой маленький сайт и своя комната, чтобы
пробовать игру **не на живой Элизии**. Адрес:

`https://<имя-ветки-буквами>.abnocw.miew.ru` (или `http://…`, пока нет TLS)

## Решение владелицы (2026-11-06)

Preview живёт **на том же VPS, что прод** (`89.232.184.77`). Изоляция —
каталог, пользователь, порт и данные. Прод-пайплайн и URL **не меняем**.

| | Прод | Preview |
| --- | --- | --- |
| Когда | push в `main` | PR своего репо |
| SSH | `deploy` + `VPS_SSH_KEY` | **`deploy-preview`** + `PREVIEW_SSH_KEY` |
| Каталог | `/opt/coop-field` | `/opt/coop-field-preview/<slug>/` |
| Юнит | `coop-field` | `coop-field-preview@<slug>` |
| Порт | 8787 | `41000 + PR%1000` |
| Данные | `data/` прода | пустой `…/<slug>/data` |
| nginx | vhost sslip.io | `/etc/nginx/preview.d/preview-<slug>.conf` |
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

## SSH для уже запущенного агента

Секрет Cursor Environment `PREVIEW_SSH_KEY` **не появляется** в VM, которая
уже работала до добавления секрета. В таком запуске нет переменных
`PREVIEW_SSH_KEY` / `VPS_SSH_KEY` / `SSH_PRIVATE_KEY`, в `~/.ssh` только
`known_hosts`, и `deploy-preview@89.232.184.77` отвечает
`Permission denied (publickey)`. Правок на сервере нет.

Нужен **новый** агент/чат с текстом:

«ключ PREVIEW_SSH_KEY уже в Secrets, настрой preview»

Отдельно от Cursor Secrets: GitHub Actions secret с тем же именем — для
workflow, его `gh` агенту не отдаёт.

## Что сделано в репо (агент на VPS не попал)

Ключа в этой VM нет. Хост-ключ приняли (`StrictHostKeyChecking=accept-new`).

В репо готово к одному запуску от root:

- `deploy/vps/preview-bootstrap.sh` — пользователь `deploy-preview`, каталоги,
  sudoers только на preview-юнит и `nginx -t`/`reload`, include nginx,
  юнит, ключ SSH;
- `deploy/vps/preview-apply.sh` — apply/destroy/validate, лимит 8, защита slug;
- `deploy/vps/sudoers-coop-field-preview`;
- `deploy/vps/nginx-preview-include.conf` + шаблон vhost;
- тесты `npm run test:preview-slug` и `npm run test:preview-apply`.

## Один шаг Сырь

На VPS, из клона этой ветки, **от root**:

```bash
sudo bash deploy/vps/preview-bootstrap.sh
```

Скрипт сам создаст ключ `/home/deploy-preview/.ssh/coop-field-preview` и
допишет публичную часть в `authorized_keys`. Затем:

**GitHub → Settings → Secrets and variables → Actions → New repository secret**

- имя ровно `PREVIEW_SSH_KEY`
- значение — **содержимое приватного файла** `/home/deploy-preview/.ssh/coop-field-preview`
  (открыть на сервере, вставить в GitHub, **не слать в чат**)

После секрета следующий push/synchronize в PR выложит preview. Форки не
деплоим. Сборка из SHA коммита.

TLS: bootstrap напишет, есть ли уже сертификат
`/etc/letsencrypt/live/abnocw.miew.ru`. Если есть — apply подставит его в
vhost. Если нет — preview слушает `:80` (HTTP-01 на звёздочку нельзя; DNS-01
на `*.abnocw.miew.ru` — отдельно, когда будет DNS API). Существующие
сертификаты sslip.io скрипт не трогает.

Не копировать в preview `ADMIN_PASS` и `data/` прода.

## Форки и приватный репозиторий

Джоба: `head.repo.full_name == github.repository`. На приватном репо секреты
есть у PR из этого репозитория. Кнопка Private: Settings → General →
Danger Zone → Change repository visibility → Private.
