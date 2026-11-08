# ARCHITECTURE.md — карта coop-field as-is и путь к цели

Сопутствует [AGENTS.md](../AGENTS.md): там — маршруты агента и контракт протокола, здесь —
глубина: слои, потоки данных, зеркала-инварианты, координатные системы и целевая структура
рефакторинга (волны W3–W5). Читай секцию задачи, не весь файл.
Платформа (аккаунт/профиль, два сайта, реестр конфига, роли, хост-изоляция) — [PLATFORM-ARCHITECTURE.md](PLATFORM-ARCHITECTURE.md);
аудит продукта — [PRODUCT-ROADMAP.md](PRODUCT-ROADMAP.md).

Состояние чисел: `wc -l` на 2026-11-08 (ветка `feature/elyria-platform-admin-profiles`, этапы
P1–P6 платформы; в CI числа бережёт гейт `npm run check:landmarks`, W7a). Карта as-is честная:
god-файлы разобраны — `server.js` разрезан волной W4 на тонкий вход 10 строк + модули `server/`;
из `simulator.tsx` (8221 → 4953 сегодня) остаётся разрезать меньшинство. Размер — это долг, а не норма:
**новые файлы >800 строк запрещены** (`npm run arch:check`).

## 1. Слои и границы

```
src/components/sim/   UI: канвас-сцена, HUD, панели, экраны.             ← знает всё ниже
src/lib/net/          транспорт комнаты: сокет, reconnect, диспетчер,     ← знает sim, не знает UI
                      HTTP-флоу аккаунта/профилей/конфига (P3–P4)
src/lib/sim/          чистая логика: математика боя, поля, раскладки.    ← не знает ни сети, ни UI
server.js             комната: комнаты, клетки, бой, чат, атмосфера,      ← отдельный процесс,
                       персистентность, HTTP/WS-транспорт, /auth//cfg/    не импортируется клиентом
                       /profiles (P1–P4)
```

- Направление зависимостей только вниз: `components → lib/net → lib/sim`.
- **Гейт в CI**: `src/lib/**` не импортирует из `src/components/**` (scripts/check-architecture.mjs).
  Сегодня это правда репо, гейт её замораживает.
- `server.js` и клиент связывает ТОЛЬКО протокол `[event, payload]` — никакого общего кода
  между ними нет, все совпадающие константы скопированы руками (раздел 4).
- Фронт — статика (`output: "export"`): ни серверного рендера, ни API-роутов Next в рантайме.
  Комната — обычный node-процесс с `ws`; Vercel её не держит.
- **Один движок — два сайта (P3/P6).** Вариант сайта фиксируется при сборке через env
  `NEXT_PUBLIC_SITE=grotto|elyria` (`npm run build:grotto / build:elyria / build:variants`).
  Вариантозависимые модули сверяют env инлайном (`const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria'`
  в самом модуле): межмодульный импорт из `src/lib/site.ts` минифаером НЕ сворачивается, а инлайн-
  сравнение фолдится и мёртвая ветка вылетает из бандла целиком — в артефакте гротов нет ни
  текстов, ни кодовых имён Элизии. Второй рубеж — `scripts/prune-export.mjs` (P6): каталоги чужих
  маршрутов вырезаются из вариантного корня (grotto держит `/, combat/, hunger/`; elyria —
  `/, elision/, players/, admin/`); итоговые корни — `www-grotto/` и `www-elyria/`.
  Третий рубеж — серверная Host-изоляция (P1): класс запроса `hostClassOf` (public | elyria | local)
  по заголовку Host закрывает целые API-зоны на публичном сайте (детали — PLATFORM-ARCHITECTURE §5).
  Четвёртый рубеж — CI-гейт изоляции `npm run check:variants` (A1): после `build:variants` оба корня
  прогоняются гейтом — www-grotto не содержит НИ ОДНОГО маркера Элизии (включая латиницу `elisium`;
  кириллический греп недостаточен), www-elyria не содержит снятых маршрутов `/combat/` и `/hunger/`
  и несёт признаки живой Элизии, ссылки на чанки `_next/static/chunks/*` цельны. Шаг
  «Изоляция вариантов (A1)» в preview-build.yml идёт после сборки обоих корней и до упаковки артефакта.

## 2. Карта модулей as-is

### Фронт

| Модуль | Строк | Ответственность (диапазоны) |
| --- | ---: | --- |
| `src/components/sim/simulator.tsx` | 4953 | Остаток после выносов W5a+W5b (+ надстройки PR #41/#48 и мини-фолловап B6): `Simulator()` начинается :253 (стейт/refs-пояс, сетевые колбэки); вызов buildEditorOps :955 (тела — ./simulator/editor-ops.ts); эффекты атмосферы/комнат/подсказки боя; главный rAF-эффект с `const loop` :4237 (оставлен на месте: ~2700-строчное замыкание, deps `[stage]` — целиком свыше лимита 800, а разрывать переменные цикла нельзя без изменения поведения); вызов buildPointerTools :4381 (тела указателей — ./simulator/pointer-tools.ts, удар — ./simulator/hooks/use-strike.ts); патчи настроек; platform-вставки P3: инлайн IS_ELYRIA :117 — auth-колбэки и auth-пропсы `<EntryScreen>` :4758–:4765 существуют только в варианте Элизии (sendAuth :4563; setWhoamiGuarded :277 — фоновый WS-кадр `whoami` не затирает свежий отказ входа, окно 8 с, мини-фолловап B6; onLogin/onRegister/onLogout — тернарники IS_ELYRIA); localStorage-маршруты: STORAGE_KEY :727 (чтение СП)/:742 (запись), COMBAT_KEY :1218, сброс :4507–4508, ротация лога :4520. Элизия: рендер WebGL-вида и включение — simulate-сторона ниже |
| `src/components/sim/simulator/` вынос W5b (+ PR #48) | 5153 | Хуки/JSX/фабрики, вырезанные из simulator.tsx (behavior-preserving): hud-canvas.ts 225 (HUD-плашка суток+погода), sim-model.ts 178 (AtmoClock/FloatLabel/Step/Engine типы, fmtSec, remote-draw хелперы), hooks/use-keyboard.ts 257 (window keydown/keyup/blur, deps []), hooks/use-network.ts 641 (сетевой эффект coop-клиента; `setWhoami` сужен до `(row: CoopWhoami) => void`), hooks/use-canvas-layers.ts 191 (useAimPublisher/useSpriteCache/useAtmosphereLayer), hooks/use-strike.ts 277 (броня+удар: landStrike/doStrike), hooks/use-elision-view.ts 47 (реестр WebGL-слоёв Элизии: подключение Babylon-Engine поверх 2D-цикла), editor-ops.ts 733 (операции черновика локации как per-render фабрика; клетки/спавны/заходы — editor-cells.ts, «Перенести» — editor-select.ts; S2: пароль редактора в localStorage больше не живёт — при открытии сидит одноразовая миграционная чистка устаревшего ключа EDITOR_PASS_KEY, :199), pointer-tools.ts 670 (мышиные обработчики канваса), editor-cells.ts 196, editor-select.ts 197, elision-present.ts 287 (кадр WebGL-вида Элизии: собирает то, что 2D-цикл уже посчитал — камера, коты, камни/деревья, без второго перевода сетевых координат), components/chrome.tsx 408 (SimulatorHeader, кнопки «Погода»/«Сутки», ColResize/SettingsPanelOverlay/RoomSwitchOverlay), components/editor-overlay.tsx 692 (панель редактора + прогресс сохранения), components/field-stage.tsx 159 (рамка канвасов+легенда) |
| `src/lib/sim/` вынос W5a-1 | 1028 | Чистые модули, вырезанные из пояса simulator.tsx: engine-consts.ts 98 (именованные константы+STORAGE-ключи, пометки [MIRROR]), geometry.ts 133 (spriteBoxOf/якоря стрелы/coveredRatio/nearestEntryCell), targeting.ts 151 (правило удара pickStrikeTarget — зеркало server aimedNeighbor, STRIKE_RESPONSE_MS), combat-log.ts 187 (layout колонок+STORAGE, mergeLog/CombatState), particles.ts 55 (спринт-частицы), paint.ts 311 (кисть PaintXP: материалы/штампы/undo/encode, синхронный+асинхронный PNG), editor-model.ts 93 (типы редактора+EDITOR_PASS_KEY) |
| `src/lib/sim/settings.ts` | 1131 | Модель боя: STRIKE_ZONES, ARMOR_CURVE (:567), DAMAGE_LEVELS (:522), тайм-ауты брони, спрайты (31), замедление, атмосфера-типы; 60 экспортов |
| `src/lib/sim/test-field.ts` | 2155 | Играбельная площадь «Элизии»: проходимость клеток и anchor-точек, route-граф, рендер кромки (марширующие квадраты + Чайкин), paint-маска, дешёвые клипы клеток рельефа, лицевая стена блока по квадранту камеры, кэши; мутабельные модульные синглтоны (раздел 5) |
| `src/lib/sim/test-map.ts` | 736 | Модель конфига локации v1/v2 + клиентский sanitize; TEST_MAP_LIMITS (:304) — зеркало серверных лимитов |
| `src/lib/sim/atmosphere.ts` | 529 | Атмосфера: облака/дождь — Pixi-оверлей, тонировка суток — цветная вуаль «source-atop» на мировом холсте (один fillRect за кадр) |
| `src/lib/sim/elision-babylon.ts` | 307 | WebGL-вид только страницы `/elision/`: динамический `import()` Babylon `Engine` (WebGL, не WebGPU), чанк не входит в гроты; луна-декалями и трава. Нет WebGL — остаётся 2D-холст. Формулы сцены — elision-scene.ts |
| `src/lib/sim/elision-scene.ts` | 156 | Математика WebGL-сцены Элизии: `worldPxToScene` — единственный шаг px мира → сцена (второго ±1 нет), камера ортографическая повторяет `screenToWorld` |
| `src/lib/sim/` прочее | 355 | keys.ts 73 (физическая раскладка WASD), remote-aim.ts 92 (чужой прицел), textures.ts 136, theme.ts 54 |
| `src/lib/site.ts` | 28 | Канон варианта сайта (P3): `SITE` из `NEXT_PUBLIC_SITE`, дефолт `grotto` (fail-safe: пустой env — публичный сайт). Хелперы для кода вне React; вариантозависимый UI-код НЕ импортирует его для фолдинга — сверяет env инлайном (см. шапку модуля) |
| `src/lib/net/modes.ts` | 163 | Клиентский каталог комнат — зеркало `server/modes.js` (titles/access/href). В grotto-варианте комната `test` отсутствует напрочь; href и карточки боевых миров сидят в мёртвых ветках IS_ELYRIA-тернарников (COMBAT_HREF/HUNGER_HREF :38–:39, NAMED_ROOMS :84, MODE_COPY :117) — «мёртвая ветка умирает на сборке», в элизии-артефакте их нет. PlayMode — `'hub' \| 'beer' \| 'elision' \| 'hunger'`: отдельного режима combat больше нет, гроты = beer, страницы /combat/ остаётся входом в гроты |
| `src/lib/net/coop.ts` | 582 | Транспорт: выбор сокета по хосту (elisium.miew.ru/\*.elisium → same-origin `/ws` — ветка свёрнута инлайн-сравнением `process.env.NEXT_PUBLIC_SITE === "elyria"` ВНУТРИ условия wsUrlBase :193, не импортом константы: мёртвая ветка выкидывается из grotto-сборки целиком вместе с хостами Элизии, A1; превью pr-N.abnocw.miew.ru → свой `/ws`; легаси sslip/vercel → сокет комнаты; localhost → LOCAL_WS `ws://localhost:3780`), `httpOrigin()` :208 — база HTTP-флоу (auth/профили/cfg; same-origin на Элизии), reconnect backoff, диспетчер входящих (guard-валидаторы + `EV.*` из `./protocol`); `?t=` в URL не используется (P3 — cookie HttpOnly) |
| `src/lib/net/auth.ts` | 30 | Остаток WS-флоу сессии (P3): `whoami` пропускается как есть, payload кадров `auth` (hello — без токена: сессия приходит cookie на хендшейке) |
| `src/lib/net/http-auth.ts` | 93 | Auth-only HTTP-флоу (P3, сплит B-волны): `httpRegister/httpLogin/httpLogout/httpMe` (`/auth/register\|login\|logout\|me`, fetch с `credentials: "include"` против `httpOrigin()`) + общие низкоуровневые хелперы `apiFetch/asText/asId/ApiRow`, на которых стоят оба соседних модуля. Сплит — изоляция сборки: модуль-донор графа симулятора не должен тянуть серверные HTTP-маршруты Элизии в public-бандл гротов. В grotto-варианте эти клиенты в мёртвых ветках |
| `src/lib/net/http-profiles.ts` | 152 | Клиент каталога профилей (P4/B3): `httpProfileCatalog` (?q поиск по displayName, ?limit деф. 24, ?cursor keyset-пагинация), `httpProfileById`, `httpMyProfile`, `httpPatchProfile`; типы PublicProfile/ProfileCard/ProfilePatch |
| `src/lib/net/http-cfg.ts` | 521 | Админ-CRUD конфига (P4/B2 + F2): fetch-обёртки GET /cfg/admin, POST /cfg (apply/reset), POST /cfg/restore, GET /cfg/export, POST /cfg/import, F2 — /cfg/rooms* (list/config/update/reset-one/reset-all/history/restore) + ЧИСТЫЕ функции черновика/диффа — draftFromSnapshot (жёстко включает §4-флаги playerSelectable), cfgPatchFromDraft (шлёт флаги явно), canonByKind, buildCfgDiff (§4: choice-аспект «выбор игроками вкл/выкл» отдельной строкой, список при флипе не мутируется), narrowingWarning, listIssue, successText, applyBadgeText (listDiff/fmtNum). Реакт не здесь: UI черновика — в cfg-dashboard.tsx, UI комнат — в room-config-panel.tsx |
| `src/lib/net/cfg-live.ts` | 122 | Живые universes для UI (P3): один fetch GET /cfg на вкладку с кэшем; сбой → реестровые дефолты; выпавшее из списка сохранённое значение снапится к дефолту (`snapToAllowed` — не к ближайшему) |
| `src/lib/cfg-registry.ts` | 158 | Клиентское зеркало реестра конфига (P2+F2): подписи/юниверсы/дефолты 6 ключей (5 числовых + bool-гейт allowPlayerAtmosphereControl, default true); формул клэмпа на клиенте НЕТ (только сервер). Паритет — `test:protocol-parity` |
| `src/lib/net/protocol.ts` | 367 | Client-side protocol canon (W3): mirrored `EV.*` registries (23+23, auth/whoami), payload types, guards; re-exports sim-owned constants from `settings.ts`/`test-map.ts` |
| `src/lib/net/move-book.ts` | 89 | Предикт своих шагов (≤1 неподтверждённый), откат по refuse, достройка чужих котов. Эталон чистоты для новых модулей |
| `src/lib/net/gerta-catalog.ts` | 417 | Справочник Герты: типизированные карточки механик/констант из protocol.ts + реальные пути файлов (юнит-проверка путей — scripts/test-handbook.mts в test:unit). Карточки боевых миров — в мёртвой ветке IS_ELYRIA-тернарника (GROTTO_MECHANIC_CARDS :353, MECHANIC_CARDS :384/:410) — умирают на сборке элизии, в её бандле грот-механик нет |
| `src/components/players/players-catalog.tsx` | 628 | Страница-каталог игроков `/players` (P4+B3, только elyria): карточки из GET /profiles с серверным поиском `?q` (debounce 300 мс либо Enter/«Найти») и keyset-пагинацией `nextCursor` (клиент НЕ фильтрует — режет сервер), deep-link `?id=<accountId>`, инлайн-редактирование своей карточки (PATCH /profiles/me) |
| `src/components/admin/cfg-dashboard.tsx` | 738 | Админ-дашборд `/admin` (P4+B2, только elyria): реестр 6 ключей, apply-политики/подписи из GET /cfg/admin, редакторы СПИСКОВ разрешённых значений universes + ЯВНЫЙ тумблер «выбор игроками» (F2 §4: флип playerSelectable, список НЕ режется — off-then-on возвращает кураторский список, не юниверс), предпросмотр диффа «было → станет» (+N/−M, отдельная строка «Выбор игроками: вкл→выкл — список N зн. сохраняется на сервере») до отправки с вторым подтверждением, предупреждение сужения списка, сворачиваемые тех-детали, честные статусы ok/err c деталями провала, reset, restore по имени из истории, export/import JSON; секция «Комнатные настройки» (F2 §3) — RoomConfigPanel; рендер только при `role==='admin'` (гейт GET /auth/me) |
| `src/components/admin/room-config-panel.tsx` | 319 | F2 §3 per-room-панель (только elyria,AdminRender внутри cfg-dashboard): селект комнаты с бейджами overrides, таблица слоёв global/override/effective per-key (whitelist v1: phaseMin, weatherMin, гейт atmoset), редакторы (число — селект диапазона, гейт — чекбокс), «Применить override» / «Наследовать» per-key, «Сбросить всё» и restore — window.confirm, история бэкапов room-configs.json; клиент не источник истины — все write валидирует сервер |
| `src/components/sim/simulator/components/…` — см. carve-строку выше: JSХ-каркас | — | — |
| `src/components/sim/` прочее | 3108 | settings-panel.tsx 1240 (панель настроек, 30 пропсов; вкладки с `admin:true` рендерятся только при `props.role==='admin'` — роль истины на сервере, локальных паролей с P3 нет), entry-screen.tsx 644, gerta-handbook.tsx 201 (вкладка «Справочник» — карточки из lib/net/gerta-catalog.ts), auth-panel.tsx 162 (форма входа/регистрации Элизии, инлайн IS_ELYRIA; reason-тексты и локальные проверки живут в auth-reasons.ts — общий источник с гейтом menu/auth-gate.tsx: дрейф текстов между точками входа исключён; сброс пароля после выхода), auth-reasons.ts 73 (REASON_TEXTS taken/weak/short/full/rate/bad + localAuthError по серверным контрактам: логин 2–24, пароль ≥8; шарится с auth-modal), room-picker 154, room-chat 126, fight-log 71, бэкдропы beer 363 / theme 74 |

Страницы (static export, `src/app/`): `page.tsx` 16 (меню `/`, обёрнуто в AuthGate live+chrome), `combat/page.tsx` 13 (`<Simulator mode="beer">` — гроты, гейт не ставится), `elision/page.tsx` 16 (`mode="elision"`, AuthGate), `hunger/page.tsx` 11 (каркас «в разработке», без гейта), `players/page.tsx` 17 (+players-catalog, AuthGate), `admin/page.tsx` 17 (+cfg-dashboard, AuthGate). `Simulator({ mode = 'hub' })` — единственный тонкий проп режима; elyria-оболочки монтируют <AuthGate> (menu/auth-gate.tsx) — окно входа для подтверждённого гостя.

### Сервер (тонкий вход `server.js` 10 строк + модули `server/`; разрез волной W4, платформенные правки P1–P4 поверх)

Вход `node server.js` только вызывает `startServer()` из `server/net.js` — весь код переехал
в модули ниже; все имена событий — только `EV.*` из `server/protocol.js` (W3-канон).

| Модуль | Строк | Что |
| --- | ---: | --- |
| `server/config.js` | 386 | env (PORT/HOST/DATA_DIR/ADMIN_PASS — S2: дефолт устранён, fail-closed: без env парольный путь редактора мёртв; WS_MAX_PER_IP деф. 8 / ROOMS_MAX деф. 32 — S5), Origin-политика REQUIRE_ORIGIN, payload/frame limits, поле (WIDTH/HEIGHT/SPAWNS/PALETTE), whitelist 31 спрайта (:314), имена котов; host-политика P1: `hostClassOf` → public\|elyria\|local (env `PUBLIC_HOSTS`/`ELYRIA_HOSTS` дополняют дефолты точным именем или суффиксом зоны, превью-поддомены наследуют класс; неизвестный хост → public; S3: легаси-шаблон *.vercel.app удалён из списков) |
| `server/protocol.js` | 284 | канон W3 + auth/whoami: реестры EV.* 23+23, зеркальные константы (кулдауны, лимиты, ARMOR_CURVE, зоны, atmo, геометрия прыжка/dummy/rab). Платформой не тронут |
| `server/testmap.js` | 502 | конфиг локации: defaultTestMap, sanitizeTestMap, атомарная запись, карантин битых конфигов, setmap-хендлер (админ-пароль, бэкапы, рассылка map+field); S2: без env ADMIN_PASS парольный путь мёртв — редактор отвечает «закрыт», fail-closed |
| `server/world.js` | 663 | чистая геометрия по конфигу: PNG-кисть, марширующие квадраты+Чайкин, island/cells, препятствия, высоты, обрывы (`cliffBetween`), entry-клетки |
| `server/sanitize.js` | 95 | чистые валидаторы входа: clipChars/sanitizeChat/sanitizeLogin/uniqueLogin + chat-хендлер (450 мс, история 40) |
| `server/room.js` | 466 | комнаты: roomOf (+ алиас RETIRED_ROOMS combat→grot-1 для легаси ?room=combat), жизнь пустой комнаты 10 мин, join (кулдаун 1/с, свободная клетка, you+field+chatlog+move, Элизия без сессии → auth_required), leave, publicCat/поле, send/broadcast, спрайт, block, space, roomsinfo с призраком: гость про registered-комнату слышит `count 0, logins []` — как про несуществующую; S5b: потолок ЖИВЫХ комнат ROOMS_MAX (деф. 32) — новая комната сверх лимита → noplace `rooms_full`; F2: стартовый якорь atmo из per-room initialRoomAtmo (override комнаты → effective, без overrides → прежняя глобальная инициализация) |
| `server/movement.js` | 295 | очередь шагов 80 мс×3, move-хендлер с refuse-кодами, freemove, cellsync, jump |
| `server/combat.js` | 285 | aim (коалесценция 20 мс)/strike: aimedNeighbor — зеркало pickStrikeTarget, зоны удара, броня по ARMOR_CURVE; P2-клэмпы: урон s.events дополнительно зажат сверху по максимальному разрешённому уровню (`maxStrikeDamage` горло-формула), входящая броня снапится вниз к разрешённым десятым (`snapArmorToUniverse`), капы берутся из runtime-config на каждом событии |
| `server/dummy-rab.js` | 133 | манекен (доли клетки, перенос grab/drop), мишень РАБ, toggle-режимы |
| `server/atmo.js` | 128 | якорь суток/погоды (фазы 4×pl, погода wl/ws), atmo/atmoset/atmoState/atmoBroadcast; дефолт новых комнат из runtime-config; F2 §3.4 мин-диф: ранний return в atmo()/atmoset(), если per-room гейт allowPlayerAtmosphereControl=false (молчаливый drop — существующий формат отклонения кадров, без нового ответа) |
| `server/persist.js` | 134 | книга позиций котов data/test-cats.json, TTL 30 дней, троттлинг записи 1/3 с |
| `server/net.js` | 401 | транспорт: http statics+`/health` (с clientIpMode: 'loopback'\|'xff'\|'direct' — S4; loopback без XFF на прод-классе → warning в лог: темп-лимиты auth не работают), HTTP-цепочка handleAuthHttp → handleRoomCfgHttp (F2: room-роуты /cfg/rooms* ПЕРЕД глобальным /cfg-хендлером) → handleCfgHttp → handleProfilesHttp → static; host-гейт P1: на public-хосте /auth/\*, /profiles/\*, /admin/\*, /cfg/admin\*, /cfg/export, /cfg/rooms\* и пишущий POST /cfg\* → 404 `not_found`; B1: CSRF fail-closed per-destination — unsafe+cookie на public/elyria: пустой Origin → 403 `csrf_origin_required`, чужой → 403 `csrf_origin_mismatch` (local — прежний щит, `AUTH_CSRF_STRICT` форсирует); S5a: потолок ОДНОВРЕМЕННЫХ WS-сокетов с одного адреса WS_MAX_PER_IP — сверх info `too_many_sockets` и close; ws-accept (Origin, heartbeat 30 с), onMessage-диспетчер по EV.\*, таймеры, startServer() |
| `server/modes.js` | 45 | каталог комнат/доступа: grot-1..3/demo/hunger открыты, `test` registered-only; RETIRED_ROOMS frozen (combat → grot-1, история ссылок) |
| `server/accounts.js` | 372 | аккаунт/персонаж, scrypt, `accounts.json`; `publicAccount` (whoami/вход), `publicProfile` (DTO карточки: displayName, bio, avatarCharacterId, characters, createdAt — без login/role); S1: BOOTSTRAP_ADMIN — МИГРАЦИОННЫЙ список: при регистрации имя из списка получает роль registered + warning в лог, роль admin назначает ТОЛЬКО одноразовый CLI `scripts/make-admin.mjs` (promoteToAdmin вызывается им одним); MAX_ACCOUNTS (деф. 2000) |
| `server/auth.js` | 538 | сессии (sessions.json, токен 32 hex, TTL 14 дней), cookie `coop_session` HttpOnly host-only — атрибута Domain намеренно нет (B1), https: Secure+SameSite=Lax (env COOKIE_LOOSE=1 — легаси None), матрица токенов по классу хоста (`AUTH_LEGACY_TOKEN=1` возвращает ?t= на elyria), HTTP /auth/* (CSRF Origin на пишущих), WS auth-кадры (register/login отказ на public), rate-лимиты per-IP+per-login |
| `server/profiles.js` | 430 | HTTP-профили P4+B3: GET /profiles (каталог карточек по старшинству с серверным поиском ?q и keyset-пагинацией ?limit деф. 24/клэмп 48/?cursor base64), GET /profiles/:id, GET/PATCH /profiles/me (только своя запись, идентичность из сессии, валидация displayName≤24/bio≤280/avatarCharacterId из своих персонажей), CSRF на PATCH |
| `server/runtime-config.js` | 375 | runtime-конфиг v2: values-only {v, atmo, universes} в DATA_DIR/runtime-config.json, read-time миграция v1, атомарная запись + 8 бэкапов; HTTP: GET /cfg (публичный: значения+apply-подсказки, БЕЗ истории), admin-роуты GET /cfg/admin (значения+регистр+история+мета), POST /cfg (патч по реестру / reset; F2 §4: universes-ключи несут ЯВНЫЙ playerSelectable — три поля: allowedValues+default+флаг; старое тело без флага = прежняя косвенная семантика list>1, backward-compat), POST /cfg/restore (имя из listHistory — path-guard; restore тоже мигрирует §4-поля при загрузке), GET /cfg/export, POST /cfg/import (всё или ничего) |
| `server/cfg-registry.js` | 431 | whitelist-реестр P2+F2: 6 ключей — 5 числовых (atmo.phaseMin, atmo.weatherMin, universes.strikeDamage/armor/arrowSpeed) + bool-гейт `atmo.allowPlayerAtmosphereControl` (F2 §3.4, room-scope, default TRUE — not-in-uniors, валидация true/false only); sanitizeValues (всё или ничего; opts.room — строгий режим room-key), sanitizeList §4 (allowedValues ⊆ юниверса, default ∈ allowedValues, длины bounded, playerSelectable раздельно), formulas: `maxStrikeDamage` (горло = база зоны 42 + 3,67·уровень — зеркало клиентской zoneDamageFor), `snapArmorToUniverse` (снап вниз к разрешённым десятым) |
| `server/room-config.js` | 589 | F2 §3 per-room слой: NEW-модуль. Слои resolveEffective: движковые дефолты ← глобальный runtime ← явный per-room override; whitelist SUPPORTED_ROOM_KEYS v1 = atmo.phaseMin, atmo.weatherMin, atmo.allowPlayerAtmosphereControl (universes — v2 после боевой интеграции: combat.js потребляет combatCaps() глобально без контекста комнаты). Persistence: DATA_DIR/room-configs.json {v:1, rooms:{[id]:{[key]:value}}}, атомарная tmp+rename 0600, BACKUP_KEEP 8, corrupt → room-configs.corrupt-<ts>.json + warn + пустое состояние. HTTP /cfg/rooms* (list/state/update/reset-one/reset-all/history/restore) — те же admin/CSRF/origin/host-гейты, что /cfg; id канонизируется через RETIRED-алиасы, path traversal → reject; room-configs.json НИКОГДА не пишется atmoset-кадрами (архитектурная изоляция), гейт atmoset в atmo.js только читает |
| `server/hunger.js` | 11 | каркас раунда idle, без выдуманных правил |
| `server.js` | 10 | тонкий вход W4: импорт startServer() из `server/net.js` и вызов; юнит деплоя не изменился |

### Сценарии и деплой

`scripts/` — 60 файлов: к npm подключены test:ws (контракт комнаты, 1119 строки), test:queue
(self-spawn), test:unit (6 юнитов движка: keys/remote-aim/move-book/elev-rules/handbook/elision-scene),
test:auth (аккаунты/cookie/CSRF/host-гейт/roomsinfo-призрак, 830), test:cross-origin (B1:
per-destination Origin/CSRF/CORS-матрица ≥20 живых проб, 508), test:cfg (реестр:
80 чеков — 6-ключевой whitelist + §4 playerSelectable-мутации/миграция + B2-редактирование
списков + S1-эскалация через стоп→make-admin→рестарт-цикл), test:room-config (F2: слои,
гейт atmoset, persistence/бэкапы/restore, atmoset-штурм не трогает overrides, 69 чеков),
test:profiles (HTTP-профили), test:server-modules, test:protocol-parity, check:protocol,
check:landmarks, check:variants (A1: гейт изоляции артефактов, 168), arch:check;
`prune-export.mjs` (137, обрезка вариантных корней P6 + чистка немонтируемых чанков);
`make-admin.mjs` (76, одноразовый CLI владелицы: роль admin — только через него, S1;
запускать при остановленном сервере); прочие — ручные пробы и ops. `deploy/vps/` — образец systemd-юнита, apply.sh (health-check,
рестарт только при изменении), nginx-www.conf, юниты/sudoers/nginx превью (dual-host),
отдельный package.json комнаты (`ws` — синхронно с корневым lockfile, гейт check-ws-versions).

## 3. Потоки данных

### Join (вход в комнату)

```
клиент ── auth {action, login, pass}  (необязательно; гость пропускает)
сервер ── whoami {ok, role, login, accountId}
клиент ── join {room, login, sprite, size} ──► сервер
сервер ── you (свой publicCat)     ──► только владельцу   } ответ на(join) всегда эта
сервер ── field (снимок комнаты)   ──► только владельцу   } тройка, в этом порядке
сервер ── chatlog (≤40 последних)  ──► только владельцу
сервер ── move  (publicCat входящего) ──► всем остальным
```

Отказ: `info` (кулдаун, логин занят) или `noplace` (потолок 30 / нет клеток /
`auth_required` для комнаты `test` без сессии). Личность registered-сокета
берётся из сессии (handshake: таблица приоритета — Host-матрица: cookie на
Элизии, query `t` переходно на public и всегда на local; `auth hello` — в запасе),
не из `join.login`. Гостевой `join` в гроты без изменений.
Снятый код комнаты (`?room=combat`) алиасится в `grot-1` (RETIRED_ROOMS), а не
проваливается в произвольный open-grid. `roomsinfo` для гостя скрывает закрытую
комнату целиком: `count 0, logins []`, как у несуществующей (P1).
Переподключение: backoff 1–2–4…30 с, повторный join; движение и удары до
переподключения заблокированы.

### HTTP-поверхность платформы (P1–P4)

```
браузер Элизии (elisium.miew.ru)          room-сервер
POST /auth/register  {login,pass}  →  scrypt, accounts.json; Set-Cookie coop_session (HttpOnly)
GET  /auth/me                        →  {ok, role, ...} | {ok:true, role:"guest"}
GET  /profiles      → каталог карточек (?q поиск, ?limit деф. 24, ?cursor keyset);  GET /profiles/:id → карточка; PATCH /profiles/me → своя
GET  /cfg           → значения+apply-подсказки (публично, без истории)
GET  /cfg/admin     → значения+реестр+история (только role=admin, cookie-сессия)
POST /cfg | /cfg/restore | /cfg/import   → admin, CSRF Origin-щит (B1: per-destination fail-closed, пустой Origin → 403 csrf_origin_required)
```

Куки `HttpOnly`, host-only — атрибута Domain нет (B1); на https — `Secure + SameSite=Lax`
(`COOKIE_LOOSE=1` возвращает легаси `None`). Токен из тела ответа на Элизии не выдаётся
(cookie-only); класс local держит токены в телах — на нём стоят тесты. На public-хостах
все эти маршруты — 404 (host-гейт) до обработчиков.

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

Урон присылает бьющий (clamp 0..100), сервер режет его бронёй цели и с P2 дополнительно
зажимает сверху формулой зон по максимальному разрешённому уровню урона
(`maxStrikeDamage`), а входящую броню снапит к разрешённым десятым
(`snapArmorToUniverse`); значение `armor` соседям не рассылается — они видят уже
порезанный урон в `fight`. Клиент-авторитетность урона — осознанный долг песочницы;
реестр P2 ограничивает её разрешёнными юниверсами.

### Atmo (сутки/погода)

```
любой игрок ── atmo {dp,w} / atmoset {pl,wl} ──► сервер
сервер ── atmo {t, cs, pl, wl, w, ws, dp} (якорь) ──► ВСЕМ, включая инициатора (эхо = подтверждение)
```

Клиент едет по ЛОКАЛЬНЫМ часам от якоря `t`; тикер сервера раз в 5 с resendит якорь только
при смене dp/w; на rejoin якорь приезжает внутри `field`. Стартовые длины новых комнат —
из runtime-config (реестровые ключи atmo.phaseMin/weatherMin); живую комнату крутит atmoset.
F2 §3.4: гейт `atmo.allowPlayerAtmosphereControl` — per-room bool-override (default TRUE,
default preserves current gameplay); админ снял для комнаты → atmoset-кадры игроков
молчаливо отбрасываются сервером (atmo.js: ранний return, существующий механизм
отклонения невалидных кадров); live-атмосферу живой комнаты admin-изменение не трогает
(new-rooms-only), room-configs.json atmoset-кадрами не пишется вообще.

### Room-config слои (F2 §3 / §3.6)

```
движковые дефолты (cfg-registry defaultsFor)
   ← глобальный runtime (runtime-config.json, POST /cfg)
   ← явный per-room override (room-configs.json, /cfg/rooms*)   ← только whitelisted
эффективное значение = resolveEffective(roomId) — считается НА СЕРВЕРЕ
```

- explicit overrides only: комната без override наследует глобал; весь конфиг на комнату
  НЕ дублируется.
- new-rooms-only: override вступает при (пере)создании объекта комнаты (room.js читает
  initialRoomAtmo при создании); живая комната НЕ меняется.
- **WS-broadcast per-room конфига НЕ нужен** (F2 §3.6): клиенты получают effective
  через обычные существующие механизмы при создании комнаты (якорь в `field`), отдельных
  протокол-событий НЕТ — политика new-rooms-only снимает потребность в рассылке.
- Persistence: DATA_DIR/room-configs.json {v:1, rooms}; atomic write 0600, 8 бэкапов,
  corrupt-safe (боковой .corrupt-<ts>.json + warn). Restore валидирует и мигрирует.
- Роуты: GET /cfg/rooms | GET/PUT/DELETE /cfg/rooms/:id (слои global/override/effective
  + бейджи) | DELETE …/:key, …/all | GET …/history | POST …/restore — только admin
  (cookie-сессия + CSRF + origin), на public-хосте 404 как весь /cfg-подпространство.

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
| Правило «в кого попадает удар» | `src/lib/sim/targeting.ts` pickStrikeTarget (вынос W5a-1) | `server/combat.js` aimedNeighbor (W4-carve) | комментарий сервера: «то же правило, что pickStrikeTarget в симе» |
| Зоны удара и урон уровней | `settings.ts` DAMAGE_LEVELS (zones re-exported by `protocol.ts`) | `server/protocol.js` STRIKE_ZONES | single source per side (W3); урон/части/диагонали |
| Отклик удара 170 мс (деф.) | `settings.ts` strikeResponseMs (re-exported as STRIKE_CATCH_MS); движковая копия `src/lib/sim/targeting.ts` STRIKE_RESPONSE_MS | `server/protocol.js` STRIKE_CATCH_MS | single source per side (W3); плюс clamp 0–600 flightMs |
| Пропускные клетки земли GROUND_COVER_IDS | исходник `test-map.ts` GROUND_COVER_OPTS → производные списки: `protocol.ts`, `src/lib/sim/paint.ts` | `server/protocol.js` | single source per side (W3) |
| Лимиты локации TEST_MAP_LIMITS | `test-map.ts` (re-exported by `protocol.ts`) | `server/protocol.js` (sanitize uses it) | single source per side (W3); редактор не предложит конфиг, который сервер отвергнет |
| Максимальный уровень высоты TERRAIN_MAX_LEVEL=10, шаг ELEV_STEP_MAX=1, прыжок JUMP_MAX_UP=3 / JUMP_CHARGE_HALF=0.5 / JUMP_CHARGE_FULL=1 | `test-map.ts` elevStepOk/elevJumpOk (re-exported by `protocol.ts`); мирная ходьба — `surfaceLevelOf`/`pointInSouthWallOf` | `server/protocol.js` + `server/world.js` elevJumpOk, surfaceLevel, inSouthWall | single source per side; вверх на 4+ нельзя, вниз на 4+ — полный заряд |
| Дальность/дуга прыжка | `simulator.tsx` leapLandingAt: точка под курсором, дальность ≤3 клетки, перепад по elevJumpOk | `server/movement.js` jump (charge 0..1) | кулдаун 450 мс с обеих сторон (`JUMP_COOLDOWN_MS` in both registries, W3) |
| Заряд приседа по hold | `simulator.tsx` (формула анимации `0.15 + 0.85·hold/4000`) | `server/room.js` space (clamp hold 0–4000) | формула анимации — клиентская, сервер хранит только флаг sq |
| Клетка мишени РАБ | `protocol.ts` RAB_CELL mirror + движковая копия `src/lib/sim/engine-consts.ts` RAB_POS (0-based) | `server/protocol.js` RAB_CELL (1-based) | single source per side (W3); сервер не рассылает позицию |
| Дефолт манекена DUMMY_DEFAULT | рендер по `dummyState` (сервер присылает всё) | `server/protocol.js` | сервер — источник; клиентские дефолты не дублируются |
| Формат кадров `[event, payload]` | `coop.ts` (диспетчер, имена через `protocol.ts` EV.*/guards) | `server/net.js` onMessage-диспетчер (имена через `server/protocol.js` EV.*) | «move» с x:0/y:0 — маркер выхода: двойной смысл сохраняется (canon: `isCoopCat` guard пропускает оба, потребитель различает по нулям) |
| Реестр конфига (P2+F2) | `src/lib/cfg-registry.ts` (подписи/юниверсы/дефолты 6 ключей: 5 числовых + bool-гейт) | `server/cfg-registry.js` (+ формулы клэмпов — только сервер) | паритет держит `test:protocol-parity` (ключей 6, сервер == зеркало == golden); сервер пишет значения, клиент — только читает |
| Whitelist спрайтов (без parity-гейта) | `src/lib/sim/settings.ts:96` (`SPRITES: SpriteMeta[]`, 31) | `server/config.js:314` (`SPRITES`, 31) | руками в одном PR; счётчики держать равными |
| Каталог комнат (без parity-гейта) | `src/lib/net/modes.ts` NAMED_ROOMS/MODE_COPY | `server/modes.js` MODE_ROOMS + `server/room.js` roomOf | руками в одном PR; в grotto-варианте ветка Элизии вырезана сборкой — там зеркалится только паблик-часть |

## 5. Координатные системы

В репо ТРИ системы, смешение — типичный источник багов:

| Система | Диапазон | Где живёт |
| --- | --- | --- |
| Сетевая (1-based) | клетка `x=1..W, y=1..H` в протоколе и publicCat | server/room.js + server/movement.js (join/move/jump/cellsync), поле |
| Модель канваса (0-based) | `col=0..W-1`, `row=0..H-1` | simulator.tsx, move-book.ts, test-field/test-map (ключи «c,r») |
| Доли клетки fx/fy | позиция внутри клетки 0..1; мирный режим живёт в мировых дробных координатах | freemove/dummyMove, рендер переходов |

Переводы: сетевая → модель: `col = x-1, row = y-1`. Углы: 0° вправо, далее по часовой;
нормализация wrap360, округление 0.1° на границе сети.

Сцена Элизии (Babylon, WebGL, только `/elision/`): px мира канваса переводит одна функция `worldPxToScene` в `src/lib/sim/elision-scene.ts` — `(x, lift, z = y)`. Второго ±1 нет: к кадру сеть уже стала `col`/`fx`. Камера ортографическая, в правой системе Babylon с обычными гранями left < right, и повторяет `screenToWorld`; клики остаются на 2D-холсте. Отражать проекцию нельзя: это ломает frustum-отсечение объектов. Рисунок земли загружается без invertY (верх PNG на z=0), спрайты повёрнуты на −π/2 вокруг X; смена карты сбрасывает кэш запасного рисунка острова. Пивные гроты слот не монтируют. Если WebGL не поднялся, Элизия остаётся на прежнем холсте.

## 6. Мутабельные синглтоны test-field.ts

`test-field.ts` держит модульное состояние (`currentMap`, paint-кэш, `rndShared`,
island-кэш, objCache). Это осознанный контракт:
**один монтаж Simulator на процесс** — `setTestMap` подменяет конфиг и сбрасывает кэши,
следующий кадр считает новую локацию. Следствия:

- Нельзя монтировать два Simulator в одном процессе (StrictMode-двойное монтирование
  переживается, т.к. пересоздание идёт тем же конфигом; тесты с разными картами —
  последовательные, не параллельные).
- Юнит-тесты test-field гоняют через самопроверку в scripts/ или dogfood-сценариями,
  не через параллельный jest-подход с общим модулем.
- Разрез движка обязан сохранить семантику «конфиг глобален на процесс» или
  ввести явный инстанс-контекст — это смена контракта, отдельно от behavior-preserving
  этапов.

## 7. Целевая структура (реализуется волнами W3–W5; платформенные фазы P1–P6 — вне W3–W5, их карта — PLATFORM-ARCHITECTURE.md)

### W3: протокол-канон — DONE

Landed in this wave (branch `refactor/protocol-canon`):
- `server/protocol.js` — canonical registries: event
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
  text in some consumers; simulator.tsx emit literals untouched (W5).

### W4: разрез server.js → тонкий вход + модули — DONE

Landed (branch `refactor/server-carve`, behavior-preserving): server.js (2666 строк)
carved verbatim into 12 flat `server/*.js` domain modules — config, protocol (W3, untouched),
testmap, world, sanitize, room, movement, combat, dummy-rab, atmo, persist, net (+ thin 10-line
server.js entry that only calls `startServer()`). Wire format, protocol
and persistence are byte-identical: only import/export plumbing and 5–10-line
contract headers are new code. Live `export let` bindings preserve the old
single-file read-latest semantics for module-owned reassigned state
(testMap/TEST_* in testmap.js).

Originally planned subdirectories (http.js/ws.js, rooms/, testmap/, persist/)
folded into flat single modules where the domain fit the 80–800-line rule —
the actual landed map is authoritative, see §2. Deploy path `node server.js`
unchanged; `server.js` dropped from SIZE_ALLOWLIST (arch:check now guards it
at the 800-line limit like any other file). Мерж за заказчицей. Платформа (P1–P4)
дописывала свои модули поверх (modes/accounts/auth/hunger/runtime-config/cfg-registry/profiles).

### W5: разрез simulator.tsx + settings-panel

Этап 1 — чистые выносы lib/sim; этап 2 — компонент-каркас. Этап 1 закрыт волной W5a
(engine-consts/geometry/targeting/combat-log/particles/paint/editor-model), этап 2 — W5b
(hooks, factories, HUD dial, sim-model, JSX chrome), оба behavior-preserving; остатки
этапа 1 (angles/persist/leap/peace-walk/camera/weather-clock) задевают rAF-замыкание и
 остаются хвостами. Kept ON PURPOSE (behavior > counters): the main rAF
closure (~2700 lines, single `useEffect` with deps `[stage]`, `const loop` :4237) —
extracting it whole would recreate a >800-line file, splitting it would re-wire engine
variables; state/refs belt of `Simulator()`; small callback/patch belts (мелкая крошка —
запрет пере-дробления). settings-panel.tsx не разрезан (1240, за лимитом держит
SIZE_ALLOWLIST арх-гейта — разрез отдельной темой после стабилизации платформы).

После W5 allowlist становится пустым — гейт 800 строк держит всю кодовую базу «чистой»
без исключений.

## 8. Правила поддержания этой карты

- Изменение модуля (±100 строк, новые секции) — обнови строку в таблице раздела 2.
- Меняешь потоки данных или зеркала — разделы 3/4 в том же PR (директива заказчицы №4:
  актуализация документации правилом, а не только дисциплиной).
- W3 догму сделала гейтом: `check:protocol` (док-таблицы == реестры, без строк-дублей в
  server.js + server/*.js) и `test:protocol-parity` (клиент == сервер == golden) уже в CI — зеркала
  раздела 4 больше не держатся одним ревью. P2 добавил в parity реестр конфига.
- Размерные числа в картах сверяются гейтом `check:landmarks` с `wc -l`;
  при расхождении доверяй `wc -l`, а не этой таблице, и обнови её в том же PR.
