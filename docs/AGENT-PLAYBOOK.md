# Agent playbook — typical tasks, file order, gates

Cheat-sheet for recurring task shapes. It names the FILES in the order you
should touch them and the GATES that prove the change — it repeats nothing:
the map of zones (source of truth vs mirror), the wire tables and the full
gate list live in [AGENTS.md](../AGENTS.md) and [ARCHITECTURE.md](ARCHITECTURE.md);
data locations and exposure rules in [PRIVACY-DATA.md](PRIVACY-DATA.md).

Default gates after ANY src/server change: `npm run typecheck`,
`npm run test:unit`, `npm run arch:check`. Drills below append their own.

## Add an admin tab to the Elysiae dashboard

1. `src/components/admin/cfg-dashboard.tsx` — the tab lives in the descriptor
   list of the side menu (see `dash-shell` descriptors); tabs render only for
   `role === 'admin'` from the server `whoami` — never a client password check.
2. Client module for the tab itself (e.g. `players-field-tab.tsx` pattern):
   Elysiae-only page, honest ok/err statuses, polling only if the task needs it
   (5 s is the existing precedent).
3. Server surface (if new): a handler in the proper `server/` module + role
   gate via the session (`role-gate admin`), route registered in
   `server/net.js` BEFORE any overlapping global handler (see /cfg/rooms*).
4. Gates: `test:auth` (host gate/roles), plus the new surface's own sandbox
   test (`scripts/test-*.mjs`, self-spawned server like `test-admin-reset.mjs`).
   The tab itself is UI state — storage key `elyria-admin-tab` via `pickTab`
   persists the active tab.

## Add a tunable game parameter (config registry)

The registry IS the whitelist — protocol constants, events, rate limits,
authorization are NOT config and must not end up here.

1. `server/cfg-registry.js` — the SOURCE OF TRUTH: add the key `REGISTRY`
   entry (label/description/unit/kind, values universe, default,
   `engineCap`, applyPolicy/applyHint, visibility, scope). Keep the 8-key
   order rule: new keys append in a deliberate place (golden order is pinned
   by `test:cfg` and `test-cfg-guard.mts`).
2. `src/lib/cfg-registry.ts` — the client MIRROR: same data, hand-copied, no
   formulas. Update `test-protocol-parity` goldens if the probe dumps it.
3. Consumers: server reads via `runtime-config` live values (`armorCurveFor`
   pattern, fail-safe on defaults); client reads the public `GET /cfg` block.
   Room-scoped keys additionally go through `server/room-config.js` layers.
4. Gates: `npm run test:cfg` (HTTP whitelist + clamps + list mutations),
   `npm run test:unit` (includes `scripts/test-cfg-guard.mts`: unknown key →
   reject, out-of-engineCap → reject, §4 playerSelectable off-then-on keeps
   allowedValues/defaultValue), `npm run test:protocol-parity` (mirror parity),
   `npm run check:protocol` if any protocol doc table changed.

## Add a UI Kit component

1. Follow [docs/UI-KIT.md](UI-KIT.md) (the kit spec) — component lives under
   `src/components/ui/`, next-style tokens from the kit, no ad-hoc CSS forks.
2. Compose it into Elysiae surfaces only; the grotto bundle must not pull the
   Elysiae admin/players tree (bundle-isolation rule, `check:variants`).
3. Gates: `npm run typecheck`, `npm run arch:check`, and after a variants
   build `npm run check:variants` (but never build in a docs/test wave).

## Add a profile field (or change its exposure)

1. Decide the audience FIRST — see [PRIVACY-DATA.md](PRIVACY-DATA.md) §3:
   a field is either public (catalog cards), owner-only (`sp`-style), or
   session-bound (`publicAccount`). The DTO source is `accounts.publicProfile`/
   `publicAccount` — there is exactly one DTO, and the catalog inherits it.
2. `server/profiles.js` — PATCH whitelist (`PATCH_FLAT`/`sanitizePatch`),
   validation limits (lengths, ranges, `cleanText`), partial semantics
   (absent key must not touch stored value), `spView`-style read shaping.
3. `server/accounts.js` — persistence/normalization of the new field
   (`normalizeAccount`, defaults on read) + the DTO builders.
4. `src/lib/net/http-profiles.ts` — client type + tolerant parser (`asText`,
   garbage collapses to honest "unknown", never invented values); consumers:
   `players-catalog` / `player-profile` UI only in the elyria variant.
5. Gates: `npm run test:profiles` (catalog/card/PATCH contract),
   `node scripts/test-sp-privacy.mjs` (owner-only fields stay owner-only,
   partial PATCH keeps siblings, raw bodies leak nothing), plus
   `test:auth` when cookie/host matrix behavior could shift.

## Add a room / play mode

1. `server/modes.js` — `MODE_ROOMS` entry (id, title, mode, access, format).
   Never delete a retired code: keep it in `RETIRED_ROOMS` so legacy
   `?room=` links alias instead of dying.
2. `src/lib/net/modes.ts` — the client MIRROR: room card + `MODE_COPY` +
   `roomsForMode`; Elysiae-only rooms/cards sit inside dead `IS_ELYRIA`
   ternaries so the grotto build folds them away (A1).
3. Site isolation: grotto-facing routes in `scripts/prune-export.mjs` cut
   lists; page shells `src/app/*/page.tsx` pass `mode` to `Simulator`.
4. Gates: `npm run test:unit` (includes `scripts/test-combat-legacy.mts`:
   retired codes stay retired and titles/access mirror across layers — use it
   as the pattern when renaming/adding codes), `npm run test:ws` against a
   running room, `npm run check:variants` after `build:variants` (artifact
   gate, when the wave is allowed to build).

## Source of truth vs mirror vs UI-only (where to look first)

Do not copy the zone map — [AGENTS.md](../AGENTS.md) §Code map and §7 own it,
[ARCHITECTURE.md](ARCHITECTURE.md) §4 formalizes the mirror rule. Rule of thumb:
server modules are always the source of truth; client twins marked "mirror"
must change in the SAME PR and stay pinned by a parity/golden gate
(protocol registries, sprite whitelist, map limits, config registry).
UI-only state (HUD layout, theme, active admin tab) never crosses the wire.
