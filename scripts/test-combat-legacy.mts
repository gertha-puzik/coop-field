// @ts-nocheck
/**
 * Wave C regression: legacy «combat» code → Beer Grottoes (P1/P3).
 *
 * The standalone `combat` room is retired: on the SERVER the old code is
 * frozen in `RETIRED_ROOMS` (`server/modes.js`) and aliased to `grot-1` by
 * `roomOf`/join (`server/room.js`); on the CLIENT the code is gone from the
 * catalogue (`src/lib/net/modes.ts`) and the `/combat/` page stays the
 * Grottoes entrance (mode "beer", src/app/combat/page.tsx). Integration
 * join-along-the-legacy-code is already pinned by `npm run test:auth`
 * («join по коду combat → поле room grot-1»); matching the two static
 * artifact builds would need `build:variants`, so this file pins the UNIT
 * level: constants and normalizers of BOTH layers imported next to each other.
 *
 * Запуск: через `npm run test:unit` (node --experimental-strip-types);
 * вручную — node --experimental-strip-types scripts/test-combat-legacy.mts
 */
import * as serverModes from "../server/modes.js";
import * as clientModes from "../src/lib/net/modes.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(`combat-legacy: ${msg}`);
}

function eq(a, b, msg) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`combat-legacy: ${msg}\n  expected ${jb}\n  got      ${ja}`);
}

/* ---------- server layer: the retired code stays aliased, never opens ---------- */

eq(serverModes.RETIRED_ROOMS, { combat: "grot-1" }, "RETIRED_ROOMS freezes exactly combat → grot-1");
assert(serverModes.modeOf("combat") === null, "«combat» is NOT in the server catalogue (retired)");
assert(serverModes.accessOf("combat") === serverModes.OPEN, "legacy ?room=combat stays guest-open on the server");
assert(serverModes.requiresAccount("combat") === false, "legacy ?room=combat is not account-walled");
assert(
  ["grot-1", "grot-2", "grot-3"].every((id) => serverModes.modeOf(id)?.mode === "beer" && serverModes.accessOf(id) === serverModes.OPEN),
  "all three grottos are open beer rooms on the server",
);
eq(
  serverModes.MODE_ROOMS.map((r) => r.id),
  ["grot-1", "grot-2", "grot-3", "demo", "hunger", "test"],
  "server catalogue order is canonical (grottos → demo → hunger → test)",
);
assert(serverModes.requiresAccount("test") === true, "the Elision room «test» stays registered-only");
assert(serverModes.requiresAccount("hunger") === false, "hunger stays guest-open");

/* ---------- client layer (grotto variant, the default for unset env) ---------- */

eq(
  clientModes.NAMED_ROOMS.map((r) => r.id),
  ["grot-1", "grot-2", "grot-3", "hunger"],
  "client grotto catalogue: grottos + hunger, no Elision, no combat",
);
assert(clientModes.namedRoom("combat") === undefined, "«combat» is retired from the client catalogue too");
assert(clientModes.isRegisteredOnlyCode("combat") === false, "legacy «combat» is not treated as a closed code on the client");
assert(clientModes.isRegisteredOnlyCode("test") === true, "closed room «test» is hidden from room cards even in the grotto build");
for (const id of ["grot-1", "grot-2", "grot-3"]) {
  const room = clientModes.namedRoom(id);
  assert(room?.href === "/combat/", `grotto ${id} still links to the legacy /combat/ page`);
  assert(room?.mode === "beer", `grotto ${id} plays mode «beer»`);
}
assert(clientModes.namedRoom("hunger")?.href === "/hunger", "hunger keeps its own /hunger page (NOT /combat/)");
assert(
  clientModes.roomsForMode("beer").length === 3 && clientModes.roomsForMode("beer").every((r) => r.mode === "beer"),
  "mode «beer» offers exactly the three grottos (there is no separate combat play mode)",
);
eq(
  Object.keys(clientModes.MODE_COPY).sort(),
  ["beer", "hub", "hunger"],
  "grotto MODE_COPY has no «elision» key (dead branch is dead)",
);

/* ---------- client layer (elyria variant): combat still retired, Elision visible ---------- */

process.env.NEXT_PUBLIC_SITE = "elyria";
const elyriaModes = await import("../src/lib/net/modes.ts?variant=elyria");
process.env.NEXT_PUBLIC_SITE = "";

eq(
  elyriaModes.NAMED_ROOMS.map((r) => r.id),
  ["grot-1", "grot-2", "grot-3", "hunger", "test"],
  "elyria catalogue adds only «test»; «combat» does not return",
);
assert(elyriaModes.namedRoom("combat") === undefined, "«combat» stays retired in the elyria variant");
eq(
  Object.keys(elyriaModes.MODE_COPY).sort(),
  ["beer", "elision", "hub", "hunger"],
  "elyria MODE_COPY has all four modes",
);
assert(
  elyriaModes.roomsForMode("elision").length === 1 && elyriaModes.roomsForMode("elision")[0].id === "test",
  "elision mode = the «test» room only",
);

/* ---------- mirror parity: shared rooms are titled/accessed identically ---------- */

for (const id of ["grot-1", "grot-2", "grot-3", "hunger"]) {
  const srv = serverModes.modeOf(id);
  const cli = clientModes.namedRoom(id);
  assert(Boolean(srv) && Boolean(cli), `room ${id} exists on both sides`);
  eq(cli.title, srv.title, `title of ${id} mirrors across layers`);
  eq(cli.access, srv.access, `access of ${id} mirrors across layers`);
}

console.log("combat-legacy: retired «combat» stays aliased to grot-1, /combat/ stays the Grottoes page — ok");
