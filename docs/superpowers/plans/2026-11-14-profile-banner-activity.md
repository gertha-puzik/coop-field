# Профиль: шапка, лента действий, вёрстка — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Профиль Элизий по макету: шапка с кадрированием 3:1, сгенерированная шапка по умолчанию, пиксельный редактор шапки, публичная лента «Последние действия», двухколоночная вёрстка.

**Architecture:** Сервер получает один новый модуль `server/activity.js` (журнал событий по аккаунту, как `notifications.js`) и вызовы `pushActivity` в существующих точках (presence, travel, friends, avatars, banners, account-delete). Шапка целиком клиентская: кадр и рисунок превращаются в PNG/JPEG 1200×400 и уходят в уже существующий `POST /cfg/banners/mine`; генератор — чистая функция от `accountId`. Вёрстка карточки собирается из новых компонент рядом с `profile-card-view.tsx`.

**Tech Stack:** Node (ESM, `node:http`), Next.js static export, React 19 client components, CSS modules, `<canvas>`.

**Spec:** `docs/superpowers/specs/2026-11-14-profile-banner-activity-design.md` (+ макет `2026-11-14-profile-mockup.webp` рядом).

## Global Constraints

- Только Элизии (`NEXT_PUBLIC_SITE=elyria`); на public-классе хоста `/activity*` и `/cfg/activity*` отвечают `404 not_found`; в grotto-бандле ни строки `/cfg/activity` (гейт `check:variants`).
- Каждый файл ≤ 800 строк (`npm run arch:check`); `player-profile.tsx` (851, в allowlist) может только уменьшиться.
- Литерал `/cfg/activity` живёт только в `src/lib/net/http-activity.ts`; клиент ходит на `/cfg/activity/<id>`, канон сервера — `/activity/<id>`.
- Журнал: `DATA_DIR/activity.json`, `{ v:1, byAccount }`, ≤ **20** событий на аккаунт, запись `writeFileAtomic`.
- Типы событий ровно: `joined_site`, `entered_game`, `moved`, `friend_added`, `avatar_changed`, `banner_changed`.
- Схлопывание: то же событие (для `moved` — тот же `locationId`) < **2 мин** назад → обновить `at`; `entered_game` не чаще раза в **10 мин**.
- Шапка: результат строго **1200×400**; сервер не меняется (лимиты ≤1200×400, ≤2 МБ).
- Генератор/редактор: сетка **120×40**, масштаб ×10, nearest-neighbour.
- Лента публична, включая названия локаций (решение владелицы 2026-11-14).
- Тексты интерфейса — по-русски; человеческие ошибки, без кодов.
- Гейты из `AGENTS.md` «Gates» зелёные перед PR.

## Review Focus

1. Уход из друзей → у обеих сторон пропадает `friend_added` друг о друге (публичная лента не врёт). Тест — Task 2.
2. Удалённый аккаунт: его журнал стёрт, а в чужих лентах `friend_added` о нём показывает «кто-то», а не падает. Тест — Task 2.
3. Кадрирование крошечной (меньше 1200×400) или очень вытянутой картинки: минимальный зум всё равно закрывает рамку, края без пустот. Тест — Task 4 (`coverScale`/`clampOffset`).
4. Порченый/посторонний `activity.json` (не JSON, не объект) — сервер стартует с пустым журналом, не падает. Тест — Task 1.
5. Мобильная ширина (<760px): одна колонка, шапка и меню шапки доступны тачем, кадр двигается пальцем (pointer events). Ручная проверка — Task 6, Step 2.

---

### Task 1: Серверный журнал `server/activity.js` + маршрут

**Files:**
- Create: `server/activity.js`
- Modify: `server/net.js` (импорт; host-гейт public → 404 для `/activity*` и `/cfg/activity*` рядом с `/friends` ~:280–:293; apiZone ~:359; цепочка хендлеров ~:430 — `handleActivityHttp` сразу после `handleFriendsHttp`)
- Create: `scripts/test-activity.mjs` (песочница как `scripts/test-profile-social.mjs`: mkdtemp `DATA_DIR`, свободный порт, spawn `server.js`)
- Modify: `package.json` — `"test:activity": "node scripts/test-activity.mjs"`

**Interfaces:**
- Produces:
  - `pushActivity(accountId: string, type: ActivityType, data?: object): void`
  - `forgetActivity(accountId: string): void` — стирает журнал аккаунта.
  - `dropFriendActivity(aId: string, bId: string): void` — убирает `friend_added` пары у обоих.
  - `handleActivityHttp(req, res): Promise<boolean>` — `GET /activity/:accountId` и `/cfg/activity/:accountId` (канонизация как `canonFriendsPath` в friends.js).
  - Ответ: `{ ok:true, items: Array<{ id, type, at, text?: never, data }> }`, новые сверху. При отдаче: `friend_added.data.friendName` = текущее `displayName` друга (`findById` + `publicProfile`), нет аккаунта → `"кто-то"`; если среди событий нет `joined_site`, в конец добавляется синтетический `{ id:"joined", type:"joined_site", at: acc.createdAt, data:{} }` (не хранится). Неизвестный/удалённый аккаунт → `404 not_found`. Не GET → `405`.

- [ ] **Step 1: Тест (failing)** — `scripts/test-activity.mjs`, сценарии с `check(cond, label)`:
  - зарегистрировать A → `GET /activity/<A.id>` → `items.length === 1`, `items[0].type === "joined_site"`, `items[0].at === createdAt`;
  - `GET /cfg/activity/<A.id>` даёт то же;
  - `GET /activity/nope` → 404; `POST /activity/<A.id>` → 405;
  - public Host (`probeWithHost` как в test-profile-social) `/activity/<A.id>` → 404;
  - порченый журнал: перед spawn записать в `DATA_DIR/activity.json` строку `"{oops"` → сервер отвечает `/health` 200 и лента A всё равно `[joined_site]`.
- [ ] **Step 2:** `npm run test:activity` → FAIL (404 на маршрут).
- [ ] **Step 3: Реализовать `server/activity.js`** по образцу `server/notifications.js` (loadStore/persist/listOf). `pushActivity`: новый `{ id: "ac-"+hex, type, at: Date.now(), data }` в начало; схлопывание и лимит 20 — из Global Constraints. Подключить в `net.js` в трёх местах.
- [ ] **Step 4:** `npm run test:activity` → все `OK`, код выхода 0.
- [ ] **Step 5: Commit** `feat(activity): public per-account activity journal`.

### Task 2: События в существующих точках + доки

**Files:**
- Modify: `server/presence.js` (heartbeat `where==="game"`, ~:267: если до обновления `row.gameUntil <= now` → `pushActivity(id, "entered_game", { label: locationLabelOf(acc) })`)
- Modify: `server/location-world.js` `travel()` (после успешного `join(...)`, ~:304): `pushActivity(ws.account.id, "moved", { locationId: passage.targetId, label: locationLabelOf(ws.account) })`
- Modify: `server/friends.js` — на обоих путях `accepted` (~:220, ~:250) `pushActivity` обеим сторонам `friend_added { friendId }`; на `remove` (~:279) `dropFriendActivity(a, b)`
- Modify: `server/avatars.js`, `server/banners.js` — после успешного upload `pushActivity(id, "avatar_changed"|"banner_changed")` (DELETE событий не даёт)
- Modify: `server/account-delete.js` — `forgetActivity(id)`
- Modify: `scripts/test-activity.mjs`, `scripts/test-locations.mjs`
- Modify: `docs/PLATFORM-ARCHITECTURE.md` (таблица HTTP-маршрутов), `docs/PRIVACY-DATA.md` (строка `activity.json`: публичный журнал, включая названия локаций; стирается при удалении аккаунта), `AGENTS.md` (Room server: `activity <N>` + `/cfg/activity` в описании net; Gates: `npm run test:activity`), `.github/workflows/ci.yml` (шаг `npm run test:activity` рядом с `test:locations`, ~:93)

**Interfaces:**
- Consumes: `pushActivity`, `dropFriendActivity`, `forgetActivity` (Task 1); `locationLabelOf(acc)` из `server/presence.js`.

- [ ] **Step 1: Тесты (failing)** в `test-activity.mjs`:
  - heartbeat `{where:"game"}` дважды подряд → ровно одно `entered_game`, у него `data.label` — строка;
  - A→B заявка, B accept → у A и у B по `friend_added`, `data.friendName` = имя другого; B переименовался (`PATCH /profiles/me {displayName}`) → у A новое имя;
  - A `remove` B → ни у кого нет `friend_added`;
  - upload баннера 1200×400 → `banner_changed`; второй upload через 10+ с → всё ещё одно `banner_changed` (схлопнулось);
  - B удаляет аккаунт (`DELETE /profiles/me {password}`) после повторной дружбы → `GET /activity/<B.id>` 404, у A `friend_added.data.friendName === "кто-то"`;
  - лимит: 25 вызовов разных типов недостижимы через HTTP — проверить через 21 смену баннера с `Date`-сдвигом нельзя, поэтому лимит проверяется unit-путём: `node -e` импорт `server/activity.js` с `DATA_DIR` во временной папке, 25 × `pushActivity(id, "moved", {locationId:i})` → в store ровно 20, первое — `locationId:24`.
  - `test-locations.mjs`: после первого успешного `join {passageId:'forest'}` (~:90) — `GET /activity/<accountId>` содержит `moved` с `data.locationId === 2`.
- [ ] **Step 2:** `npm run test:activity && npm run test:locations` → FAIL на новых проверках.
- [ ] **Step 3:** Вставить вызовы в перечисленные места.
- [ ] **Step 4:** `npm run test:activity && npm run test:locations && npm run test:profile-social && npm run test:avatars` → зелёные.
- [ ] **Step 5:** Обновить доки; `npm run check:landmarks` → зелёный.
- [ ] **Step 6: Commit** `feat(activity): record game entry, travel, friends, avatar/banner changes`.

### Task 3: Клиент ленты + генератор шапки

**Files:**
- Create: `src/lib/net/http-activity.ts`
- Create: `src/lib/sim/banner-gen.ts`
- Create: `scripts/test-banner-gen.mts`; Modify: `scripts/run-unit-tests.mjs` (строка в `TESTS`)

**Interfaces:**
- Produces:
  - `type ActivityItem = { id: string; type: 'joined_site'|'entered_game'|'moved'|'friend_added'|'avatar_changed'|'banner_changed'; at: number; data: { label?: string; locationId?: number; friendId?: string; friendName?: string } }`
  - `httpActivity(accountId: string): Promise<{ ok: true; items: ActivityItem[] } | { ok: false; reason: string }>` — на grotto (inline `IS_ELYRIA` false) сразу `{ok:false, reason:'not_found'}`; мусорные элементы отбрасываются.
  - `BANNER_W = 120`, `BANNER_H = 40`
  - `generateBanner(seed: string): Uint8ClampedArray` — RGBA, длина `120*40*4`, без DOM.
  - `paintPixels(ctx: CanvasRenderingContext2D, rgba: Uint8ClampedArray, scale: number): void` — рисует сетку nearest-neighbour (для превью и экспорта).

- [ ] **Step 1: Тест (failing)** `scripts/test-banner-gen.mts`: длина `19200`; `generateBanner("a")` дважды → побайтно равны; `"a"` vs `"b"` → различаются > 5% пикселей; все альфы = 255; верхняя строка темнее нижней строки неба в среднем (ночное небо — градиент к горизонту).
- [ ] **Step 2:** `npm run test:unit` → FAIL (модуль не найден).
- [ ] **Step 3:** Реализовать. Seed: FNV-1a хэш строки → mulberry32. Слои: 3–4 палитры ночного неба (выбор по seed), градиент, звёзды (~60–120, часть 2px), луна (серп/полная, позиция в верхней трети), 2–3 силуэта холмов (сумма синусов от seed), деревья-силуэты на ближнем холме, по seed — руины-арка или замок вдали, кусты с цветными точками у нижних углов. `httpActivity` — по образцу `src/lib/net/http-friends.ts` (`apiFetch`).
- [ ] **Step 4:** `npm run test:unit && npm run typecheck` → зелёные.
- [ ] **Step 5: Commit** `feat(profile): generated pixel banner and activity client`.

### Task 4: Кадрирование шапки «как в Твиттере»

**Files:**
- Create: `src/components/players/banner-crop-math.ts`
- Create: `src/components/players/banner-cropper.tsx`
- Create: `scripts/test-banner-crop.mts`; Modify: `scripts/run-unit-tests.mjs`

**Interfaces:**
- Produces:
  - `coverScale(imgW: number, imgH: number, frameW: number, frameH: number): number` — минимальный масштаб, при котором картинка закрывает рамку.
  - `clampOffset(off: {x:number;y:number}, imgW: number, imgH: number, scale: number, frameW: number, frameH: number): {x:number;y:number}` — сдвиг (px рамки, левый-верхний угол картинки относительно рамки) так, чтобы края не открывались.
  - `cropRect(off, scale, frameW, frameH): { sx:number; sy:number; sw:number; sh:number }` — прямоугольник исходника для `drawImage`.
  - `<BannerCropper file: File; onDone: (blob: Blob) => void; onCancel: () => void />` — модалка: рамка 3:1 на всю ширину модалки, drag через pointer events (мышь и тач), ползунок зума `coverScale … coverScale*4`, кнопки «Сохранить»/«Отмена»; Esc = отмена. Экспорт: canvas 1200×400, `drawImage` по `cropRect`, `toBlob('image/jpeg', 0.9)`; если исходник `image/png` — сначала PNG, и только если он > 2 МБ — JPEG. Файлы > 10 МБ отклоняются текстом «Картинка больше 10 МБ — выберите поменьше».

- [ ] **Step 1: Тест (failing)** `scripts/test-banner-crop.mts`: `coverScale(600,200,1200,400) === 2`; `coverScale(300,1000,1200,400) === 4` (узкая высокая); `clampOffset({x:50,y:50},1200,400,1,1200,400)` → `{x:0,y:0}`; `clampOffset({x:-5000,y:0},2400,400,1,1200,400)` → `{x:-1200,y:0}`; `cropRect({x:-100,y:-50},2,1200,400)` → `{sx:50,sy:25,sw:600,sh:200}`.
- [ ] **Step 2:** `npm run test:unit` → FAIL.
- [ ] **Step 3:** Реализовать math и компонент (UI-kit: `Button` из `@/components/ui`; стили — новый `src/components/players/profile-card.module.css`).
- [ ] **Step 4:** `npm run test:unit && npm run typecheck` → зелёные.
- [ ] **Step 5: Commit** `feat(profile): twitter-style banner cropper`.

### Task 5: Пиксельный редактор шапки

**Files:**
- Create: `src/components/players/banner-painter.tsx`
- Create: `src/components/players/banner-paint-ops.ts`; `scripts/test-banner-paint.mts`; Modify: `scripts/run-unit-tests.mjs`

**Interfaces:**
- Consumes: `generateBanner`, `paintPixels`, `BANNER_W/H` (Task 3).
- Produces:
  - `floodFill(px: Uint8ClampedArray, x: number, y: number, rgba: [number,number,number,number]): void` (4-связная, сетка 120×40)
  - `stamp(px, x, y, size: 1|2|3, rgba): void`
  - `<BannerPainter seed: string; onDone: (blob: Blob) => void; onCancel: () => void />` — инструменты: кисть 1/2/3, ластик (рисует цветом `#0b1026`), заливка, пипетка; палитра 24 цвета ночной гаммы + `<input type="color">`; отмена/повтор (стек 50 снимков); кнопки «Начать с моей шапки» (= `generateBanner(seed)`) и «Чистый лист» (заливка `#0b1026`); старт — с генерированной. Рисование pointer events с интерполяцией линии между событиями. «Сохранить» → canvas 1200×400 через `paintPixels(…,10)` → `toBlob('image/png')`.

- [ ] **Step 1: Тест (failing)**: `floodFill` на чистом поле красит все 4800 пикселей; на поле с замкнутой рамкой 10×10 красит только внутренность (64); `stamp(size 3)` у угла (0,0) не выходит за границы и красит 4 пикселя.
- [ ] **Step 2:** `npm run test:unit` → FAIL.
- [ ] **Step 3:** Реализовать.
- [ ] **Step 4:** `npm run test:unit && npm run typecheck` → зелёные.
- [ ] **Step 5: Commit** `feat(profile): pixel banner painter`.

### Task 6: Вёрстка профиля по макету

**Files:**
- Create: `src/components/players/profile-hero.tsx` — шапка (своя `<div style=backgroundImage>` или `<canvas>` из `generateBanner(card.accountId)` с `image-rendering: pixelated`), меню владельца «Изменить шапку» → «Загрузить картинку…» (скрытый `<input type=file accept="image/*">` → `BannerCropper`), «Нарисовать…» (`BannerPainter`), «Убрать шапку» (только если есть, подтверждение вторым кликом как сейчас); аватар с наездом на шапку; имя, статус, первая строка «о себе», пилюли (дни/лунки, «На сайте с …», presence), кнопки дружбы (перенос из `profile-card-view.tsx` без изменения логики).
- Create: `src/components/players/profile-activity.tsx` — `httpActivity(card.accountId)` при монтировании и при смене `accountId`; строки: иконка, текст, относительное время `ruAgo(at, now)` из `players-format.ts`; пусто → «Пока тихо»; ошибка → «Ленту не удалось загрузить».
- Create: `src/components/players/profile-friends-grid.tsx` — сетка аватаров с точкой presence, клик открывает профиль; владелец: «Удалить» остаётся (в меню/наведении).
- Create: `src/components/players/profile-card.module.css` — карточки с рамкой и стеклом по макету, две колонки `grid-template-columns: 1fr 1fr`, < 760px — одна колонка в порядке: персонаж, друзья, действия, статистика, о себе.
- Modify: `src/components/players/profile-card-view.tsx` — собирает: Hero, вкладки «Профиль»/«⚙ Настройки профиля» (справа), левая колонка (Активный персонаж = `MeadowPortrait` + имя; Краткая статистика плитками: дни на сайте, персонажей, локация, время в игре, друзей; О себе), правая (Друзья · N, Последние действия). Новый проп `onBannerChanged?: () => void`.
- Modify: `src/components/players/player-profile.tsx` — убрать блок фона из редактора (стейт `bannerUrl/bannerBusy/armedBanner/bannerFileRef`, `uploadOwnBanner/removeOwnBanner`, разметка ~:470–:510, импорт http-banners); передать `onBannerChanged={async () => { const f = await httpMyProfile(); if (f.ok && f.profile) onSaved(f.profile); }}`. Файл должен стать короче 851.

**Тексты событий** (`profile-activity.tsx`; имя друга — ссылка на профиль, если `friendName !== "кто-то"`): Пола в DTO нет — тексты нейтральные, без глагола в прошедшем времени: `joined_site` «Регистрация на сайте»; `entered_game` «Вход в игру» + ` · {label}`; `moved` «Переход в локацию «{label}»»; `friend_added` «Новый друг: {friendName}»; `avatar_changed` «Новый аватар»; `banner_changed` «Новая шапка профиля».

- [ ] **Step 1:** Реализовать компоненты; `npm run typecheck && npm run arch:check` → зелёные.
- [ ] **Step 2:** `NEXT_PUBLIC_SITE=elyria npm run dev -- --hostname 0.0.0.0 --port 3000` + `npm start`; зарегистрировать двух игроков; проверить в браузере: генерированная шапка у нового игрока, кадр (drag/zoom/сохранить), рисование (кисть/заливка/отмена/сохранить), «Убрать шапку» возвращает генерированную, лента показывает регистрацию/вход в игру/друга/шапку, ширина 375 px — одна колонка, кадр двигается тачем (эмуляция mobile). Скриншоты сверить с макетом.
- [ ] **Step 3: Commit** `feat(profile): mockup layout with hero banner, friends grid and activity`.

### Task 7: Гейты и PR

- [ ] **Step 1:** Все команды из `AGENTS.md` «Gates» + `npm run test:activity`; `npm run build:variants && npm run check:variants`. Всё зелёное.
- [ ] **Step 2:** Push ветки, PR по `.github/PULL_REQUEST_TEMPLATE.md`: ссылки `https://pr-<N>.abnocw.phainonsmilk.ru` и `https://pr-<N>.elysiae.phainonsmilk.ru`, Added/Changed, как проверено. Мерж — только по слову владелицы.
