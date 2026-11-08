// @ts-nocheck
/**
 * Wave C regression: config-registry guard (P2/B2 + F2 §4).
 *
 * The registry (server/cfg-registry.js — the SOURCE OF TRUTH, client mirror
 * src/lib/cfg-registry.ts) must stay a strict whitelist:
 *   - a key outside the registry → reject (unknown_keys, full allowed list);
 *   - a room-scoped key in the GLOBAL layer → reject (it is not stored there);
 *   - a list value outside the engineCap universe → reject, not clamp;
 *   - flipping playerSelectable OFF must NOT wipe the curated
 *     allowedValues/defaultValue (F2 §4 «off-then-on» fix): the flag is
 *     stored as a SEPARATE boolean on top of the surviving list;
 *   - the public player view collapses the list to [defaultValue] only
 *     while the admin view keeps the curated list;
 *   - points (combat.armorCurve) outside the axis caps → reject.
 *
 * The HTTP-level battery lives in `npm run test:cfg` (incl. the §4 admin
 * flows); this file pins the REGISTRY level directly, immune to route
 * wiring. Range-kind values are clamped (documented guest tolerance), the
 * test pins that behavior too — it is the contract, not an accident.
 *
 * Запуск: через `npm run test:unit` (node --experimental-strip-types);
 * вручную — node --experimental-strip-types scripts/test-cfg-guard.mts
 */
import * as srv from "../server/cfg-registry.js";
import * as cli from "../src/lib/cfg-registry.ts";

function assert(cond, msg) {
  if (!cond) throw new Error(`cfg-guard: ${msg}`);
}

function eq(a, b, msg) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) throw new Error(`cfg-guard: ${msg}\n  expected ${jb}\n  got      ${ja}`);
}

const LIST_KINDS = ["universes.strikeDamage", "universes.armor", "universes.arrowSpeed"];
const canonOf = (kind, italic) => (kind === "levels" ? Math.round(Number(italic)) : Math.round(Number(italic) * 10) / 10);

/* ---------- 8 keys, both layers agree on the key set ---------- */

eq(srv.KEYS.length, 8, "the registry whitelists exactly 8 keys");
eq(cli.CFG_KEYS, srv.KEYS, "client mirror key list == server KEYS (byte-identical order)");

/* ---------- unknown key → reject with the full allowed list ---------- */

const unknownSec = srv.sanitizeValues({ marja: 1 });
eq(unknownSec.error?.reason, "unknown_keys", "unknown SECTION → unknown_keys");
eq(unknownSec.error?.allowed, srv.KEYS, "rejection enumerates the full allowed list (8 keys)");

const unknownField = srv.sanitizeValues({ atmo: { marja: 2 } });
eq(unknownField.error?.reason, "unknown_keys", "unknown FIELD → unknown_keys");
eq(unknownField.error?.unknown, ["atmo.marja"], "rejection names the exact unknown field");

const roomKeyGlobal = srv.sanitizeValues({ atmo: { allowPlayerAtmosphereControl: false } });
eq(roomKeyGlobal.error?.reason, "unknown_keys", "room-scoped key is unknown for the GLOBAL layer");
eq(roomKeyGlobal.error?.unknown, ["atmo.allowPlayerAtmosphereControl"], "the room-scoped gate is named in the rejection");
assert(
  srv.sanitizeValues({ atmo: { allowPlayerAtmosphereControl: true } }, srv.defaultsFor(), { room: true }).values !== undefined,
  "…but the SAME key is legal with opts.room (per-room layer)",
);

/* ---------- list value outside engineCap → reject ---------- */

for (const [key, fieldBody] of [
  ["universes.strikeDamage", { levels: [0, 27], default: 0 }],
  ["universes.armor", { tenths: [0, 1.5], default: 0 }],
  ["universes.arrowSpeed", { periods: [1.8, 9], default: 1.8 }],
]) {
  const [sec, field] = key.split(".");
  const res = srv.sanitizeValues({ [sec]: { [field]: fieldBody } });
  assert(res.error?.reason === "invalid", `a value in ${key} outside engineCap → invalid (not clamped)`);
  eq(res.error.invalid[0].key, key, `rejection points exactly at ${key}`);
}
assert(srv.sanitizeValues({ combat: { armorCurve: 42 } }).error?.reason === "invalid", "points curve: non-array → invalid");
assert(srv.sanitizeValues({ combat: { armorCurve: [] } }).error?.reason === "invalid", "points curve: below count cap → invalid");

/* ---------- points (armorCurve): outside the axis caps → reject ---------- */

const CAP = srv.REGISTRY["combat.armorCurve"].points;
const COUNT_MAX = srv.REGISTRY["combat.armorCurve"].values.max;
const capCurves = {
  y_over: [[0, 12], [0.5, CAP.yMax + 1]],
  x_over: [[CAP.xMax + 0.05, 60], [CAP.xMax + 0.06, 60]],
  count_over: Array.from({ length: COUNT_MAX + 1 }, (_, i) => [i * 0.05, 60 - i]),
};
for (const [name, curve] of Object.entries(capCurves)) {
  const res = srv.sanitizeValues({ combat: { armorCurve: curve } });
  assert(res.error?.reason === "invalid", `armorCurve ${name} → invalid`);
}
assert(
  srv.sanitizeValues({ combat: { armorCurve: [[0.1, 50], [0.1, 45]] } }).error?.reason === "invalid",
  "armorCurve: duplicate x → invalid",
);
assert(
  srv.sanitizeValues({ combat: { armorCurve: [[0, 50], [0.3, 55]] } }).error?.reason === "invalid",
  "armorCurve: growing damage% violates the defense curve → invalid",
);

/* ---------- range kind: clamps inside engineCap (documented tolerance) ---------- */

const clamped = srv.sanitizeValues({ atmo: { phaseMin: 999, weatherMin: -5 } }).values;
assert(clamped?.atmo.phaseMin === 120 && clamped.atmo.weatherMin === 2, "numeric ranges clamp to the engineCap bounds (999→120, -5→2)");
assert(srv.sanitizeValues({ atmo: { phaseMin: "мусор" } }).error?.reason === "invalid", "range: non-number garbage → invalid, not clamped");

/* ---------- engineCap vs values: caps coincide with the universes ---------- */

for (const key of srv.KEYS) {
  const def = srv.REGISTRY[key];
  if (def.kind === "bool") {
    assert(def.values === null && def.engineCap === null, `${key}: bool has no value universe`);
    continue;
  }
  eq(def.engineCap, def.values, `${key}: engineCap coincides with the values universe`);
  if (LIST_KINDS.includes(key)) {
    const kind = def.kind;
    const canon = canonOf(kind, def.default);
    assert(def.values.some((v) => canonOf(kind, v) === canon), `${key}: defaultValue is a member of the universe`);
    const cliDef = cli.CFG_REGISTRY[key];
    eq(cliDef.engineCap, def.engineCap, `${key}: client mirror engineCap == server engineCap`);
  }
}

/* ---------- defaultsFor: §4 storage explicitly derives the triple ---------- */

const defs = srv.defaultsFor();
for (const [field, rec] of Object.entries(defs.universes)) {
  const def = srv.REGISTRY["universes." + field];
  eq(
    Object.keys(rec).sort(),
    ["default", def.kind, "playerSelectable"].sort(),
    `defaults store the §4 triple for ${field}`,
  );
  assert(rec.playerSelectable === true, `defaults: full engine universe => playerSelectable=true (${field})`);
  assert(rec[def.kind].includes(rec.default), `defaults: defaultValue ∈ allowedValues (${field})`);
}

/* ---------- playerSelectable OFF keeps the curated list (off-then-on, §4) ---------- */

const CURATED = [0.2, 0.4, 0.6, 0.8, 0.9];
const base = srv.defaultsFor();
base.universes.armor = { tenths: [...CURATED], default: 0.4, playerSelectable: true };

const off = srv.sanitizeValues({ universes: { armor: { playerSelectable: false } } }, base);
eq(
  off.values?.universes?.armor,
  { tenths: [...CURATED], default: 0.4, playerSelectable: false },
  "flag-only OFF patch: allowedValues and defaultValue SURVIVE (separate §4 storage)",
);

const pub = srv.universesForPublic(off.values, { playerView: true });
eq(pub.armor, { tenths: [0.4], default: 0.4, playerSelectable: false }, "player view with OFF: only defaultValue is offered");
const adminView = srv.universesForPublic(off.values, { playerView: false });
eq(adminView.armor, { tenths: [...CURATED], default: 0.4, playerSelectable: false }, "admin view with OFF: the curated list is still there (no data loss)");

const on = srv.sanitizeValues({ universes: { armor: { playerSelectable: true } } }, off.values);
eq(
  on.values?.universes?.armor,
  { tenths: [...CURATED], default: 0.4, playerSelectable: true },
  "flag-only ON patch: the curated list returns (off-then-on loses nothing)",
);

/* ---------- flag hygiene: strictly boolean ---------- */

for (const bad of ["false", 0, 1, null]) {
  const res = srv.sanitizeValues({ universes: { armor: { playerSelectable: bad } } }, base);
  assert(res.error?.reason === "invalid", `playerSelectable ${JSON.stringify(bad)} → invalid (strictly true/false)`);
}
const emptyListBase = srv.defaultsFor();
emptyListBase.universes.armor = { tenths: [], default: 0 };
const noList = srv.sanitizeValues({ universes: { armor: { playerSelectable: false } } }, emptyListBase);
assert(
  noList.error?.reason === "invalid",
  "flag-only patch over an EMPTY stored list → invalid (nothing to inherit)",
);

/* ---------- read-time §4 migration on storage without the flag ---------- */

const legacyOnly = srv.defaultsFor();
legacyOnly.universes.armor = { tenths: [0.5], default: 0.5 }; // no playerSelectable key
const migrated = srv.sanitizeValues({}, legacyOnly);
eq(
  migrated.values?.universes?.armor,
  { tenths: [0.5], default: 0.5, playerSelectable: false },
  "legacy single-value list derives playerSelectable=false on read",
);

console.log("cfg-guard: whitelist stays strict, engineCap rejects, §4 off-then-on keeps curated values — ok");
