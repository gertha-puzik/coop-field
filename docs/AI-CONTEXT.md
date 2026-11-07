# AI-CONTEXT.md — coop-field in one file, for chat AIs without file-system access

You are an external chat AI: the user pastes files into the chat, and you cannot read the
repo, run gates, or push branches. This file is the whole project brief — what exists,
where things live, and which rules are hard. Ask for files by exact path (see "Files to
ask for, by task"). In-repo maps for agents WITH file access: `AGENTS.md` (routes + wire
contract), `docs/ARCHITECTURE.md` (depth). All sizes below are `wc -l` as of 2026-11-06;
the CI gate `npm run check:landmarks` keeps them honest — line numbers drift, `grep` wins.

## What this project is

**coop-field** — a browser co-op game: cats battle on a shared canvas field (WASD walking
that survives the Russian keyboard layout, aimed strikes with zones and block, skins,
chat, day/night + weather, a drawn location with an in-game editor). Two independent apps
live in one GitHub repo (`gertha-puzik/coop-field`; owner decision: **private** —
if it is still public, GitHub → Settings → General → Danger Zone → Change
repository visibility → Private):

- **Frontend** — Next.js static export (`output: "export"`): canvas engine, HUD, panels. `src/`.
- **Room server** — plain Node process (`ws` WebSocket library): rooms, cell authority,
  combat, chat, atmosphere. `server.js` (thin entry) + 12 modules in `server/`.

They share **no code**. The only link is the wire protocol: JSON frames `[event, payload]`.
The server is the cell authority — two cats never share a cell; every step gets exactly
one reply (an `update cat` echo or `refuse {code}`); clients predict one step ahead and
roll back on `refuse`. Vercel cannot host WebSocket, so the room server runs on the
owner's VPS behind nginx.

## Stack

- Frontend: Next.js 16, React 19, TypeScript, Tailwind 4, pixi.js 8 (weather overlay, lazy).
- Room server: Node ESM JavaScript, no build step; `ws@8`; data in `data/*.json`.
- Protocol: 23 client→server + 23 server→client events, mirrored by hand in
  `server/protocol.js` and `src/lib/net/protocol.ts` (constants like ARMOR_CURVE are
  re-exported per side); CI gates pin the mirror.
- CI: GitHub Actions on every PR (node 22) — see gates below.

## Deploy pipeline — why branch + PR is MANDATORY

A push to `main` IS a production deploy. Three workflows start on `main`:

1. **«Проверки»** (`.github/workflows/ci.yml`) — typecheck, architecture gate (no new file
   over 800 lines, `lib` must not import `components`), protocol sync + parity, unit tests.
2. **«Фронтенд на Vercel и VPS»** (`deploy-frontend.yml`) — `vercel deploy --prod` and
   rsync of the static `out/` to the VPS web root.
3. **«Сервер комнаты на VPS»** (`deploy-backend.yml`) — rsync of `server/` + restart of
   the systemd unit `coop-field` (port 8787 behind nginx) with a health check.

So **nobody ever pushes to `main` directly** — that would ship to production unreviewed
(the live game AND the room server). The workflow is always: branch → PR → green CI → merge.

PR preview (same VPS, `/opt/coop-field-preview/`, host `*.abnocw.miew.ru`) is a fourth
workflow on pull_request, not on `main`. It does not replace the prod pipeline.
Until DNS-01 wildcard TLS exists, previews are HTTP. Remaining owner step:
`sudo bash /home/deploy-preview/incoming-preview/preview-bootstrap.sh`.

## Module map (top files; path — responsibility; sizes = wc -l, 2026-11-06)

| Path | Lines | What is inside |
| --- | ---: | --- |
| `src/components/sim/simulator.tsx` | 4477 | Canvas engine. Legacy monolith, deliberately kept (W5a/W5b moved out what could be moved): state/refs belt 233–868, `buildEditorOps` call :869, effects ~1014–1248, main rAF 1249–3978 (`const loop` :3947, one `useEffect` `[stage]`), pointer handlers 3979–4075, settings patches 4076–~4210, JSX 4324–4477 |
| `src/components/sim/simulator/` | 11 files | Stage-2 carve of the engine: hooks — use-network 624, use-canvas-layers 181, use-keyboard 230, use-strike 277; factories — editor-ops 785, pointer-tools 619; hud-canvas 241, sim-model 174, chrome 373, editor-overlay 621, field-stage 146 |
| `src/components/sim/settings-panel.tsx` | 1299 | Settings/HUD panel (25 props). The admin-tab password gate is UX-only — the real arbiter is the server (`setmap`) |
| `src/lib/sim/settings.ts` | 1138 | Combat model: ARMOR_CURVE (:572), DAMAGE_LEVELS (:527), strike zones, sprites, slowdown |
| `src/lib/sim/test-map.ts` | 634 | Location config v1/v2 + client-side editor limits (mirror of server sanitize) |
| `src/lib/sim/test-field.ts` | 1822 | The drawn «Elision» field: walkability, routes, edge render, paint mask. Mutable singletons — ONE Simulator mount per process |
| `src/lib/sim/atmosphere.ts` | 527 | pixi.js day/night + weather overlay |
| `src/lib/net/coop.ts` | 537 | Transport: socket choice, reconnect backoff, inbound dispatch |
| `src/lib/net/protocol.ts` | 329 | Client protocol canon: mirrored `EV.*` registries, payload types, guards |
| `src/lib/net/move-book.ts` | 89 | Step prediction (≤1 unconfirmed). **The reference module — copy its style for new files** |
| `server.js` + `server/*.js` | 10 + 12 | Room server: config 137, protocol 272 (canon), testmap 493, world 598, sanitize 95, room 412, movement 268, combat 271, dummy-rab 133, atmo 114, persist 131, net 199 |

Docs: `docs/ARCHITECTURE.md` — data flows, client↔server mirrors, THREE coordinate
systems (network 1-based, canvas 0-based, peace-mode fractions), mutable-singleton contract.

## The 5 hard rules (violating one = PR rework)

1. **PR-only, never direct push to `main`.** Merge to main = production deploy (frontend
   + room server). Branch + PR; all CI checks green before merge.
2. **Protocol events via `EV.*` names only.** `server/protocol.js` (server side) and
   `src/lib/net/protocol.ts` (client side) are the only registries. Never write a new
   string literal for an event name; never add an event on one side only. CI gates:
   `check:protocol`, `test:protocol-parity`.
3. **Docs updated in the same PR.** Changed protocol, module boundaries or sizes →
   update the tables in `AGENTS.md` and `docs/ARCHITECTURE.md` (§2) in the same PR;
   drifted size numbers fail CI (`check:landmarks`).
4. **No secrets in the client bundle.** Password `1946` is a known legacy default inside
   `server/config.js` (`process.env.ADMIN_PASS || …`) — an accepted transitional exception.
   Do not move it (or any secret) into client code; changing the value is an owner
   decision done via the systemd unit env.
5. **Production/VPS is owner-only.** An agent needing prod operations writes the exact
   commands for the owner and waits — it never improvises server work itself.

## Publishing & self-merge

The agent (or owner) opens a PR, waits for green checks, then **may merge it itself**
(`gh pr merge`); if merge rights fail — hand the PR link to the owner and continue other
work. Either way: never a direct push to `main`.

## Working through a human intermediary (your chat protocol)

- Ask her to **paste the WHOLE files** you are going to change — not fragments. Partial
  pastes silently mislead (line numbers, missing imports, half an effect).
- Return changes as **unified diffs** (`diff -u` style) with the file path at the top —
  not prose descriptions of edits.
- Ask her to run the local gates and paste the output verbatim before anything merges:

```bash
export PATH="$HOME/.nvm/versions/node/v24.12.0/bin:$PATH"
npm run typecheck            # tsc --noEmit
npm run arch:check           # files <= 800 lines + layer boundaries
npm run check:protocol       # doc tables == protocol registries
npm run test:protocol-parity # client == server == golden values
npm run check:landmarks      # doc sizes == wc -l
```

- Browser checks: start the server (`npm start`, port 3780) + `npm run dev`
  (http://localhost:3000), open `/?room=demo&name=<имя>`. If a change is visually
  verifiable — give her the exact click path instead of trusting it "looks right".
- A task that needs MANY files changed at once is usually a job for a repo agent WITH
  file-system access (Cursor-like) — say so honestly instead of juggling a dozen pastes.

## Files to ask for, by task

- **Change/add an event (anything on the wire):** `src/lib/net/protocol.ts`,
  `server/protocol.js`, `AGENTS.md` (the 23+23 tables), `src/lib/net/coop.ts` (client)
  dispatch), the `server/*.js` domain module, `scripts/test-ws.mjs`. Always ALL sides
  of the registry in one change — single-sided edits are guaranteed rework.
- **Combat/damage/armor:** `src/lib/sim/settings.ts` (single client source) ↔
  `server/protocol.js` (mirror) + `src/lib/sim/targeting.ts` pickStrikeTarget ↔
  `server/combat.js` aimedNeighbor (:76) — the same strike rule on both sides.
- **Field/map/editor:** `src/lib/sim/test-map.ts` (client limits) + `server/testmap.js`
  (server sanitize, same limits) + `src/components/sim/simulator/editor-ops.ts`.
- **Settings/HUD:** `src/components/sim/settings-panel.tsx` + ARCHITECTURE §2.
- Known hand-synced mirrors WITHOUT CI coverage (check both in one PR):
  sprite whitelist — `server/config.js:86` ↔ `src/lib/sim/settings.ts:96` (31 entries
  each side); client localStorage routes — `simulator.tsx` :659 (read), :674/:1089
  (writes), :4140–4141 (reset), :4153 (log rotation); `editor-ops.ts` :144/:769
  (editor password). Storage keys are named constants in `src/lib/sim/engine-consts.ts`.
