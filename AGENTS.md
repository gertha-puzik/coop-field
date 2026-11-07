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
npm run test:auth            # accounts, cookies/CSRF, host gate, closed Elision (P1–P3)
npm run test:cfg             # config registry whitelist + clamps (P4)
npm run test:profiles        # HTTP profiles: catalog, card, PATCH /profiles/me (P5)
```

All of them must be green. If `arch:check` fails on a new file — do not grow the allowlist
(it holds only legacy god-files; they are removed in waves W4/W5).

## Code map

| Task leads to | File | What is inside |
| --- | --- | --- |
| Any engine task | `docs/ARCHITECTURE.md` §2 | map of ALL modules with line ranges — read first |
| Any platform task | `docs/PLATFORM-ARCHITECTURE.md` | as-implemented: accounts, host policy, token matrix, config registry, RETIRED_ROOMS |
| Room server | `server.js` (10, thin entry since W4: imports `startServer()` from `server/net.js`) + `server/` modules: config 228 (host policy), protocol 284 (W3 canon + auth/whoami), testmap 494, world 663, sanitize 95, room 438 (join gate, roomsinfo ghost), movement 295, combat 285 (registry clamps), dummy-rab 133, atmo 118, persist 134, net 264 (HTTP host gate + CSRF), modes 45 (grotto catalogue, RETIRED_ROOMS), accounts 347, auth 510 (sessions, cookie, token matrix), profiles 310 (public cards, PATCH /profiles/me), runtime-config 357 (v2 routes), cfg-registry 295 (5-key whitelist + clamps), hunger 11 (skeleton) — domain map with details in ARCHITECTURE.md §2 |
| Canvas engine | `src/components/sim/simulator.tsx` (4933) | Two-stage carve: W5a moved the pure helper belt to `src/lib/sim/*` (engine-consts, geometry, targeting, combat-log, particles, paint, editor-model); W5b moved stage-2 pieces to `src/components/sim/simulator/*` — hooks (use-keyboard 257, use-network 641, use-canvas-layers 186, use-strike 277, use-elision-view 47), hookless factories (editor-ops 734, editor-cells 196, editor-select 197, pointer-tools 670, elision-present 287), HUD day panel (hud-canvas 225), sim-model 178 (types, fmtSec, remote-draw + lib/net consumers), JSX chrome (chrome 408 — кнопки «Погода»/«Сутки», editor-overlay 692, field-stage 159). Platform hooks are INLINE: `IS_ELYRIA` :117 gates the auth panel and callbacks (:4548–:4744). Kept ON PURPOSE: the main rAF closure (`const loop` :4220, one `useEffect` deps `[stage]` — moving it whole recreates a >800-line file, splitting it rewires engine variables), the state/refs belt of `Simulator()` (:253) with the `buildEditorOps` call :938 and `buildPointerTools` call :4364. targeting.pickStrikeTarget mirrors `server/combat.js` aimedNeighbor (:76) -> ARCHITECTURE §4; module/belt map — ARCHITECTURE §2/§7 |
| Combat model, sprites, armor | `src/lib/sim/settings.ts` (1131) | ARMOR_CURVE (:567), DAMAGE_LEVELS (:522), strike zones, sprites; SPRITES (:96, 31 entries) mirrors `server/config.js` |
| «Elision» location | `src/lib/sim/test-field.ts` (2155) | walkability, route graph, edge render, paint, cheap terrain-cell clips, camera-facing cliff faces; mutable singletons — one Simulator mount per process (ARCHITECTURE §6) |
| Elision WebGL | `src/lib/sim/elision-babylon.ts` (307) + `elision-scene.ts` (156) | `/elision/` only. Dynamic `import()` of Babylon `Engine` (WebGL, not WebGPU) so the grotto bundle stays 2D. Orthographic camera matches `screenToWorld`; `worldPxToScene` is the only canvas-px → scene step (no extra ±1). No WebGL → the existing painter stays. Grottos do not mount the slot |
| Location config | `src/lib/sim/test-map.ts` (736) | v1/v2 + editor limits (mirror of server-side sanitize) |
| Site variant canon | `src/lib/site.ts` (28) | `NEXT_PUBLIC_SITE=grotto\|elyria`, default grotto (fail-safe). Variant-dependent modules check env INLINE (`const IS_ELYRIA = …`) — imports from `site.ts` do NOT fold in the bundle, inline checks do (decision P3) |
| Transport, inbound dispatch | `src/lib/net/coop.ts` (576) | socket choice by HOST (elisium → same-origin `/ws`; preview `pr-N.*` → own `/ws`; legacy sslip → room socket; localhost → `ws://localhost:3780`), `httpOrigin()` :202 for the HTTP flows, reconnect backoff, dispatcher; `?t=` in URLs is not used (cookie session) |
| Step prediction | `src/lib/net/move-book.ts` (89) | **the reference module** — copy its style for new files |
| HTTP session client | `src/lib/net/http-auth.ts` (367) + `auth.ts` (30) | the whole HTTP surface of the front: `/auth/register\|login\|logout\|me`, `/profiles` catalog/card/`PATCH /profiles/me`, `/cfg` admin (apply/reset/restore/export/import). Session = HttpOnly cookie; no token in JS storage; WS auth frames go through `auth.ts` |
| Live config client | `src/lib/net/cfg-live.ts` (122) + `src/lib/cfg-registry.ts` (139) | `cfg-live`: universes from the public `GET /cfg` (one fetch per tab; registry defaults on failure; a saved value missing from the registry snaps to DEFAULT). `cfg-registry.ts`: client mirror of the 5-key whitelist (parity gate) |
| Settings panel | `src/components/sim/settings-panel.tsx` (1240) | admin tabs render ONLY for `role === 'admin'` from the server `whoami` (:510–:515 — the old client "tab password" is gone, P3); server stays the arbiter. Handbook tab «Справочник Герты»; server tunables via `/admin`, not here |
| Client room catalogue | `src/lib/net/modes.ts` (155) | mirrors `server/modes.js` (grotto side has no Elision room at all); PlayMode: hub/beer/elision/hunger |
| Main menu | `src/components/menu/wander-gate.tsx` (360) | `/` Wanderpaws, per-site by `IS_ELYRIA` (:15): grotto build — `/combat/` grottos + `/hunger/` placeholder; Elysiae build — Elision window + «Каталог игроков»/«Панель админа» links (:335–:339). «Главное меню» on every game page |
| `/players` catalog | `src/components/players/players-catalog.tsx` (458) | Elysiae-only page: public player cards, `?id=` deep links (:364), inline edit of your own card |
| `/admin` dashboard | `src/components/admin/cfg-dashboard.tsx` (444) | Elysiae-only page, renders for `role==='admin'` (:169): registry values, apply/reset, restore by history name, export/import JSON |
| Route wrappers | `src/app/*/page.tsx` | 11–13-line shells: `/` menu, `/combat/` (grottos), `/elision/`, `/hunger/` (skeleton), `/players/`, `/admin/` — each renders `Simulator` with the `mode` prop or its own page component |

Where to start common tasks:
- **"Add/change an event"** → both registries first (`server/protocol.js` + `src/lib/net/protocol.ts`; they must stay mirrored) → `server/net.js` onMessage dispatcher and the domain handler in `server/*.js` →
  `src/lib/net/coop.ts` (validator+dispatch) → a case in `scripts/test-ws.mjs` (room contract) → update the tables in this file and ARCHITECTURE §3 in the same PR
  (CI gates `check:protocol` + `test:protocol-parity` verify all of it).
- **"Combat/damage/armor"** → `settings.ts` + the server side — both read the same registry set since W3: ARMOR_CURVE lives in `settings.ts` (re-exported by `protocol.ts`), server mirrors it in `server/protocol.js`, `test:protocol-parity` pins the mirror. Admin-tunable damage/armor caps come from the 5-key registry (`server/cfg-registry.js`), clamped in `server/combat.js`.
- **"Settings/HUD"** → ARCHITECTURE §2 (simulator.tsx belts), SettingsPanel pattern (30 props; admin tabs are role-gated, never password-gated).
- **"Map/editor"** → `test-map.ts` (client) + sanitize in `server/testmap.js` (sanitizeTestMap) — limits are single-source now: TEST_MAP_LIMITS is re-exported by `protocol.ts` and mirrored in `server/protocol.js` (parity in CI).
- **"Accounts / roles / host gating"** → `server/config.js` (`hostClassOf`) + `server/auth.js` (sessions, token matrix) + `server/net.js` (HTTP host gate) — matrix in PLATFORM-ARCHITECTURE §3; contract tests in `scripts/test-auth.mjs`.
- **"Admin config"** → `server/cfg-registry.js` (whitelist + clamps) + `server/runtime-config.js` (routes) + `src/components/admin/cfg-dashboard.tsx`; `npm run test:cfg` pins the registry.
- **"Site variant / new public page"** → inline `IS_ELYRIA`/`NEXT_PUBLIC_SITE` check in the page module (never a shared import for folding reasons), `scripts/prune-export.mjs` cut list, `build:variants` check that the other variant's routes are gone from the artifact.

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
| `sprite` | `{sprite}` | whitelist of 31; broadcast `update cat` |
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
| `freemove` | `{x, y, sp?, jp?, stop?}` | `test` room only; cell fractions; ≤1/50 ms; point-in-polygon check |
| `cellsync` | `{x, y}` 1-based | `test` only; enter battle mode: cell must be walkable/entry, occupied → ring search ≤6; → `update cat` to ALL |
| `jump` | `{x, y, deg?, charge?}` 1-based | cooldown 450 ms; 8 directions, 1–3 cells; `charge` 0–1 is the spacebar fill. Step is free when the elevation delta is at most 1. Jump: delta 2 needs charge ≥ 0.5, delta 3 needs charge ≥ 1, climbing 4 or more is impossible, dropping 4 or more needs a full charge |
| `setmap` | `{pass, map}` | admin location editor: sanitize (v1\|2, cols 6–60, rows 3–40, zones ≤48, objects ≤2000), ≥8 backups; the password is verified by the server (ADMIN_PASS, env); throttle 1/10 s per socket (any frame); → `map`+`field` to the `test` room; errors → `info` |
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
| `ADMIN_PASS` | setmap editor password | legacy default in server/config.js; on prod override via the systemd unit (template in `deploy/vps/coop-field.service`) |
| `BOOTSTRAP_ADMIN` | comma-separated logins; EACH becomes `admin` on its own first registration (trim, case-insensitive) | empty = no account-admin until set in `accounts.json` |
| `AUTH_LEGACY_TOKEN` | return `?t=` token acceptance on elyria for the transition period | off: elyria is cookie-only |
| `COOKIE_LOOSE` | relax session cookie to legacy `SameSite=None` | off: `SameSite=Lax` (+`Secure` on https) |
| `MAX_ACCOUNTS` | account registry cap; further registrations → `full` | 500 |
| `DATA_DIR` | data (cat positions, map, backups, accounts, sessions) | `data/` |
| `NEXT_PUBLIC_SITE` | BUILD-time site variant of the front (`grotto\|elyria`) — client-side canon in `src/lib/site.ts` | `grotto` (fail-safe: unknown/empty = public grotto build) |

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
the grotto artifact physically has no `elision/players/admin` routes, the Elysiae artifact has no
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
4. **localStorage routes (client persistence):** `simulator.tsx`: :710 (read saved SP), :725 (write SP), :1201 (write combat log), :4490–4491 (reset), :4503 (log rotation); `editor-ops.ts`: :195 (read editor password), :696 (write it). Storage keys are named constants in `src/lib/sim/engine-consts.ts` / `@/lib/sim/editor-model`.
5. **Sprite whitelist mirror (no CI coverage):** `server/config.js:175` (`SPRITES`, 31) <-> `src/lib/sim/settings.ts:96` (`SPRITES: SpriteMeta[]`) — always change both sides in one PR, keep the counts equal.
6. **Config registry is a whitelist:** the only admin-tunable values are the 5 keys of `server/cfg-registry.js` (clamps included); protocol constants/events/limits are NOT config. Client mirror — `src/lib/cfg-registry.ts` (parity gate).
7. **Production/VPS is owner-only**, except one-shot preview work the owner explicitly authorized. Agents still never restart `coop-field`, never write `/opt/coop-field` (except reading node), never copy prod `data/` or `ADMIN_PASS`. Preview: user `deploy-preview`, `/opt/coop-field-preview/`, TWO webroots per PR — `https://pr-<N>.abnocw.miew.ru` (grottoes) + `https://pr-<N>.elisium.miew.ru` (Elysiae), one room instance, destroy on PR `closed`/`merged`. SSH as `deploy-preview` works with secret `PREVIEW_SSH_KEY`. Preview pipeline is two workflows: `preview-build.yml` (on `pull_request`, no secrets, artifact carries BOTH `www-grotto/` and `www-elyria/`) and `preview-deploy.yml` (on `workflow_run` — that file is always taken from `main`, holds `PREVIEW_SSH_KEY`). Deploy scripts, sudoers and the unit template are owned by `main`: PR branches cannot change what runs on the VPS; the unit is installed only by `preview-bootstrap.sh` from root (apply never copies units or calls daemon-reload). The production front deploy (`deploy-frontend.yml`) rsyncs BOTH site roots: `/opt/coop-field/www` (grottoes) and `/opt/coop-field/www-elyria` (Elysiae). See `docs/PREVIEW-ENVIRONMENTS.md`.

## Doc index

- `AGENTS.md` — this map + wire-contract tables (updated by the wave that changes the protocol).
- `docs/ARCHITECTURE.md` — as-is map, data flows, mirrors, coordinates, target structure (W3–W5 + platform §).
- `docs/PLATFORM-ARCHITECTURE.md` — as-implemented platform: accounts, host policy, token matrix, config registry, profiles, RETIRED_ROOMS, build variants.
- `docs/PRODUCT-ROADMAP.md` — product audit: what exists, what's missing, order of platform work.
- `docs/PREVIEW-ENVIRONMENTS.md` — PR preview on the same VPS (`/opt/coop-field-preview/`, dual-host `pr-<N>.abnocw.miew.ru` + `pr-<N>.elisium.miew.ru`).
- `README.md` — human overview in Russian: two sites, quick start, tests, prod, feature eras.
- `scripts/` — npm runners: test:ws (against a running server or `WS_URL`), test:queue (self-spawn),
  test:unit, arch:check; manual probes with self-spawn carry a "how to run" header line.
- Local per-module `AGENTS.md` files appear in W5 (simulator.tsx/panel split) — until then use the belt
  line ranges in ARCHITECTURE §2.

## Cursor Cloud specific instructions

- Install is `npm ci`. The image already has Node 22. `test:unit` and `check:landmarks` need Node 22.6 or newer; `package.json` `engines` only says `>=18`.
- Boot starts two processes and waits until they answer:
  - room: `npm start` — `http://127.0.0.1:3780/health`, socket `ws://127.0.0.1:3780`
  - front: `npm run dev -- --hostname 0.0.0.0 --port 3000` — open `http://localhost:3000`. The dev HMR socket rejects a page opened as `127.0.0.1` while the server listens on all interfaces.
- A localhost page connects to `ws://localhost:3780` by itself. The plain dev build is the GROTTO variant — to see Elysiae run `NEXT_PUBLIC_SITE=elyria npm run dev`. Hello-world: `/?name=...`, confirm the three hidden parameters («Использовать предыдущие СП»), pick «Пивной грот №1». Join answers `you` then `field`; a step answers `update cat` or `refuse`. Elision (`/elision/` or room `test`) needs register/login first (`auth` → `whoami`); catalog is `/players/`, admin dashboard is `/admin/` (admin session only). Extra tests: `npm run test:auth`, `npm run test:cfg`, `npm run test:profiles`, `npm run test:preview-slug`, `npm run test:preview-apply`, `npm run test:preview-pr-link`, `npm run test:write-openssh-key`.
- `npm run test:queue` spawns its own server on a random port. `npm run test:ws` needs the room already listening (`WS_URL`, default `ws://127.0.0.1:3780`).
- `next dev` rewrites `next-env.d.ts` to `.next/dev/types`; `next build` points it back at `.next/types`. Leave that flip out of feature commits. `agentRules: false` in `next.config.ts` keeps `next dev` from appending its own block to this file.
- Production sockets stay untouched unless a script is given `--prod`. `ADMIN_PASS` is optional for local play.
