# ARCHITECTURE.md — карта coop-field as-is и путь к цели

Сопутствует [AGENTS.md](../AGENTS.md): там — маршруты агента и контракт протокола, здесь —
глубина: слои, потоки данных, зеркала-инварианты, координатные системы и целевая структура
рефакторинга (волны W3–W5). Читай секцию задачи, не весь файл.
Платформа (аккаунт/профиль, два сайта, реестр конфига, роли, хост-изоляция) — [PLATFORM-ARCHITECTURE.md](PLATFORM-ARCHITECTURE.md);
аудит продукта — [PRODUCT-ROADMAP.md](PRODUCT-ROADMAP.md).

Состояние чисел: `wc -l` на 2026-11-08 (ветка `feature/elyria-platform-admin-profiles`, этапы
P1–P6 платформы; в CI числа бережёт гейт `npm run check:landmarks`, W7a). Карта as-is честная:
god-файлы разобраны — `server.js` разрезан волной W4 на тонкий вход 10 строк + модули `server/`;
из `simulator.tsx` (8221 → 4955 сегодня) остаётся разрезать меньшинство. Размер — это долг, а не норма:
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
  `/, game/, players/, admin/`; в `elision/` — только стаб-пересылка); итоговые корни — `www-grotto/` и `www-elyria/`.
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
| `src/components/sim/simulator.tsx` | 4994 | Остаток после выносов W5a+W5b (+ надстройки PR #41/#48 и мини-фолловап B6; мобильный UX 2026-11-10: плашки-кнопки чата/лога для <lg — хуки mobilePanel/chatSeenRef/logSeenRef + эффекты синхронизации прочитанного над `if (stage === 'entry')` :4658; слот touchControls внутри `<FieldStage>` :4801): `Simulator()` начинается :267 (стейт/refs-пояс, сетевые колбэки); вызов buildEditorOps :990 (тела — ./simulator/editor-ops.ts); эффекты атмосферы/комнат/подсказки боя; главный rAF-эффект с `const loop` :4111 (оставлен на месте: ~2700-строчное замыкание, deps `[stage]` — целиком свыше лимита 800, а разрывать переменные цикла нельзя без изменения поведения); вызов buildPointerTools :4279 (тела указателей — ./simulator/pointer-tools.ts, удар — ./simulator/hooks/use-strike.ts); патчи настроек; platform-вставки P3: инлайн IS_ELYRIA :118 — auth-колбэки и auth-пропсы `<EntryScreen>` :4664, :4679–:4681 существуют только в варианте Элизии (sendAuth :4463; setWhoamiGuarded :291 — фоновый WS-кадр `whoami` не затирает свежий отказ входа, окно 8 с, мини-фолловап B6; onLogin/onRegister/onLogout — тернарники IS_ELYRIA); localStorage-маршруты: STORAGE_KEY :752 (чтение СП)/:767 (запись), COMBAT_KEY :1251, сброс :4408, ротация лога внутри mergeLog (combat-log.ts). Элизия: рендер WebGL-вида и включение — simulate-сторона ниже |
| `src/components/sim/simulator/` вынос W5b (+ PR #48, тач-волна 2026-11-10) | 4780 | Хуки/JSX/фабрики, вырезанные из simulator.tsx (behavior-preserving): hud-canvas.ts 166 (HUD-плашка суток+погода + nameplates), sim-model.ts 178 (AtmoClock/FloatLabel/Step/Engine типы, fmtSec, remote-draw хелперы), hooks/use-keyboard.ts 258 (window keydown/keyup/blur, deps []), hooks/use-network.ts 709 (сетевой эффект coop-клиента; `setWhoami` сужен до `(row: CoopWhoami) => void`; отказ сохранения «Редактор: …» дублируется в панель редактора — setEditorMsg при открытом редакторе, иначе троттлинг/пароль гасили прогресс молча), hooks/use-canvas-layers.ts 239 (useAimPublisher/useSpriteCache/useWalkGifCache/useAtmosphereLayer), hooks/use-strike.ts 277 (броня+удар: landStrike/doStrike), hooks/use-elision-view.ts 51 (реестр WebGL-слоёв Элизии: подключение Babylon-Engine поверх 2D-цикла), hooks/use-touch-controls.ts 301 (сенсорное управление для pointer:coarse — джойстик на 8 углов и кнопка «прыжок» дублируют семантику keydown/keyup из use-keyboard: сектор пушит угол в engine.held/гасит ptarget мирной комнаты/зовёт startStep, удержание кнопки — spaceHoldRef.holding + emit space on:true, отпускание — charge 0.15+0.85·Δt/4000 в leapRequestRef + emit space on:false/hold), editor-ops.ts 747 (операции черновика локации как per-render фабрика; клиентский предгейт троттлинга setmap (10 с на сокет, SETMAP_MIN_GAP_MS из editor-model) — раньше срока кадр не уходит, панель показывает честный отсчёт; клетки/спавны/заходы — editor-cells.ts, «Перенести» — editor-select.ts; Пароль редактора удалён; в localStorage больше не живёт — при открытии сидит одноразовая миграционная чистка устаревшего ключа EDITOR_PASS_KEY, :199), pointer-tools.ts 772 (мышиные обработчики канваса), editor-cells.ts 198, editor-select.ts 201, elision-present.ts 444 (кадр WebGL-вида Элизии: собирает то, что 2D-цикл уже посчитал — камера, коты, камни/деревья, без второго перевода сетевых координат; атлас поверхности рисует kind path через path-field), components/chrome.tsx 488 (SimulatorHeader; #113-мерж: нативные select панелей заменены на ukit Dropdown, кнопки «Погода»/«Сутки», ColResize/SettingsPanelOverlay/RoomSwitchOverlay; <lg панель кнопок свёрнута в меню-шестерёнку «Настройки игры» — закрытие: повторный тап/клик-вне/Esc; «Редактор локации» рендерится только при whoami.role==='admin'), components/editor-overlay.tsx 254 (панель редактора + прогресс сохранения; инструмент «Тропинка»), components/field-stage.tsx 164 (рамка канвасов+легенда+слот touchControls над HUD+KeyHint вне редактора), components/touch-controls.tsx 118 (круги джойстика и «прыжка» поверх канваса: z-50, pointer-events только на кругах; кольцо заряда 4 с дублирует кривую приседа; скрыт на pointer:fine), components/key-hint.tsx 190 (плашка «Управление» при первом входе, #124: один раз на браузер — KEY_HINT_SEEN_KEY в localStorage под try/catch; Esc/крестик/«Понятно», кнопки не берут фокус, игровые клавиши не глушит; раскладка гротов с ударом/блоком, Элизии — мирная, инлайн IS_ELYRIA; pointer:coarse — строка про джойстик, z-[45] сверху, не перекрывает touch-controls; showKeyHintAgain() — кнопка в gerta-handbook) || `src/lib/sim/` вынос W5a-1 | 1028 | Чистые модули, вырезанные из пояса simulator.tsx: engine-consts.ts 98 (именованные константы+STORAGE-ключи, пометки [MIRROR]), geometry.ts 133 (spriteBoxOf/якоря стрелы/coveredRatio/nearestEntryCell), targeting.ts 151 (правило удара pickStrikeTarget — зеркало server aimedNeighbor, STRIKE_RESPONSE_MS), combat-log.ts 187 (layout колонок+STORAGE, mergeLog/CombatState), particles.ts 146 (спринт-частицы), paint.ts 520 (кисть PaintXP: материалы/штампы/undo/encode, синхронный+асинхронный PNG), editor-model.ts 161 (типы редактора+EDITOR_PASS_KEY+SETMAP_MIN_GAP_MS); рядом path-field.ts — контур тропинки (Чайкин/дрожь/dirt/tufts), кэш в GeoCache |
| `src/lib/sim/settings.ts` | 1173 | Модель боя: STRIKE_ZONES, ARMOR_CURVE (:567), DAMAGE_LEVELS (:522), тайм-ауты брони, спрайты (33), WALK_GIF_SRC (:253 — пробная GIF-ходьба), замедление, атмосфера-типы; 65 экспортов |
| `src/lib/sim/test-field.ts` | 2162 | Играбельная площадь «Элизии»: проходимость клеток и anchor-точек, route-граф, рендер кромки (марширующие квадраты + Чайкин), paint-маска, дешёвые клипы клеток рельефа, лицевая стена блока по квадранту камеры, кэши; камень — платформа уровня 1: stoneCells кормят боевой elevLevelAt, мирная опора — supportLevelAt, явный грунт — terrainLevelAt/effectiveElevRecord, ходьба и мирные якоря блокируются только деревьями, тела камней пропущены в testPeaceObjectDepth; мутабельные модульные синглтоны (раздел 5) |
| `src/lib/sim/test-map.ts` | 796 | Модель конфига локации v1/v2 + клиентский sanitize; TEST_MAP_LIMITS (:304) — зеркало серверных лимитов; STONE_LEVEL=1 (зеркало — server/world.js) |
| `src/lib/sim/atmosphere.ts` | 533 | Атмосфера: облака/дождь — Pixi-оверлей, тонировка суток — цветная вуаль «source-atop» на мировом холсте (один fillRect за кадр) |
| `src/lib/sim/elision-babylon.ts` | 485 | WebGL-вид только страницы `/game/`: динамический `import()` Babylon `Engine` (WebGL, не WebGPU), чанк не входит в гроты; луна-декалями и трава. Нет WebGL — остаётся 2D-холст. Формулы сцены — elision-scene.ts |
| `src/lib/sim/elision-scene.ts` | 356 | Математика WebGL-сцены Элизии: `worldPxToScene` — единственный шаг px мира → сцена (второго ±1 нет), камера ортографическая повторяет `screenToWorld` |
| `src/lib/sim/` прочее | 472 | keys.ts 73 (физическая раскладка WASD), remote-aim.ts 92 (чужой прицел), textures.ts 189 + tex-live.ts 126, theme.ts 54, gif-walk.ts 117 (пробная GIF-анимация ходьбы: decodeGifFrames через WebCodecs ImageDecoder, walkFrameAt/walkPhaseOf — кадр по локальным часам с фазой кота; без класса/битый gif — отказ, useWalkGifCache оставляет статичный PNG) |
| `src/lib/site.ts` | 28 | Канон варианта сайта (P3): `SITE` из `NEXT_PUBLIC_SITE`, дефолт `grotto` (fail-safe: пустой env — публичный сайт). Хелперы для кода вне React; вариантозависимый UI-код НЕ импортирует его для фолдинга — сверяет env инлайном (см. шапку модуля) |
| `src/components/menu/wander-gate.tsx` | 370 | Главное меню: фон `/menu/home-bg.jpg` 16:9 cover по центру, окна миров (Элизия — одно шире по центру), hotspot доски; на Элизии шапка сверху + комнаты из GET /locations |
| `src/components/menu/wander-home-board.tsx` | 120 | Hotspot доски + модалка новостей (portal, pin/HTML body, GET /cfg/news) |
| `src/components/admin/news-rich-editor.tsx` | 103 | Мини-редактор body новости (b/i/u/size) |
| `server/home-news.js` | 281 | Новости доски: GET/POST /cfg/news, pin+порядок, HTML body allowlist, DATA_DIR/home-news.json |
| `src/lib/net/modes.ts` | 163 | Клиентский каталог комнат — зеркало `server/modes.js` (titles/access/href). В grotto-варианте комната `test` отсутствует напрочь; href и карточки боевых миров сидят в мёртвых ветках IS_ELYRIA-тернарников (COMBAT_HREF/HUNGER_HREF :38–:39, NAMED_ROOMS :84, MODE_COPY :117) — «мёртвая ветка умирает на сборке», в элизии-артефакте их нет. PlayMode — `'hub' \| 'beer' \| 'elision' \| 'hunger'`: отдельного режима combat больше нет, гроты = beer, страницы /combat/ остаётся входом в гроты |
| `src/lib/net/coop.ts` | 613 | Транспорт: выбор сокета по хосту (phainonsmilk.ru/\*.elisium → same-origin `/ws` — ветка свёрнута инлайн-сравнением `process.env.NEXT_PUBLIC_SITE === "elyria"` ВНУТРИ условия wsUrlBase :193, не импортом константы: мёртвая ветка выкидывается из grotto-сборки целиком вместе с хостами Элизии, A1; превью pr-N.abnocw.phainonsmilk.ru → свой `/ws`; легаси sslip/vercel → сокет комнаты; localhost → LOCAL_WS `ws://localhost:3780`), `httpOrigin()` :208 — база HTTP-флоу (auth/профили/cfg; same-origin на Элизии), reconnect backoff, диспетчер входящих (guard-валидаторы + `EV.*` из `./protocol`); `?t=` в URL не используется (P3 — cookie HttpOnly) |
| `src/lib/net/auth.ts` | 30 | Остаток WS-флоу сессии (P3): `whoami` пропускается как есть, payload кадров `auth` (hello — без токена: сессия приходит cookie на хендшейке) |
| `src/lib/net/http-auth.ts` | 185 | Auth-only HTTP-флоу (P3, сплит B-волны): `httpRegister/httpLogin/httpLogout/httpMe` (`/auth/register\|login\|logout\|me`, fetch с `credentials: "include"` против `httpOrigin()`; register body может нести необязательное поле invite — инвайт-волна 2026-11-12, код живёт 24 ч) + общие низкоуровневые хелперы `apiFetch/asText/asId/ApiRow`, на которых стоят оба соседних модуля. Сплит — изоляция сборки: модуль-донор графа симулятора не должен тянуть серверные HTTP-маршруты Элизии в public-бандл гротов. В grotto-варианте эти клиенты в мёртвых ветках |
| `src/lib/paint/` | — | Решение владелицы 2026-11-10: окрасы CatWar в игре не используются. Модуль `catwar-coat.ts` и vendor `public/catwar/` из репозитория сняты. Личный PNG и KNS Paint остаются. |
| `src/lib/net/http-profiles.ts` | 152 | Клиент каталога профилей (P4/B3): `httpProfileCatalog` (?q поиск по displayName, ?limit деф. 24, ?cursor keyset-пагинация), `httpProfileById`, `httpMyProfile`, `httpPatchProfile`; типы PublicProfile/ProfileCard/ProfilePatch |
| `src/lib/net/http-cfg.ts` | 521 | Админ-CRUD конфига (P4/B2 + F2): fetch-обёртки GET /cfg/admin, POST /cfg (apply/reset), POST /cfg/restore, GET /cfg/export, POST /cfg/import, F2 — /cfg/rooms* (list/config/update/reset-one/reset-all/history/restore) + ЧИСТЫЕ функции черновика/диффа — draftFromSnapshot (жёстко включает §4-флаги playerSelectable), cfgPatchFromDraft (шлёт флаги явно), canonByKind, buildCfgDiff (§4: choice-аспект «выбор игроками вкл/выкл» отдельной строкой, список при флипе не мутируется), narrowingWarning, listIssue, successText, applyBadgeText (listDiff/fmtNum). Реакт не здесь: UI черновика — в cfg-dashboard.tsx, UI комнат — в room-config-panel.tsx |
| `src/lib/net/cfg-live.ts` | 122 | Живые universes для UI (P3): один fetch GET /cfg на вкладку с кэшем; сбой → реестровые дефолты; выпавшее из списка сохранённое значение снапится к дефолту (`snapToAllowed` — не к ближайшему) |
| `src/lib/cfg-registry.ts` | 158 | Клиентское зеркало реестра конфига (P2+F2): подписи/юниверсы/дефолты 6 ключей (5 числовых + bool-гейт allowPlayerAtmosphereControl, default true); формул клэмпа на клиенте НЕТ (только сервер). Паритет — `test:protocol-parity` |
| `src/lib/net/protocol.ts` | 369 | Client-side protocol canon (W3): mirrored `EV.*` registries (23+24, auth/whoami), payload types, guards; re-exports sim-owned constants from `settings.ts`/`test-map.ts` |
| `src/lib/net/move-book.ts` | 89 | Предикт своих шагов (≤1 неподтверждённый), откат по refuse, достройка чужих котов. Эталон чистоты для новых модулей |
| `src/lib/net/gerta-catalog.ts` | 417 | Справочник Герты: типизированные карточки механик/констант из protocol.ts + реальные пути файлов (юнит-проверка путей — scripts/test-handbook.mts в test:unit). Карточки боевых миров — в мёртвой ветке IS_ELYRIA-тернарника (GROTTO_MECHANIC_CARDS :353, MECHANIC_CARDS :384/:410) — умирают на сборке элизии, в её бандле грот-механик нет |
| `src/components/players/players-catalog.tsx` | 918 | Страница-каталог игроков `/players` (P4+B3, только elyria): карточки из GET /profiles с серверным поиском `?q` (debounce 300 мс либо Enter/«Найти») и keyset-пагинацией `nextCursor` (клиент НЕ фильтрует — режет сервер), deep-link `?id=<accountId>`, инлайн-редактирование своей карточки (PATCH /profiles/me) |
| `src/components/admin/cfg-dashboard.tsx` | 631 | Админ-дашборд `/admin` (P4+B2, только elyria): реестр 6 ключей, apply-политики/подписи из GET /cfg/admin, редакторы СПИСКОВ разрешённых значений universes + ЯВНЫЙ тумблер «выбор игроками» (F2 §4: флип playerSelectable, список НЕ режется — off-then-on возвращает кураторский список, не юниверс), предпросмотр диффа «было → станет» (+N/−M, отдельная строка «Выбор игроками: вкл→выкл — список N зн. сохраняется на сервере») до отправки с вторым подтверждением, предупреждение сужения списка, сворачиваемые тех-детали, честные статусы ok/err c деталями провала, reset, restore по имени из истории, export/import JSON; секция «Комнатные настройки» (F2 §3) — RoomConfigPanel; вкладка «Коды приглашений» (invites-tab.tsx: генерация 1/3/5 с заметкой, журнал статусов, копирование, отзыв с confirm; фечеры — http-admin-ops.ts); рендер только при `role==='admin'` (гейт GET /auth/me) |
| `src/components/admin/room-config-panel.tsx` | 319 | F2 §3 per-room-панель (только elyria,AdminRender внутри cfg-dashboard): селект комнаты с бейджами overrides, таблица слоёв global/override/effective per-key (whitelist v1: phaseMin, weatherMin, гейт atmoset), редакторы (число — селект диапазона, гейт — чекбокс), «Применить override» / «Наследовать» per-key, «Сбросить всё» и restore — window.confirm, история бэкапов room-configs.json; клиент не источник истины — все write валидирует сервер |
| `src/components/sim/simulator/components/…` — см. carve-строку выше: JSХ-каркас | — | — |
| `src/components/sim/` прочее | 3181 | settings-panel.tsx 1222 (панель настроек, 30 пропсов; вкладки с `admin:true` рендерятся только при `props.role==='admin'` — роль истины на сервере, локальных паролей с P3 нет), entry-screen.tsx 742, gerta-handbook.tsx 203 (вкладка «Справочник» — карточки из lib/net/gerta-catalog.ts), auth-panel.tsx 216 (форма входа/регистрации Элизии с полем «Код приглашения», инлайн IS_ELYRIA; reason-тексты и локальные проверки живут в auth-reasons.ts — общий источник с гейтом menu/auth-gate.tsx: дрейф текстов между точками входа исключён; сброс пароля после выхода), auth-reasons.ts 127 (REASON_TEXTS taken/weak/short/full/rate/bad/invite + localAuthError/localInviteError по серверным контрактам: логин 2–24, пароль ≥8, инвайт непустой в регистрации; шарится с auth-modal), room-picker 154, room-chat 142, fight-log 83, бэкдропы beer 363 / theme 74 |

Страницы (static export, `src/app/`): `page.tsx` 16 (меню `/`, обёрнуто в AuthGate live+chrome), `combat/page.tsx` 13 (`<Simulator mode="beer">` — гроты, гейт не ставится), `game/page.tsx` 21 (`mode="elision"`, AuthGate; до 2026-11-10 страница жила на `/elision/`), `elision/page.tsx` 23 (стаб: пересылает старые инвайт-ссылки на `/game/`, noindex), `hunger/page.tsx` 11 (каркас «в разработке», без гейта), `players/page.tsx` 17 (+players-catalog, AuthGate), `admin/page.tsx` 17 (+cfg-dashboard, AuthGate). `Simulator({ mode = 'hub' })` — единственный тонкий проп режима; elyria-оболочки монтируют <AuthGate> (menu/auth-gate.tsx) — окно входа для подтверждённого гостя.

### Сервер (тонкий вход `server.js` 10 строк + модули `server/`; разрез волной W4, платформенные правки P1–P4 поверх)

Вход `node server.js` только вызывает `startServer()` из `server/net.js` — весь код переехал
в модули ниже; все имена событий — только `EV.*` из `server/protocol.js` (W3-канон).

| Модуль | Строк | Что |
| --- | ---: | --- |
| `server/config.js` | 440 | env (PORT/HOST/DATA_DIR; WS_MAX_PER_IP деф. 8 / ROOMS_MAX деф. 32 — S5), Origin-политика REQUIRE_ORIGIN, payload/frame limits, поле (WIDTH/HEIGHT/SPAWNS/PALETTE), whitelist 31 спрайта (:314), имена котов; host-политика P1: `hostClassOf` → public\|elyria\|local (env `PUBLIC_HOSTS`/`ELYRIA_HOSTS` дополняют дефолты точным именем или суффиксом зоны, превью-поддомены наследуют класс; неизвестный хост → public; S3: легаси-шаблон *.vercel.app удалён из списков) |
| `server/protocol.js` | 286 | канон W3 + auth/whoami: реестры EV.* 23+24, зеркальные константы (кулдауны, лимиты, ARMOR_CURVE, зоны, atmo, геометрия прыжка/dummy/rab). Платформой не тронут |
| `server/testmap.js` | 705 | конфиг локации: defaultTestMap, sanitizeTestMap, атомарная запись, карантин битых конфигов, setmap-хендлер (сохранение — только админ: гейт ws.account.role==='admin' в setMap, ux/admin-gate admin, бэкапы, рассылка map+field) |
| `server/world.js` | 780 | чистая геометрия по конфигу: PNG-кисть, марширующие квадраты+Чайкин, island/cells, препятствия (блокируют только деревья), высоты по эффективному уровню (testElev = elev + камень STONE_LEVEL, stoneCellsOf с кэшем по конфигу), обрывы (`cliffBetween`), entry-клетки |
| `server/sanitize.js` | 95 | чистые валидаторы входа: clipChars/sanitizeChat/sanitizeLogin/uniqueLogin + chat-хендлер (450 мс, история 40) |
| `server/room.js` | 657 | комнаты: roomOf (+ алиас RETIRED_ROOMS combat→grot-1 для легаси ?room=combat), жизнь пустой комнаты 10 мин, join (кулдаун 1/с, свободная клетка, you+field+chatlog+move, Элизия без сессии → auth_required; надетый спрайт профиля из живого вайтлиста важнее payload.sprite), leave, publicCat/поле, send/broadcast, спрайт, block, space, roomsinfo с призраком: гость про registered-комнату слышит `count 0, logins []` — как про несуществующую; S5b: потолок ЖИВЫХ комнат ROOMS_MAX (деф. 32) — новая комната сверх лимита → noplace `rooms_full`; F2: стартовый якорь atmo из per-room initialRoomAtmo (override комнаты → effective, без overrides → прежняя глобальная инициализация) |
| `server/movement.js` | 318 | очередь шагов 80 мс×3, move-хендлер с refuse-кодами, freemove, cellsync, jump |
| `server/combat.js` | 295 | aim (коалесценция 20 мс)/strike: aimedNeighbor — зеркало pickStrikeTarget, зоны удара, броня по ARMOR_CURVE; P2-клэмпы: урон s.events дополнительно зажат сверху по максимальному разрешённому уровню (`maxStrikeDamage` горло-формула), входящая броня снапится вниз к разрешённым десятым (`snapArmorToUniverse`), капы берутся из runtime-config на каждом событии |
| `server/dummy-rab.js` | 133 | манекен (доли клетки, перенос grab/drop), мишень РАБ, toggle-режимы |
| `server/atmo.js` | 131 | якорь суток/погоды (фазы 4×pl, погода wl/ws), atmo/atmoset/atmoState/atmoBroadcast; дефолт новых комнат из runtime-config; F2 §3.4 мин-диф: ранний return в atmo()/atmoset(), если per-room гейт allowPlayerAtmosphereControl=false (молчаливый drop — существующий формат отклонения кадров, без нового ответа) |
| `server/persist.js` | 168 | книга позиций котов data/test-cats.json, TTL 30 дней, троттлинг записи 1/3 с; мирная точка на клетке камня разрешена (камень — платформа) |
| `server/net.js` | 543 | транспорт: http statics+`/health` (с clientIpMode: 'loopback'\|'xff'\|'direct' — S4; loopback без XFF на прод-классе → warning в лог: темп-лимиты auth не работают), HTTP-цепочка handleAuthHttp → handleRoomCfgHttp (F2: room-роуты /cfg/rooms* ПЕРЕД глобальным /cfg-хендлером) → handleCfgHttp → handleProfilesHttp → handleInvitesHttp (GET/POST /admin/invites* — apiZone-CSRF, разбор ДО статики; инвайт-волна 2026-11-12) → static; host-гейт P1: на public-хосте /auth/\*, /profiles/\*, /admin/\*, /cfg/admin\*, /cfg/export, /cfg/rooms\*, сессионная зона `/sprites/mine\*` (#83: public-хост → 404, гость → 401) и пишущий POST /cfg\* → 404 `not_found`; B1: CSRF fail-closed per-destination — unsafe+cookie на public/elyria: пустой Origin → 403 `csrf_origin_required`, чужой → 403 `csrf_origin_mismatch` (local — прежний щит, `AUTH_CSRF_STRICT` форсирует); S5a: потолок ОДНОВРЕМЕННЫХ WS-сокетов с одного адреса WS_MAX_PER_IP — сверх info `too_many_sockets` и close; ws-accept (Origin, heartbeat 30 с), onMessage-диспетчер по EV.\*, таймеры, startServer() |
| `server/modes.js` | 45 | каталог комнат/доступа: grot-1..3/demo/hunger открыты, `test` registered-only; RETIRED_ROOMS frozen (combat → grot-1, история ссылок) |
| `server/accounts.js` | 543 | аккаунт/персонаж, scrypt, `accounts.json`; `publicAccount` (whoami/вход), `publicProfile` (DTO карточки: displayName, bio, avatarCharacterId, characters, createdAt — без login/role); S1: BOOTSTRAP_ADMIN — МИГРАЦИОННЫЙ список: при регистрации имя из списка получает роль registered + warning в лог, роль admin: CLI `scripts/make-admin.mjs` (первый/офлайн) и `POST /admin/players/promote` (живой админ); promoteToAdmin — общий mutator; MAX_ACCOUNTS (деф. 2000) |
| `server/auth.js` | 714 | сессии (sessions.json, токен 32 hex, TTL 14 дней), cookie `coop_session` HttpOnly host-only — атрибута Domain намеренно нет (B1), SameSite=Lax всегда (+Secure на https), матрица токенов по классу хоста (?t= только на local, public/elyria — cookie-only; A7), HTTP /auth/* (CSRF Origin на пишущих), WS auth-кадры (register/login отказ на public), rate-лимиты per-IP+per-login; инвайт-гейт регистрации (код проверяется ДО createAccount, захват — после успеха; невалидный/просроченный/использованный/отозванный → reason 'invite') |
| `server/invites.js` | 351 | Инвайт-коды регистрации (волна 2026-11-12): генерация XXXX-XXXX (randomBytes, алфавит без 0/1/O/I/L/U), TTL 24 ч (env AUTH_INVITE_TTL_MS), журнал DATA_DIR/invites.json append-only (использованные/истёкшие/отозванные НЕ удаляются); enforcement: production — код обязателен, preview/local/test — нет, env AUTH_INVITE_ENFORCE='1'/'0' override; админ-роуты в самом модуле (паттерн admin-ops.js, гейт role admin): POST /admin/invites/generate (count 1–10, note ≤80), GET /admin/invites (статусы active/used/expired/revoked + claimedByLogin), POST /admin/invites/revoke |
| `server/profiles.js` | 715 | HTTP-профили P4+B3: GET /profiles (каталог карточек по старшинству с серверным поиском ?q и keyset-пагинацией ?limit деф. 24/клэмп 48/?cursor base64), GET /profiles/:id, GET/PATCH /profiles/me (только своя запись, идентичность из сессии, валидация displayName≤24/bio≤280/avatarCharacterId из своих персонажей), CSRF на PATCH |
| `server/runtime-config.js` | 412 | runtime-конфиг v2: values-only {v, atmo, universes} в DATA_DIR/runtime-config.json, read-time миграция v1, атомарная запись + 8 бэкапов; HTTP: GET /cfg (публичный: значения+apply-подсказки, БЕЗ истории), admin-роуты GET /cfg/admin (значения+регистр+история+мета), POST /cfg (патч по реестру / reset; F2 §4: universes-ключи несут ЯВНЫЙ playerSelectable — три поля: allowedValues+default+флаг; старое тело без флага = прежняя косвенная семантика list>1, backward-compat), POST /cfg/restore (имя из listHistory — path-guard; restore тоже мигрирует §4-поля при загрузке), GET /cfg/export, POST /cfg/import (всё или ничего) |
| `server/cfg-registry.js` | 574 | whitelist-реестр P2+F2: 6 ключей — 5 числовых (atmo.phaseMin, atmo.weatherMin, universes.strikeDamage/armor/arrowSpeed) + bool-гейт `atmo.allowPlayerAtmosphereControl` (F2 §3.4, room-scope, default TRUE — not-in-uniors, валидация true/false only); sanitizeValues (всё или ничего; opts.room — строгий режим room-key), sanitizeList §4 (allowedValues ⊆ юниверса, default ∈ allowedValues, длины bounded, playerSelectable раздельно), formulas: `maxStrikeDamage` (горло = база зоны 42 + 3,67·уровень — зеркало клиентской zoneDamageFor), `snapArmorToUniverse` (снап вниз к разрешённым десятым) |
| `server/room-config.js` | 603 | F2 §3 per-room слой: NEW-модуль. Слои resolveEffective: движковые дефолты ← глобальный runtime ← явный per-room override; whitelist SUPPORTED_ROOM_KEYS v1 = atmo.phaseMin, atmo.weatherMin, atmo.allowPlayerAtmosphereControl (universes — v2 после боевой интеграции: combat.js потребляет combatCaps() глобально без контекста комнаты). Persistence: DATA_DIR/room-configs.json {v:1, rooms:{[id]:{[key]:value}}}, атомарная tmp+rename 0600, BACKUP_KEEP 8, corrupt → room-configs.corrupt-<ts>.json + warn + пустое состояние. HTTP /cfg/rooms* (list/state/update/reset-one/reset-all/history/restore) — те же admin/CSRF/origin/host-гейты, что /cfg; id канонизируется через RETIRED-алиасы, path traversal → reject; room-configs.json НИКОГДА не пишется atmoset-кадрами (архитектурная изоляция), гейт atmoset в atmo.js только читает |
| `server/sprites.js` | 788 | манифест-каталог окрасов (DATA_DIR/sprites/manifest.json, канон в памяти; сид builtin при старте): GET /sprites/catalog (без hidden-строк), /sprites/file/:id (отдача НЕ-builtin PNG), админские /admin/sprites* (upload multipart ≤3 МБ, PATCH name/category/hidden, DELETE — не builtin и не «одет», отказ с wornBy); #83: serializeManifestWork/mutateSprites — ЕДИНАЯ FIFO-очередь на все мутации каталога с контрактным порядком коммита png→память→manifest.json→syncWhitelist и откатом; hidden — рычаг модерации против «одетого» окраса (строка уходит из каталога/whitelist/spriteIdAllowed, PNG-файл-улика остаётся); битый/урезанный манифест → manifest.corrupt-<ts>.json улика + громкий лог + пересев базой |
| `server/my-sprites.js` | 350 | #83: личные окрасы игроков — POST/GET/DELETE /sprites/mine*, сессионная зона на стеке профилей (cookie-сессия → 401 auth_required; unsafe-cookie Origin-щит csrfDecision → 403; host-гейт: public-хост → 404); upload: один PNG multipart, тело ≤1 МБ (проверка при чтении), IHDR 100–1000 px / площадь ≤600 000 px / файл ≥1,5 КБ (осознанно без силуэт-чека: источник силуэта — редактор, не сервер), name 2–24 кодпоинта NFC без control/bidi; id — транслит-слаг имени (никогда из filename), категория «Мои окрасы» — серверная константа, владелец — из сессии (DTO наружу без ownerAccountId); дедуп sha256 своего же тела → 200 существующего, слот не тратится; лимит 3/аккаунт (MAX_SPRITES_PER_ACCOUNT, 409 limit), rate 5/час+20/день in-memory (429 rate), capacity 2000 uploaded (503), аудит sprites-audit.jsonl append-only; DELETE: владелец или админ, «одет» → 409 worn с wornBy |
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
запускать при остановленном сервере); прочие — ручные пробы и ops. `deploy/vps/` — образец systemd-юнита, apply.sh (health-check до 8 минут — холодный старт под swap-давлением замерян в ~6 минут 2026-11-09,
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
браузер Элизии (phainonsmilk.ru)          room-сервер
POST /auth/register  {login,pass}  →  scrypt, accounts.json; Set-Cookie coop_session (HttpOnly)
GET  /auth/me                        →  {ok, role, ...} | {ok:true, role:"guest"}
GET  /profiles      → каталог карточек (?q поиск, ?limit деф. 24, ?cursor keyset);  GET /profiles/:id → карточка; PATCH /profiles/me → своя
GET  /cfg           → значения+apply-подсказки (публично, без истории)
GET  /cfg/admin     → значения+реестр+история (только role=admin, cookie-сессия)
POST /cfg | /cfg/restore | /cfg/import   → admin, CSRF Origin-щит (B1: per-destination fail-closed, пустой Origin → 403 csrf_origin_required)
```

Куки `HttpOnly`, host-only — атрибута Domain нет (B1); на https — `Secure + SameSite=Lax`
(всегда; флаг `COOKIE_LOOSE` удалён, A7). `?t=` принимается только на классе local;
public и Элизия — cookie-only (A7). Токен из тела ответа и из кадра `whoami`
на Элизии не выдаётся (на public кадр тоже молчит); класс local держит
токены в телах и в `whoami` — на нём стоят тесты. `hello` с токеном в payload на
public/elyria требует Origin своего класса. На public-хостах
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

Урон в `fight` считает сервер сразу (2026-11-10, без флага): таблица зон
× `profile.sp.damageLevel` бьющего, потолок — `maxStrikeDamage` по максимальному
разрешённому уровню реестра. Поля кадра `damage` и `pawsDamage` принимаются и
игнорируются. Сервер режет уже это число бронёй цели, а входящую броню снапит
к разрешённым десятым (`snapArmorToUniverse`); значение `armor` соседям не
рассылается — они видят порезанный урон в `fight`.

### Atmo (сутки/погода)

```
любой игрок ── atmo {dp,w} / atmoset {pl,wl} ──► сервер
сервер ── atmo {t, cs, pl, wl, w, ws, dp} (якорь) ──► ВСЕМ, включая инициатора (эхо = подтверждение)
```

Кадры `atmo`, `atmoset`, `block`, `space`, `dummy`, `dummyMove`, `dummyGrab`, `dummyDrop`, `rab` и `rabHit` делят один бакет на сокет (`server/frame-limit.js`): 50 мс, как рассылка `freemove`, запас 2 кадра, лишнее молча отбрасывается. Смысл принятого кадра не меняется.

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
админ комнаты test ── setmap {map} (role=admin, без пароля) ──► sanitize: v 1|2, cols 6–60, rows 3–40, zones ≤48, objects ≤2000
сервер: атомарная запись data/test-map.json (+8 бэкапов), тестовая прогонка
сервер ── map (новый конфиг) ──► каждому сокету комнаты «test»
сервер ── field (свежий снимок) ──► всем: сетка, dummy/rab/atmo пересчитаны
```

### Freemove/cellsync (мирный режим «Элизии», только комната «test»)

```
мирная ходьба: freemove {x,y,foot?:{dx,dy,rx?,ry?}} — доли клеток, foot = смещение лап от угла спрайта, бродкаст ≤1/50 мс остальным
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
| Максимальный уровень высоты TERRAIN_MAX_LEVEL=20, шаг ELEV_STEP_MAX=1, прыжок JUMP_MAX_UP=3 / JUMP_CHARGE_HALF=0.5 / JUMP_CHARGE_FULL=1 | `test-map.ts` elevStepOk/elevJumpOk (re-exported by `protocol.ts`); мирная ходьба — уровень под лапами + `terrainBodyOverlap` | `server/protocol.js` + `server/world.js` elevJumpOk, terrainBodyOverlap | single source per side; вверх на 4+ нельзя, вниз на 4+ — полный заряд |
| Камень — платформа STONE_LEVEL=1: эффективный уровень клетки = elev + камень (клэмп TERRAIN_MAX_LEVEL); клетка камня проходима, дерево — единственное непроходимое препятствие; тело камня не стена для мирных тел и мирных точек | `test-map.ts` STONE_LEVEL; `test-field.ts` stoneCells/elevLevelAt/testWalkableCell/peace-якоря/testPeaceObjectDepth, supportLevelAt (опора внутри тела), terrainLevelAt/effectiveElevRecord (только явный грунт) | `server/world.js` STONE_LEVEL + stoneCellsOf + testElev; `buildCells` блокирует только деревья; `persist.js` мирная точка камня разрешена | регресс-тест `npm run test:stone` (боевая клетка камня, перепады 1/2, дерево-стена, freemove на камень); грунт рисуется по terrainLevelAt, опора на камне — supportLevelAt |
| Дальность/дуга прыжка | `simulator.tsx` leapLandingAt: точка под курсором, дальность ≤3 клетки, перепад по elevJumpOk | `server/movement.js` jump (charge 0..1) | кулдаун 450 мс с обеих сторон (`JUMP_COOLDOWN_MS` in both registries, W3) |
| Тело у обрыва от 2 уровней | `test-map.ts` terrainBodyOverlap; `simulator.tsx` радиус из peaceBodyRadius | `server/world.js` terrainBodyOverlap; `movement.js` foot.rx/ry | зеркальные случаи в test-elev-rules/test-server-modules; old packets без радиуса остаются точечными |
| Заряд приседа по hold | `simulator.tsx` (формула анимации `0.15 + 0.85·hold/4000`; дубль формулы — тач-кнопка «прыжок», hooks/use-touch-controls.ts: spaceRelease) | `server/room.js` space (clamp hold 0–4000) | формула анимации — клиентская, сервер хранит только флаг sq |
| Клетка мишени РАБ | `protocol.ts` RAB_CELL mirror + движковая копия `src/lib/sim/engine-consts.ts` RAB_POS (0-based) | `server/protocol.js` RAB_CELL (1-based) | single source per side (W3); сервер не рассылает позицию |
| Дефолт манекена DUMMY_DEFAULT | рендер по `dummyState` (сервер присылает всё) | `server/protocol.js` | сервер — источник; клиентские дефолты не дублируются |
| Формат кадров `[event, payload]` | `coop.ts` (диспетчер, имена через `protocol.ts` EV.*/guards) | `server/net.js` onMessage-диспетчер (имена через `server/protocol.js` EV.*) | «move» с x:0/y:0 — маркер выхода: двойной смысл сохраняется (canon: `isCoopCat` guard пропускает оба, потребитель различает по нулям) |
| Реестр конфига (P2+F2) | `src/lib/cfg-registry.ts` (подписи/юниверсы/дефолты 6 ключей: 5 числовых + bool-гейт) | `server/cfg-registry.js` (+ формулы клэмпов — только сервер) | паритет держит `test:protocol-parity` (ключей 6, сервер == зеркало == golden); сервер пишет значения, клиент — только читает |
| Whitelist спрайтов (без parity-гейта) | `src/lib/sim/settings.ts:96` (`SPRITES: SpriteMeta[]`, 34) | `server/config.js:368` (`SPRITES`, 34) | руками в одном PR; счётчики держать равными |
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


Сцена Элизии (Babylon, WebGL, только `/game/`): px мира канваса переводит одна функция `worldPxToScene` в `src/lib/sim/elision-scene.ts` — `(x, lift, z = y)`. Второго ±1 нет: к кадру сеть уже стала `col`/`fx`. Камера в правой системе Babylon наклонена на 45°, вертикаль ортопроекции компенсирует сжатие земли: плоская карта совпадает с `screenToWorld`, высота даёт тот же экранный сдвиг вверх, что 2D. Грани left < right сохраняют правильное frustum-отсечение. `elision-present.ts` кэширует полный атлас поверхности (кисть/трава, покрытия, заходы, сетка зон `cells` и объектов `battle`); смена карты, декод кисти, догрузка пака и возврат из редактора обновляют атлас. Babylon использует его на земле и поднятых верхах клеток, строит стены только на перепадах эффективных высот (`elision-present` кладёт в кадр `effectiveElevRecord` — явные высоты плюс клетки камней); соседние клетки одной высоты не имеют общей стены. Высоты берутся из той же карты, что ходьба, шаг — `TERRAIN_LIFT_PX`. Рисунок земли загружается без invertY (верх PNG на z=0), старые спрайты стоят вертикальными билбордами у точки опоры (общая горизонтальная плоскость вызывала z-fighting). Постоянный depth bias разрешает совпавшие опоры; мешающее игроку препятствие просвечивает. MSAA, mipmaps и трилинейная фильтрация уменьшают дрожание границ. Клики остаются на 2D-холсте; в редакторе WebGL остаётся включённым (mid-stroke — dirty-загрузка атласа с мировым паттерном кисти), пивные гроты слот не монтируют, без WebGL остаётся прежний холст.

Снятые из поставки builtin-спрайты отфильтровываются при загрузке манифеста; загруженные администратором спрайты сохраняются. Неизвестный вариант дерева в сохранённой карте нормализуется в `tree-1` обоими sanitize, положение и коллизия объекта сохраняются.

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
closure (~2700 lines, single `useEffect` with deps `[stage]`, `const loop` :4099) —
extracting it whole would recreate a >800-line file, splitting it would re-wire engine
variables; state/refs belt of `Simulator()`; small callback/patch belts (мелкая крошка —
запрет пере-дробления). settings-panel.tsx не разрезан (1222, за лимитом держит
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

WebGL-персонаж сохраняет меш и материал при зеркалировании, изменяются только вершины. Кадр передаёт локальное/сетевое «желе» и состояние пробела; шкала заряда рисуется на HUD поверх WebGL. Коллизия и подъём определяются уровнем логической клетки под лапами, без экранного сдвига плато. `freemove.foot` — необязательное смещение лап в долях клетки (dx 0–4, dy 0–2); сервер проверяет перепад по той же опоре, старые пакеты без foot принимаются с нулевым смещением. Сервер не использует экранные surfaceLevel/inSouthWall для свободной ходьбы. Свободные координаты передаются и хранятся без округления до сотых: иначе лапы у самой кромки могли перейти в соседнюю клетку из-за округления угла спрайта.

HUD поля: круглый четырёхсекторный диск суток с неподвижной левой стрелкой и погодным спутником; погодные значки соответствуют трём реальным состояниям сервера. В WebGL передаётся непрерывный dayProgress: циклический цвет и временное сглаживание общие для земли, стен и персонажей. Метка посадки приходит из той же leapLandingAt/дуги, что управляет прыжком, и рисуется поверх WebGL. Разворот персонажей определяется горизонтальной составляющей движения в экранной системе камеры. В редакторе [ ] и кнопки ↶/↷ вращают камеру, Alt+[ ] и Alt+колесо меняют размер; вписывание карты учитывает повёрнутый bbox. Нижняя легенда удалена на обоих сайтах; у Элизии в шапке игры остаётся счётчик игроков и игровые действия, общая навигация и тема — в SiteHeader. Высота игровой области учитывает измеренную высоту SiteHeader (включая перенос навигации на узком экране), поэтому игровая панель не уходит под sticky-шапку.

Контакт с обрывом от 2 уровней проверяет круглое тело у лап (peaceBodyRadius), а не только его центр. `terrainBodyOverlap` зеркалится в test-map.ts/server/world.js: точное пересечение эллипса в долях клетки с прямоугольниками соседних клеток. freemove.foot.rx/ry — необязательный радиус в долях клетки (сервер зажимает 0–1), старые пакеты остаются точечными. При наложении после посадки/изменения карты можно выйти из стены и скользить вдоль неё, но нельзя углубляться. Объекты также учитывают радиус тела, посадка требует свободного места под тело. Опора пересчитывается после перемещения в том же кадре: вверх лапы сразу стоят на твёрдом грунте, вниз высота опускается плавно — спрайт не режется поверхностью из-за запаздывающего подъёма.

Мирная дуга прыжка проверяет высоту грунта с обеих сторон каждого пересечения клеточной границы; её амплитуда увеличивается только настолько, чтобы не входить в поверхность уровня старта/посадки. Допуск по заряду и перепаду не меняется, ровные прыжки прежние. При увеличенном теле предметов можно выйти из уже существующего наложения, но нельзя углубляться в него.

На заблокированном шаге contactFraction уточняет момент касания по каждой оси, сохраняя скольжение. Поэтому зазор перед стеной/предметом не зависит от скорости и длительности кадра.

Камни: явный рельеф (`terrainLevelAt`, `effectiveElevRecord`) рисуется отдельно от опоры предметов. Мирная опора `supportLevelAt` добавляет STONE_LEVEL=1 только внутри повёрнутого тела камня; сам камень стоит на грунте и остаётся непрозрачным. Боевые клетки сохраняют дискретный уровень `elevLevelAt`/`testElev`. Сохранение редактора отправляет снимок черновика даже после закрытия панели во время кодирования; ошибка диска откатывает серверную карту и не рассылает успешный `map`. Регрессии: `npm run test:editor-save`.

Сохранение профиля (`PATCH /profiles/me`) использует общую пару Origin/класс сайта через originAllowedHere и csrfDecision, как /auth и HTTP-слой. Доверенный адрес сайта не нужно повторно добавлять в старый глобальный ALLOWED_ORIGINS; посторонние Origin и запросы с cookie без Origin отклоняются. Регрессия test:cross-origin: смена и повторная смена скина с последующим GET.

Скин `test1`: builtin `/sprites/test1.png` с прозрачным фоном, отдельная группа выбора `test1` (оригинал + «test1 PNG 600»; WebP-вариант снят); статический каталог клиента и серверный whitelist содержат 33 базовые модели. Старый runtime-манифест автоматически дополняется новыми моделями при запуске, снятый builtin из манифеста не воскресает. Пробная анимация ходьбы: builtin `/sprites/test1-walk.gif` (оригинальные байты, SHA-256 в test:sprites) декодируется клиентом (gif-walk.ts, WebCodecs ImageDecoder) и проигрывается в 2D-канвасе и WebGL, пока кот идёт (свой: флаг свободной ходьбы/боевая дуга, чужой: доведение freemove/очередь клеток); направление — существующие flip-правила drawChar, фаза цикла своя у каждого кота. Браузер без ImageDecoder использует 11 lossless PNG-кадров с исходными длительностями. Анимация назначена test1 и test1-png; WebGL кэширует текстуры кадров, не загружая их заново при каждом шаге.

Рельеф и редактор: [TERRAIN-EDITOR.md](TERRAIN-EDITOR.md). `src/lib/sim/terrain-editor.ts` (188 строк) содержит выбор видимой поверхности лучом, прямоугольные штампы и экранные подсказки. Редактор и игра используют одну WebGL-сцену с проверкой глубины; объекты не дублируются отдельным 2D-проходом.

Точные прямоугольники рельефа: `src/lib/sim/terrain-shape.ts` (366 строк); серверное зеркало санитаризации, разбиения и контакта находится в `server/testmap.js`. elev поддерживает целочисленные ключи «c,r» и прямоугольные «x,y,w,d», уровни 0–20 с точностью 0,1; прямоугольный ноль перекрывает старую высоту. Последняя прямоугольная запись имеет приоритет. Боевые клетки берут уровень в центре; мирная опора/столкновения и рендер используют точные границы.

Сохранение редактора: неизменённый PNG переиспользуется, rebuildTestGeometry(previousMap) сохраняет неизменённые TEST_PAINT/TEST_ISLAND/TEST_CELLS. info «Редактор: сохранено.» означает успешную атомарную запись; map остаётся полной авторитетной картой для всех участников. Потеря сокета и field после переподключения очищают старый индикатор ожидания. Свободный штамп и магнит вычисляются общей freeTerrainPlacement для превью и клика.

Редактор — отдельное рабочее пространство: editor-overlay.tsx + editor-workspace.module.css. FieldStage резервирует место для инспектора/панелей и холста; чат/игровая шапка скрыты до выхода. Горячие клавиши редактора перехватываются в EditorOverlay до игровых обработчиков. editor-model.ts содержит EditorSnapshot и восстановление единой истории; editor-ops управляет undo/redo и подтверждённым чистым состоянием. paint.ts рисует свободные интерполированные штампы и scanline-заливку. Ревизия paintOverride инвалидирует атлас WebGL во время рисования. use-network игнорирует повтор одинаковой авторитетной карты; параметры необязательного mir/rot/scale сравниваются с их семантическими значениями по умолчанию. Сетевой формат карты не менялся.

Координаты редактора: стабильный обзор по cols×cellW / rows×cellH, без зависимости от paint bbox; HUD clearFieldHud обновляет размеры на каждом кадре. cursorScreenRef хранит clientX/clientY для повторной привязки к прямоугольнику холста после изменения панелей. Незафиксированный призрак обновляется в rAF тем же попаданием луча, что и кисть. Погода редактора — локальный дневной режим, без atmo/atmoset-запросов на сервер.

### Расширение карты и архивы (PR #75)

Форма нарисованной земли для ходьбы читается непосредственно из alpha-маски,
а не из сглаженного полигона отрисовки. Клиент и сервер используют одинаковое
правило; старые зоны задают боевые области, но не ограничивают новую заливку.
Проверки тела у обрывов кэшируются по версии высот и читают только соседние
клетки. Пустой рельеф использует общий объект и не строит геометрию мира при
каждом шаге. Устаревший PNG-decode не может заменить новый рисунок/холст редактора.

При работающем WebGL старый 2D-рендер мира выключен (холст остаётся для ввода),
на загрузке нового рисунка прежняя карта по контуру зон не показывается.
2D-отрисовка остаётся fallback для устройств без WebGL и движком гротов.

Раздел «Мир» экспортирует ZIP/store с версионированным map.json (включая PNG),
проверяет формат, CRC, размеры и карту перед импортом. Очистка и импорт меняют
только черновик, входят в undo/redo и применяются для комнаты обычным сохранением.
Полная очистка удаляет рисунок, высоты, зоны, объекты и спавны, оставляя ровное
травяное поле. Мирные карты без боевых зон валидны; спавн на них ищется по земле.

Анимация ходьбы test1 / test1 PNG: кадр передаётся в WebGL как actor.image, материал и геометрия переиспользуются. Исходные кадры вписываются без искажения пропорций в размер статичного спрайта с сохранением точки опоры; коллизии и развороты остаются прежними. Без WebCodecs используются побайтно точные по RGBA PNG-кадры GIF.

Высота в редакторе подписывается только в текущей точке наведения. Оверлей использует уже выбранную поверхность (terrainCursor), без обхода всех блоков и повторного pickTerrainTop для каждого. Общая 2D-отрисовка также не выводит подписи всей карты.

### Растения в редакторе (PR #80)

75 декоративных спрайтов из пяти исходных PNG-листов: «Объекты → Растения»,
группы и поиск, свободная точка опоры, масштаб/поворот/отражение. Тип объекта
`plant` сохраняет x/y/s/rot/spr/mir на обеих сторонах и в ZIP-архивах.
Растения не входят в obstacleBodies/stone support/боевые блокировки и не
занимают логический индекс входов. Выделение и перенос используют свободные
координаты, как для других спрайтов. WebGL рисует их билбордами; 2D fallback
лениво загружает только используемые PNG.

Каталоги данных src/lib/sim/plant-sprites.json и server/plant-sprites.json
зеркальны (регрессия test:editor-save); код клиента и сервера не импортирует
модули друг друга. Размеры и координаты нарезки записаны в каталоге. Оригиналы
побайтно сохранены в public/tex/plants-source, нарезанные PNG сохраняют RGBA
соответствующего региона без масштабирования и перерисовки.

Мирное движение по полю: фиксированные 220 px мира/с, Shift ×1,5 (330 px/с). Старое localStorage peaceSpeed нормализуется к правилу поля; ползунок скорости заменён справочной строкой. Боевой шаг и сетевой формат freemove не меняются.

Погода/эффекты поля: setWeatherFx скрывает весь Pixi-холст с учётом master
видимости и очищает сохранённый GPU-кадр, не замораживая дождь. Суточный цвет
остаётся независимым. Капли — тонкие штрихи; случайные брызги выбираются только
на нарисованной земле и хранят мировую позицию/высоту.

particles.ts ведёт ограниченные пулы (90 частиц земли/травы/пыли, 64 брызги).
Спринт и одноразовое приземление рисуются на HUD поверх текущего WebGL/2D вида
через общую проекцию с учётом yaw, zoom и высоты опоры. Старый скрытый проход
частиц удалён. В редакторе пулы очищаются, погодный тумблер мгновенно убирает
брызги, но не отключает частицы движения.

Remote free-move jumps reuse the existing `jp` flag: repeated airborne packets do not restart the visual arc; a single dust burst is emitted when it ends. Sprint chips and landing dust are rendered locally for every visible peer, using its interpolated feet and terrain support.

World locations: `test` is Долина (ID 1), `test-loc-2` is Редколесье (ID 2), both zone 1 Средиземье; further maps get the next free ID via admin create (`POST /locations`, blank 10×10; `/admin/locations` alias). Legacy `test-map.json` stays in place; `location-N.json` files are separately atomic and backed up. Editor textures (trees/rocks/plants/covers/floors) are managed under `/admin` → «Текстуры» (`DATA_DIR/tex`, `/tex/file/*`, custom CRUD + live `/tex/catalog`). Map `place` and `passages` survive sanitization, editor history/archive/save. `field.locations` seeds the catalogue; server `locations` only updates metadata across rooms. JOIN `{passageId}` verifies an authenticated peaceful actor inside the saved trigger and derives the destination/arrival on the server. Reverse passages use matching link keys; absent reverse uses spawn. Geometry lives in cached synchronous `withTestLocation` scopes; nested FIELD/catalog and queued movement restore their prior scope. Position keys retain legacy Valley entries and add a location suffix for other maps.

Detailed world-location schema, persistence boundaries, editor actions and travel phases: [WORLD-LOCATIONS.md](WORLD-LOCATIONS.md). Initial world joins also remember positions and lastLocationId; a new entry resumes that world, while explicit room links override it. The client clears source-room chat/entry anchors and cancels jump input on transfer. A missing/corrupt neighboring map never replaces Valley or poisons its geometry cache.
