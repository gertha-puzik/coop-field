# AI-CONTEXT.md — coop-field in one file, for chat AIs without file-system access

You are an external chat AI: the user pastes files into the chat, and you cannot read the
repo, run gates, or push branches. This file is the whole project brief — what exists,
where things live, and which rules are hard. Ask for files by exact path (see "Files to
ask for, by task"). In-repo maps for agents WITH file access: `AGENTS.md` (routes + wire
contract), `docs/ARCHITECTURE.md` (engine depth), `docs/PLATFORM-ARCHITECTURE.md` (accounts,
two sites, config registry). All sizes below are `wc -l` as of 2026-11-08 (platform branch
`feature/elyria-platform-admin-profiles`); the CI gate `npm run check:landmarks` keeps them
honest — line numbers drift, `grep` wins.

## What this project is

**coop-field** — a browser co-op game: cats battle on a shared canvas field (WASD walking
that survives the Russian keyboard layout, aimed strikes with zones and block, skins,
chat, day/night + weather, a drawn location with an in-game editor). One GitHub repo
(`gertha-puzik/coop-field`), two apps:

- **Frontend** — Next.js static export (`output: "export"`): canvas engine, HUD, panels. `src/`.
- **Room server** — plain Node process (`ws` WebSocket library): rooms, cell authority,
  combat, chat, atmosphere + the HTTP surface for accounts/sessions, profiles and admin
  config. `server.js` (thin entry) + 19 modules in `server/`.

**One engine, two public sites** (platform work, branch above):

- **Beer Grottoes** (grotto site, `abnocw.phainonsmilk.ru`) — public, guest-only, `/combat/` grotto
  rooms and a `/hunger/` placeholder. No accounts, no Elision traces in UI, bundle or server
  answers (the API zones are 404 on that host class).
- **Elysiae / Elision** (elyria site, `phainonsmilk.ru`) — registration/login (HttpOnly
  cookie), the closed drawn location `/game/` (a client stub still redirects old `/elision/` links), player catalog `/players`, admin dashboard
  `/admin`. Preview PRs get BOTH: `pr-<N>.abnocw.phainonsmilk.ru` + `pr-<N>.elysiae.phainonsmilk.ru`.

The two loops share **no code**. The only link is the wire protocol: JSON frames `[event, payload]`.
The server is the cell authority — two cats never share a cell; every step gets exactly
one reply (an `update cat` echo or `refuse {code}`); clients predict one step ahead and
roll back on `refuse`. Vercel cannot host WebSocket, so the room server runs on the
owner's VPS behind nginx.

## Stack

- Frontend: Next.js 16 (static export), React 19, TypeScript, Tailwind 4, pixi.js 8 (weather
  overlay, lazy); Babylon WebGL view only for the `/game/` page (dynamic import).
- Room server: Node ESM JavaScript, no build step; `ws@8`; data in `data/*.json`.
- Protocol: 23 client→server + 23 server→client events, mirrored by hand in
  `server/protocol.js` and `src/lib/net/protocol.ts` (constants like ARMOR_CURVE are
  re-exported per side); CI gates pin the mirror. The platform wave did NOT touch the wire.
- CI: GitHub Actions on every PR (node 22) — see gates below.

## Deploy pipeline — why branch + PR is MANDATORY

A push to `main` IS a production deploy (merge only by PR; branch protection is on). Workflows on `main`:

1. **«Проверки»** (`.github/workflows/ci.yml`) — typecheck, architecture gate (no new file
   over 800 lines, `lib` must not import `components`), protocol sync + parity, doc landmarks,
   unit tests, server-modules smoke, queue tests, auth tests, preview gates.
2. **«Фронтенд на VPS»** (`deploy-frontend.yml`) — builds BOTH site variants
   (`npm run build:variants`: `NEXT_PUBLIC_SITE=grotto|elyria` + `scripts/prune-export.mjs`
   cuts the other variant's routes), then TWO rsyncs: `www-grotto/` → `/opt/coop-field/www`
   (the public grottoes site) and `www-elyria/` → `/opt/coop-field/www-elyria` (Elysiae;
   the directory must exist and be writable once — an owner step, see the workflow's own
   error text). The former Vercel mirror step is gone.
3. **«Сервер комнаты на VPS»** (`deploy-backend.yml`) — rsync of `server/` + restart of the
   systemd unit `coop-field` (port 8787 behind nginx) with a health check.

Merging into `main` additionally requires the green `conflict-check` required status check
(branch protection, `enforce_admins` ON): on every PR it test-merges `origin/main` into the
PR branch, so a conflicted PR can never be merged — GitHub blocks conflicted PRs natively,
the gate makes the block a visible red ✗. Branches cut before 2026-11-10 (no workflow file
in their tree yet) get the check only after their first push/Update branch.

PR preview (same VPS, `/opt/coop-field-preview/`) is TWO more workflows: `preview-build.yml`
(on `pull_request`, no secrets, artifact carries both `www-grotto/` and `www-elyria/`) and
`preview-deploy.yml` (on `workflow_run`, executed from `main`, holds `PREVIEW_SSH_KEY`).
Deploy of a PR serves both hosts `pr-<N>.abnocw.phainonsmilk.ru` (grottoes) and
`pr-<N>.elysiae.phainonsmilk.ru` (Elysiae) from one room instance; TLS per-host by a root cron
(~5 min). See `docs/PREVIEW-ENVIRONMENTS.md`.

## Module map (top files; path — responsibility; sizes = wc -l, 2026-11-08)

| Path | Lines | What is inside |
| --- | ---: | --- |
| `src/components/sim/simulator.tsx` | 4955 | Canvas engine. Deliberate legacy remainder: state/refs belt from :253, `buildEditorOps` call :955, main rAF (`const loop` :4237, one `useEffect` `[stage]`), `buildPointerTools` call :4381. Platform hooks inline: `IS_ELYRIA` :117 gates the auth callbacks (`sendAuth` :4563; a background WS `whoami` frame may NOT overwrite a fresh login refusal — `setWhoamiGuarded` :277) and the auth props of `EntryScreen` (:4758–:4765: whoami/authMessage/authBusy; onLogin/onRegister/onLogout exist only on elyria). localStorage: :727/:742 (saved SP), :1218 (combat log), :4507-4508 (reset), :4520 (rotation) |
| `src/components/sim/simulator/` | 15 files | Stage-2 carve + PR #48: hooks — use-network 641 (`setWhoami` narrowed to `(row: CoopWhoami) => void`), use-canvas-layers 186, use-keyboard 257, use-strike 277, use-elision-view 47; factories — editor-ops 733 (editor password no longer in localStorage — a one-time migration removes the stale key, :199), pointer-tools 670, editor-cells 196, editor-select 197; hud-canvas 225, sim-model 178, elision-present 287; JSX — chrome 408, editor-overlay 692, field-stage 159 |
| `src/components/sim/settings-panel.tsx` | 1222 | Settings/HUD panel (30 props). Admin tabs render ONLY for `role === 'admin'` from the session `whoami` — the old local "tab password" is gone (P3); the server stays the arbiter |
| `src/lib/sim/settings.ts` | 1131 | Combat model: ARMOR_CURVE (:567), DAMAGE_LEVELS (:522), strike zones, sprites (31), slowdown |
| `src/lib/sim/test-map.ts` | 736 | Location config v1/v2 + client-side editor limits (mirror of server sanitize) |
| `src/lib/sim/test-field.ts` | 2155 | The drawn «Elision» field: walkability, routes, edge render, paint mask. Mutable singletons — ONE Simulator mount per process |
| `src/lib/sim/elision-babylon.ts` (+ elision-scene.ts 156) | 307 | WebGL view of `/game/` only: dynamic Babylon import; `worldPxToScene` — the single px→scene step |
| `src/lib/site.ts` | 28 | Site variant canon: `NEXT_PUBLIC_SITE=grotto\|elyria`, default grotto (fail-safe). Variant-dependent modules check env INLINE (`const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === 'elyria'`) — imports from site.ts do NOT fold, inline checks do |
| `src/lib/net/coop.ts` | 582 | Transport: socket choice by host (elisium → same-origin `/ws` via an INLINE env check inside `wsUrlBase` :193 — the dead branch dies at build in the grotto artifact, together with the elisium hostnames; preview → own `/ws`, legacy → room socket, localhost → :3780), `httpOrigin()` :208 for the HTTP flows, reconnect backoff, inbound dispatcher. No `?t=` in URLs |
| `src/lib/net/protocol.ts` | 367 | Client protocol canon: mirrored `EV.*` registries, payload types, guards |
| `src/lib/net/auth.ts` + `http-auth.ts` | 30 + 160 | Session = HttpOnly cookie (no token in JS storage). `http-auth.ts` — auth-only core: `/auth/register\|login\|logout\|me` (`httpRegister` sends an optional `invite` field when the user enters a code) + shared low-level helpers `apiFetch/asText/asId/ApiRow`; WS auth frames go through `auth.ts` |
| `src/lib/net/http-profiles.ts` | 152 | Profiles catalog client: `httpProfileCatalog` (?q search, ?limit def. 24, ?cursor keyset pagination), `httpProfileById`, `httpMyProfile`, `httpPatchProfile` |
| `src/lib/net/http-cfg.ts` | 335→521 | Admin cfg client: /cfg fetch wrappers (apply/reset/restore/export/import) + F2 `/cfg/rooms*` room-fetchers (list/config/update/reset/reset-all/history/restore) + PURE draft/diff helpers (`draftFromSnapshot` carries §4 playerSelectable flags, `cfgPatchFromDraft` sends them explicitly, `canonByKind`, `buildCfgDiff` — §4 choice-aspect, `narrowingWarning`, `listIssue`, `successText`, `applyBadgeText`); React UI stays in cfg-dashboard.tsx / room-config-panel.tsx. Split for bundle isolation: the simulator-graph donor module must not pull Elysiae HTTP routes into the grotto bundle |
| `src/lib/net/cfg-live.ts` + `src/lib/cfg-registry.ts` | 122 + 157 | Live universes from public `GET /cfg` (one fetch per tab; registry defaults on failure; a dropped saved value snaps to DEFAULT); client mirror of the 6-key config registry (5 numeric + bool atmoset gate, parity gate) |
| `src/lib/net/modes.ts` | 163 | Client room catalogue mirroring `server/modes.js`; the grotto build contains no Elision room at all. PlayMode: hub/beer/elision/hunger — the standalone "combat" mode is retired (server aliases room code `combat` → `grot-1`). Variant hrefs/cards sit in dead IS_ELYRIA ternaries (COMBAT_HREF/HUNGER_HREF :38–:39, NAMED_ROOMS :84, MODE_COPY :117) — a dead branch dies at build |
| `src/lib/net/move-book.ts` | 89 | Step prediction (≤1 unconfirmed). **The reference module — copy its style for new files** |
| `src/components/players/players-catalog.tsx` | 918 | `/players` catalog (elyria build only): public cards, server-side `?q` search (300 ms debounce) + keyset pagination via `nextCursor`, `?id=` deep links, inline edit of your own card |
| `src/components/admin/cfg-dashboard.tsx` + `room-config-panel.tsx` | 736 + — | `/admin` dashboard (elyria only, renders for `role==='admin'`): registry values/apply policies (6 keys), editors for allowed-value LISTS with an EXPLICIT playerSelectable toggle (F2 §4: flip does NOT cut the list; off-then-on returns the curated list), was→will-become diff preview (incl. choice flip line), narrowing warning, collapsible tech details, honest ok/err statuses, reset, restore by history name, export/import JSON; «Комнатные настройки» section (F2 §3) — room select, layer table global/override/effective, per-key badges, atmoset gate, reset/restore with confirm |
| `server.js` + `server/*.js` | 10 + 20 | Room server: config 386 (host policy `hostClassOf` public/elyria/local + env `PUBLIC_HOSTS`/`ELYRIA_HOSTS`; WS_MAX_PER_IP def. 8 / ROOMS_MAX def. 32 — S5), protocol 284 (canon), net 401 (HTTP host gate, per-destination Origin/CSRF B1, per-IP socket cap S5a, `/health` `clientIpMode` S4; room-роуты /cfg/rooms* ПЕРЕД глобальным /cfg-хендлером), room 466 (join gate, roomsinfo ghost for guests, RETIRED_ROOMS alias, live-rooms cap → `rooms_full`; F2: стартовый якорь atmo из per-room initialRoomAtmo), movement 295, combat 285 (registry clamps), dummy-rab 133, atmo 128 (якорь + F2 per-room гейт allowPlayerAtmosphereControl: atmoset-кадры игроков молчаливо дропаются), persist 134, sanitize 95, testmap 502 (сохранение локации только role=admin, без пароля), world 663, modes 45, accounts 372 (S1: admin ONLY via `scripts/make-admin.mjs`; `MAX_ACCOUNTS` def. 500), auth 538 (sessions/cookies/token matrix; host-only cookie), profiles 430 (catalog with ?q/?limit/?cursor), runtime-config 375, cfg-registry 431 (6-key whitelist: 5 numeric + bool atmoset gate; §4 playerSelectable), room-config 589 (F2 per-room layer: /cfg/rooms*, layers, room-configs.json), hunger 11 (skeleton) |

Docs: `docs/ARCHITECTURE.md` — data flows, client↔server mirrors, THREE coordinate
systems (network 1-based, canvas 0-based, peace-mode fractions), mutable-singleton contract.
`docs/PLATFORM-ARCHITECTURE.md` — as-implemented platform: session/token matrix per host
class, config registry (5 keys, apply policies), profiles, RETIRED_ROOMS.

## The 5 hard rules (violating one = PR rework)

1. **PR-only, never direct push to `main`.** Merge to main = production deploy (frontend
   + room server). Branch + PR; all CI checks green before merge.
2. **Protocol events via `EV.*` names only.** `server/protocol.js` (server side) and
   `src/lib/net/protocol.ts` (client side) are the only registries. Never write a new
   string literal for an event name; never add an event on one side only. CI gates:
   `check:protocol`, `test:protocol-parity` (the parity also pins the 5-key config registry).
3. **Docs updated in the same PR.** Changed protocol, module boundaries or sizes →
   update the tables in `AGENTS.md` and `docs/ARCHITECTURE.md` (§2) in the same PR;
   drifted size numbers fail CI (`check:landmarks`).
4. **No secrets in the client bundle; secrets come from env only.** The owner
   removed the editor password on 2026-11-09. On 2026-11-10 the owner limited
   saving to role admin: a joined test-room admin may save maps. There is no editor password (ADMIN_PASS removed, A7).

5. **Production/VPS is owner-only.** An agent needing prod operations writes the exact
   commands for the owner and waits — it never improvises server work itself.

Plus two platform rules:
6. **Site-variant code stays folded.** New variant-dependent UI checks
   `NEXT_PUBLIC_SITE` INLINE in its own file (an import of the constant from
   `src/lib/site.ts` does NOT fold — the minifier cannot collapse a cross-module import,
   so the dead branch with its texts stays in the open bundle; an inline
   `process.env.NEXT_PUBLIC_SITE === 'elyria'` comparison is folded by DCE and the dead
   branch dies at build). The same rule applies to variant-world href/HOST STRINGS: they
   must sit inside IS_ELYRIA ternaries (`coop.ts` elisium branch of `wsUrlBase`,
   `modes.ts` COMBAT_HREF/HUNGER_HREF + NAMED_ROOMS, `gerta-catalog` GROTTO_MECHANIC_CARDS,
   `wander-gate` WORLDS) — a string reachable only through the dead branch never reaches
   the other variant's bundle. The arch gate pins the import ban: `src/lib/site.ts` may
   be imported ONLY by itself (`isolatedImports` in `scripts/check-architecture.mjs`).
   The artifact gate is `npm run check:variants` after `build:variants`: the grotto root
   must contain zero Elysiae markers INCLUDING the latin hostname `elisium` (a cyrillic
   grep is NOT sufficient), the elyria root must carry no retired `/combat/`+`/hunger/`
   routes and must contain signs of live Elysiae; chunk links must resolve. Server-side,
   the Host class (`hostClassOf`) gates whole API zones — never mark a hidden route
   "deprecated but working" on the public site.
7. **The config registry is a whitelist.** `server/cfg-registry.js` (6 keys: 5 numeric +
   F2 bool atmoset gate) is the only
   way admin-tunable values exist; protocol constants, events, auth or frame limits are
   NOT admin-editable — do not "just add one more key" without the owner's say-so.
   F2 per-room layer is a separate whitelist (`SUPPORTED_ROOM_KEYS` in
   `server/room-config.js`) on top of the same registry — also explicit-only.

Audit canons (Z.AI security audit 2026-11-08, follow-up waves B/C — hard rules):

- **S1 — the admin role is CLI-only.** Registration with a `BOOTSTRAP_ADMIN` name gives
  `registered` (NOT admin) + a warning line in the server log; the ONLY way to become
  admin is the owner's one-shot `node scripts/make-admin.mjs <login> [pass]`, run with
  the server stopped (a live server would overwrite accounts.json from memory).
- **Invites — registration is invite-only on production (2026-11-12).** POST /auth/register takes an
  optional `invite` code (`XXXX-XXXX`, 24h TTL); on `COOP_INSTANCE_CLASS=production` a valid unused
  non-expired non-revoked code is REQUIRED (bad code → 400 `reason:"invite"`). preview/local/test
  classes skip the gate; `AUTH_INVITE_ENFORCE=1/0` overrides either way; `AUTH_INVITE_TTL_MS` adjusts
  the TTL. Codes are generated/revoked by admins in the /admin tab «Коды приглашений» (routes
  GET/POST /admin/invites*; the store is `DATA_DIR/invites.json`).
- **Location editor:** no password. Since 2026-11-10 only `role=admin` may save
  the test-room map. Legacy localStorage password keys are only removed, never reused.
- **S5 — resource caps:** `WS_MAX_PER_IP` (default 8) — per-IP simultaneous WS sockets,
  over the cap the socket is closed with `too_many_sockets`; `ROOMS_MAX` (default 32) —
  live rooms per process, over the cap new rooms get `noplace rooms_full`. `/health`
  reports `clientIpMode` (`loopback|xff|direct`, S4): `loopback` on a prod host class
  means the proxy does not pass X-Forwarded-For and auth rate-limits are OFF.
- **test:cfg harness mirrors prod escalation:** it stops the server, runs
  `make-admin.mjs`, restarts with the same DATA_DIR, then logs in — that exact
  stop→promote→restart cycle is the only supported admin path (S1).

## Publishing & self-merge

The agent (or owner) opens a PR, waits for green checks, then **may merge it itself**
(`gh pr merge`); if merge rights fail — hand the PR link to the owner and continue other
work. Either way: never a direct push to `main`.

PR descriptions are a contract (owner directive, 2026-11-08): attach links to BOTH
feature environments — `https://pr-<N>.abnocw.phainonsmilk.ru` + `https://pr-<N>.elysiae.phainonsmilk.ru`
(the preview bot fills the marked block) — AND a short bullet list of what was ADDED
and what was CHANGED, with the verification done (gates + live checks). Shape:
`.github/PULL_REQUEST_TEMPLATE.md`.

## Working through a human intermediary (your chat protocol)

- Ask her to **paste the WHOLE files** you are going to change — not fragments. Partial
  pastes silently mislead (line numbers, missing imports, half an effect).
- Return changes as **unified diffs** (`diff -u` style) with the file path at the top —
  not prose descriptions of edits.
- Ask her to run the local gates and paste the output verbatim before anything merges:

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run typecheck            # tsc --noEmit
npm run arch:check           # files <= 800 lines + layer boundaries + isolatedImports (site.ts)
npm run check:protocol       # doc tables == protocol registries
npm run test:protocol-parity # client == server == golden values
npm run check:landmarks      # doc sizes == wc -l
npm run test:auth            # accounts, cookies/CSRF, host gate
npm run test:cfg             # config registry (80 checks: 6 keys, §4 playerSelectable + list mutations + S1 escalation cycle)
npm run test:room-config     # F2 per-room layer (layers, atmoset gate, persistence/restore, 69 checks)
npm run test:cross-origin    # per-destination Origin/CSRF/CORS matrix (B1)
npm run test:profiles        # HTTP profiles (catalog/patch)
npm run check:variants       # artifact isolation A1 — needs www-grotto/ + www-elyria/ (after npm run build:variants)
```

- Browser checks: start the room (`npm start`, port 3780) + `npm run dev`
  (http://localhost:3000; the plain dev build is the GROTTO variant — the Elision UI needs
  `NEXT_PUBLIC_SITE=elyria npm run dev`). Grotto rooms live on `/combat/`,
  Elision on `/game/` (register/login first — the room refuses guests), the catalog on
  `/players/`, the admin dashboard on `/admin/` (only with an admin session). If a change
  is visually verifiable — give her the exact click path instead of trusting it "looks right".
- A task that needs MANY files changed at once is usually a job for a repo agent WITH
  file-system access (Cursor-like) — say so honestly instead of juggling a dozen pastes.

## Files to ask for, by task

- **Change/add an event (anything on the wire):** `src/lib/net/protocol.ts`,
  `server/protocol.js`, `AGENTS.md` (the 23+24 tables), `src/lib/net/coop.ts` (client
  dispatch), the `server/*.js` domain module, `scripts/test-ws.mjs`. Always ALL sides
  of the registry in one change — single-sided edits are guaranteed rework.
- **Combat/damage/armor:** `src/lib/sim/settings.ts` (single client source) ↔
  `server/protocol.js` (mirror) + `src/lib/sim/targeting.ts` pickStrikeTarget ↔
  `server/combat.js` aimedNeighbor — the same strike rule on both sides; the clamps
  (max damage by allowed level, armor snap to allowed tenths) live in
  `server/cfg-registry.js` + consumed in `server/combat.js`.
- **Field/map/editor:** `src/lib/sim/test-map.ts` (client limits) + `server/testmap.js`
  (server sanitize, same limits) + `src/components/sim/simulator/editor-ops.ts`.
- **Settings/HUD:** `src/components/sim/settings-panel.tsx` + ARCHITECTURE §2. Role-gated
  tabs read `whoami.role` — no client password anymore.
- **Accounts/limits/auth:** `server/accounts.js` (`BOOTSTRAP_ADMIN` = a MIGRATION list of
  preset logins — registration gives `registered`, NOT admin, plus a log warning; admin
  role ONLY via `node scripts/make-admin.mjs` (S1); `MAX_ACCOUNTS` cap → `full`),
  `server/auth.js` (sessions; cookie `coop_session` HttpOnly host-only (no Domain
  attribute), SameSite=Lax (+Secure on https; always — `COOKIE_LOOSE` removed, A7); token
  matrix per host class — public and elyria are cookie-only, `?t=` only on local (A7);
  WS `whoami.token` is hostClass `local` only, and `hello` with a payload token
  on public/elyria requires `originOk`;
  rate envs `AUTH_REGISTER_GAP_MS`, `AUTH_REGISTER_HOURLY_MAX`, `AUTH_LOGIN_GAP_MS`,
  `AUTH_LOGIN_FAIL_MAX`, `AUTH_LOGIN_FAIL_WINDOW_MS`; XFF trusted only from the last hop
  behind our own nginx),
  `server/config.js` (`hostClassOf`, env `PUBLIC_HOSTS`/`ELYRIA_HOSTS`; unknown host → public),
  `server/room.js` (join `auth_required` for `test`; roomsinfo ghost: guests get count 0 / no
  logins for registered-only rooms, as if they did not exist),
  `server/profiles.js` (catalog/card/`PATCH /profiles/me`).
- **Admin config:** `server/cfg-registry.js` + `server/runtime-config.js` (routes:
  `GET /cfg` public values, `GET /cfg/admin`, `POST /cfg` (patch/reset — incl. allowed-value
  LIST mutations + explicit `playerSelectable` flags, B2/F2 §4; old bodies without the flag
  keep the legacy list>1 semantics), `POST /cfg/restore` (name from history), `GET /cfg/export`,
  `POST /cfg/import`; all admin ones need the admin session + Origin check) +
  `src/components/admin/cfg-dashboard.tsx`.
  F2 per-room layer: `server/room-config.js` (`/cfg/rooms*`: layers, overrides, reset,
  history/restore; `room-configs.json` atomic; new-rooms-only — no WS broadcast needed;
  atmoset player frames gated per room in `server/atmo.js`, never persisted) +
  `src/components/admin/room-config-panel.tsx`.
- Known hand-synced mirrors WITHOUT CI coverage (check both in one PR):
  sprite whitelist — `server/config.js:314` ↔ `src/lib/sim/settings.ts:96` (31 entries
  each side); room catalogue — `server/modes.js` ↔ `src/lib/net/modes.ts` (grotto build
  folds the Elision branch away); client localStorage routes — `simulator.tsx` :727
  (read SP), :742 (write SP), :1218 (combat log), :4507–4508 (reset), :4520 (log rotation);
  `editor-ops.ts` :199 — one-time migration REMOVING the stale editor-password key (S2:
  the editor password is never written to localStorage anymore). Storage keys are named
  constants in `src/lib/sim/engine-consts.ts`.
