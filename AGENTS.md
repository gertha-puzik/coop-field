# AGENTS.md — agent map of the coop-field repo

Coop-field: cat battles on a shared canvas field. Two independent loops live in this repo:

- **Front** — Next.js static export (`output: "export"`): canvas engine, HUD, panels, screens. Lives in `src/`.
- **Room server** — plain Node process (`server.js`, `ws`): rooms, cells, combat, chat, atmosphere.
  Vercel cannot host WebSocket, so the room is deployed on a VPS (systemd unit `coop-field`).

The two loops are connected ONLY by the wire protocol `[event, payload]` — there is no shared code;
matching constants are hand-copied mirrors (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §4 —
required reading before touching either side).

This file is the map: the minimum needed to start a task without reading the god-files.
Human overview — [README.md](README.md) (Russian, on purpose); depth — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Gates: run before submitting ANY task

```bash
npm run typecheck   # tsc --noEmit — always run: fast explicit type check (build catches the same, but slower)
npm run build       # next build, static export
npm run test:queue  # server step-queue contract (spawns its own server)
npm run test:unit   # engine unit tests (node>=22.6, otherwise SKIP; CI runs on node 22)
npm run arch:check  # architecture gate: files <=800 lines + layer boundary rules
npm run check:protocol       # protocol doc tables == EV.* registries (W3)
npm run test:protocol-parity # client/server golden parity (W3)
npm run check:landmarks      # doc size numbers == wc -l (W7a)
```

All eight must be green. If `arch:check` fails on a new file — do not grow the allowlist
(it holds only legacy god-files; they are removed in waves W4/W5).

## Code map

| Task leads to | File | What is inside |
| --- | --- | --- |
| Any engine task | `docs/ARCHITECTURE.md` §2 | map of ALL modules with line ranges — read first |
| Room server | `server.js` (10, thin entry since W4: imports `startServer()` from `server/net.js`) + `server/` modules: config 137, protocol 272 (W3 canon), testmap 493, world 598, sanitize 95, room 412, movement 268, combat 271, dummy-rab 133, atmo 114, persist 131, net 199 — domain map with details in ARCHITECTURE.md §2 |
| Canvas engine | `src/components/sim/simulator.tsx` (4609) | Two-stage carve: W5a moved the pure helper belt to `src/lib/sim/*` (engine-consts, geometry, targeting, combat-log, particles, paint, editor-model); W5b moved stage-2 pieces to `src/components/sim/simulator/*` — hooks (use-keyboard 243, use-network 631, use-canvas-layers 181, use-strike 277), hookless factories (editor-ops 731, editor-cells 196, editor-select 197, pointer-tools 643), HUD day panel (hud-canvas 225), sim-model 174 (types, fmtSec, remote-draw + lib/net consumers), JSX chrome (chrome 373, editor-overlay 691, field-stage 146). Kept ON PURPOSE: the main rAF closure (~2700 lines, one `useEffect` deps `[stage]`, `const loop` at :3993 — moving it whole recreates a >800-line file, splitting it rewires engine variables), state/refs belt of `Simulator()` (233–873) + buildEditorOps call :888, effects ~1041–1274, pointer-tools call :4146, JSX assembly 4371–4609. targeting.pickStrikeTarget mirrors `server/combat.js` aimedNeighbor (:76) -> ARCHITECTURE §4; module/belt map — ARCHITECTURE §2/§7 |
| Combat model, sprites, armor | `src/lib/sim/settings.ts` (1138) | ARMOR_CURVE (:572), strike zones, damage levels; 54 exports |
| «Elision» location | `src/lib/sim/test-field.ts` (1822) | walkability, route graph, edge render, paint; mutable singletons — one Simulator mount per process (ARCHITECTURE §6) |
| Location config | `src/lib/sim/test-map.ts` (634) | v1/v2 + editor limits (mirror of server-side sanitize) |
| Transport, inbound dispatch | `src/lib/net/coop.ts` (537) | socket choice, reconnect backoff, dispatcher 367+ |
| Step prediction | `src/lib/net/move-book.ts` (89) | **the reference module** — copy its style for new files |
| Settings panel | `src/components/sim/settings-panel.tsx` | admin-tab gate is a UX filter; the real password arbiter is the server (setmap) |

Where to start common tasks:
- **"Add/change an event"** → both registries first (`server/protocol.js` + `src/lib/net/protocol.ts`; they must stay mirrored) → `server/net.js` onMessage dispatcher and the domain handler in `server/*.js` →
  `src/lib/net/coop.ts` (validator+dispatch) → a case in `scripts/test-ws.mjs` (room contract) → update the tables in this file and ARCHITECTURE §3 in the same PR
  (CI gates `check:protocol` + `test:protocol-parity` verify all of it).
- **"Combat/damage/armor"** → `settings.ts` + the server side — both read the same registry set since W3: ARMOR_CURVE lives in `settings.ts` (re-exported by `protocol.ts`), server mirrors it in `server/protocol.js`, `test:protocol-parity` pins the mirror.
- **"Settings/HUD"** → ARCHITECTURE §2 (simulator.tsx belts), SettingsPanel pattern (25 props).
- **"Map/editor"** → `test-map.ts` (client) + sanitize in `server/testmap.js` (sanitizeTestMap) — limits are single-source now: TEST_MAP_LIMITS is re-exported by `protocol.ts` and mirrored in `server/protocol.js` (parity in CI).

## Room contract

Frame format: JSON `[event, payload]`. The server is the cell authority: two cats never share a cell,
client-side step prediction is rolled back on `refuse`. Two rooms exist by default: the demo field and
the drawn `test` location («Elision», 19×7, peace mode).

Invariants (violating one = a bug):
- Every step gets exactly one response: an `update cat` echo or `refuse {code}`; silence desyncs the predictor.
- Network coordinates are 1-based (`x=1..W, y=1..H`), canvas is 0-based (`col=x-1, row=y-1`); peace mode uses cell fractions `fx/fy`.
- At most 1 unconfirmed predicted step (move-book.ts).
- `move` FROM THE SERVER is overloaded (canon since W3: the dual MEANING stays, the NAME lives in `server/protocol.js` `EV.MOVE` + client `src/lib/net/protocol.ts`): `publicCat` of a joiner OR `{id, x:0, y:0}` = leave marker — the client dispatches both through one `isCoopCat` guard, and the consumer (`simulator.tsx`) treats `x===0` as the leave marker.
- Clients advance on LOCAL clocks from the `atmo.t` anchor; the server ticker (5 s) resends the anchor only on phase change.
- Damage is client-authoritative (an accepted debt of this sandbox): the server cuts it by target armor and ships it in `fight`.

### Client → server (22)

| Event | Payload | Limits / response |
| --- | --- | --- |
| `join` | `room?, login?, sprite?, size?` | 1/s; login ≤24 codepoints, unique; size 60–100; success → `you`+`field`+`chatlog`, `move` to others; failure → `info`/`noplace` |
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
| `jump` | `{x, y, deg?}` 1-based | cooldown 450 ms; 8 directions, 1–3 cells, elevation drop ≤3; cliffs are passable only by jump |
| `setmap` | `{pass, map}` | admin location editor: sanitize (v1\|2, cols 6–60, rows 3–40, zones ≤48, objects ≤2000), ≥8 backups; the password is verified by the server (ADMIN_PASS, env); throttle 1/10 s per socket (any frame); → `map`+`field` to the `test` room; errors → `info` |
| `rooms` | `{ids: [...]}` ≤32 | 1/250 ms; → `roomsinfo` (does not materialize rooms) |

### Server → client (22)

| Event | Payload | To whom / when |
| --- | --- | --- |
| `you` | own publicCat | join, first response |
| `field` | grid, `cats[]`, `location`, `dummy?`, `rab?`, `atmo`, `map?` | on join and after setmap (`huntMode` was removed in W3 — it was always false) |
| `chatlog` | ≤40 `{seq,id,login,color,text,ts}` | only the joiner, after `field` |
| `move` | publicCat of the joiner \| `{id,x:0,y:0}` | to all; the latter is the leave marker (see the invariant above) |
| `update cat` | publicCat (id, login, color, sprite, x, y, deg, size, blocking, sq) | step/jump/cellsync/skin/aim — to all, including the author |
| `refuse` | `{code, text}` | codes: `edge`/`cell_busy`/`cliff`/`cooldown` — machine-readable predictor rollback |
| `info` | string | all human-facing errors/hints (parse by `refuse` code, not by text) |
| `noplace` | `{room, reason}` | join refusal: 30-cats cap or no free cell |
| `fight` | `{attacker, targetId, part, zone, damage, flightMs…}` | after flightMs; the striker gets `isAttacking=true`; damage is already armor-cut |
| `chat` | `{seq, id, login, color, text, ts}` | whole room, including the sender |
| `map` | TestMap config | every socket of the `test` room after setmap |
| `dummyState` | `{on, x, y, sprite, grab}` | whole room |
| `dummyMove` / `dummyGrab` / `dummyDrop` | `{x,y}` / `{login}` / `{}` | to others (`dummyGrab` — show the grabber cursor) |
| `rabState` / `rabHit` | `{on}` / `{zone, part, damage}` | to all / others without echo |
| `block` / `space` | `{id, on}` / `{id, on, hold?}` | except the sender |
| `atmo` | anchor `{t, cs, pl, wl, w, ws, dp}` | to ALL on atmo/atmoset + 5 s ticker on dp/w change; on rejoin it rides inside `field` |
| `freemove` | `{id, x, y, cx, cy, sp, jp}` | to others, ≤1/50 ms |
| `roomsinfo` | `[{id, count, logins}]` ≤32 | reply to `rooms`, ≤4 req/s |

## Server env

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT` / `HOST` | listen socket | 3780 (prod: 8787 behind nginx) / 0.0.0.0 |
| `REQUIRE_ORIGIN` | enforce the browser Origin check | prod = 1; `ALLOWED_ORIGINS` holds the whitelist |
| `ADMIN_PASS` | setmap editor password | legacy default in server/config.js; on prod override via the systemd unit (template in `deploy/vps/coop-field.service`) |
| `DATA_DIR` | data (cat positions, map, backups) | `data/` |

Map scripts read `MAP_PASS` (same legacy default fallback). Hitting the prod endpoint
(`wss://coop.89-232-184-77.sslip.io`) requires the explicit `--prod` flag — scripts refuse without it.

## Working rules (violation = PR rework)

1. **When you change the protocol, boundaries or data flows — update the tables above and ARCHITECTURE in the same PR.** The check is a gate, not discipline: CI runs `npm run check:protocol` (doc tables vs `server/protocol.js` registries) and `npm run test:protocol-parity` (client/server golden parity) since W3.
2. **Mirrors (ARCHITECTURE §4) change in sync**, client + server in one PR; the sync mechanism since W3 is `test:protocol-parity` in CI (golden values inside the test catch two-sided drift).
3. **Secrets come only from env**; never write values into code or docs (the legacy password default is an accepted transitional exception; changing it is done via env).
4. **No new files above 800 lines** — the `arch:check` gate; a new module is 300–800 self-contained lines (do not fragment below that).
5. **Prod endpoints only via an explicit flag**; scripts target localhost by default.
6. **Coordinates**: any protocol change must respect 1-based/0-based/fx-fy (ARCHITECTURE §5).
7. **Do not "fix style" in passing**: keep wave PRs free of cosmetics; do not grow the god-files.

## Publishing policy & environments (owner directives, 2026-11-06)

1. **PR-only:** never push to `main` — a merge to main IS the production deploy (frontend + room server). Branch + PR; CI green before merge.
2. **Self-merge:** the agent may merge its own PR via `gh pr merge` once all checks are green; if merge rights fail — hand the PR link to the owner and keep going.
3. **External chat AIs (no file-system access, z.ai-style):** point them to `docs/AI-CONTEXT.md` FIRST — it is the one-file EN project brief (stack, deploy, module map, hard rules, human-intermediary protocol). Paste files they ask for; take unified diffs back.
4. **localStorage routes (client persistence):** `simulator.tsx:664` (read saved SP), `:679` (write SP), `:1116` (write combat log), `:4187–4188` (reset), `:4200` (log rotation); `editor-ops.ts:144`/`:769` (editor password). Storage keys are named constants in `src/lib/sim/engine-consts.ts`.
5. **Sprite whitelist mirror (no CI coverage):** `server/config.js:86` (`SPRITES`, 31) <-> `src/lib/sim/settings.ts:96` (`SPRITES: SpriteMeta[]`) — always change both sides in one PR, keep the counts equal.
6. **Production/VPS is owner-only.** Agents never run prod operations, even with SSH access: write the exact commands/steps for the owner (game nick «Сырь») and wait for her confirmation. VPS root is owner-only.

## Doc index

- `AGENTS.md` — this map + wire-contract tables (updated by the wave that changes the protocol).
- `docs/ARCHITECTURE.md` — as-is map, data flows, mirrors, coordinates, target structure (W3–W5).
- `README.md` — human overview in Russian: what the game is, quick start, prod, feature eras.
- `scripts/` — npm runners: test:ws (against a running server or `WS_URL`), test:queue (self-spawn),
  test:unit, arch:check; manual probes with self-spawn carry a "how to run" header line.
- Local per-module `AGENTS.md` files appear in W5 (simulator.tsx/panel split) — until then use the belt
  line ranges in ARCHITECTURE §2.
