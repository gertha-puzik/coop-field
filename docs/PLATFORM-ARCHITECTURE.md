# Архитектура платформы Coop Field

**As-implemented** (ветка `feature/elyria-platform-admin-profiles`, фазы P1–P6; сверка с кодом
2026-11-08). Когда-то был «целевой моделью» — теперь описывает, что реально работает:
два публичных сайта из одного движка, аккаунты/сессии, профили, админ-дашборд и реестр
конфига. Не замена [ARCHITECTURE.md](ARCHITECTURE.md): там as-is движок и провод;
здесь — платформа поверх. Аудит продукта — [PRODUCT-ROADMAP.md](PRODUCT-ROADMAP.md).

Роадмап-незакрытое остаётся маленьким: правил Голодных игр нет (каркас без выдумки),
модератора нет, «активный бой» как отдельный режим снят (гроты и есть бой).

---

## 1. Один движок — два сайта

Один и тот же canvas-движок и один room-сервер собираются в два сайта:

| Сайт | Домен | Что видит игрок | Сборка (P6) |
| --- | --- | --- | --- |
| **Пивные гроты** (public) | `abnocw.miew.ru` (+ превью `pr-N.abnocw.miew.ru`, легаси `abnocw.89-232-184-77.sslip.io`) | меню с гротами и «Голодными играми», `/combat/`, `/hunger/`. Без аккаунтов, без Элизии: ни ссылок, ни API, ни её комнат | `NEXT_PUBLIC_SITE=grotto` + `prune-export` — корень `www-grotto/` (маршруты elision/players/admin вырезаны) |
| **Элизия** (elyria) | `elisium.miew.ru` (+ превью `pr-N.elisium.miew.ru`) | вход/регистрация, каталог игроков, панель админа, `/elision/`; комнаты гротов остаются доступными из её меню | `NEXT_PUBLIC_SITE=elyria` + `prune-export` — корень `www-elyria/` (маршруты combat/hunger вырезаны) |

Изоляция тройная, каждый рубеж самодостаточен:

1. **Compile-time (P3):** вариантозависимые модули проверяют инлайн-флаг
   `const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria'` в СВОЁМ файле.
   Импорт константы из `src/lib/site.ts` минифаером не сворачивается (проверено сборкой),
   а инлайн-сравнение фолдится — мёртвая ветка с текстами/именами Элизии исчезает из
   grotto-бандла целиком. Так делают: wander-gate (меню), modes.ts (каталог комнат),
   settings-panel (подписи), auth-panel/simulator (вход), players/admin-страницы.
2. **Артефакт (P6):** `npm run build:variants` → `scripts/prune-export.mjs` копирует `out/` в
   `www-grotto/` и `www-elyria/`, вырезая каталоги чужих маршрутов; deploy/preview заливают оба корня.
3. **Runtime (P1):** сервер классифицирует каждый HTTP/WS запрос по заголовку Host — см. §3.

## 2. Три сущности (не путать)

```
Аккаунт          Профиль              Персонаж
──────────       ──────────────       ────────────────
вход в систему   как меня видят       кого я вожу по полю
login + пароль   displayName, bio,    name, sprite, size
роль             avatarCharacterId    СП: скорость/урон/броня
createdAt                             позиция в Элизии — по name
                                      (книга test-cats.json)
```

- **Аккаунт** один на человека (`accounts.json`, scrypt). Без него — `guest`.
- **Профиль** 1:1 с аккаунтом: публичная карточка из `publicProfile` (server/accounts.js):
  displayName, bio (≤280), avatarCharacterId (id персонажа из своего списка либо null),
  characters (id/name/sprite/size), activeCharacterId, createdAt. **Без login и role** — это
 DTO для `/profiles`, профиль ≠ логин.
- **Персонаж** 1:N у аккаунта; на сокете активен один. Имя персонажа — подпись в чате и на
  поле, ключ книги позиций. Гость персонажей на сервере не имеет: имя и скин — только заход.

Идентичность: `accountId` сессии; подпись = `character.name`; ключ позиции = то же имя.

## 3. Хост-изоляция и матрица токенов (P1)

Один process обслуживает оба сайта; класс запроса считает `server/config.js hostClassOf(host)`:
`local | elyria | public`. Списки — дефолты + env `PUBLIC_HOSTS` / `ELYRIA_HOSTS`
(через запятую; точное имя ИЛИ суффикс зоны через точку — `pr-7.abnocw.miew.ru` наследует
`abnocw.miew.ru`). Неизвестный хост → `public` (самый закрытый). `local` — loopback-имена.

| Класс | HTTP-API | WS auth-кадры | Токены |
| --- | --- | --- | --- |
| `public` (гроты) | `/auth/*`, `/profiles/*`, `/admin/*`, `/cfg/admin*`, `/cfg/export`, пишущие `POST /cfg*` → **404 `not_found`** (гейт server/net.js); `GET /cfg` (значения) и геймплей — ок | `register`/`login` → `{ok:false, reason:"error"}` (спокойный отказ) | `?t=` принимается переходно (старые клиенты) + cookie |
| `elyria` (Элизия) | всё API открыто | обычно | **cookie-only**: `?t=` выключен; env `AUTH_LEGACY_TOKEN=1` возвращает на переходный период; токен из тела HTTP-ответа не выдаётся |
| `local` (dev/тесты) | всё API, пермиссивно | работают | прежнее поведение: `?t=` + токен в телах — на нём стоят test-auth/test-флои |

Cookie `coop_session`: `HttpOnly; Path=/; Max-Age=14д`. На https — `Secure + SameSite=Lax`
(P1; `COOKIE_LOOSE=1` возвращает легаси `None` для старых кросс-доменных клиентов), на http —
`SameSite=Lax`. CSRF-щит: непустой Origin пишущих POST (`/auth/*`, `/cfg/*`, PATCH
`/profiles/me`) обязан быть в AllowList, иначе 403 `csrf`; пустой Origin не блокируется
(curl/тесты). Троттлинг: register 1/мин и 5/час на IP, login шаг 6 c на IP + per-LOGIN замок
20 неудач за 15 мин (env-подстройка: `AUTH_REGISTER_GAP_MS`, `AUTH_REGISTER_HOURLY_MAX`,
`AUTH_LOGIN_GAP_MS`, `AUTH_LOGIN_FAIL_MAX`, `AUTH_LOGIN_FAIL_WINDOW_MS`);
XFF доверяется одному случаю — соединение с loopback терминировано нашим nginx, берётся
последний хоп.

## 4. Роли и доступ

| Роль | Как появляется | Что можно |
| --- | --- | --- |
| `guest` | нет сессии | гроты, demo, голодные игре, справочник. **Не** Элизия (join-отказ `auth_required`, даже прямым WS) |
| `registered` | регистрация | + Элизия, свой профиль (PATCH /profiles/me), страницы /players |
| `admin` | логин из env `BOOTSTRAP_ADMIN` (список через запятую — каждое имя получает роль при СВОЕЙ первой регистрации; поле `role` в `accounts.json` — прямой путь) | + GET/POST /cfg/admin-роуты (реестр, история, restore, export/import), админ-вкладки панели (ролевой рендер), дашборд /admin. `setmap` остаётся за паролем `ADMIN_PASS` — это аварийный ключ редактора, не «логин» |

Права проверяет **сервер** (сессия), UI только рендерит по `whoami.role`. Клиентский
«пароль вкладок» снят (P3): вкладки `admin:true` в settings-panel рендерятся только при
`role === 'admin'`, локальных паролей нет.

## 5. Режимы и комнаты

Один room-процесс. Режим — свойство кода комнаты, не копии движка.

| Режим | Код комнаты | Формат | Доступ | Страница |
| --- | --- | --- | --- | --- |
| Меню Wanderpaws | — | — | открытый | `/` |
| Пивной грот (beer) | `grot-1` `grot-2` `grot-3`, `demo` | `grid` 10×6 | открытый | `/combat/` |
| Элизия | `test` | `test` 19×7 | **только сессия** | `/elision/` |
| Голодные игры (каркас) | `hunger` | `grid` | открытый | `/hunger/` |

- **Отдельный режим combat снят (P1).** Комнаты «combat» в каталоге нет; снятый код заморожен
  в `RETIRED_ROOMS` (server/modes.js) и алиасится в `roomOf` → `grot-1`: легаси-ссылка
  `?room=combat` попадает в настоящий грот, а не в произвольный open-grid. Страница
  `/combat/` остаётся страницей гротов (режим `beer`) — старые URL живут.
- Неизвестный код комнаты остаётся открытым grid (легаси `?room=...`), registered-комнаты не
  через каталог код не создаются.
- `roomsinfo` для ГОСТЯ прячет registered-комнату целиком: `count 0, logins []` — как
  несуществующую (комната не раскрывается даже счётчиком сидящих). «Комната из ссылки» для
  registered-кода карточку не получает.
- При join под сессией личность — активный персонаж (name/sprite/size), `payload.login`
  гостя остаётся подписью; сессия не подтверждена — отказ `auth_required` в `refuse`/`noplace`
  общим текстом без имени комнаты.

## 6. Конфиг: registry whitelist (P2) + runtime-config v2

`DATA_DIR/runtime-config.json` хранит ТОЛЬКО значения `{ v:1, atmo, universes }`. Что можно
менять, определяет реестр `server/cfg-registry.js` — whitelist из **5 ключей** (заморожен,
deepFreeze): `atmo.phaseMin`, `atmo.weatherMin`, `universes.strikeDamage`,
`universes.armor`, `universes.arrowSpeed`. Формат WS-протокола, события, авторизация,
rate-limits, ARMOR_CURVE/STRIKE_ZONES (канон protocol.js) сюда НЕ входят в принципе —
панель админа редактирует разрешённые ЗНАЧЕНИЯ, не константы движка.

По каждому ключу: подпись, описание, юниверс разрешённых значений, движковый кап, дефолт,
**apply-политика**, видимость (все `public`, `scope: global`):

| Ключ | Apply | Смысл |
| --- | --- | --- |
| `atmo.phaseMin` / `atmo.weatherMin` | `new-room` — стартовые длины новых комнат; живую крутит atmoset | минуты части суток / интервал погоды |
| `universes.strikeDamage` (уровни 0–9) | `on-next-event` — каждый входящий удар клэмпится сверху | список уровней урона на экране входа + дефолт |
| `universes.armor` (десятые 0–0.9) | `on-next-event` — кадр брони снапится | список десятых брони + дефолт |
| `universes.arrowSpeed` (периоды 1.8–5 c) | `new-session` — игрок увидит в новой сессии | периоды оборота стрелы (чисто клиентская механика, серверного клэмпа нет) |

Серверные клэмпы боя (только сервер, клиенту зеркала формул нет): `maxStrikeDamage(zone, level)` —
верхняя граница урона удара по формуле горла (база зоны 42 + 3,67·уровень; рост масштабирует
урон остальных зон); combat.js зажимает каждый удар по максимальному разрешённому уровню.
`snapArmorToUniverse(raw, allowed)` — наибольшая разрешённая десятая, не превышающая вход;
ниже наименьшей — 0 (без брони). Клиент (`cfg-live.ts`) при этом снапит выпавшее сохранённое
значение к ДЕФОЛТУ (не к ближайшему) — загрузка профиля не ломается.

HTTP (роли — по cookie-сессии, `adminFromReq`):

| Маршрут | Доступ | Что |
| --- | --- | --- |
| `GET /cfg` | публичный | значения v/atmo/universes + apply-подсказки; **без истории** |
| `GET /cfg/admin` | admin | значения + метаданные реестра (подписи/типы/капы) + apply + история бэкапов |
| `POST /cfg` | admin, CSRF | патч по ключам реестра (всё-или-ничего: unknown_keys/invalid) или `{reset:true}` — дефолты |
| `POST /cfg/restore` | admin | восстановить бэкап; имя обязано быть в свежем listHistory (path-guard), мусор не читается |
| `GET /cfg/export` | admin | текущие значения одним JSON |
| `POST /cfg/import` | admin | принять экспорт через sanitizeValues, всё или ничего |

Файл: атомарная запись + 8 вращаемых бэкапов (`DATA_DIR/cfg-backups/`). Старый v1-файл
(atmo-only) читается с read-time миграцией — universes добираются дефолтами реестра, файл не
перезаписывается до первого admin-POST. Дашборд `/admin` (cfg-dashboard.tsx) — только
elyria-вариант, рендер при `role==='admin'`; комнатные конфиги (per-room atmoset) сюда не
входят — для них нет HTTP API.

Клиентское зеркало реестра — `src/lib/cfg-registry.ts` (подписи/юниверсы/дефолты; формул
клэмпа нет). Паритет «сервер == зеркало == golden» держит `test:protocol-parity`
(`test:cfg` — 49 юнит-чеков реестра).

## 7. Профили игроков (P4)

- `GET /profiles` — каталог публичных карточек (только строки с заполненным `profile`),
  стабильный порядок по старшинству, без пагинации.
- `GET /profiles/:id` — карточка (`accountId` + publicProfile); нет карточки/легаси-строка →
  единый 404 `unknown` (существование скрытых аккаунтов не раскрывается).
- `GET /profiles/me` — своя карточка по сессии; гость → 401 `auth_required`.
- `PATCH /profiles/me` — правка ТОЛЬКО своей записи: плоские `displayName` (1–24 видимых
  символа), `bio` (≤280), `avatarCharacterId` (null или id из своих characters);
  идентификационные ключи (id/login/role/…) отбиваются `unknown_keys`; невидимые/bidi-символы
  вырезаются тем же классом, что в sanitize.js; UTF-8 длины считаются по код-поинтам.
  Identity — строго из сессии (cookie), CSRF-щит на PATCH. Правка legacy-строки без профиля
  и есть «опубликовать карточку».
- Клиент: страница `/players` (players-catalog.tsx, только elyria) — карточки, deep-link
  `?id=`, инлайн-редактирование своей; ошибки сервера показываются целиком.

## 8. Хранение (`DATA_DIR`, деплой его не затирает)

| Файл | Содержание |
| --- | --- |
| `accounts.json` | `{v, accounts: {id: {id, login, pass{algo,N,r,p,salt,hash}, role, createdAt, profile{displayName?,bio?,avatarCharacterId?}, characters, activeCharacterId}}}` |
| `sessions.json` | `{v:1, sessions: {[token]: {accountId, createdAt, expiresAt}}}`; токен 32 hex-байта, TTL 14 дней, отзыв = удаление записи |
| `test-cats.json` / `test-map.json` | как раньше; ключ позиций = имя персонажа |
| `runtime-config.json` | значения whitelist-ключей (см. §6); v1-atmo-only читается миграцией |
| `cfg-backups/` | 8 последних версий конфига (restore по имени отсюда) |

Записи атомарные (`writeFileAtomic`), JSON, один event loop — без SQLite. Зависимости из
`node:crypto` (scrypt) — новых npm-пакетов нет.

## 9. Миграция существующих данных

- Книга позиций не конвертируется: ключ `login.toLowerCase()` остаётся; регистрация «тем же
  именем» подхватывает старую клетку персонажем с этим именем (restoreCatPosition).
- Имя занято в accounts.json → регистрация отказывает (`taken`), позиция под старым именем
  не теряется и не перетирается чужим registered.
- Потолок `MAX_ACCOUNTS` (env, дефолт 2000): при достижении регистрация отвечает `full`.
- Скины/СП в localStorage не трогаются; сервер не хранит СП персонажа (сессия подставляет
  name/sprite/size активного персонажа).
- Карта Элизии и бэкапы не мигрируют: формат тот же. Гость в гроты — как раньше.

## 10. Preview (dual-host)

Один VPS с продом, каталог `/opt/coop-field-preview/pr-<N>/`, один room-инстанс
(порт `41000 + PR%1000`), **два** сайта:

- `https://pr-<N>.abnocw.miew.ru` → `…/pr-N/www-grotto/` (публичные гроты);
- `https://pr-<N>.elisium.miew.ru` → `…/pr-N/www-elyria/` (Элизия).

Оба хоста проксируются в один инстанс; Host-классы разруливает сервер (env `PUBLIC_HOSTS` /
`ELYRIA_HOSTS` пишет preview-apply). Конвейер из двух workflow: `preview-build.yml`
(pull_request, без секретов, артефакт с ОБОИМИ корнями) и `preview-deploy.yml`
(workflow_run — исполняется из main, держит `PREVIEW_SSH_KEY`). TLS per-host (root-cron,
первый apply до ~5 минут на http). Снос на closed/merged; лимит 8 живых превью.
Полная механика и проверки доверия — [PREVIEW-ENVIRONMENTS.md](PREVIEW-ENVIRONMENTS.md).

## 11. Карта платформенных модулей (лимит 800 строк)

| Модуль | Строк | Ответственность |
| --- | ---: | --- |
| `server/config.js` | 228 | host-политика `hostClassOf` (public/elyria/local), env сплитов PUBLIC_HOSTS/ELYRIA_HOSTS |
| `server/net.js` | 264 | HTTP host-гейт (404 зон Элизии на public), CSRF Origin на пишущих /cfg |
| `server/auth.js` | 510 | сессии, cookie HttpOnly/Lax/Secure, матрица токенов, rate-лимиты, /auth/* |
| `server/modes.js` | 45 | каталог комнат + RETIRED_ROOMS (combat→grot-1) |
| `server/room.js` | 438 | join-гейт `auth_required`, roomsinfo-призрак, алиас roomOf |
| `server/accounts.js` | 347 | scrypt-стор, publicAccount/publicProfile, BOOTSTRAP_ADMIN, MAX_ACCOUNTS |
| `server/profiles.js` | 310 | HTTP /profiles*: каталог, карточка, правка своего профиля |
| `server/cfg-registry.js` | 295 | whitelist 5 ключей + формулы клэмпов (maxStrikeDamage, snapArmorToUniverse) |
| `server/runtime-config.js` | 357 | значения v2, read-time миграция v1, бэкапы, HTTP /cfg(+admin-роуты) |
| `server/combat.js` | 285 | клэмпы боя поверх ARMOR_CURVE (капы из реестра на каждом событии) |
| `src/lib/site.ts` | 28 | канон варианта NEXT_PUBLIC_SITE (дефолт grotto) |
| `src/lib/net/modes.ts` | 155 | клиентский каталог комнат — зеркало modes.js; grotto не знает «test» |
| `src/lib/net/auth.ts` | 30 | WS-кадры auth без ?t= (cookie-сессия) |
| `src/lib/net/http-auth.ts` | 367 | HTTP-клиент /auth/*, /profiles/*, /cfg admin (credentials include) |
| `src/lib/net/cfg-live.ts` | 122 | universes из GET /cfg: кэш на вкладку, дефолты при сбое, снап к дефолту |
| `src/lib/cfg-registry.ts` | 139 | зеркало реестра для клиента (паритет — parity-гейт) |
| `src/components/sim/auth-panel.tsx` | 113 | форма входа/регистрации (только elyria) |
| `src/components/sim/settings-panel.tsx` | 1240 | ролевой рендер вкладок (role из whoami; паролей нет) |
| `src/components/players/players-catalog.tsx` | 458 | каталог игроков /players (deep-link, правка своей) |
| `src/components/admin/cfg-dashboard.tsx` | 444 | админ-дашборд /admin (реестр/restore/export/import) |
| `src/app/*/page.tsx` | 11–13 | оболочки Simulator: `/` hub, `/combat/` beer, `/elision/` elision, `/hunger/` каркас, `/players/`, `/admin/` |

## 12. Совместимость провода

События не менялись (реестры 23+23, канон W3; матрица routers — AGENTS.md). Гостевой
`join {room, login, sprite, size}` в открытые комнаты работает как раньше — старые клиенты и
`scripts/test-ws.mjs` ходят без сессии. Новое — только HTTP-поверхность и поведение
сервера по классу хоста; `?t=` на Элизии выключен по умолчанию (env-тумблер на переход),
на public/local — прежние пути живы. Инварианты шага/координат/`update cat`/leave-маркера
не тронуты. `?room=combat` не ломается: алиас RETIRED_ROOMS ведёт в grot-1.
