# ARCHITECTURE.md — карта coop-field as-is и путь к цели

Сопутствует [AGENTS.md](../AGENTS.md): там — маршруты агента и контракт протокола, здесь —
глубина: слои, потоки данных, зеркала-инварианты, координатные системы и целевая структура
рефакторинга (волны W3–W5). Читай секцию задачи, не весь файл.
Платформа (аккаунты, режимы, сессии) — [PLATFORM-ARCHITECTURE.md](PLATFORM-ARCHITECTURE.md);
аудит продукта — [PRODUCT-ROADMAP.md](PRODUCT-ROADMAP.md).

Состояние чисел: `wc -l` на 2026-11-06 (main = `060a51f`; волны W3–W5b слиты; в CI числа бережёт
гейт `npm run check:landmarks`, W7a). Карта as-is честная: god-файлы разобраны — `server.js` (2701)
разрезан волной W4 на тонкий вход 10 строк + модули `server/`; из `simulator.tsx` (8221 → 7523 (W5a)
→ 4388 (W5b) → 4477 сегодня) остаётся разрезать меньшинство. Размер — это долг, а не норма:
**новые файлы >800 строк запрещены** (`npm run arch:check`).

## 1. Слои и границы

```
src/components/sim/   UI: канвас-сцена, HUD, панели, экраны.             ← знает всё ниже
src/lib/net/          транспорт комнаты: сокет, reconnect, диспетчер.  ← знает sim, не знает UI
src/lib/sim/          чистая логика: математика боя, поля, раскладки.   ← не знает ни сети, ни UI
server.js             комната: комнаты, клетки, бой, чат, атмосфера,    ← отдельный процесс,
                       персистентность, HTTP/WS-транспорт                  не импортируется клиентом
```

- Направление зависимостей только вниз: `components → lib/net → lib/sim`.
- **Гейт в CI**: `src/lib/**` не импортирует из `src/components/**` (scripts/check-architecture.mjs).
Сегодня это правда репо, гейт её замораживает.
- `server.js` и клиент связывает ТОЛЬКО протокол `[event, payload]` — никакого общего кода
  между ними нет, все совпадающие константы скопированы руками (раздел 4).
- Фронт — статика (`output: "export"`): ни серверного рендера, ни API-роутов Next в рантайме.
  Комната — обычный node-процесс с `ws`; Vercel её не держит.

## 2. Карта модулей as-is

### Фронт

| Модуль | Строк | Ответственность (диапазоны) |
| --- | ---: | --- |
| `src/components/sim/simulator.tsx` | 4834 | Остаток после выносов W5a+W5b (behavior-preserving): стейт/refs-пояс и сетевые колбэки 233–873; вызов buildEditorOps :888 (тела — ./simulator/editor-ops.ts); эффекты атмосферы/комнат/подсказки боя ~1041–1274; главный rAF 1275–4145 (оставлен на месте: ~2700-строчное замыкание с deps `[stage]`, `const loop` :4064 — целиком свыше лимита 800, а разрывать переменные цикла нельзя без изменения поведения); ручной угол/клавиатура/мышь 4025–4122, вызов buildPointerTools :4146 (тела указателей — ./simulator/pointer-tools.ts, удар — ./simulator/hooks/use-strike.ts); патчи настроек 4150+ (patchField :345 — перенесён выше вызова buildEditorOps); entry-флоу/theme ~4258–4370; JSX-каркас 4371–4609 (панели — ./simulator/components/*) |

| `src/components/sim/simulator/` вынос W5b | 4678 | Хуки/JSX/фабрики, вырезанные из simulator.tsx (behavior-preserving, проверено байт-в-байт diff): hud-canvas.ts 225 (HUD-плашка суток+погода), sim-model.ts 178 (AtmoClock/FloatLabel/Step/Engine типы, fmtSec, remote-draw хелперы), hooks/use-keyboard.ts 257 (window keydown/keyup/blur, deps []), hooks/use-network.ts 641 (сетевой эффект coop-клиента, deps [loaded, netStarted, applyNetFight, wantedRoomIds]), hooks/use-canvas-layers.ts 186 (useAimPublisher/useSpriteCache/useAtmosphereLayer), hooks/use-strike.ts 277 (броня+удар: landStrike/doStrike, doStrikeRef), editor-ops.ts 734 (операции черновика локации как per-render фабрика; клетки/спавны/заходы вынесены в editor-cells.ts, «Перенести» — в editor-select.ts), pointer-tools.ts 670 (мышиные обработчики канваса), editor-cells.ts 196 (земля/покрытие/боевая клетка/спавн/заход), editor-select.ts 197 (инструмент «Перенести»: вырезать/потащить/поставить), components/chrome.tsx 404 (SimulatorHeader — кнопки «Погода»/«Сутки», ColResize/SettingsPanelOverlay/RoomSwitchOverlay), components/editor-overlay.tsx 692 (панель редактора + прогресс сохранения), components/field-stage.tsx 159 (рамка канвасов+легенда) |
| `src/lib/sim/` вынос W5a-1 | 980 | Чистые модули, вырезанные из пояса simulator.tsx (behavior-preserving): engine-consts.ts 109 (именованные константы+STORAGE-ключи, пометки [MIRROR] у DUMMY_DEFAULT/RAB_POS), geometry.ts 109 (spriteBoxOf/якоря стрелы/coveredRatio/nearestEntryCell), targeting.ts 151 (правило удара pickStrikeTarget — зеркало server.js aimedNeighbor, STRIKE_RESPONSE_MS), combat-log.ts 187 (layout колонок+STORAGE, mergeLog/CombatState), particles.ts 55 (спринт-частицы), paint.ts 311 (кисть PaintXP: материалы/штампы/undo/encode, синхронный+асинхронный PNG), editor-model.ts 93 (типы редактора+EDITOR_PASS_KEY) |
| `src/lib/sim/settings.ts` | 1131 | Модель боя: STRIKE_ZONES, ARMOR_CURVE (:572), DAMAGE_LEVELS (:527), спрайты (31), замедление, атмосфера-типы; ~54 экспорта |
| `src/lib/sim/test-field.ts` | 2155 | Играбельная площадь «Элизии»: проходимость клеток и anchor-точек, route-граф, рендер кромки (марширующие квадраты + Чайкин), paint-маска, дешёвые клипы клеток рельефа, лицевая стена блока по квадранту камеры, кэши; мутабельные модульные синглтоны (раздел 5) |
| `src/lib/sim/test-map.ts` | 736 | Модель конфига локации v1/v2 + клиентский sanitize; TEST_MAP_LIMITS (:304) — зеркало серверных лимитов |
| `src/lib/sim/atmosphere.ts` | 529 | Атмосфера: облака/дождь — Pixi-оверлей, тонировка суток — цветная вуаль «source-atop» на мировом холсте (один fillRect за кадр; без заливки текстуры мира в GPU и без SVG-фильтров) |
| `src/lib/sim/elision-babylon.ts` | 307 | WebGL-вид только страницы `/elision/`: динамический `import()` Babylon `Engine` (не WebGPU), чанк не входит в гроты. Земля — пиксели кисти, без рисунка — остров травы тем же контуром. Коты и камни/деревья — горизонтальные декали. Камера ортографическая, формулы в `elision-scene.ts`. Нет WebGL — остаётся 2D-холст. Редактор прячет вид, чтобы кисть писала в прежний канвас |
| `src/lib/sim/` прочее | ~355 | keys.ts 73 (физическая раскладка WASD), remote-aim.ts 92 (чужой прицел), textures.ts 136, theme.ts 54 |
| `src/lib/net/coop.ts` | 552 | Транспорт: выбор сокета (prod по домену, preview `*.abnocw.miew.ru` → свой `/ws`, `?ws=` на localhost), reconnect backoff, диспетчер входящих; имена событий и guard-валидаторы — из `./protocol` (W3) |
| `src/lib/net/protocol.ts` | 367 | Client-side protocol canon (W3): mirrored `EV.*` registries (23+23, auth/whoami), payload types, guards; re-exports sim-owned constants from `settings.ts`/`test-map.ts` |
| `src/lib/net/move-book.ts` | 89 | Предикт своих шагов (≤1 неподтверждённый), откат по refuse, достройка чужих котов. Эталон чистоты для новых модулей |
| `src/components/sim/` прочее | ~2650 | settings-panel.tsx 1315 (панель настроек, 25 пропсов/10 колбэков — разрез в W5, вкладка справочника), entry-screen.tsx 626, room-picker 143, room-chat 126, fight-log 71, beer/theme-бэкдропы |

### Сервер (тонкий вход `server.js` 10 строк + модули `server/`; разрез волной W4, behavior-preserving)

Вход `node server.js` только вызывает `startServer()` из `server/net.js` — весь код переехал
в модули ниже; все имена событий — только `EV.*` из `server/protocol.js` (W3-канон).

| Модуль | Строк | Что |
| --- | ---: | --- |
| `server/config.js` | 137 | env (PORT/HOST/DATA_DIR/ADMIN_PASS), Origin-политика REQUIRE_ORIGIN, payload/frame limits, поле (WIDTH/HEIGHT/SPAWNS/PALETTE), whitelist 31 спрайта, имена котов |
| `server/protocol.js` | 284 | канон W3 + auth/whoami: реестры EV.* 23+23, зеркальные константы (кулдауны, лимиты, ARMOR_CURVE, зоны, atmo, геометрия прыжка/dummy/rab) |
| `server/testmap.js` | 493 | конфиг локации: defaultTestMap, sanitizeTestMap (cols 6–60, rows 3–40, zones ≤48, objects ≤2000), атомарная запись, карантин битых конфигов, setmap-хендлер (админ-пароль, бэкапы, рассылка map+field), live-геометрия testMap/TEST_* |
| `server/world.js` | 663 | чистая геометрия по конфигу: PNG-кисть (декод zlib, маска земли), марширующие квадраты+Чайкин, island/cells, препятствия, высоты, обрывы (`cliffBetween`), entry-клетки — бит-в-бит зеркало клиентской |
| `server/sanitize.js` | 95 | чистые валидаторы входа: clipChars/sanitizeChat (контрольные/bidi, ≤200)/sanitizeLogin/uniqueLogin + chat-хендлер (450 мс, история 40) |
| `server/room.js` | 431 | комнаты: roomOf, жизнь пустой комнаты 10 мин, join (кулдаун 1/с, свободная клетка, you+field+chatlog+move, Элизия без сессии → auth_required)/leave, publicCat/поле, send/broadcast, спрайт, block, space (присед — clamp hold 0–4000), roomsinfo |
| `server/movement.js` | 295 | очередь шагов 80 мс×3, move-хендлер с refuse-кодами, freemove, cellsync, jump (кулдаун 450, 8 направлений, 1–3 клетки, charge 0..1) |
| `server/combat.js` | 271 | aim (коалесценция 20 мс)/strike: aimedNeighbor — зеркало pickStrikeTarget, зоны удара, броня по ARMOR_CURVE; урон/броня клиент-авторитетные |
| `server/dummy-rab.js` | 133 | манекен (доли клетки, перенос grab/drop), мишень РАБ, toggle-режимы dummy/rab |
| `server/atmo.js` | 118 | якорь суток/погоды (фазы 4×pl, погода wl/ws), atmo/atmoset/atmoState/atmoBroadcast; дефолт новых комнат из runtime-config |
| `server/persist.js` | 134 | книга позиций котов data/test-cats.json, TTL 30 дней, троттлинг записи 1/3 с, flushCatBook/restoreCatPosition |
| `server/net.js` | 221 | транспорт: http statics+`/health`+`/auth`+`/cfg`, ws-accept (verifyClient+Origin, heartbeat 30 с), onMessage-диспетчер по EV.*, таймеры (слив позиций 2 с, тикер атмо 5 с), SIGTERM/SIGINT-флаш; startServer() — единственная точка старта |
| `server/modes.js` | 37 | каталог комнат и доступа: `test` registered-only, гроты/combat/hunger открыты |
| `server/accounts.js` | 318 | аккаунт/профиль/персонаж, scrypt, `accounts.json` |
| `server/auth.js` | 461 | сессии, HTTP `/auth/*`, WS `auth`/`whoami`, handshake `?t=` / cookie |
| `server/hunger.js` | 11 | каркас раунда idle, без выдуманных правил |
| `server/runtime-config.js` | 248 | безопасные длины суток новых комнат, HTTP `/cfg`, бэкапы |
| `server.js` | 10 | тонкий вход W4: импорт startServer() из `server/net.js` и вызов; юнит деплоя не изменился |

### Сценарии и деплой

`scripts/` — 37 файлов: к npm подключены test:ws (контракт комнаты, 1104 строки),
test:queue (self-spawn), test:unit (3 юнита движка), arch:check; прочие — ручные пробы
и ops, часть с прод-дефолтами (чистятся в W2). `deploy/vps/` — образец systemd-юнита,
apply.sh (health-check, рестарт только при изменении), nginx-www.conf, отдельный
package.json комнаты (`ws` — синхронно с корневым lockfile, гейт check-ws-versions).

## 3. Потоки данных

### Join (вход в комнату)

```
клиент ── auth {action, login, pass, token?}  (необязательно; гость пропускает)
сервер ── whoami {ok, role, login, accountId, token?}
клиент ── join {room, login, sprite, size} ──► сервер
сервер ── you (свой publicCat)     ──► только владельцу   } ответ на(join) всегда эта
сервер ── field (снимок комнаты)   ──► только владельцу   } тройка, в этом порядке
сервер ── chatlog (≤40 последних)  ──► только владельцу
сервер ── move  (publicCat входящего) ──► всем остальным
```

Отказ: `info` (кулдаун, логин занят) или `noplace` (потолок 30 / нет клеток /
`auth_required` для комнаты `test` без сессии). Личность registered-сокета
берётся из сессии (handshake query `t` / cookie / `auth hello`), не из
`join.login`. Гостевой `join` в гроты без изменений.
Reconnect после обрыва: backoff 1–2–4…30 c, повторный join; движение и удары до
переподключения заблокированы.

### Move (шаг клетки) — предикт/эхо/refuse

```
клиент: send move ──► move-book.ts ставит предикт (≤1 неподтверждённый шаг)
сервер: очередь 80 мс, глубина 3; занято/край/обрыв → refuse {code}
сервер: update cat (эхо) ──► всем, включая ходока
клиент: эхо своего хода → applyOwnMoveAck (подтвердить предикт); refuse → rejectOwnMove (откат)
```

Инвариант: **каждый ход = ровно один ответ**. Молчание расходит предикт с сервером —
кот «телепортируется». Чужие коты достраиваются по темпе клетки (60 мс), отставание >4
клеток — мгновенная постановка в серверную клетку.

### Strike (удар)

```
клиент ── strike {target, zone, angle, flightMs} ──► сервер (кулдаун 25 мс, молчаливый drop)
сервер: pickStrikeTarget-зеркало aimedNeighbor решает, в какую часть идёт удар
        (диагонали, блок → «Лапы», хвост блоком не ловится)
сервер ── fight {attacker, target, зона, урон} ──► всей комнате после flightMs (0–600, деф. 170)
```

Урон присылает бьющий (clamp 0..100), сервер режет его бронёй цели и НЕ рассылает значение
`armor` соседям — они видят уже порезанный урон в `fight`. Клиент-авторитетность урона —
осознанный долг песочницы (W3 его не закрывает: канонизируются константы и имена, ответственность не меняется).

### Atmo (сутки/погода)

```
любой игрок ── atmo {dp,w} / atmoset {pl,wl} ──► сервер
сервер ── atmo {t, cs, pl, wl, w, ws, dp} (якорь) ──► ВСЕМ, включая инициатора (эхо = подтверждение)
```

Клиент едет по ЛОКАЛЬНЫМ часам от якоря `t`; тикер сервера раз в 5 с resendит якорь только
при смене dp/w; на rejoin якорь приезжает внутри `field`. Копии фаз суток/погоды: server/atmo.js
и coop.ts теперь читают их из зеркальных реестров (`server/protocol.js` ↔ `src/lib/net/protocol.ts`,
parity в CI, W3); тестовая копия `scripts/test-atmo-sync.mjs` синхронизируется руками —
канонизировать тестовые скрипты не входило в W3.

### Setmap (редактор локации)

```
клиент ── setmap {pass, map} ──► sanitize: v 1|2, cols 6–60, rows 3–40, zones ≤48, objects ≤2000
сервер: атомарная запись data/test-map.json (+8 бэкапов), тестовая прогонка
сервер ── map (новый конфиг) ──► каждому сокету комнаты «test»
сервер ── field (свежий снимок) ──► всем: сетка, dummy/rab/atmo пересчитаны
```

### Freemove/cellsync (мирный режим «Элизии», только комната «test»)

```
мирная ходьба: freemove {x,y} — доли клеток, бродкаст ≤1/50 мс остальным
вход в бой:    cellsync {x,y} — 1-based клетка, обязана быть walkable или entry-заходом,
               занятая → кольцо радиусом ≤6 ищет свободную; ответ update cat ВСЕМ
```

## 4. Зеркала-инварианты клиент ↔ сервер

Парный код НЕТ общего модуля. Since W3 the mirrors are pinned by CI: event names and
constants live in two mirrored registries — `server/protocol.js` (server side) and
`src/lib/net/protocol.ts` (client side; sim-owned values are re-exported from
`settings.ts`/`test-map.ts`, not copied). Gates: `npm run check:protocol`
(AGENTS.md doc tables == registries) and `npm run test:protocol-parity`
(client == server == golden values). **Менять только синхронно, в одном PR;**
таблица ниже обязательна к прочтению перед правкой любой из сторон.

| Инвариант | Клиент | Сервер | Комментарий |
| --- | --- | --- | --- |
| Кривая брони ARMOR_CURVE | `src/lib/sim/settings.ts` (re-exported by `protocol.ts`) | `server/protocol.js` | single source per side (W3); интерполяция урона по пресету 0–0,9 |
| Правило «в кого попадает удар» | `src/lib/sim/targeting.ts` pickStrikeTarget (вынос W5a-1) | `server/combat.js` aimedNeighbor (:76; W4-carve; прежний server.js:1806) | комментарий сервера: «то же правило, что pickStrikeTarget в симе» |
| Зоны удара и урон уровней | `settings.ts` DAMAGE_LEVELS (zones re-exported by `protocol.ts`) | `server/protocol.js` STRIKE_ZONES | single source per side (W3); урон/части/диагонали |
| Отклик удара 170 мс (деф.) | `settings.ts` strikeResponseMs (re-exported as STRIKE_CATCH_MS); движковая копия `src/lib/sim/targeting.ts` STRIKE_RESPONSE_MS (вынос W5a-1) | `server/protocol.js` STRIKE_CATCH_MS | single source per side (W3); плюс clamp 0–600 flightMs |
| Пропускные клетки земли GROUND_COVER_IDS | исходник `test-map.ts` GROUND_COVER_OPTS → производные списки: `protocol.ts`, `src/lib/sim/paint.ts` (Set, вынос W5a-1) | `server/protocol.js` | single source per side (W3); было три независимые копии |
| Лимиты локации TEST_MAP_LIMITS | `test-map.ts` (re-exported by `protocol.ts`) | `server/protocol.js` (sanitize uses it) | single source per side (W3); редактор не предложит конфиг, который сервер отвергнет |
| Максимальный уровень высоты TERRAIN_MAX_LEVEL=10, шаг ELEV_STEP_MAX=1, прыжок JUMP_MAX_UP=3 / JUMP_CHARGE_HALF=0.5 / JUMP_CHARGE_FULL=1 | `test-map.ts` elevStepOk/elevJumpOk (re-exported by `protocol.ts`); мирная ходьба — `surfaceLevelOf`/`pointInSouthWallOf` (нарисованный верх и южная стена при перепаде >1) | `server/protocol.js` + `server/world.js` elevJumpOk, surfaceLevel, inSouthWall | single source per side; вверх на 4+ нельзя, вниз на 4+ — полный заряд; спина высокого плато пешком не берётся |
| Дальность/дуга прыжка | `simulator.tsx` leapLandingAt: точка под курсором, дальность ≤3 клетки, перепад по elevJumpOk | `server/movement.js` jump (charge 0..1) | кулдаун 450 мс с обеих сторон (`JUMP_COOLDOWN_MS` in both registries, W3) |
| Заряд приседа по hold | `simulator.tsx:2587` (`0.15 + 0.85·hold/4000`) | `server/room.js` space (:377; clamp hold 0–4000; W4-carve) | формула анимации — клиентская, сервер хранит только флаг sq |
| Клетка мишени РАБ | `protocol.ts` RAB_CELL mirror + движковая копия `src/lib/sim/engine-consts.ts` RAB_POS (0-based, вынос W5a-1) | `server/protocol.js` RAB_CELL (1-based) | single source per side (W3); сервер не рассылает позицию |
| Дефолт манекена DUMMY_DEFAULT | рендер по `dummyState` (сервер присылает всё) | `server/protocol.js` | сервер — источник; клиентские дефолты не дублируются |
| Формат кадров `[event, payload]` | `coop.ts:325+` (диспетчер, имена через `protocol.ts` EV.*/guards) | `server/net.js` onMessage-диспетчер (имена через `server/protocol.js` EV.*) | «move» с x:0/y:0 — маркер выхода: двойной смысл сохраняется (canon: `isCoopCat` guard пропускает оба, потребитель различает по нулям) |

## 5. Координатные системы

В репо ТРИ системы, смешение — типичный источник багов:

| Система | Диапазон | Где живёт |
| --- | --- | --- |
| Сетевая (1-based) | клетка `x=1..W`, `y=1..H` в протоколе и publicCat | server/room.js + server/movement.js (join/move/jump/cellsync), поле |
| Модель канваса (0-based) | `col=0..W-1`, `row=0..H-1` | simulator.tsx, move-book.ts, test-field/test-map (ключи «c,r») |
| Доли клетки fx/fy | позиция внутри клетки 0..1; мирный режим живёт в мировых дробных координатах | freemove/dummyMove, рендер переходов |

Переводы: сетевая → модель: `col = x-1, row = y-1`. Углы: 0° вправо, далее по часовой;
нормализация wrap360, округление 0.1° на границе сети.

Сцена Элизии (Babylon, WebGL, только `/elision/`): px мира канваса переводит одна функция `worldPxToScene` в `src/lib/sim/elision-scene.ts` — `(x, lift, z = y)`. Второго ±1 нет: к кадру сеть уже стала `col`/`fx`. Камера в правой системе Babylon наклонена на 45°, вертикаль ортопроекции компенсирует сжатие земли: плоская карта совпадает с `screenToWorld`, высота даёт тот же экранный сдвиг вверх, что 2D. Грани left < right сохраняют правильное frustum-отсечение. `elision-present.ts` кэширует полный атлас поверхности (кисть/трава, покрытия, заходы, сетка зон `cells` и объектов `battle`); смена карты, декод кисти, догрузка пака и возврат из редактора обновляют атлас. Babylon использует его на земле и поднятых верхах клеток, строит стены только на перепадах `map.elev`; соседние клетки одной высоты не имеют общей стены. Высоты берутся из той же карты, что ходьба, шаг — `TERRAIN_LIFT_PX`. Рисунок земли загружается без invertY (верх PNG на z=0), декали повёрнуты на −π/2 вокруг X. Клики остаются на 2D-холсте; редактор скрывает WebGL, пивные гроты слот не монтируют, без WebGL остаётся прежний холст.

## 6. Мутабельные синглтоны test-field.ts

`test-field.ts` держит модульное состояние: `currentMap` (:47), paint-кэш (:99–104),
`rndShared` (:342), island-кэш (:370–371), objCache (:489). Это осознанный контракт:
**один монтаж Simulator на процесс** — `setTestMap` подменяет конфиг и сбрасывает кэши,
следующий кадр считает новую локацию. Следствия:

- Нельзя монтировать два Simulator в одном процессе (StrictMode-двойное монтирование
  переживается, т.к. пересоздание идёт тем же конфигом; тесты с разными картами —
  последовательные, не параллельные).
- Юнит-тесты test-field гоняют через самопроверку в scripts/ или dogfood-сценариями,
  не через параллельный jest-подход с общим модулем.
- W5 (разрез движка) обязан сохранить семантику «конфиг глобален на процесс» или
  ввести явный инстанс-контекст — это смена контракта, отдельно от behavior-preserving
  этапа 1.

## 7. Целевая структура (реализуется волнами W3–W5)

### W3: протокол-канон — DONE

Landed in this wave (branch `refactor/protocol-canon`):
- `server/protocol.js` — canonical registries: 22 client→server + 22 server→client event
  names (`EV.*`, incl. `update cat`) and all mirrored constants (cooldowns, limits,
  ARMOR_CURVE, strike zones, atmo lists, jump/dummy/rab geometry). server modules import
  everything from it — no inline duplicates left (checked by `check:protocol`,
  which since W4 scans `server.js` AND every `server/*.js` except protocol.js itself).
- `src/lib/net/protocol.ts` — mirrored client registry: same `EV.*`, payload types,
  guard validators; sim-owned values (ARMOR_CURVE, TEST_MAP_LIMITS, TERRAIN_MAX_LEVEL,
  zones, 170 ms response) are RE-EXPORTED from `settings.ts`/`test-map.ts`, not copied.
  `coop.ts` dispatches on `EV.*` + guards instead of string literals and blind casts.
- Legacy removed after grep proof of zero consumers: `first` join alias, `huntMode`
  field (was always false). No other wire changes.
- CI gates: `check:protocol` (doc tables == registries + no literal duplicates across
  server.js + server/*.js) right after `arch:check`; `test:protocol-parity` (client == server ==
  golden) in the unit-test block, node 22 in CI, honest SKIP under node < 22.6.
- Deploy learned the new `server/` directory: rsync in deploy-backend.yml, install +
  hash into the restart marker in `deploy/vps/apply.sh`.
- Not done here (left for later waves, on purpose): `onInfo` still parses russian
  text in some consumers — MVP guards cover only mechanically safe casts; W4 server.js
  module split — done by W4 (see §7); simulator.tsx emit literals untouched (W5).

### W4: разрез server.js → тонкий вход + модули — DONE

Landed (branch `refactor/server-carve`, behavior-preserving): server.js (2666 строк)
carved verbatim into 12 flat `server/*.js` domain modules — config, protocol (W3, untouched),
testmap, world, sanitize, room, movement, combat, dummy-rab, atmo, persist, net (+ thin 10-line
server.js entry that only calls `startServer()`). Wire format, protocol
and persistence are byte-identical: only import/export plumbing and 5–10-line
contract headers are new code. Live `export let` bindings preserve the old
single-file read-latest semantics for module-owned reassigned state
(testMap/TEST_* in testmap.js).

New gates with this wave:
- `check:protocol` (check-protocol-sync.mjs) now scans `server.js` AND every
  `server/*.js` (except protocol.js, the canon itself) for string-literal event
  duplicates. 
- `test:server-modules` (scripts/test-server-modules.mjs, in CI): imports every
  server module without network side effects and pins 84 golden checks — pure
  functions (armorMultiplier/ARMOR_CURVE interpolation, resolveZone, parseMove,
  sanitizeChat/Login, uniqueLogin, geometry buildIsland/buildCells path) must
  return exactly the values the pre-carve monolith produced (goldens were
  generated by executing the pre-carve server.js functions directly).

Originally planned subdirectories (http.js/ws.js, rooms/, testmap/, persist/)
folded into flat single modules where the domain fit the 80–800-line rule —
the actual landed map is authoritative, see §2. Deploy path `node server.js`
unchanged; `server.js` dropped from SIZE_ALLOWLIST (arch:check now guards it
at the 800-line limit like any other file). Мерж за заказчицей.

### W5: разрез simulator.tsx + settings-panel

```
lib/sim/          + geometry.ts, angles.ts, combat-log.ts, persist.ts, particles.ts, leap.ts,
                    peace-walk.ts, camera.ts, weather-clock.ts, paint.ts, targeting.ts,
                    engine-consts.ts        (выносы этапа 1 — behavior-preserving)
components/sim/   simulator/ index.tsx, use-game-loop.ts, use-network.ts, use-editor.ts,
                    use-battle.ts, use-settings-patches.ts
                  panel/ panel.tsx, tab-{field,arrow,slowdown,combat,config}.tsx, controls.tsx,
                    zone-target.tsx, live-angle.tsx   (dispatch вместо 10 колбэков)
                  shell/  entry-screen, room-picker, room-chat, fight-log, бэкдропы
```

Этап 1 — чистые выносы lib/sim; этап 2 — компонент-каркас. Оба этапа закрываются
dogfood-сценариями (мир, бой с entry-клетки, редактор с undo, переподключение, смена карты)
и `__simState`-зондом. test-field/settings/test-ws выпадают из SIZE_ALLOWLIST.

Этап 1 частично закрыт волной W5a (2026-11): engine-consts/geometry/targeting/combat-log/
particles/paint/editor-model вырезаны из пояса simulator.tsx и возвращены импортом
(behavior-preserving; карту — §2/§4). Остались выносы этапа 1: angles.ts, persist.ts, leap.ts,
peace-walk.ts, camera.ts, weather-clock.ts (задевают rAF-замыкание или дедупликацию —
следующие пул-реквесты; актуально и после W5b).

Этап 2 DONE волной W5b (2026-11-05, branch `refactor/sim-carve-stage2`, PR #16):
hooks (use-keyboard 238, use-network 621, use-canvas-layers 157, use-strike 277),
hookless factories (editor-ops 785, pointer-tools 605 — per-render builders, no hooks),
HUD dial (hud-canvas 241 at the carve; 225 today), sim-model (types, fmtSec, remote-draw helpers — lives in
components because it consumes lib/net), JSX chrome (chrome.tsx 367, editor-overlay 623,
field-stage 138) — 11 modules, byte-identical bodies against pre-carve git snapshots.
simulator.tsx: 8221 → 7523 (W5a) → 4388 lines at the W5b landing — 4524 today, after the post-carve fix PRs (atmo lifecycle, cols clamp, cursor DPR, editor draft WYSIWYG, editor wheel zoom). Kept ON PURPOSE (behavior > counters): the main rAF
closure (~2700 lines, single `useEffect` with deps `[stage]`, `const loop` at :3993) —
extracting it whole would recreate a >800-line file, splitting it would re-wire engine
variables; state/refs belt of `Simulator()`; small callback/patch belts (мелкая крошка —
запрет пере-дробления). Stage-1 leftovers (angles/persist/leap/peace-walk/camera/
weather-clock) remain — they interlock with the same rAF closure and are follow-ups.

После W5 allowlist становится пустым — гейт 800 строк держит всю кодовую базу «чистой»
без исключений.

## 8. Правила поддержания этой карты

- Изменение модуля (±100 строк, новые секции) — обнови строку в таблице раздела 2.
- Меняешь потоки данных или зеркала — разделы 3/4 в том же PR (директива заказчицы №4:
  актуализация документации правилом, а не только дисциплиной).
- W3 догму сделала гейтом: `check:protocol` (док-таблицы == реестры, без строк-дублей в
  server.js + server/*.js) и `test:protocol-parity` (клиент == сервер == golden) уже в CI — зеркала
  раздела 4 больше не держатся одним ревью.
- Размерные числа в картах сверяны с `wc -l` на 2026-11-06 (W7a; в CI — гейт `check:landmarks`); при расхождении доверяй
  `wc -l`, а не этой таблице, и обнови её.
