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
   ссылки на чанки цельны. В deploy-frontend.yml — шаг «Изоляция вариантов (A1)» после
   сборки обоих корней, до выкладки.

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
| `public` (гроты) | `/auth/*`, `/profiles/*`, `/admin/*`, `/cfg/admin*`, `/cfg/export`, пишущие `POST /cfg*` → **404 `not_found`** (гейт server/net.js); `GET /cfg` (значения) и геймплей — ок | `register`/`login` → `{ok:false, reason:"error"}` (спокойный отказ) | **cookie-only** (A7, 2026-11): `?t=` игнорируется; кадр `whoami` токен не возвращает. `hello` с `payload.token` требует Origin своего класса |
| `elyria` (Элизия) | всё API открыто | обычно | **cookie-only**: `?t=` игнорируется (флаг `AUTH_LEGACY_TOKEN` удалён, A7); токен не выдаётся ни в теле HTTP, ни в кадре `whoami`. `hello` с `payload.token` требует Origin своего класса (`originOk`) |
| `local` (dev/тесты) | всё API, пермиссивно | работают | прежнее поведение: `?t=` + токен в HTTP-телах и в кадре `whoami` — на нём стоят test-auth/test-флои; `hello` с токеном без Origin по-прежнему жив |

Cookie `coop_session`: `HttpOnly; Path=/; Max-Age=14д`, **host-only** — атрибута Domain
намеренно нет (B1): кука привязана к точному хосту, соседний сайт её не увидит. На https —
`Secure + SameSite=Lax` (P1; легаси-флаг `COOKIE_LOOSE` удалён, A7), на http — `SameSite=Lax`. CSRF-щит (B1, fail-closed
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
| `admin` | два пути: (1) одноразовый CLI `node scripts/make-admin.mjs <login> [pass]` (server остановлен; повышает существующий аккаунт с сохранением пароль-хеша ИЛИ создаёт аккаунт сразу с ролью; повтор — idempotent; понижения не умеет) — первый админ / офлайн; (2) живой админ через `POST /admin/players/promote {login}` (панель «Игроки на поле», role-gate admin, CSRF). Env `BOOTSTRAP_ADMIN` МИГРАЦИОННЫЙ: имена читаются, но при регистрации роли НЕ назначают — сервер пишет в лог warning «bootstrap имя занято; назначьте роль через scripts/make-admin.mjs». Поле `role` в `accounts.json` — прямой путь для migrateStore (существующие админы старого механизма сохраняются при старте) | + GET/POST /cfg/admin-роуты (реестр, история, restore, export/import), админ-вкладки панели (ролевой рендер), дашборд /admin, `POST /admin/players/promote`. `setmap` принимает только role=admin в комнате test; пароль не проверяется |

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

## 10. Preview (сняты)

PR-превью (`pr-<N>.*`) сняты 2026-11-14 по решению владелицы: ими не пользовались, а их сертификаты выбирали недельный лимит Let's Encrypt на `phainonsmilk.ru`.
Серверный класс инстанса `preview` в `server/config.js` остался (мягкие лимиты
регистрации); новых preview-инстансов не создаётся. Прежняя механика — в истории git
(`docs/PREVIEW-ENVIRONMENTS.md` до 2026-11-14).

## 11. Карта платформенных модулей (лимит 800 строк)

| Модуль | Строк | Ответственность |
| --- | ---: | --- |
| `server/config.js` | 386 | host-политика `hostClassOf` (public/elyria/local), env сплитов PUBLIC_HOSTS/ELYRIA_HOSTS, WS_MAX_PER_IP/ROOMS_MAX (S5) |
| `server/net.js` | 388 | HTTP host-гейт (404 зон Элизии на public), per-destination Origin/CSRF fail-closed (B1), per-IP сокет-лимит (S5a), /health clientIpMode (S4) |
| `server/auth.js` | 538 | сессии, cookie HttpOnly host-only/Lax/Secure, матрица токенов, rate-лимиты, /auth/* |
| `server/modes.js` | 45 | каталог комнат + RETIRED_ROOMS (combat→grot-1) |
| `server/room.js` | 460 | join-гейт `auth_required`, roomsinfo-призрак, алиас roomOf, потолок живых комнат ROOMS_MAX → rooms_full (S5b) |
| `server/accounts.js` | 507 | scrypt-стор, publicAccount/publicProfile, BOOTSTRAP_ADMIN миграционный + promoteToAdmin (CLI make-admin и POST /admin/players/promote), MAX_ACCOUNTS |
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

События не менялись (реестры 23+24, канон W3; матрица routers — AGENTS.md). Гостевой
`join {room, login, sprite, size}` в открытые комнаты работает как раньше — старые клиенты и
`scripts/test-ws.mjs` ходят без сессии. Новое — только HTTP-поверхность и поведение
сервера по классу хоста; `?t=` на Элизии выключен по умолчанию (env-тумблер на переход),
на public/local — прежние пути живы. Инварианты шага/координат/`update cat`/leave-маркера
не тронуты. `?room=combat` не ломается: алиас RETIRED_ROOMS ведёт в grot-1.


### Admin console v0.6.7 (2026-11-16)

The current access contract supersedes earlier admin-only descriptions above. Legacy `account.role=admin` retains full access. Configurable roles live in `DATA_DIR/access-roles.json`, assigned through `profile.accessRoleId`; permissions are overview, players, roles, world, config, sprites, textures, invites, news, announcements and statuses. Cosmetic `profile.statusId` is independent and never grants privileges. Auth HTTP/WS replies include `permissions`; server gates enforce each section independently. Map save requires world permission or legacy admin.

`server/admin-console.js` owns `/cfg/console`: overview statistics/system/version, users, role CRUD/assignment, field occupancy/spawns, teleport and account deletion. Cookie Origin/CSRF and public-host hiding apply; OPTIONS permits preflight without bypassing mutation authorization. Deletion checks a separate server password with rate limiting, rejects self-deletion and protects legacy admins from custom roles; the existing eraseAccount workflow cleans account files and sessions. `server/admin-world.js` resolves explicit map spawns, falling back to the existing free-spawn algorithm on older maps; only trusted server options bypass join cooldown.

`server/admin-audit.js` atomically stores the newest 50 changes in `admin-audit.json`. HTTP success hooks, registration and map-save hooks record grouped events; passwords and invite values are excluded. The general view shows system status above the journal, with filters and scrolling after ten rows. Invites, news and announcements are general subtabs; users/administration, access roles and cosmetic statuses share a separate section. World settings retain config and armor; assets retain sprite/texture tools. Game version is v0.6.7.

Profile sidebar `profile-user-info.tsx` shows birthday (public month/day), cosmetic position and social links. `profile-social-fields.tsx` edits these from primary information. `server/profile-links.js` validates HTTPS and official network hosts; public DTOs expose links but never access-role assignments or permissions. Regression: `scripts/test-console-profile.mjs` covers RBAC/cosmetic separation, host/CSRF/CORS, deletion, persistence, social validation, teleport and journal retention.

### Оформление сайта (2026-11-16)

`server/site-design.js` обслуживает `GET /cfg/site-design` (публичные безопасные
настройки оформления) и `POST /cfg/site-design` (полный валидированный снимок,
право `textures`). `POST /cfg/site-design/assets/{frame|divider|background|button|fontFile}`
принимает до 2 МиБ PNG/JPEG/WebP/GIF или WOFF2 для шрифта. SVG-загрузки запрещены;
исходные SVG-орнаменты и PNG для девятисегментной рамки входят в статику. Файлы адресуются SHA-256 и читаются через
`GET /cfg/site-design/files/<hash>.<ext>` с фиксированным MIME и immutable cache.
Все маршруты скрыты на public-хосте; запись проходит общий cookie/Origin/CSRF-гейт
`net.js`, затем проверку сессии и права `textures`. Значения CSS, произвольные URL
и пути не принимаются: только разрешённые шрифты, диапазоны, hex-цвета, серверные
ресурсы и исходные пути. Снимок и файлы записываются атомарно в
`DATA_DIR/site-design/`; смена оформления попадает в журнал `textures`.

`src/lib/site-design.ts` зеркалит JSON-схему и исходные значения сервера.
`SiteDesignProvider` монтируется только в Elysiae, применяет CSS-переменные и
обновляет настройки раз в минуту. Шрифт WOFF2 загружается через FontFace API.
`Ресурсы → Сайтовые текстуры` позволяет загрузить ресурсы, настроить срез рамки,
размеры текста/заголовков, цвета, прозрачность и подписи пяти карточек профиля.
Предпросмотр локален для вкладки администратора; загрузка ресурса сама по себе
не публикует его. Кнопка сохранения применяет снимок всем посетителям. Отмена
и уход со вкладки снимают предпросмотр; сброс сначала меняет черновик и требует
сохранения. Серверный перезапуск сохраняет настройки. Оригиналы и старые версии
загруженных ресурсов сохраняются для отката. Игровые текстуры поля независимы.

Регрессия: `npm run test:console-profile` проверяет публичное чтение,
ограничение доступа, CSRF/host-гейты, загрузку, лимит размера, запрет SVG,
сохранение после перезапуска и восстановление исходного оформления.

Навигация админки (2026-11-16): основные разделы и их подразделы находятся
в одном блоке DashShell. ConsoleSubtabs переносит навигацию в общий слот через
React portal; содержание остаётся ниже блока. При каждом входе оба уровня
закрыты, прежний localStorage-ключ elyria-admin-tab больше не читается и не
пишется. Повторное нажатие сворачивает раздел или подраздел. Раскрытие общего
блока анимируется CSS grid, содержимое появляется с коротким fade/slide;
системный prefers-reduced-motion отключает анимацию. Закрытая навигация inert,
кнопки объявляют aria-expanded/aria-controls.

Исходное оформление возвращено к золотой рамке ornamental-frame.svg и простым
линиям. Собственные загрузки и остальные настройки сохранены. При чтении старого
снимка прежние встроенные site-frame.png/site-divider.svg заменяются исходными,
срез/толщина/высота корректируются только при их прежних исходных значениях.
Пользовательские загруженные файлы, шрифт, размер текста и другие настройки
не сбрасываются. Регрессия миграции входит в test:console-profile.

### Игровой HUD, предметы и инвентарь (2026-11-16)

Элизия использует `sim/inventory/game-hud.tsx` поверх поля: компактный чат слева
снизу, вертикальное меню под часами/погодой, хотбар снизу по центру. Основные
переключатели находятся в небольшом окне настроек; прежний SettingsPanel
встраивается во вкладку «Расширенные». Памятка под кнопкой книги использует общие
CONTROL_ROWS из key-hint. Кнопка игроков пока не выполняет действий. B/И открывает
инвентарь вместо переключения боя; бой включается кнопкой в настройках. 1–5 и
Numpad1–5 выбирают слот, ничего не расходуя. Окна закрываются Escape, учитывают
фокус и останавливают удержанные игровые клавиши. В редакторе его B и остальные
сочетания остаются прежними. Публичные гроты сохраняют прежние колонки и клавиши.

`server/inventory-store.js` хранит каталог и инвентари в атомарном
`DATA_DIR/inventories.json` (v1). Ключ инвентаря — accountId:characterId; отдельные
персонажи не разделяют содержимое. Снимок: version, bag[10], hotbar[5]; слот —
null либо {itemId,quantity}. Одинаковые предметы объединяются в стеки. Вес считается
на сервере в целых сотых, общий потолок 30 включает оба массива. Выдача сверх
лимита или при отсутствии свободного слота отклоняется целиком. Перемещение
проверяет version: конкурентный/повторный запрос со старой версией получает 409.
Переносит весь стек, объединяет одинаковые либо меняет разные стеки местами.
Клиент не передаёт вес или количество при перемещении. Админская выдача использует
operationId; последние 1000 отпечатков сохраняются и предотвращают повторную
выдачу при сетевом повторе, включая перезапуск сервера. При удалении аккаунта
его инвентари и идентификаторы повторов очищаются.

| HTTP | Доступ и действие |
| --- | --- |
| GET /cfg/inventory?characterId=… | Сессия; только собственный персонаж; без ID — активный. Снимок включает нужный каталог и общий вес |
| POST /cfg/inventory/move | Сессия, собственный characterId, version, from/to {area,index}; quick:true выбирает совпадающий/свободный слот другой области |
| GET /cfg/items | Право items; каталог |
| POST /cfg/items | Право items; создать/обновить id, name, weight, sprite; повышение веса запрещено, если перегрузит существующий инвентарь |
| POST /cfg/items/sprite | Право items; PNG до 2 МиБ, до 2048 по стороне и до 1 Мп; оригинальные байты без перекодирования |
| GET /cfg/items/files/<sha256>.png | Публичный PNG с фиксированным MIME, nosniff, immutable cache |
| GET /cfg/items/players | Право items; игроки, их персонажи и вес для выдачи |
| POST /cfg/items/grant | Право items; accountId, characterId, itemId, quantity, operationId |

Все маршруты скрыты на public-хосте и включены в общий Origin/CSRF-гейт /cfg.
Новые ресурсы хранятся в DATA_DIR/items. Изменения определений и успешные выдачи
попадают в admin-audit с группой items. Повтор запроса не дублирует запись выдачи.
Админка: Ресурсы → Предметы / Выдача предметов; отдельное право «Предметы и выдача».
Начальный каталог содержит nugget, «Наггетс», вес 3; исходный PNG из архива
владелицы сохранён без перекодирования в public/items/nugget.png (30×30, 1274 байта).
Замена через каталог сохраняется отдельно и не затирается встроенным спрайтом. Свойств использования, категорий, выбрасывания и мира-подбора
в этой версии нет. Идентичные предметы можно распределить по областям; повторная
выдача дополняет существующий стек.

`use-inventory.ts` получает свой снимок раз в 3 секунды и при фокусе. Запись ждёт
ответа сервера; устаревшая версия обновляет снимок и показывает сообщение.
Pointer Events поддерживают перетаскивание и Shift + ЛКМ; слева сверху слота
количество, справа снизу суммарный вес. Полёт через Web Animations и мягкое
сжатие/пружина слота отключаются при prefers-reduced-motion. Клавиши не работают
в полях ввода и не переключают бой.

Чат сохраняет события chat/chatlog и прежний лимит 200 символов, 450 мс на
отправителя и историю 40 сообщений на канал. Дополнительные поля сообщения:
channel:global|near, room, characterId. Рядом — только текущая комната; Глобал —
авторизованные сокеты всех мировых test-комнат, без публичных гротов. Новичок
получает до 40 глобальных и 40 локальных записей. Истории живут в памяти. Старые
клиенты без channel отправляют локально. Клиент различает сообщения по тройке
channel/room/seq, рисует новые сверху и сохраняет позицию при чтении старых.

Регрессии: test:inventory (владение, персонажи, стеки, 15 слотов, общий вес,
конкурентные переносы, повтор выдачи, PNG, журнал, перезапуск, удаление аккаунта)
и test:chat-channels (две локации, глобальный/локальный канал, история, гроты,
общий cooldown). Обе входят в CI.

### World items and mouth (2026-11-16)

GET `/cfg/inventory/world?characterId=…` returns only the active live character's
room ground, player mouth state and incoming offers. POST to the same path accepts
`drop` (`from` bag/hotbar slot or `"mouth"`, x/y in cell fractions), `mouth`/`take`
(ground UUID), `offer` (target live cat ID), `accept`/`cancel` (offer UUID).
Inventory mutations include the current `version`; stale/racing writes fail.
Ground coordinates are checked against the location's actual mask and trees.
Pickup uses a 70px circle: hypot(dx×100,dy×150)<=70 from authoritative feet.
Offers retain distance <=1.5 cell units.
A drop removes one unit; mouth holds one unit outside the 30-weight sum and stays
with its character across passage travel/reconnect/restart. F merges into an
existing bag stack or the first empty bag slot, enforcing weight and bag capacity.
Accepted transfers atomically empty sender mouth and fill recipient mouth, without
changing either bag. Offers retain ownership at sender, expire in 20 seconds and
invalidate on departure, distance, version change or occupied recipient mouth.
Ground and mouth are additive fields in the same inventories.json v1 file;
old inventories default to no mouth/ground. No item properties or categories added.

Mouse drops include expectedItemId so a concurrently replaced slot/mouth cannot
drop a different item than the one displayed on the cursor.

`release` derives the drop point from the live character's feet (repeat R).
`stash` takes `to:{area,index}` (or first free/matching hotbar slot if omitted),
adds exactly one mouth unit, applies the shared 30-weight limit and requires an
empty or matching target. Failure leaves the mouth unchanged. Client transfers
use two clicks, preserving the held cursor item after a rejected operation.
World items render within the scene below weather and all UI, at identical
30px fitted size on the ground/in the mouth; no raw sprite bytes are changed.

Optional catalogue property `glows:boolean` (default false) is editable with the
existing items permission. Invalid non-boolean input is rejected; omitted fields
retain existing values for older clients. It changes appearance only, with no
inventory weight/effect changes. Items emit light at progress [2,4), with smooth
fade at dusk/dawn; fireflies appear at [3,4). Both use the room's atmosphere clock.
Ground item hover now reveals name/weight/glow information regardless of distance;
all pickup buttons and R/F remain disabled beyond authoritative pickup range.

World-item GET/POST accepts the current socket's `catId`. It is resolved only
inside the authenticated account and character. This distinguishes simultaneous
game tabs and avoids checking actions against another tab's feet/location.
Reachable UI requires both the rendered and the latest authoritative feet to be
within 70px. Offers stay bound to their original sender/recipient actor IDs.
Inventory errors render once (inside the inventory or beside the hotbar), and
transient action errors clear after 4.5 seconds.

Glow controls (2026-11-17): optional `glowIntensity` (0–3, default 1),
`glowPeriod` (0 or 0.5–60 seconds, default 0 = steady), and boolean `sparkle`
(default false) use the existing item-write permission. Invalid values reject
the whole save; omitted fields preserve stored values for older clients.
A smooth pulse varies between 60% and 100% of configured intensity; it never
extinguishes the source. Gem sparkle adds a small periodic cross glint without
modulating the base light. Both renderers use the same energy/timing model.

Friend request notifications (2026-11-17): the friendship domain registers a
pending-request predicate with notifications, avoiding circular imports. Both
notification list/read responses and unreadCount expose only still-pending
incoming requests. Accepted, declined, cancelled, reciprocal and legacy resolved
rows remain private journal history and are filtered immediately. New payloads
include requestId; legacy rows must be at least as recent as the current request,
so a new request does not revive an earlier notification. Announcements and
read/unread semantics for active requests are unchanged.
Successful client friendship mutations emit friends:changed; the bell and open
profile refresh immediately and ignore obsolete requests. Opening a catalogue
profile fetches its full card immediately instead of waiting for the 20-second
poll. Missing friends metadata displays «Загружаем друзей…» with role=status and
aria-busy; an empty list is rendered only after data arrives. Own-profile friends
come from the fresh full card, with /profiles/me as the initial fallback.
