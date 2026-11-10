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
| **Пивные гроты** (public) | `abnocw.phainonsmilk.ru` (+ превью `pr-N.abnocw.phainonsmilk.ru`, легаси `abnocw.89-232-184-77.sslip.io`) | меню с гротами и «Голодными играми», `/combat/`, `/hunger/`. Без аккаунтов, без Элизии: ни ссылок, ни API, ни её комнат | `NEXT_PUBLIC_SITE=grotto` + `prune-export` — корень `www-grotto/` (маршруты game/elision/players/admin вырезаны — elision-каталог теперь только стаб-пересылка) |
| **Элизия** (elyria) | `phainonsmilk.ru` (+ превью `pr-N.elysiae.phainonsmilk.ru`) | вход/регистрация, каталог игроков, панель админа, `/game/` (со старого `/elision/` пересылает стаб); комнаты гротов остаются доступными из её меню | `NEXT_PUBLIC_SITE=elyria` + `prune-export` — корень `www-elyria/` (маршруты combat/hunger вырезаны) |

Изоляция четырёхрубежная, каждый рубеж самодостаточен:

1. **Compile-time (P3):** вариантозависимые модули проверяют инлайн-флаг
   `const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria'` в СВОЁМ файле.
   Импорт константы из `src/lib/site.ts` минифаером не сворачивается (проверено сборкой),
   а инлайн-сравнение фолдится — мёртвая ветка с текстами/именами Элизии исчезает из
   grotto-бандла целиком. Так делают: wander-gate (меню), modes.ts (каталог комнат),
   settings-panel (подписи), auth-panel/simulator (вход), players/admin-страницы.
   Гейт `arch:check` (правило isolatedImports) запрещает импорт `src/lib/site.ts` всем
   файлам, кроме самого site.ts.
2. **Артефакт (P6):** `npm run build:variants` → `scripts/prune-export.mjs` копирует `out/` в
   `www-grotto/` и `www-elyria/`, вырезая каталоги чужих маршрутов; deploy/preview заливают оба корня.
3. **Runtime (P1):** сервер классифицирует каждый HTTP/WS запрос по заголовку Host — см. §3.
4. **CI-гейт артефактов (A1):** `npm run check:variants` после сборки — www-grotto без НИ
   ОДНОГО маркера Элизии (включая латиницу `elisium`: кириллический греп «Элизи» НЕ
   достаточен), www-elyria без снятых `/combat/`+`/hunger/` и СО следами живой Элизии,
   ссылки на чанки цельны. В preview-build.yml — шаг «Изоляция вариантов (A1)» после
   сборки обоих корней, до упаковки артефакта.

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
(через запятую; точное имя ИЛИ суффикс зоны через точку — `pr-7.abnocw.phainonsmilk.ru` наследует
`abnocw.phainonsmilk.ru`). Неизвестный хост → `public` (самый закрытый). `local` — loopback-имена.

| Класс | HTTP-API | WS auth-кадры | Токены |
| --- | --- | --- | --- |
| `public` (гроты) | `/auth/*`, `/profiles/*`, `/admin/*`, `/cfg/admin*`, `/cfg/export`, пишущие `POST /cfg*` → **404 `not_found`** (гейт server/net.js); `GET /cfg` (значения) и геймплей — ок | `register`/`login` → `{ok:false, reason:"error"}` (спокойный отказ) | `?t=` принимается переходно (старые клиенты) + cookie; кадр `whoami` токен не возвращает. `hello` с `payload.token` требует Origin своего класса |
| `elyria` (Элизия) | всё API открыто | обычно | **cookie-only**: `?t=` выключен; env `AUTH_LEGACY_TOKEN=1` возвращает на переходный период; токен не выдаётся ни в теле HTTP, ни в кадре `whoami`. `hello` с `payload.token` требует Origin своего класса (`originOk`) |
| `local` (dev/тесты) | всё API, пермиссивно | работают | прежнее поведение: `?t=` + токен в HTTP-телах и в кадре `whoami` — на нём стоят test-auth/test-флои; `hello` с токеном без Origin по-прежнему жив |

Cookie `coop_session`: `HttpOnly; Path=/; Max-Age=14д`, **host-only** — атрибута Domain
намеренно нет (B1): кука привязана к точному хосту, соседний сайт её не увидит. На https —
`Secure + SameSite=Lax` (P1; `COOKIE_LOOSE=1` возвращает легаси `None` для старых
кросс-доменных клиентов), на http — `SameSite=Lax`. CSRF-щит (B1, fail-closed
per-destination): unsafe-метод с cookie-аутентификацией на public/elyria обязан нести
Origin, точный для destination-класса — пустой Origin → 403 `csrf_origin_required`,
чужой (в т.ч. сиблинг-класс из общего env-списка) → 403 `csrf_origin_mismatch`; класс
local — прежний щит (`AUTH_CSRF_STRICT=0/1` форсирует/ослабляет для всех). CORS:
credentialed-ответы API отражают Origin только «своему» сайту. Троттлинг: register 1/мин
и 5/час на IP, login шаг 6 с на IP + per-LOGIN замок 20 неудач за 15 мин (env-подстройка:
`AUTH_REGISTER_GAP_MS`, `AUTH_REGISTER_HOURLY_MAX`, `AUTH_LOGIN_GAP_MS`,
`AUTH_LOGIN_FAIL_MAX`, `AUTH_LOGIN_FAIL_WINDOW_MS`);
XFF доверяется одному случаю — соединение с loopback терминировано нашим nginx, берётся
последний хоп; надёжность режима видна в `/health` → `clientIpMode` (`loopback|xff|direct`,
S4: `loopback` на прод-классе хоста = темп-лимиты auth выключены — сервер пишет warning в лог).

## 4. Роли и доступ

| Роль | Как появляется | Что можно |
| --- | --- | --- |
| `guest` | нет сессии | гроты, demo, голодные игре, справочник. **Не** Элизия (join-отказ `auth_required`, даже прямым WS) |
| `registered` | регистрация | + Элизия, свой профиль (PATCH /profiles/me), страницы /players |
| `admin` | только одноразовый CLI владелицы: `node scripts/make-admin.mjs <login> [pass]` (server остановлен; повышает существующий аккаунт с сохранением пароль-хеша ИЛИ создаёт аккаунт сразу с ролью; повтор — idempotent; понижения не умеет). Env `BOOTSTRAP_ADMIN` отныне МИГРАЦИОННЫЙ: имена читаются, но при регистрации роли НЕ назначают — сервер пишет в лог warning «bootstrap имя занято; назначьте роль через scripts/make-admin.mjs». Поле `role` в `accounts.json` — прямой путь для migrateStore (существующие админы старого механизма сохраняются при старте) | + GET/POST /cfg/admin-роуты (реестр, история, restore, export/import), админ-вкладки панели (ролевой рендер), дашборд /admin. `setmap` принимает только role=admin в комнате test; пароль не проверяется |

Права проверяет **сервер** (сессия), UI только рендерит по `whoami.role`. Клиентский
«пароль вкладок» снят (P3): вкладки `admin:true` в settings-panel рендерятся только при
`role === 'admin'`, локальных паролей нет.

## 5. Режимы и комнаты

Один room-процесс. Режим — свойство кода комнаты, не копии движка.

| Режим | Код комнаты | Формат | Доступ | Страница |
| --- | --- | --- | --- | --- |
| Меню Wanderpaws | — | — | открытый | `/` |
| Пивной грот (beer) | `grot-1` `grot-2` `grot-3`, `demo` | `grid` 10×6 | открытый | `/combat/` |
| Элизия | `test` | `test` 19×7 | **только сессия** | `/game/` |
| Голодные игры (каркас) | `hunger` | `grid` | открытый | `/hunger/` |

- **Отдельный режим combat снят (P1).** Комнаты «combat» в каталоге нет; снятый код заморожен
  в `RETIRED_ROOMS` (server/modes.js) и алиасится в `roomOf` → `grot-1`: легаси-ссылка
  `?room=combat` попадает в настоящий грот, а не в произвольный open-grid. Страница
  `/combat/` остаётся страницей гротов (режим `beer`) — старые URL живут.
- Неизвестный код комнаты остаётся открытым grid (легаси `?room=...`), registered-комнаты не
  через каталог код не создаются. S5b: потолок ЖИВЫХ комнат на процесс `ROOMS_MAX`
  (env, деф. 32) — новая комната сверх лимита → `noplace rooms_full`.
- `roomsinfo` для ГОСТЯ прячет registered-комнату целиком: `count 0, logins []` — как
  несуществующую (комната не раскрывается даже счётчиком сидящих). «Комната из ссылки» для
  registered-кода карточку не получает.
- При join под сессией личность — активный персонаж (name/sprite/size), `payload.login`
  гостя остаётся подписью; сессия не подтверждена — отказ `auth_required` в `refuse`/`noplace`
  общим текстом без имени комнаты.

## 6. Конфиг: registry whitelist (P2) + runtime-config v2

`DATA_DIR/runtime-config.json` хранит ТОЛЬКО значения `{ v:1, atmo, universes }`. Что можно
менять, определяет реестр `server/cfg-registry.js` — whitelist из **6 ключей** (заморожен,
deepFreeze): 5 числовых `atmo.phaseMin`, `atmo.weatherMin`, `universes.strikeDamage`,
`universes.armor`, `universes.arrowSpeed` + bool-гейт `atmo.allowPlayerAtmosphereControl`
(F2 §3.4: room-scope, default TRUE — не в юниорсах, валидация true/false only).
Формат WS-протокола, события, авторизация,
rate-limits, ARMOR_CURVE/STRIKE_ZONES (канон protocol.js) сюда НЕ входят в принципе —
панель админа редактирует разрешённые ЗНАЧЕНИЯ, не константы движка.

По каждому ключу: подпись, описание, юниверс разрешённых значений, движковый кап, дефолт,
**apply-политика**, видимость (числовые — `public`, `scope: global`; гейт — `admin-only`,
`scope: room`):

| Ключ | Apply | Смысл |
| --- | --- | --- |
| `atmo.phaseMin` / `atmo.weatherMin` | `new-room` — стартовые длины новых комнат; живую крутит atmoset | минуты части суток / интервал погоды |
| `atmo.allowPlayerAtmosphereControl` | `live-gate` (F2) — НЕ новое значение, а per-room гейт atmoset-кадров игроков; отсутствие override = TRUE (default preserves current gameplay); управляется через per-room §6a, глобальным POST /cfg НЕ пишется | «игроки могут крутить сутки» в конкретной комнате |
| `universes.strikeDamage` (уровни 0–9) | `on-next-event` — каждый входящий удар клэмпится сверху | список уровней урона на экране входа + дефолт |
| `universes.armor` (десятые 0–0.9) | `on-next-event` — кадр брони снапится | список десятых брони + дефолт |
| `universes.arrowSpeed` (периоды 1.8–5 c) | `new-session` — игрок увидит в новой сессии | периоды оборота стрелы (чисто клиентская механика, серверного клэмпа нет) |

**F2 §4 — playerSelectable (снятие части заморозки B2):** у universes-ключей ТРИ понятия
хранятся раздельно: `allowedValues` (кураторский список ⊆ юниверса, длины bounded),
`defaultValue` (∈ allowedValues, инвариант проверяется на каждом write) и ЯВНЫЙ флаг
`playerSelectable`. При selectable=false игроку отдаётся только дефолт — список НЕ режется
«в никуда»: off-then-on возвращает кураторский список, а не движковый юниверс. Миграция
старых файлов — read-time (вывод флага из длины списка: >1 → true, {default}-only → false),
файл не переписывается; restore из старых снапшотов тоже мигрирует. Гейт WS/бой:
вне-списочное значение игрока снапится сервером (клиент не авторитетен, тест есть).

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
| `POST /cfg` | admin, CSRF | патч по ключам реестра (всё-или-ничего: unknown_keys/invalid), значения И списочные мутации universes (B2+B2§4: редактирование списков разрешённых значений; тумблер «выбор игроками» = ЯВНЫЙ playerSelectable, список не режется; старое тело без флага = прежняя косвенная семантика list>1, backward-compat) или `{reset:true}` — дефолты |
| `POST /cfg/restore` | admin | восстановить бэкап; имя обязано быть в свежем listHistory (path-guard), мусор не читается |
| `GET /cfg/export` | admin | текущие значения одним JSON |
| `POST /cfg/import` | admin | принять экспорт через sanitizeValues, всё или ничего |

Файл: атомарная запись + 8 вращаемых бэкапов (`DATA_DIR/cfg-backups/`). Старый v1-файл
(atmo-only) читается с read-time миграцией — universes добираются дефолтами реестра, файл не
перезаписывается до первого admin-POST. Дашборд `/admin` (cfg-dashboard.tsx) — только
elyria-вариант, рендер при `role==='admin'`.

**F2 §6a — per-room слой (`/cfg/rooms*`, только elyria-хост):** слоеная модель
движковые дефолты ← глобальный runtime ← ЯВНЫЙ per-room override; effective считает
сервер (resolveEffective), explicit overrides only. Файл `DATA_DIR/room-configs.json`
{v:1, rooms:{[id]:{[key]:value}}} — атомарная запись 0600, 8 бэкапов, corrupt →
`.corrupt-<ts>.json` + warn + пустое состояние; restore валидирует id/ключи/значения.
Whitelist v1: `atmo.phaseMin`, `atmo.weatherMin`, `atmo.allowPlayerAtmosphereControl`
(universes — v2 после боевой интеграции). Роуты: `GET /cfg/rooms` (каталог с бейджами
overrides), `GET/PUT/DELETE /cfg/rooms/:id` (слои global/override/effective; PUT — merge
validated), `DELETE /cfg/rooms/:id/:key` (reset one), `DELETE /cfg/rooms/:id/all`
(reset all), `GET /cfg/rooms/:id/history`, `POST /cfg/rooms/:id/restore`. Те же
admin/CSRF/origin-гейты, что /cfg; на public-хосте — 404. Политика new-rooms-only:
override вступает при (пере)создании объекта комнаты, живая атмосфера НЕ трогается;
**WS-broadcast per-room конфига НЕ нужен** (F2 §3.6) — клиенты получают effective
через якорь в `field` при создании комнаты, новых протокол-событий нет.
Atmoset-кадры игроков гейтятся в atmo.js (per-room, молчаливый drop, существующий
формат) и НИКОГДА не пишут room-configs.json.

Клиентское зеркало реестра — `src/lib/cfg-registry.ts` (подписи/юниверсы/дефолты; формул
клэмпа нет). Паритет «сервер == зеркало == golden» держит `test:protocol-parity`
(`test:cfg` — 80 юнит-чеков реестра: значения, §4-мутации/миграция, списочные мутации B2,
S1-эскалация через стоп→make-admin→рестарт-цикл; F2-комнатный слой — `test:room-config`,
69 чеков). Дашборд `/admin` (cfg-dashboard.tsx + room-config-panel.tsx) — только
elyria-вариант, рендер при `role==='admin'`: редакторы списков разрешённых значений
с ЯВНЫМ тумблером «выбор игроками» (§4, список сохраняется),
предпросмотр «было → станет» с предупреждением сужения, restore/export/import;
секция «Комнатные настройки» — per-room селект комнаты, слои, гейт atmoset,
reset/restore с подтверждением.

## 7. Профили игроков (P4)

- `GET /profiles` — каталог публичных карточек (только строки с заполненным `profile`),
  стабильный порядок по старшинству; с B3 — серверный поиск `?q` (по displayName) и
  keyset-пагинация: `?limit` (деф. 24, клэмп 48, мусор → 400 `invalid_limit`) +
  `?cursor` (base64, next-page keyset). Пустой фильтр = первая страница дефолтного
  размера; клиент НЕ фильтрует сам.
- `GET /profiles/:id` — карточка (`accountId` + publicProfile); нет карточки/легаси-строка →
  единый 404 `unknown` (существование скрытых аккаунтов не раскрывается).
  Чужим `birthday` — только `ММ-ДД` (год остаётся в сторе), `lastSeenAt` остаётся,
  `lastSeenRoom` в JSON нет.
- `GET /profiles/me` — своя карточка по сессии, с полной `birthday` `ГГГГ-ММ-ДД`; гость → 401 `auth_required`.
- `PATCH /profiles/me` — правка ТОЛЬКО своей записи: плоские `displayName` (1–24 видимых
  символа), `bio` (≤280), `avatarCharacterId` (null или id из своих characters);
  идентификационные ключи (id/login/role/…) отбиваются `unknown_keys`; невидимые/bidi-символы
  вырезаются тем же классом, что в sanitize.js; UTF-8 длины считаются по код-поинтам.
  Identity — строго из сессии (cookie), CSRF-щит на PATCH. Правка legacy-строки без профиля
  и есть «опубликовать карточку».
- Клиент: страница `/players` (players-catalog.tsx, 628, только elyria) — карточки, поиск
  `?q` (debounce 300 мс), пагинация по `nextCursor`, deep-link `?id=`,
  инлайн-редактирование своей; ошибки сервера показываются целиком.

- `POST/GET/DELETE /sprites/mine*` — личные окрасы игроков (#83): сессионная зона на стеке
  `/profiles/me` (гость → 401 `auth_required`); на public-хосте (гроты) — 404 `not_found`
  host-гейтом; unsafe-cookie POST/DELETE — Origin-щит `csrfDecision` (403 по матрице B1).
  Загрузка: multipart `file` (один PNG; IHDR 100–1000 px, площадь ≤600k px, тело ≤1 МБ,
  проверка при чтении) + `name` (2–24 кодпоинта, NFC, без control/bidi — как sanitize.js);
  `category`/`id`/`owner` из запроса игнорируются: категория «Мои окрасы» — серверная
  константа, id — транслит-слаг имени (никогда из uploaded filename), владелец — из сессии.
  Дедуп sha256 тела своего же окраса → 200 существующего (слот не тратится — защита от
  даблклика). Лимит 3/аккаунт (`MAX_SPRITES_PER_ACCOUNT`, 409 `limit`), rate 5/час + 20/день
  на аккаунт (429 `rate`, in-memory — сброс при рестарте норма), аудит `sprites-audit.jsonl`
  (append-only). Модерация: PATCH `/admin/sprites/:id` `hidden:true` — строка уходит из
  каталога/whitelist/spriteIdAllowed (PNG-файл-улика остаётся на диске); DELETE `/sprites/mine/:id`
  — владелец или админ, «одет» → 409 `worn` (сначала переодеться).
  Перекопированный редактор KNS Paint — публичная статика `/paint-demo/` на обоих сайтах
  (#84 ч.1, синхронизация версий — байт-в-байт shasum-сверкой из репо kns).
  Мост редактор↔игра (#84 ч.2, только Элизия): кнопка «Нарисовать окрас» в профиле →
  `/paint-demo/?back=profile` (allowlist значения back — анти-open-redirect) → «Сохранить и надеть»
  одним действием (POST /sprites/mine + PATCH /profiles/me {sprite}) → возврат deep-linkом
  `/players/?id&mine=<id>#settings` с подсветкой плитки. Мост — третий файл
  `public/paint-demo/game-bridge.js` (копия редактора не тронута, один шов перед </body>,
  гейт check:paint-seam); из www-grotto вырезан.
  Решение владелицы 2026-11-10: окрасы CatWar в игре не используются, пак изображений
  в этом репозитории не лежит. Личная загрузка PNG и редактор KNS Paint остаются.

## 8. Хранение (`DATA_DIR`, деплой его не затирает)

| Файл | Содержание |
| --- | --- |
| `accounts.json` | `{v, accounts: {id: {id, login, pass{algo,N,r,p,salt,hash}, role, createdAt, profile{displayName?,bio?,avatarCharacterId?}, characters, activeCharacterId}}}` |
| `sessions.json` | `{v:1, sessions: {[token]: {accountId, createdAt, expiresAt}}}`; токен 32 hex-байта, TTL 14 дней, отзыв = удаление записи |
| `test-cats.json` / `test-map.json` | как раньше; ключ позиций = имя персонажа |
| `runtime-config.json` | значения whitelist-ключей (см. §6); v1-atmo-only читается миграцией |
| `room-configs.json` | F2 §6a per-room overrides {v:1, rooms:{[id]:{[key]:value}}}; corrupt → `.corrupt-<ts>.json`, бэкапы `room-configs.backup.<ts>[-N].json` |
| `cfg-backups/` | 8 последних версий конфига (restore по имени отсюда) |

Записи атомарные (`writeFileAtomic`), JSON, один event loop — без SQLite. Зависимости из
`node:crypto` (scrypt) — новых npm-пакетов нет.

## 9. Миграция существующих данных

- Книга позиций не конвертируется: ключ `login.toLowerCase()` остаётся; регистрация «тем же
  именем» подхватывает старую клетку персонажем с этим именем (restoreCatPosition).
- Имя занято в accounts.json → регистрация отказывает (`taken`), позиция под старым именем
  не теряется и не перетирается чужим registered.
- Потолок `MAX_ACCOUNTS` (env, дефолт 500 — решение владелицы 2026-11-08): при достижении регистрация отвечает `full`.
- Скины/СП в localStorage не трогаются; сервер не хранит СП персонажа (сессия подставляет
  name/sprite/size активного персонажа).
- Карта Элизии и бэкапы не мигрируют: формат тот же. Гость в гроты — как раньше.

## 10. Preview (dual-host)

Один VPS с продом, каталог `/opt/coop-field-preview/pr-<N>/`, один room-инстанс
(порт `41000 + PR%1000`), **два** сайта:

- `https://pr-<N>.abnocw.phainonsmilk.ru` → `…/pr-N/www-grotto/` (публичные гроты);
- `https://pr-<N>.elysiae.phainonsmilk.ru` → `…/pr-N/www-elyria/` (Элизия).

Оба хоста проксируются в один инстанс; Host-классы разруливает сервер (env `PUBLIC_HOSTS` /
`ELYRIA_HOSTS` пишет preview-apply). Конвейер из двух workflow: `preview-build.yml`
(pull_request, без секретов, артефакт с ОБОИМИ корнями; шаг «Изоляция вариантов (A1)» —
`npm run check:variants` — гоняется ПОСЛЕ сборки обоих корней и ДО упаковки артефакта) и
`preview-deploy.yml` (workflow_run — исполняется из main, держит `PREVIEW_SSH_KEY`).
TLS per-host (root-cron, первый apply до ~5 минут на http). Снос на closed/merged; лимит
8 живых превью. Полная механика и проверки доверия —
[PREVIEW-ENVIRONMENTS.md](PREVIEW-ENVIRONMENTS.md).

Инфраструктура dual-host (nginx-фрагмент с двумя server-блоками, per-host TLS-cron,
bootstrap юнита/sudoers, preview-apply) живёт в отдельной ветке
`feature/preview-dual-host-infra` и до её влития (отдельный инфра-PR; изменения VPS —
только по явному «ок» владелицы) превью-деплой остаётся на действующем пайплайне из
main; репо-часть конвейера в этой ветке — только preview-build.yml,
включая шаг изоляции A1.

## 11. Карта платформенных модулей (лимит 800 строк)

| Модуль | Строк | Ответственность |
| --- | ---: | --- |
| `server/config.js` | 386 | host-политика `hostClassOf` (public/elyria/local), env сплитов PUBLIC_HOSTS/ELYRIA_HOSTS, WS_MAX_PER_IP/ROOMS_MAX (S5) |
| `server/net.js` | 388 | HTTP host-гейт (404 зон Элизии на public), per-destination Origin/CSRF fail-closed (B1), per-IP сокет-лимит (S5a), /health clientIpMode (S4) |
| `server/auth.js` | 538 | сессии, cookie HttpOnly host-only/Lax/Secure, матрица токенов, rate-лимиты, /auth/* |
| `server/modes.js` | 45 | каталог комнат + RETIRED_ROOMS (combat→grot-1) |
| `server/room.js` | 460 | join-гейт `auth_required`, roomsinfo-призрак, алиас roomOf, потолок живых комнат ROOMS_MAX → rooms_full (S5b) |
| `server/accounts.js` | 372 | scrypt-стор, publicAccount/publicProfile, BOOTSTRAP_ADMIN миграционный + promoteToAdmin только из make-admin CLI (S1), MAX_ACCOUNTS |
| `server/profiles.js` | 430 | HTTP /profiles*: каталог (?q/?limit/?cursor), карточка, правка своего профиля |
| `server/cfg-registry.js` | 295 | whitelist 5 ключей + формулы клэмпов (maxStrikeDamage, snapArmorToUniverse) + метаданные списочных мутаций (B2) |
| `server/runtime-config.js` | 357 | значения v2, read-time миграция v1, бэкапы, HTTP /cfg(+admin-роуты) |
| `server/combat.js` | 285 | клэмпы боя поверх ARMOR_CURVE (капы из реестра на каждом событии) |
| `src/lib/site.ts` | 28 | канон варианта NEXT_PUBLIC_SITE (дефолт grotto); импорт запрещён всем, кроме самого site.ts (isolatedImports) |
| `src/lib/net/modes.ts` | 163 | клиентский каталог комнат — зеркало modes.js; href/карточки боевых миров в мёртвых IS_ELYRIA-тернарниках |
| `src/lib/net/auth.ts` | 30 | WS-кадры auth без ?t= (cookie-сессия) |
| `src/lib/net/http-auth.ts` | 93 | auth-only HTTP-клиент /auth/* + общие хелперы apiFetch/asText/asId/ApiRow |
| `src/lib/net/http-profiles.ts` | 152 | клиент каталога профилей (?q/?limit/?cursor, карточка, правка своей) |
| `src/lib/net/http-cfg.ts` | 335 | админ-CRUD конфига: /cfg* fetch-обёртки + чистые draft/diff-функции (React — в cfg-dashboard) |
| `src/lib/net/cfg-live.ts` | 122 | universes из GET /cfg: кэш на вкладку, дефолты при сбое, снап к дефолту |
| `src/lib/cfg-registry.ts` | 139 | зеркало реестра для клиента (паритет — parity-гейт) |
| `src/components/sim/auth-panel.tsx` | 189 | форма входа/регистрации (только elyria): reason→человекочитаемые тексты, локальная валидация, автофокус, сброс пароля после выхода (B6) |
| `src/components/sim/settings-panel.tsx` | 1222 | ролевой рендер вкладок (role из whoami; паролей нет) |
| `src/components/players/players-catalog.tsx` | 918 | каталог игроков /players (поиск ?q, пагинация nextCursor, deep-link, правка своей) |
| `src/components/admin/cfg-dashboard.tsx` | 736 | админ-дашборд /admin: реестр/списки разрешённых значений (B2)/restore/export/import, диф-предпросмотр |
| `src/app/*/page.tsx` | 11–13 | оболочки Simulator: `/` hub, `/combat/` beer, `/game/` elision (+ `/elision/` — redirect-стаб), `/hunger/` каркас, `/players/`, `/admin/` |

## 12. Совместимость провода

События не менялись (реестры 23+23, канон W3; матрица routers — AGENTS.md). Гостевой
`join {room, login, sprite, size}` в открытые комнаты работает как раньше — старые клиенты и
`scripts/test-ws.mjs` ходят без сессии. Новое — только HTTP-поверхность и поведение
сервера по классу хоста; `?t=` на Элизии выключен по умолчанию (env-тумблер на переход),
на public/local — прежние пути живы. Инварианты шага/координат/`update cat`/leave-маркера
не тронуты. `?room=combat` не ломается: алиас RETIRED_ROOMS ведёт в grot-1.
