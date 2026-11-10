# AGENTS.md — agent map of the coop-field repo

Coop-field: cat battles on a shared canvas field. One engine builds TWO public sites
(`NEXT_PUBLIC_SITE=grotto|elyria`, default grotto): the public Beer Grottoes and the
account-based Elysiae — see "Host policy" below. Two independent loops live in this repo:

- **Front** — Next.js static export (`output: "export"`): canvas engine, HUD, panels, screens. Lives in `src/`.
- **Room server** — ONE plain Node process (`server.js`, `ws`): rooms, cells, combat, chat,
  atmosphere + the HTTP surface for accounts/sessions, profiles and admin config. Vercel-style
  hosts cannot keep WebSocket, so the room runs on the owner's VPS behind nginx
  (systemd unit `coop-field`).

The two loops are connected ONLY by the wire protocol `[event, payload]` — there is no shared code;
matching constants are hand-copied mirrors (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §4 —
required reading before touching either side).

This file is the map: the minimum needed to start a task without reading the god-files.
Human overview — [README.md](README.md) (Russian, on purpose); depth — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md);
platform (accounts, two sites, config registry) — [docs/PLATFORM-ARCHITECTURE.md](docs/PLATFORM-ARCHITECTURE.md).

## Gates: run before submitting ANY task

```bash
npm run typecheck   # tsc --noEmit — always run: fast explicit type check (build catches the same, but slower)
npm run test:unit   # engine unit tests (node>=22.6, otherwise SKIP; CI runs on node 22)
npm run arch:check  # architecture gate: files <=800 lines + layer boundary rules
npm run check:protocol       # protocol doc tables == EV.* registries (W3)
npm run test:protocol-parity # client/server golden parity, incl. the 5-key config registry (W3/P4)
npm run check:landmarks      # doc size numbers == wc -l (W7a)
npm run test:queue           # server step-queue contract (spawns its own server)
npm run test:server-modules  # server module smoke against golden values
npm run test:stone           # stone = level-1 platform: battle cell walkable, elev step rules, tree still a wall
npm run test:auth            # accounts, cookies/CSRF, host gate, closed Elision (P1–P3)
npm run test:cross-origin    # B1: per-destination Origin/CSRF/CORS live-probe matrix (>=20)
npm run test:cfg             # config registry whitelist + clamps + list mutations (P4/B2); S1 harness: stop -> make-admin -> restart cycle
npm run test:profiles        # HTTP profiles: catalog (?q/?limit/?cursor), card, PATCH /profiles/me (P5)
npm run test:my-sprites     # #83: /sprites/mine* — сессия, дедуп, лимит 3, rate, IHDR-валидация, CSRF, corrupt-манифест (spawn песочница)
npm run check:paint-seam    # #84 ч.2: шов копии KNS Paint (sha1 эталона) + ровно один <script> моста перед </body>
npm run check:catwar-vendor # #84 в3: vendor-копия public/catwar байт-в-байт — sha256-канон tint.js+манифеста+масок gray
npm run test:catwar-coat    # #84 в3: код CatWar → котик: грамматика в node:vm, пиксельная реплика, детерминизм, битые коды — отказ
npm run check:variants       # A1 isolation gate after build:variants: grotto zero Elysiae markers (incl. latin 'elisium'), elyria no /combat//hunger/, chunk links resolve
```

All of them must be green. If `arch:check` fails on a new file — do not grow the allowlist
(it holds only legacy god-files; they are removed in waves W4/W5).

Merge gate (server-side, not a local command): `main` branch protection requires the green
`conflict-check` status check before any merge, `enforce_admins` ON. On every PR into `main`
it test-merges `origin/main` into the PR branch (`.github/workflows/conflict-check.yml`,
~6 s) — a conflicted PR can never merge: GitHub refuses conflicted PRs natively, and the gate
makes the block a visible red ✗ in the PR checks. Old branches that predate the gate file
report the check only after their first push/Update branch.

## Code map

| Task leads to | File | What is inside |
| --- | --- | --- |
| Any engine task | `docs/ARCHITECTURE.md` §2 | map of ALL modules with line ranges — read first |
| Any platform task | `docs/PLATFORM-ARCHITECTURE.md` | as-implemented: accounts, host policy, token matrix, config registry, RETIRED_ROOMS |
| Room server | `server.js` (10, thin entry since W4: imports `startServer()` from `server/net.js`) + `server/` modules: config 440 (host policy; WS_MAX_PER_IP/ROOMS_MAX S5), protocol 284 (W3 canon + auth/whoami), testmap 664 (сохранение любым игроком локации без пароля), world 744 (камень — платформа STONE_LEVEL: stoneCellsOf, testElev по эффективному уровню, buildCells блокирует только деревья), sanitize 95, room 569 (join gate, roomsinfo ghost, rooms_full S5b; F2: стартовый atmo-якорь из per-room initialRoomAtmo), movement 311, combat 285 (registry clamps), dummy-rab 133, atmo 128 (F2 §3.4: per-room гейт allowPlayerAtmosphereControl в atmo()/atmoset() — молчаливый drop), persist 165 (P5: + catSeenAt, read-only время последней записи кота из catBook, TTL 30 дней; admin-стык forgetCat — сброс положения), net 471 (HTTP host gate, per-destination Origin/CSRF B1, per-IP sockets S5a, /health clientIpMode S4; room-роуты /cfg/rooms* ПЕРЕД глобальным /cfg-хендлером; контент-волна 2026-11-10: сессионные /avatars/mine в host-гейте и apiZone рядом с my-sprites, публичный GET /avatars/file/* диспетчеризуется ДО статики), modes 45 (grotto catalogue, RETIRED_ROOMS), accounts 508 (S1: admin role only via scripts/make-admin.mjs; контент-волна 2026-11-10: publicProfile + birthday ГГГГ-ММ-ДД|null и avatar-URL через avatarUrlOf из profile.avatarExt/avatarAt — мусор в null), auth 562 (sessions, cookie, token matrix; P5: + lastSeenByAccount, read-only свежая сессия, TTL 14 дней), profiles 650 (public cards, ?q/?limit/?cursor catalog; P5: card() + lastSeenAt/lastSeenRoom — read-only из сессий и catBook; контент-волна 2026-11-10: PATCH-поле birthday ГГГГ-ММ-ДД|null — sanitize: реальная дата, 01.01.1900..сегодня UTC), runtime-config 375 (v2 routes; §4 playerSelectable; restore мигрирует), cfg-registry 431 (6-key whitelist: 5 numeric + bool atmoset gate F2 §3.4; §4 sanitizeList; clamps + list-mutation meta B2), room-config 589 (F2 §3 per-room: /cfg/rooms*, слои, room-configs.json atomic, гейт), hunger 11 (skeleton), sprites 793 (#83: манифест-каталог окрасов — единая очередь serializeManifestWork/mutateSprites на ВСЕ мутации (админские + личные), атомарные коммиты в порядке png→память→manifest.json→syncWhitelist с откатом; скрытие hidden админом уводит строку из каталога/whitelist/spriteIdAllowed, файл-улика остаётся; битый манифест откладывается manifest.corrupt-<ts>.json с громким логом, каталог пересеивается базой; опциональные поля строк ownerAccountId/sha256/w/h/bytes/hidden — старые манифесты валидны), my-sprites 350 (сессионная зона #83: POST/GET/DELETE /sprites/mine* на стеке /profiles/me — unsafe-cookie Origin-щит + host-гейт (public → 404); multipart PNG+name 2–24 NFC, id=транслит-слаг имени, категория «Мои окрасы» серверная; дедуп sha256 своего же тела → 200 существующего без траты слота; лимит MAX_SPRITES_PER_ACCOUNT=3 (409 limit), IHDR 100–1000/площадь≤600k/тело≤1 МБ; rate 5/час+20/день in-memory (429); аудит sprites-audit.jsonl append-only), avatars 368 (контент-волна 2026-11-10: сессия+apiZone POST/DELETE /avatars/mine, публичный GET /avatars/file/<id>.<png|jpg>?v=<ts>; PNG IHDR/JPEG SOF: сторона 64–1500 px, ≤2.25 Мп, тело ≤2 МБ, файл ≥100 байт; rate 1/10с на аккаунт → 429 reason=rate; data/avatars, tmp+rename, файл <accountId>.<ext>; профиль-поля avatarExt/avatarAt; тесты scripts/test-avatars.mjs), admin-ops 90 (admin-операции «Игроки на поле»: GET /admin/players — занятость комнат, POST /admin/players/reset — сброс кота на свежую клетку спавна, role-gate admin) — domain map with details in ARCHITECTURE.md §2 |
| Canvas engine | `src/components/sim/simulator.tsx` (4844) | Two-stage carve: W5a moved the pure helper belt to `src/lib/sim/*` (engine-consts, geometry, targeting, combat-log, particles, paint, editor-model, gif-walk); W5b moved stage-2 pieces to `src/components/sim/simulator/*` — hooks (use-keyboard 258, use-network 654, use-canvas-layers 225, use-strike 277, use-elision-view 51), hookless factories (editor-ops 741, editor-cells 196, editor-select 201, pointer-tools 706, elision-present 351), HUD day panel (hud-canvas 124), sim-model 178 (types, fmtSec, remote-draw + lib/net consumers), JSX chrome (chrome 410 — кнопки «Погода»/«Сутки», editor-overlay 241, field-stage 143). Platform hooks are INLINE: `IS_ELYRIA` :118 gates the auth callbacks (`sendAuth` :4493; `setWhoamiGuarded` :285 — a background WS `whoami` frame may NOT overwrite a fresh login refusal, B6 mini-followup) and the auth props of `EntryScreen` :4677, :4692–:4694 (whoami/authMessage/authBusy; onLogin/onRegister/onLogout exist only on elyria). Kept ON PURPOSE: the main rAF closure (`const loop` :4152, one `useEffect` deps `[stage]` — moving it whole recreates a >800-line file, splitting it rewires engine variables), the state/refs belt of `Simulator()` (:261) with the `buildEditorOps` call :981 and `buildPointerTools` call :4309. targeting.pickStrikeTarget mirrors `server/combat.js` aimedNeighbor (:78) -> ARCHITECTURE §4; module/belt map — ARCHITECTURE §2/§7 |
| Combat model, sprites, armor | `src/lib/sim/settings.ts` (1173) | ARMOR_CURVE (:567), DAMAGE_LEVELS (:522), strike zones, sprites; SPRITES (:96, 33 entries), WALK_GIF_SRC (:253 — пробная GIF-ходьба) mirrors `server/config.js` |
| «Elision» location | `src/lib/sim/test-field.ts` (2142) | walkability, route graph, edge render, paint, cheap terrain-cell clips, camera-facing cliff faces; stone = level-1 object support; explicit terrain stays separate (supportLevelAt/terrainLevelAt); mutable singletons — one Simulator mount per process (ARCHITECTURE §6) |
| Elision WebGL | `src/lib/sim/elision-babylon.ts` (388) + `elision-scene.ts` (352) | `/game/` only (the page moved there 2026-11-10). Dynamic `import()` of Babylon `Engine` (WebGL, not WebGPU) so the grotto bundle stays 2D. Orthographic camera matches `screenToWorld`; `worldPxToScene` is the only canvas-px → scene step (no extra ±1). No WebGL → the existing painter stays. Grottos do not mount the slot |
| Location config | `src/lib/sim/test-map.ts` (774) | v1/v2 + editor limits + STONE_LEVEL=1 (mirror of server-side sanitize) |
| Site variant canon | `src/lib/site.ts` (28) | `NEXT_PUBLIC_SITE=grotto\|elyria`, default grotto (fail-safe). Variant-dependent modules check env INLINE (`const IS_ELYRIA = …`) — imports from `site.ts` do NOT fold in the bundle, inline checks do (decision P3) |
| Transport, inbound dispatch | `src/lib/net/coop.ts` (582) | socket choice by HOST (elisium → same-origin `/ws` — the branch checks the env INLINE inside `wsUrlBase` so the dead branch dies in the grotto build together with the elisium hostnames, A1; preview `pr-N.*` → own `/ws`; legacy sslip → room socket; localhost → `ws://localhost:3780`), `httpOrigin()` :208 for the HTTP flows, reconnect backoff, dispatcher; `?t=` in URLs is not used (cookie session) |
| Step prediction | `src/lib/net/move-book.ts` (89) | **the reference module** — copy its style for new files |
| HTTP session client | `http-auth.ts` (136; W2: per-tab meMemo cache + ME_EVENT «coop:me» CustomEvent — one GET /auth/me per tab, badge/logout refresh on login/logout) + `auth.ts` (30) + `http-profiles.ts` (245; P5: + lastSeenAt/lastSeenRoom в PublicProfile, мусор парсер схлопывает в «неизвестно»; W1: ProfileSp type/parsers + persistProfileSp; контент-волна 2026-11-10: PublicProfile.birthday ГГГГ-ММ-ДД|null по BIRTHDAY_RE-маске, PATCH birthday плоской строкой|null) + `http-avatars.ts` (126; контент-волна 2026-11-10: upload/delete /avatars/mine (multipart FormData без своего content-type), человеко-русские тексты humanAvatarError по reason; литералы /avatars/* физически только здесь — импорт из player-profile.tsx, бандл-изоляция photocanon check-variants) + `http-cfg.ts` (664; админ-клиент + draft/diff с kind points кривой брони) + `http-admin-ops.ts` (119) | auth-only core: `/auth/register\|login\|logout\|me` + shared low-level helpers `apiFetch/asText/asId/ApiRow`. The profiles catalog client (httpProfileCatalog: ?q search, ?limit def. 24, ?cursor keyset; card/me/PATCH-me) lives in `http-profiles.ts`; the admin Cfg client (incl. F2 `/cfg/rooms*` room fetchers) + PURE draft/diff helpers (draftFromSnapshot — carries §4 playerSelectable flags, cfgPatchFromDraft — sends them explicitly, canonByKind, buildCfgDiff — §4 choice-aspect, narrowingWarning, listIssue, successText, applyBadgeText) in `http-cfg.ts` — split for bundle isolation: the simulator-graph donor module must not pull Elysiae HTTP routes into the grotto bundle. Session = HttpOnly cookie (host-only, no Domain — B1); no token in JS storage; WS auth frames go through `auth.ts` |
| Live config client | `src/lib/net/cfg-live.ts` (138) + `src/lib/cfg-registry.ts` (223) | `cfg-live`: universes AND the liveserver armor curve (combat section of the public `GET /cfg`; one fetch per tab; registry defaults/canon W3 on failure; a saved value missing from the registry snaps to DEFAULT). `cfg-registry.ts`: client mirror of the 8-key registry (5 numeric + bool atmoset gates F2 + points curve; parity gate) |
| Sprites client | `src/lib/sim/sprite-catalog.ts` + `src/lib/net/http-sprites.ts`/`http-admin-sprites.ts` + `src/components/admin/sprites-tab.tsx` | dynamic sprite catalogue (admin mandate 2026-11-08): fetch on carousel open, category filter, static SPRITES fallback offline; upload/patch/delete via /admin/sprites*; #83 personal sprites: `http-my-sprites.ts` (205) — upload/remove/list via /sprites/mine* + humanMineError (бандлится только с зоной профиля),MineSpritesSection in `player-profile-ui.tsx` (757): загрузка со спиннером и префиллом имени, «X из 3», надеть/удалить (подтверждение вторым кликом), плашка «Сейчас на вас», доставки причин — человеческим русским; админ-таблица sprites-tab.tsx показывает владельца и флаг «скрыт» (тоггл PATCH /admin/sprites/:id hidden). KNS Paint editor (#84 ч.1): копия v8.1.2 в `public/paint-demo/` байт-в-байт (sync при релизах KNS — shasum-сверка в PR), на обоих сайтах, хуки для моста: window.PAINT (exportGameCanvas/exportFlatCanvas/importLayer/persistNow), selftest ?selftest=1 → window.__PAINT_TEST 18/18. #84 ч.2 (мост): третий файл `public/paint-demo/game-bridge.js` (484) на Элизии, копия не тронута кроме ОДНОГО шва перед </body> (гейт check:paint-seam); кнопка «Нарисовать окрас» → /paint-demo/?back=profile (allowlist), «Сохранить и надеть» = POST /sprites/mine → PATCH /profiles/me {sprite} → deep-link /players/?id&mine=#settings + подсветка плитки; из гротов мост вырезан (prune ELIXIR-only, гротовый «200» — SPA-фолбэк). #84 в3 (окрас по КОДУ, без загрузки картинки): второй вход зоны — CatwarCodeEntry: вставка кода окраса CatWar из конструктора kns.phainonsmilk.ru → `src/lib/paint/catwar-coat.ts` (285): vendor public/catwar (tint.js + манифест 24 палитр + gray/{norm,thin,chub}, sha-гейт check:catwar-vendor), рендер сид-кадра '0' → кроп по силуэту 2/2/2/0 → NEAREST ≥100 → тот же POST /sprites/mine; движок грузится динамическим import() только в зоне профиля (§10.4), гроты без catwar (prune EXCLUDE); отказы человеческие: bad_syntax / no_coat_zones / engine_unavailable. Волна-B (#84 в4, deep-link из KNS): consumeCatalogDeepLink (players-format) принял ?coat=<urlencoded код CatWar> — строго ОДИН параметр, сырая длина ≤2048 (мусорная очередь до движка не доезжает), грамматика проверяется движком лениво, replaceState-чистка как у ?mine с сохранением #settings/?id; CatwarCodeEntry одноразово (реф-гвард) автозаполняет поле и автопревью, БЕЗ авто-POST — сохранение только кнопкой; источник ссылки — кнопка «Надеть в игре» в конструкторе kns.phainonsmilk.ru (код → window.open phainonsmilk.ru/players/?coat=…#settings, _blank noopener) |
| Settings panel | `src/components/sim/settings-panel.tsx` (1230) | admin tabs render ONLY for `role === 'admin'` from the server `whoami` (:510–:515 — the old client "tab password" is gone, P3); server stays the arbiter. Handbook tab «Справочник Герты»; server tunables via `/admin`, not here |
| Client room catalogue | `src/lib/net/modes.ts` (163) | mirrors `server/modes.js` (grotto side has no Elision room at all); variant hrefs/cards sit in dead IS_ELYRIA ternaries (COMBAT_HREF/HUNGER_HREF, NAMED_ROOMS, MODE_COPY) so the dead branch dies at build; PlayMode: hub/beer/elision/hunger |
| Main menu | `src/components/menu/wander-gate.tsx` (341) + `star-backdrop.tsx` (shared star backdrop, extracted from wander-gate by the admin-suite wave; mounted inside Elysiae-gated components) | `/` Wanderpaws, per-site by `IS_ELYRIA` (:15): grotto build — `/combat/` grottos + `/hunger/` placeholder + Elysiae bridge card linking to https://phainonsmilk.ru/ (owner mandate 2026-11-08; the ONLY legal «elisium» occurrence in www-grotto — check-variants.mjs checks it per-occurrence as a full URL); Elysiae build — Elision window; nav (Каталог/Панель links of older waves) is carried by SiteHeader (W2). «Главное меню» on every game page |
| Login gate (Elysiae) | `src/components/menu/auth-gate.tsx` (176) + `auth-modal.tsx` (258; reg-v2: «Имя на поле» field, cookie-helper line dropped) + `site-fonts.ts` (9) + `src/components/sim/auth-reasons.ts` (73) | Elysiae-only fullscreen login gate mounted by page shells of `/`, `/game/`, `/players/`, `/admin/`: a CONFIRMED guest (GET /auth/me answer) first sees the glass modal (tabs «Вход»/«Создать аккаунт») — page children still render under the overlay so the prerender and check:variants stay intact; logged-in users go straight in (existing cookie whoami-flow). Logout/badge live in SiteHeader now (W2; the home `chrome` flag removed — no duplicate). http-auth.ts clients reused as-is; simulator.tsx/entry-screen.tsx untouched — children mount fresh after the gate and read the same cookie |
| Site header (Elysiae) | `src/components/site/site-header.tsx` (103) + `src/lib/net/me-cache.tsx` (81) + `theme-select.tsx`/`theme-select.module.css` (31) + `src/app/game/page.tsx` (21) | W2 owner mandate — glass top bar on all four Elysiae pages (`/`, `/game/`, `/players/`, `/admin/`): Главная / Игровая комната / Игроки / Мой профиль / Админка (admin-only by me.role) + «Вы вошли как {name}» + «Выйти» (logout resets the me-cache) + ThemeSelect; the separate «Настройки» nav item was dropped by owner call 2026-11-10 (it led to the same profile page as Мой профиль; the #settings anchor stays in deep links); me-cache.tsx = useMeRow/meHasAccount/myProfileHref/meBadgeName over the tab-wide meMemo (ME_EVENT refresh); page-head inlays of older waves dismantled into it |
| `/players` catalog | `src/components/players/players-catalog.tsx` (796) + `player-profile.tsx` (805) + `player-profile-ui.tsx` (849; presentation bricks carved out in W1 acceptance: ach icons/facts, Portrait (контент-волна: card.avatar-строка → img со своей картинкой в прежней рамке), SpChip, SKIN_GROUPS, moonPath; + AvatarField — блок «Аватар» редактора: скрытый input + «Загрузить картинку»/«Убрать» вторым кликом, человеко-тексты через humanAvatarError; сетевой ходок http-avatars импортируется только в player-profile.tsx) + `players-format.ts` (236; контент-волна: ruBirthday — «8 ноября 2011» из ГГГГ-ММ-ДД) + `players-elyria.module.css` (1258) | Elysiae-only page (P5 night redesign): таблица/плитки, клиентская сортировка колонок по загруженным, серверный `?q` поиск (300 ms debounce), keyset `nextCursor` (клиент НЕ фильтрует), `?id=` deep-link открывает полную страницу профиля; статус/активность выводятся из `lastSeenAt` (players-format thresholds), честное «неизвестно» без выдумок; own-profile inline editor carries «Внешность» (skin tiles/scale/field name) + «Игровые параметры» (hidden params, owner-only) inside `<form id="settings">` (anchor for the #settings deep link, W1); ThemeSelect moved to SiteHeader (W2); контент-волна 2026-11-10: карточка «День рождения» (ruBirthday) приоритетнее «Даты рождения» (регистрация), редактор+: поле День рождения (input type=date 1900-01-01..сегодня, PATCH birthday строка|null) и блок «Аватар» над «Внешностью»; подпись про несобираемые боевые счётчики удалена решением владелицы |
| `/admin` dashboard | `src/components/admin/cfg-dashboard.tsx` (652; вкладка «Игроки на поле» — players-field-tab.tsx: список комнат/котов с координатами, авто-обновление 5 с, инлайн-сброс на спавн; вкладка «Броня» — armor-tab.tsx + cfg-apply-preview.tsx: live точки кривой + SVG «было→станет»; вкладка «Спрайты» — sprites-tab.tsx: загрузка/категории/удаление; W2-δ3: active tab persisted via localStorage `elyria-admin-tab`, picked by pickTab) + `room-config-panel.tsx` + `dash-shell.tsx` (ночь + звёзды + стеклянный сайд-меню из дескрипторов вкладок) + `cfg-fields.tsx` (строки-редакторы полей) | Elysiae-only page, renders for `role==='admin'`: registry values (8 keys), apply policies, editors for allowed-value LISTS with an EXPLICIT playerSelectable toggle (F2 §4: the flip does NOT cut the list; off-then-on returns the curated list), was→will-become diff preview (incl. the choice-flip line) with narrowing warning, collapsible tech details, honest ok/err statuses, reset/restore by history name, export/import JSON; «Комнатные настройки» (F2 §3) — target panel below |
| Room-config panel | `src/components/admin/room-config-panel.tsx` (319) | F2 §3 per-room UI (inside cfg-dashboard): room select with override badges, layer table global/override/effective per whitelisted key (phaseMin, weatherMin, bool atmoset gate), Apply override / Inherit per key, Reset-all and restore via window.confirm, room-configs.json backup history; the client is NOT the source of truth — every write is validated server-side |
| Route wrappers | `src/app/*/page.tsx` | thin shells: `/` menu, `/combat/` (grottos), `/game/` (the closed field, ex-`/elision/` since 2026-11-10), `/hunger/` (skeleton), `/players/`, `/admin/` — each renders `Simulator` with the `mode` prop or its own page component; `elision/page.tsx` is a tiny client stub that forwards old invite links (query preserved) to `/game/` |

Where to start common tasks:
- **"Add/change an event"** → both registries first (`server/protocol.js` + `src/lib/net/protocol.ts`; they must stay mirrored) → `server/net.js` onMessage dispatcher and the domain handler in `server/*.js` →
  `src/lib/net/coop.ts` (validator+dispatch) → a case in `scripts/test-ws.mjs` (room contract) → update the tables in this file and ARCHITECTURE §3 in the same PR
  (CI gates `check:protocol` + `test:protocol-parity` verify all of it).
- **"Combat/damage/armor"** → `settings.ts` + the server side — both read the same registry set since W3: ARMOR_CURVE lives in `settings.ts` (re-exported by `protocol.ts`), server mirrors it in `server/protocol.js`, `test:protocol-parity` pins the mirror. Admin-tunable damage/armor caps come from the 5-key registry (`server/cfg-registry.js`), clamped in `server/combat.js`.
- **"Settings/HUD"** → ARCHITECTURE §2 (simulator.tsx belts), SettingsPanel pattern (30 props; admin tabs are role-gated, never password-gated).
- **"Map/editor"** → `test-map.ts` (client) + sanitize in `server/testmap.js` (sanitizeTestMap) — limits are single-source now: TEST_MAP_LIMITS is re-exported by `protocol.ts` and mirrored in `server/protocol.js` (parity in CI).
- **"Accounts / roles / host gating"** → `server/config.js` (`hostClassOf`) + `server/auth.js` (sessions, token matrix) + `server/net.js` (HTTP host gate, per-destination Origin/CSRF B1, per-IP sockets S5a) — matrix in PLATFORM-ARCHITECTURE §3; contract tests in `scripts/test-auth.mjs` + `scripts/test-cross-origin.mjs`. S1: the `admin` role is assigned ONLY by the owner's one-shot CLI `node scripts/make-admin.mjs <login> [pass]` (server stopped); `BOOTSTRAP_ADMIN` registration no longer grants admin (role `registered` + a log warning).
- **"Admin config"** → `server/cfg-registry.js` (whitelist + clamps) + `server/runtime-config.js` (routes) + `src/components/admin/cfg-dashboard.tsx`; `npm run test:cfg` pins the registry.
- **"Site variant / new public page"** → inline `IS_ELYRIA`/`NEXT_PUBLIC_SITE` check in the page module (never a shared import for folding reasons — the arch gate `isolatedImports` bans importing `src/lib/site.ts` anywhere except site.ts itself), `scripts/prune-export.mjs` cut list, `build:variants` + `npm run check:variants` (A1) — the artifact gate must be green: zero Elysiae markers in www-grotto (incl. latin 'elisium'), no retired /combat//hunger/ routes in www-elyria, chunk links resolve.

## Context graph: graphify (optional local index)

A local knowledge graph over this codebase (graphify; the official PyPI package is
`graphifyy` — double-y, any other `graphify*` package is unrelated). It is an OPTIONAL
accelerator, not a gate and never a CI dependency. The graph is NOT committed:
`graphify-out/` is gitignored and rebuilt per clone.

Setup per machine (needs Python 3.10+ and uv): `uv tool install graphifyy`, then
`graphify hook install` (writes `.git/hooks/*` only — untracked, rebuilds the graph on
commit) and the first build `graphify extract . --code-only` (~40 s; later refreshes are
`graphify update .`, seconds via the AST cache). AST-only means deterministic, free and
nothing leaves the machine — do NOT configure LLM/semantic backends for this repo.
Per-assistant skill/hook wiring: `graphify install` (user-level, reversible by
`graphify uninstall`). Sandboxes without Python/uv (Cursor Cloud and similar) skip
graphify — the Code map above stays the primary navigation.

When `graphify-out/graph.json` exists, prefer it over blind grep for ORIENTATION:
`graphify query "<question>"` (scoped node dump with file:line), `graphify path "<A>" "<B>"`,
`graphify explain "<sym>"`, and `graphify affected "<sym>"` (reverse impact before
refactors). Graph output is a retrieval HINT, not a fact: verify against the source before
acting; file:line refs age with commits (check "Graph Freshness" in
graphify-out/GRAPH_REPORT.md). God-node/degree listings never weaken arch:check rules.

## Room contract

Frame format: JSON `[event, payload]`. The server is the cell authority: two cats never share a cell,
client-side step prediction is rolled back on `refuse`. Rooms: `grot-1…3` (Beer Grottoes, open-grid),
`test` («Elision», 19×7, peace mode, needs a session), `hunger` (skeleton, no rules yet).
Retired room codes are aliased by `RETIRED_ROOMS` (`combat` → `grot-1`), so legacy `?room=combat`
links keep working instead of silently dying.

Invariants (violating one = a bug):
- Every step gets exactly one response: an `update cat` echo or `refuse {code}`; silence desyncs the predictor.
- Network coordinates are 1-based (`x=1..W, y=1..H`), canvas is 0-based (`col=x-1, row=y-1`); peace mode uses cell fractions `fx/fy`.
- At most 1 unconfirmed predicted step (move-book.ts).
- `move` FROM THE SERVER is overloaded (canon since W3: the dual MEANING stays, the NAME lives in `server/protocol.js` `EV.MOVE` + client `src/lib/net/protocol.ts`): `publicCat` of a joiner OR `{id, x:0, y:0}` = leave marker — the client dispatches both through one `isCoopCat` guard, and the consumer (`simulator.tsx`) treats `x===0` as the leave marker.
- The EFFECTIVE terrain level of a cell = its `elev` entry + a stone on that cell (STONE_LEVEL=1, mirrored test-map.ts ↔ server/world.js): a stone is a walkable level-1 platform (step up = delta 1), a tree is the only impassable obstacle. Both sides must compute levels by the same rule.
- Clients advance on LOCAL clocks from the `atmo.t` anchor; the server ticker (5 s) resends the anchor only on phase change.
- Damage is client-authoritative (an accepted debt of this sandbox): the server cuts it by target armor and ships it in `fight`.

### Client → server (23)

| Event | Payload | Limits / response |
| --- | --- | --- |
| `join` | `{room?, login?, sprite?, size?}` | 1/s; login ≤24 codepoints, unique; size 60–100; session uses character name (client login is not identity); room `test` needs a session else refuse/noplace auth_required; success → `you`+`field`+`chatlog`, `move` to others; failure → `info`/`noplace` |
| `move` | `{x, y}` — step −1..1 | cooldown 80 ms, queue ≤3; response: echo or `refuse {code}` |
| `aim` | `{deg}` | coalesced ≥20 ms; the angle is broadcast via `update cat` |
| `strike` | `{target, zone, angle, damage?, pawsDamage?, flightMs?}` | cooldown 25 ms (silent); damage 0–100; flightMs 0–600 (def. 170); errors come as `info` text; after flightMs → `fight` to the room |
| `chat` | `{text}` | ≤200 chars after sanitize, 450 ms; success → `chat` to all |
| `sprite` | `{sprite}` | whitelist of 32; broadcast `update cat` |
| `dummy` | `{on, sprite?}` | non-test rooms only; → `dummyState` to all |
| `dummyMove` | `{x, y}` — fractions | clamp 0..9/0..5; → `dummyMove` to others |
| `dummyGrab` / `dummyDrop` | `{}` | one holder at a time; released on socket close |
| `rab` | `{on}` | non-test rooms only; → `rabState` to all |
| `rabHit` | `{zone, part, damage}` | → `rabHit` to others |
| `block` | `{on}` | → `block` to others; block counts at the moment of impact |
| `space` | `{on, hold?, cancel?}` | hold 0–4000; crouch-"jelly"; → `space` to others |
| `atmo` | `{dp, w}` | phases morning/day/evening/night; weather sun/cloud/rain; ANY player; → `atmo` to ALL (echo = ack) |
| `atmoset` | `{pl, wl}` minutes | pl 1–120, wl 2–240; → `atmo` anchor |
| `armor` | `{armor}` 0–0.9 | NOT broadcast: neighbors see the cut damage in `fight` |
| `freemove` | `{x, y, sp?, jp?, stop?, foot?:{dx,dy,rx?,ry?}}` | `test` room only; cell fractions; ≤1/50 ms; point-in-polygon check |
| `cellsync` | `{x, y}` 1-based | `test` only; enter battle mode: cell must be walkable/entry, occupied → ring search ≤6; → `update cat` to ALL |
| `jump` | `{x, y, deg?, charge?}` 1-based | cooldown 450 ms; 8 directions, 1–3 cells; `charge` 0–1 is the spacebar fill. Step is free when the elevation delta is at most 1. Jump: delta 2 needs charge ≥ 0.5, delta 3 needs charge ≥ 1, climbing 4 or more is impossible, dropping 4 or more needs a full charge |
| `setmap` | `{map}` | shared location editor for every joined player: sanitize (v1\|2, cols 6–60, rows 3–40, zones ≤48, objects ≤2000), ≥8 backups; no password or admin role required; joined test-room member required; throttle 1/10 s per socket (any frame); → `map`+`field` to the `test` room; errors → `info` |
| `rooms` | `{ids: [...]}` ≤32 | 1/250 ms; → `roomsinfo` (does not materialize rooms) |
| `auth` | `{action, login?, pass?, token?}` | `hello`/`register`/`login`/`logout`; register 1/min/IP; login 10/min/IP; pass ≥8; → `whoami`. Token also on WS query `t` or Cookie `coop_session`. |

### Server → client (23)

| Event | Payload | To whom / when |
| --- | --- | --- |
| `you` | own publicCat | join, first response |
| `field` | grid, `cats[]`, `location`, `dummy?`, `rab?`, `atmo`, `map?` | on join and after setmap (`huntMode` was removed in W3 — it was always false) |
| `chatlog` | ≤40 `{seq,id,login,color,text,ts}` | only the joiner, after `field` |
| `move` | publicCat of the joiner \| `{id,x:0,y:0}` | to all; the latter is the leave marker (see the invariant above) |
| `update cat` | publicCat (id, login, color, sprite, x, y, deg, size, blocking, sq) | step/jump/cellsync/skin/aim — to all, including the author |
| `refuse` | `{code, text}` | codes: `edge`/`cell_busy`/`cliff`/`cooldown`/`auth_required` — machine-readable predictor rollback |
| `info` | string | all human-facing errors/hints (parse by `refuse` code, not by text) |
| `noplace` | `{room, reason}` | join refusal: 30-cats cap, no free cell, or `auth_required` (Элизия без сессии) |
| `fight` | `{attacker, targetId, part, zone, damage, flightMs…}` | after flightMs; the striker gets `isAttacking=true`; damage is already armor-cut |
| `chat` | `{seq, id, login, color, text, ts}` | whole room, including the sender |
| `map` | TestMap config | every socket of the `test` room after setmap |
| `dummyState` | `{on, x, y, sprite, grab}` | whole room |
| `dummyMove` / `dummyGrab` / `dummyDrop` | `{x,y}` / `{login}` / `{}` | to others (`dummyGrab` — show the grabber cursor) |
| `rabState` / `rabHit` | `{on}` / `{zone, part, damage}` | to all / others without echo |
| `block` / `space` | `{id, on}` / `{id, on, hold?}` | except the sender |
| `atmo` | anchor `{t, cs, pl, wl, w, ws, dp}` | to ALL on atmo/atmoset + 5 s ticker on dp/w change; on rejoin it rides inside `field` |
| `freemove` | `{id, x, y, cx, cy, sp, jp}` | to others, ≤1/50 ms |
| `roomsinfo` | `[{id, count, logins}]` ≤32 | reply to `rooms`, ≤4 req/s; у закрытой комнаты гость видит count, но не logins |
| `whoami` | `{ok, role, login, accountId, token?, characters?, reason?}` | reply to `auth` and after handshake bind; guest has `ok:false` only on error, hello without token → `{ok:true, role:"guest"}` |

## Server env

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT` / `HOST` | listen socket | 3780 (prod: 8787 behind nginx) / 0.0.0.0 |
| `REQUIRE_ORIGIN` | enforce the browser Origin check | prod = 1; `ALLOWED_ORIGINS` holds the whitelist |
| `PUBLIC_HOSTS` / `ELYRIA_HOSTS` | host classes for `hostClassOf` (server/config.js): `public` = grottoes, `elyria` = Elysiae, everything else = `local` (dev/tests) | prod sets both; unknown hosts fall to `public` — fail closed |
| `ADMIN_PASS` | Deprecated compatibility env, ignored by the location editor | no effect; any player in the location can save |
| `BOOTSTRAP_ADMIN` | MIGRATION list of logins (trim, case-insensitive): registration of a listed name gives `registered` + a log warning (S1); the `admin` role is handed out ONLY by the one-shot CLI `scripts/make-admin.mjs` (server stopped) | empty = no migration list |
| `AUTH_LEGACY_TOKEN` | return `?t=` token acceptance on elyria for the transition period | off: elyria is cookie-only |
| `COOKIE_LOOSE` | relax session cookie to legacy `SameSite=None` | off: `SameSite=Lax` (+`Secure` on https) |
| `MAX_ACCOUNTS` | account registry cap; further registrations → `full` | 500 (server/accounts.js) |
| `WS_MAX_PER_IP` | max simultaneous WS sockets per client IP (S5a); over the cap → `info too_many_sockets` + close | 8 |
| `ROOMS_MAX` | cap of LIVE rooms per process (S5b); a new room over the cap → `noplace rooms_full` | 32 |
| `DATA_DIR` | data (cat positions, map, backups, accounts, sessions) | `data/` |
| `NEXT_PUBLIC_SITE` | BUILD-time site variant of the front (`grotto\|elyria`) — client-side canon in `src/lib/site.ts` | `grotto` (fail-safe: unknown/empty = public grotto build) |

`/health` answers `{ok, rooms, maxPlayers, clientIpMode}` — `clientIpMode: 'loopback' | 'xff' | 'direct'` (S4): `loopback` on a prod host class means the proxy passes no X-Forwarded-For and the auth rate-limits are off (the server warns in the log).

Map scripts read `MAP_PASS` (same legacy default fallback). Hitting the prod endpoint
(`wss://coop.89-232-184-77.sslip.io`) requires the explicit `--prod` flag — scripts refuse without it.

## Host policy, sites and the token matrix (platform, P1–P3)

One room server serves BOTH sites and separates them by the `Host` header (`hostClassOf`):
`public` (grottoes) / `elyria` (Elysiae) / `local` (dev/tests). Full matrix —
[docs/PLATFORM-ARCHITECTURE.md](docs/PLATFORM-ARCHITECTURE.md) §3. Short version:

- **public:** HTTP auth/profiles/admin zones answer `404 not_found` (they do not exist there);
  `GET /cfg` (public values) and gameplay work; WS `register`/`login` is calmly refused. Old clients'
  `?t=` is still accepted transitively on this class.
- **elyria:** the whole API; sessions ride the HttpOnly cookie `coop_session` (Secure+SameSite=Lax on
  https) — **cookie-only**: `?t=` is off (env `AUTH_LEGACY_TOKEN=1` returns it for the transition period),
  the token is not exposed in HTTP response bodies.
- **local:** permissive legacy mode (`?t=` works, token in bodies) — the auth/cfg/profiles tests stand on it.

The front is built twice (`npm run build:variants`, `NEXT_PUBLIC_SITE` + `scripts/prune-export.mjs`):
the grotto artifact physically has no `game/elision/players/admin` routes (in the Elysiae artifact `elision/` is only the redirect stub), the Elysiae artifact has no
`combat/hunger`; results land in `www-grotto/` / `www-elyria/` (what gets rsynced to the VPS and into
PR previews). Variant checks are inline `IS_ELYRIA` constants in each module (see `src/lib/site.ts`).

## Working rules (violation = PR rework)

1. **When you change the protocol, boundaries or data flows — update the tables above and ARCHITECTURE in the same PR.** The check is a gate, not discipline: CI runs `npm run check:protocol` (doc tables vs `server/protocol.js` registries) and `npm run test:protocol-parity` (client/server golden parity) since W3.
2. **Mirrors (ARCHITECTURE §4) change in sync**, client + server in one PR; the sync mechanism since W3 is `test:protocol-parity` in CI (golden values inside the test catch two-sided drift).
3. **Secrets come only from env**; never write values into code or docs (the legacy password default is an accepted transitional exception; changing it is done via env).
4. **No new files above 800 lines** — the `arch:check` gate; a new module is 300–800 self-contained lines (do not fragment below that).
5. **Prod endpoints only via an explicit flag**; scripts target localhost by default.
6. **Coordinates**: any protocol change must respect 1-based/0-based/fx-fy (ARCHITECTURE §5).
7. **Do not "fix style" in passing**: keep wave PRs free of cosmetics; do not grow the god-files.
8. **Site-variant checks stay inline** (`IS_ELYRIA` in the module that needs it) and the grotto artifact must contain zero Elysiae routes/strings; hidden server routes must never linger "deprecated but working" on the public host class.

## Publishing policy & environments (owner directives, 2026-11-06)

1. **PR-only:** never push to `main` — a merge to main IS the production deploy (frontend + room server). Branch + PR; CI green before merge.
2. **Self-merge:** the agent may merge its own PR via `gh pr merge` once all checks are green; if merge rights fail — hand the PR link to the owner and keep going.
3. **External chat AIs (no file-system access, z.ai-style):** point them to `docs/AI-CONTEXT.md` FIRST — it is the one-file EN project brief (stack, deploy, module map, hard rules, human-intermediary protocol). Paste files they ask for; take unified diffs back.
4. **localStorage routes (client persistence):** `simulator.tsx`: :745 (read saved SP), :760 (write SP), :1242 (write combat log), :4437–4438 (reset), log rotation lives in mergeLog (combat-log.ts); `editor-ops.ts`: :199 — one-time migration REMOVING the stale editor-password key (the editor has no password; only legacy-key cleanup remains). Storage keys are named constants in `src/lib/sim/engine-consts.ts` / `@/lib/sim/editor-model`.
5. **Sprite whitelist mirror (test:server-modules):** `server/config.js:368` (`SPRITES`, 33) <-> `src/lib/sim/settings.ts:96` (`SPRITES: SpriteMeta[]`) — always change both sides in one PR, keep the counts equal.
6. **Config registry is a whitelist:** the only admin-tunable values are the 5 keys of `server/cfg-registry.js` (clamps included); protocol constants/events/limits are NOT config. Client mirror — `src/lib/cfg-registry.ts` (parity gate).
7. **Production/VPS is owner-only**, except one-shot preview work the owner explicitly authorized. Agents still never restart `coop-field`, never write `/opt/coop-field` (except reading node), never copy prod `data/` or `ADMIN_PASS`. Preview: user `deploy-preview`, `/opt/coop-field-preview/`, TWO webroots per PR — `https://pr-<N>.abnocw.phainonsmilk.ru` (grottoes) + `https://pr-<N>.elysiae.phainonsmilk.ru` (Elysiae), one room instance, destroy on PR `closed`/`merged`. SSH as `deploy-preview` works with secret `PREVIEW_SSH_KEY`. Preview pipeline is two workflows: `preview-build.yml` (on `pull_request`, no secrets, artifact carries BOTH `www-grotto/` and `www-elyria/`) and `preview-deploy.yml` (on `workflow_run` — that file is always taken from `main`, holds `PREVIEW_SSH_KEY`). Deploy scripts, sudoers and the unit template are owned by `main`: PR branches cannot change what runs on the VPS; the unit is installed only by `preview-bootstrap.sh` from root (apply never copies units or calls daemon-reload). The production front deploy (`deploy-frontend.yml`) rsyncs BOTH site roots: `/opt/coop-field/www` (grottoes) and `/opt/coop-field/www-elyria` (Elysiae). See `docs/PREVIEW-ENVIRONMENTS.md`.
8. **PR description contract (owner directive, 2026-11-08; restored 2026-11-08):** every PR opened by an agent must carry in its description (a) links to BOTH feature environments — `https://pr-<N>.abnocw.phainonsmilk.ru` AND `https://pr-<N>.elysiae.phainonsmilk.ru` — and (b) a short bulleted summary of what was ADDED and what was CHANGED, plus how it was verified (gates + live checks). Start from `.github/PULL_REQUEST_TEMPLATE.md`. The preview pipeline rewrites ONLY the marked block (`<!-- coop-field-preview-link -->` … `<!-- /coop-field-preview-link -->`); the Added/Changed list is the author's responsibility; the bot never fills it. If the preview is not live yet (needs-dns/needs-tls), say so explicitly instead of omitting the links.

## Doc index

- `AGENTS.md` — this map + wire-contract tables (updated by the wave that changes the protocol).
- `docs/ARCHITECTURE.md` — as-is map, data flows, mirrors, coordinates, target structure (W3–W5 + platform §).
- `docs/PLATFORM-ARCHITECTURE.md` — as-implemented platform: accounts, host policy, token matrix, config registry, profiles, RETIRED_ROOMS, build variants.
- `docs/UI-KIT.md` — in-app UI Kit: paired `--uk-*` tokens, public barrel `src/components/ui`, component API, rules for agents (reuse a kit primitive before writing a new one).
- `docs/AGENT-PLAYBOOK.md` — recipes: add admin tab / tunable param / UI-kit component / profile field / room mode.
- `docs/PRIVACY-DATA.md` — data map: accounts.json, sessions, DTO privacy, sp owner-only, DATA_DIR per env, logs, backups; legal qualification is owner-action, do not claim compliance from tests.
- `docs/DEPLOY-CHECKLIST.md` — owner-only production steps (environment protection, secret rotation, VPS manual actions); nothing there is claimed as done.
- `docs/PRODUCT-ROADMAP.md` — product audit: what exists, what's missing, order of platform work.
- `docs/PREVIEW-ENVIRONMENTS.md` — PR preview on the same VPS (`/opt/coop-field-preview/`, dual-host `pr-<N>.abnocw.phainonsmilk.ru` + `pr-<N>.elysiae.phainonsmilk.ru`).
- `README.md` — human overview in Russian: two sites, quick start, tests, prod, feature eras.
- `scripts/` — npm runners: test:ws (against a running server or `WS_URL`), test:queue (self-spawn),
  test:unit, arch:check, check:variants (A1, needs built `www-grotto/` + `www-elyria/`);
  owner CLI: `scripts/make-admin.mjs` (S1 admin role; run with the server stopped).
  Manual probes with self-spawn carry a "how to run" header line.
- Local per-module `AGENTS.md` files appear in W5 (simulator.tsx/panel split) — until then use the belt
  line ranges in ARCHITECTURE §2.

## Cursor Cloud specific instructions

- Install is `npm ci`. The image already has Node 22. `test:unit` and `check:landmarks` need Node 22.6 or newer; `package.json` `engines` only says `>=18`.
- Boot starts two processes and waits until they answer:
  - room: `npm start` — `http://127.0.0.1:3780/health`, socket `ws://127.0.0.1:3780`
  - front: `npm run dev -- --hostname 0.0.0.0 --port 3000` — open `http://localhost:3000`. The dev HMR socket rejects a page opened as `127.0.0.1` while the server listens on all interfaces.
- A localhost page connects to `ws://localhost:3780` by itself. The plain dev build is the GROTTO variant — to see Elysiae run `NEXT_PUBLIC_SITE=elyria npm run dev`. Hello-world: `/?name=...`, confirm the three hidden parameters («Использовать предыдущие СП»), pick «Пивной грот №1». Join answers `you` then `field`; a step answers `update cat` or `refuse`. Elision (`/game/` or room `test`; old `/elision/` links are forwarded by the stub) needs register/login first (`auth` → `whoami`); catalog is `/players/`, admin dashboard is `/admin/` (admin session only). Extra tests: `npm run test:auth`, `npm run test:cfg`, `npm run test:profiles`, `npm run test:my-sprites`, `npm run test:preview-slug`, `npm run test:preview-apply`, `npm run test:preview-pr-link`, `npm run test:write-openssh-key`.
- `npm run test:queue` spawns its own server on a random port. `npm run test:ws` needs the room already listening (`WS_URL`, default `ws://127.0.0.1:3780`).
- `next dev` rewrites `next-env.d.ts` to `.next/dev/types`; `next build` points it back at `.next/types`. Leave that flip out of feature commits. `agentRules: false` in `next.config.ts` keeps `next dev` from appending its own block to this file.
- Production sockets stay untouched unless a script is given `--prod`. The location editor is open to every joined player without a password; `ADMIN_PASS` is ignored.

Камни: явный рельеф (`terrainLevelAt`, `effectiveElevRecord`) рисуется отдельно от опоры предметов. Мирная опора `supportLevelAt` добавляет STONE_LEVEL=1 только внутри повёрнутого тела камня; сам камень стоит на грунте и остаётся непрозрачным. Боевые клетки сохраняют дискретный уровень `elevLevelAt`/`testElev`. Сохранение редактора отправляет снимок черновика даже после закрытия панели во время кодирования; ошибка диска откатывает серверную карту и не рассылает успешный `map`. Регрессии: `npm run test:editor-save`.

Директива владелицы 2026-11-09: редактор локации открыт всем игрокам комнаты test без пароля и роли admin. Сервер проверяет участие в комнате, валидность карты и лимит сохранений; бэкапы и атомарная запись сохранены.

Сохранение профиля (`PATCH /profiles/me`) использует общую пару Origin/класс сайта через originAllowedHere и csrfDecision, как /auth и HTTP-слой. Доверенный адрес сайта не нужно повторно добавлять в старый глобальный ALLOWED_ORIGINS; посторонние Origin и запросы с cookie без Origin отклоняются. Регрессия test:cross-origin: смена и повторная смена скина с последующим GET.

Скин `test1`: builtin `/sprites/test1.png` с прозрачным фоном, отдельная группа выбора `test1` (оригинал + «test1 PNG 600»; WebP-вариант снят); статический каталог клиента и серверный whitelist содержат 33 базовые модели. Старый runtime-манифест автоматически дополняется новыми моделями при запуске, снятый builtin из манифеста не воскресает. Пробная анимация ходьбы: builtin `/sprites/test1-walk.gif` (оригинальные байты, SHA-256 в test:sprites) декодируется клиентом (gif-walk.ts, WebCodecs ImageDecoder) и проигрывается в 2D-канвасе и WebGL, пока кот идёт (свой: флаг свободной ходьбы/боевая дуга, чужой: доведение freemove/очередь клеток); направление — существующие flip-правила drawChar, фаза цикла своя у каждого кота. Браузер без ImageDecoder использует 11 lossless PNG-кадров с исходными длительностями. Анимация назначена test1 и test1-png; WebGL кэширует текстуры кадров, не загружая их заново при каждом шаге.
Клиент дополняет старый кэш новыми builtin-моделями, сохраняя загруженные скины и их метаданные.

## Качество новых моделей (директива владелицы 2026-11-09)

- Авторские PNG/SVG подключать из исходных файлов, без генеративной перерисовки, утолщения линии, трассировки и промежуточного увеличения.
- PNG с прозрачностью сохранять побайтно; исходный размер и альфа-канал не менять. Масштаб отображения задаёт движок.
- При замене спрайта обновлять ревизию URL в статическом и серверном каталогах, чтобы браузер не показывал старую картинку.
- Если исходник недоступен файлом, запросить архив; не заменять рисунок приблизительной генерацией. Проверять модель в профиле и на поле.
