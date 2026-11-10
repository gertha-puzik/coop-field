# Data & privacy map (as implemented)

Code-derived inventory of everything the project stores, sends and logs about
people. Every statement below is anchored in a source file; nothing here is a
policy promise. Companion pages: [PLATFORM-ARCHITECTURE.md](PLATFORM-ARCHITECTURE.md)
(host policy/token matrix), [AGENTS.md](../AGENTS.md) (gates and code map).
The regression battery pinning the privacy-sensitive contracts:
`npm run test:profiles`, `npm run test:auth` and `node scripts/test-sp-privacy.mjs`.

**Legal qualification of the map is out of scope here — it needs separate
owner/legal review.** The rest of this file is engineering fact, not legal advice.

## 1. `accounts.json` — the account store (server/accounts.js)

Location: `DATA_DIR/accounts.json`, atomic writes (`writeFileAtomic`). One row
per account:

| Field | Content | Notes |
| --- | --- | --- |
| `id` | `a` + 16 hex | random, never exposed to strangers |
| `login` | 2–24 chars | unique, case-insensitive lookup; **new** registrations are latin/digits/`._-` only (register v2), legacy logins with spaces still work |
| `pass` | `{algo:"scrypt", N, r, p, keylen, salt, hash}` | Passwords never leave `accounts.js` as plaintext; scrypt (N=16384, r=8, p=1, 32-byte key), random 16-byte salt, `timingSafeEqual` verification. Minimum password length: 8 (`PASS_MIN`) |
| `role` | `registered` \| `admin` | `admin` is granted ONLY by the owner's one-shot CLI `scripts/make-admin.mjs` (server stopped); `BOOTSTRAP_ADMIN` names no longer auto-promote (S1) |
| `createdAt` | epoch ms | |
| `profile` | `{displayName, bio?, birthday?, avatarCharacterId?, sp?}` | `birthday` is stored as a full `YYYY-MM-DD` or null for the owner. Stranger catalog/card responses do not include the year (§3). `sp` stays private |
| `characters` | `[{id, name, sprite, size}]` | sprite ids whitelist-checked against the live sprite catalogue; size clamped 60–100 |
| `activeCharacterId` | character id | |

There are **no** email/phone/payment fields anywhere in the store — the code
simply does not collect them. Account count is capped (`MAX_ACCOUNTS`,
default 500). Unknown file versions migrate without dropping rows
(`migrateStore`). There is **no account-deletion route**; only the position
book forgets a cat (`forgetCat`, admin reset).

## 2. Sessions (server/auth.js)

- Storage: `DATA_DIR/sessions.json` — `{v:1, sessions: {<64-hex-token>: {accountId, createdAt, expiresAt}}}`.
  Expired rows are pruned on every save. **No IP, no user-agent, no login is
  stored in the sessions file.**
- TTL: 14 days (`TTL_MS`), sliding per session creation (not refreshed on use —
  `createdAt` is fixed; `lastSeenByAccount()` reads the newest live session as a
  read-only "last seen" source for the catalog).
- Cookie: `coop_session`, **HttpOnly**, `Path=/`, `Max-Age=14d`, host-only (no
  `Domain` attribute — B1). On https: `Secure` + `SameSite=Lax` (legacy
  `SameSite=None` only behind `COOKIE_LOOSE=1`). The token is never put in
  `localStorage`; on the elyria host class it is cookie-only (`?t=` acceptance
  off unless `AUTH_LEGACY_TOKEN=1`); on `local` the token also appears in HTTP
  response bodies (tests/dev rely on it); on `public` old clients' `?t=` still
  works transitively.
- Rate limiting (anti-guessing) — **memory-only, never persisted**: per-IP buckets
  (`hits` map, register 60s/5h prod, login 6s gap) and the per-LOGIN failure lock
  (`AUTH_LOGIN_FAIL_MAX`, default 20 failures / 15 min window, success resets).
  Client IP is the socket address, or the last `X-Forwarded-For` hop **only when
  the socket is loopback** (i.e., our own nginx appended it) — client-forged
  hops are before the last one and cannot impersonate it.

## 3. Public DTO vs owner-private fields

Who sees what (single DTO source: `accounts.publicProfile` / `accounts.publicAccount`):

| Audience | Fields |
| --- | --- |
| Owner (WS `whoami`, `GET /auth/me`) | `accountId`, `login`, `role`, `profile.displayName`, `characters[]`, `activeCharacterId`, `character` (`publicAccount`) |
| Everyone (catalog `GET /profiles`, card `GET /profiles/:id`) | `accountId`, `displayName`, `bio`, `birthday` as `MM-DD` or null (month and day only — the stored year is not in the JSON), `avatar`, `avatarCharacterId`, `characters[{id,name,sprite,size}]`, `activeCharacterId`, `createdAt`, plus read-only `lastSeenAt` (derived, §5) — **no `lastSeenRoom`, no birth year, no login, no role, no password, no sp** |
| Guest in a room | `publicCat` frames: id, login (character name), color, sprite, x/y, deg, size; `roomsinfo` occupancy (a guest sees a closed room's count but not its logins — the "ghost" rule); `chatlog` — the room's last ≤40 chat messages |
| Owner only (`GET/PATCH /profiles/me`) | the owner DTO from `publicProfile` (full `birthday` `YYYY-MM-DD` so the date can be edited) **plus `sp`** (hidden per-player parameters `periodSec`/`damageLevel`/`armorLevel`, stored in `profile.sp`, partial-merged on PATCH — an untouched key survives). `GET /profiles/:id` of one's own id is still the stranger card: month-day birthday, no year |

`sp` is the only profile block that is deliberately owner-private: it never
enters the catalog, another player's card, `whoami` or `/auth/me` — and not
even the owner's own `/profiles/:id` card route. Pinned by
`scripts/test-sp-privacy.mjs` (catalog/card raw bodies must not contain `"sp"`).
An account row without a filled `profile` has **no** public card at all
(404 by id, absent from the catalog and search).

`lastSeenRoom` is not part of the public DTO. Elysiae has a single field
(Elision), so a "last room" would not tell another player anything; the
catalog and profile UI do not render a room and do not substitute a placeholder.

Known honest limit of the derivation source: `lastSeenAt` for a cat is keyed by
the character NAME in the position book, so two same-named characters are
indistinguishable there. The timestamp is still published; the room is not.

## 4. Server logs (facts from `grep console\.\* server/*.js`)

`console.log/warn/error` calls — what lands in stdout/stderr (journalctl on the VPS):

| Line | Data | Where |
| --- | --- | --- |
| `ws open <remoteAddress> origin=<origin>` | client IP socket address + Origin header | `server/net.js` on every WebSocket connection |
| `ws origin rejected: <origin>` | the rejected Origin string | `net.js` upgrade gate |
| `ws per-ip limit: ip=… open=… max=…` | client IP + socket counts | `net.js` (S5a) |
| `ws leave room=<code> cat=<login>#<id>` | character login of the leaving cat | `server/room.js` |
| `admin reset: room=<code> cat=<login>#<id> -> <x>,<y>` | admin action with character login | `room.js` (POST /admin/players/reset) |
| `spawn cells all blocked/occupied: raw=<spawn json>` | map spawn data only | `room.js` |
| `bootstrap имя «<login>» занято` | a claimed migration name | `accounts.js` |
| `[health] … клиент пришёл loopback…` (rate ≤1/5 min) | host class, no personal data | `net.js` |
| `map set: <dims>` / file-save warnings (`accounts save failed:` etc.) | map geometry; IO error messages | `testmap.js`, `accounts.js`, `auth.js`, `persist.js`, `runtime-config.js`, `room-config.js`, `sprites.js` |

No password, hash, session token or request body is ever logged. IPs and
logins/character names are the only person-related values in the log stream.
`GET /health` answers `{ok, rooms, maxPlayers, clientIpMode}` — no personal data.

## 5. `DATA_DIR` inventory, per environment

Files the server owns inside `DATA_DIR` (root resolved in `server/config.js`;
default `<repo>/data`, overridable per environment):

| File / dir | Content | Retention |
| --- | --- | --- |
| `accounts.json` | §1 | until manually removed (no TTL, no delete route) |
| `sessions.json` | §2 | 14-day TTL, pruned on save |
| `test-cats.json` | cat position book ("test" room only): `{login(name, lower), fm, fx, fy, x, y, ts}` per character | 30-day TTL, throttled atomic flush |
| `runtime-config.json` | registry values only (no secrets) | until changed; last 8 backups in `cfg-backups/` |
| `room-configs.json` | per-room overrides + named backup history | rolling backups |
| `test-map.json` | location layout (no personal data) | last 8 backups in `backups/`; invalid files quarantined as `test-map.invalid-*.json` |
| `sprites/` | admin-uploaded sprite files + manifest | admin-managed |

Where that root lives per environment:

- **Production** — `/opt/coop-field` working directory with no `DATA_DIR` override
  in the systemd unit template ([deploy/vps/coop-field.service](../deploy/vps/coop-field.service)),
  so data lands in `/opt/coop-field/data` (the module default, gitignored).
  The instance declares `COOP_INSTANCE_CLASS=production` explicitly.
- **PR preview** — `/opt/coop-field-preview/<slug>/data` (unit + `preview-apply.sh`
  write `DATA_DIR=$APP/data`; the script **refuses** a `DATA_DIR` pointing at the
  prod root). Preview instances get a per-instance random `ADMIN_PASS` and
  softened register limits (5s / 60 per hour). Whole tree is destroyed on PR
  close/merge.
- **Local dev** — repo `./data/` (gitignored, fails safe to empty).
- **Tests/CI** — `mkdtempSync` sandboxes per run (`coop-auth-*`, `coop-cfg-*`,
  `coop-profiles-*`, `coop-sp-privacy-*`), killed and removed in `finally`.
  CI never touches prod paths (scripts target localhost; prod endpoints need
  an explicit `--prod` flag).

Client-side (browser) storage — **no tokens ever**; the session cookie is
HttpOnly-only. Keys under `localStorage`:
`catwar-battle-sim-v4` (entry settings incl. hidden SP presets),
`catwar-battle-sim-combat-v1` (rotating combat log),
`catwar-battle-sim-layout-v1` (HUD layout), `catwar-battle-sim-theme`,
`catwar-sprite-catalog-v1` (sprite cache), `elyria-admin-tab` (admin UI tab),
and the legacy `catwar-editor-pass` which a one-time migration DELETES on
purpose (S2: the editor password lives in component state only).
The `/auth/me` snapshot (meMemo) is per-tab **memory**, cached one fetch per tab;
login/logout reset it and broadcast the `coop:me` `CustomEvent`.

## 6. Backups (VPS-owner zone)

What is visible from code: the server itself rotates only config/map backups
inside `DATA_DIR` (`cfg-backups/` — 8 stamps, `backups/` — 8 map snapshots,
room-config named history). Anything beyond that — VPS-level disk snapshots,
file archives of `data/`, offsite copies — is **not visible from the code base
and is an owner action**: it needs an owner decision on where those copies
live. The repo's own `backups/` folder contains owner-dumped production map
layouts (`prod-elysia-map-*.json`) — map geometry only, no account data.

## 7. Test/synthetic accounts

No fixture accounts ship with the repo, and nothing seeds `accounts.json` in
any environment. The battery creates throwaway accounts **inside its tmp
sandboxes only**, removed at exit — e.g. `test:auth`/`test:cfg` register
bootstrap-probe names (`gertha_q`) and flood probes, `test:profiles` a pair of
registered accounts, `scripts/test-sp-privacy.mjs` `alice_sp`/`bob_view`.
Deploy scripts, PR previews and tests never read or copy a production
`data/` directory (owner-directive boundary in AGENTS.md §7). The only
code path that adds a real account outside a sandbox is the owner CLI
`scripts/make-admin.mjs <login> [pass]` (creates or promotes an admin in the
target `DATA_DIR`, server stopped).
