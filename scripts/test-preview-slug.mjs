#!/usr/bin/env node
import {
  previewHost,
  previewId,
  previewPort,
  previewRoot,
  previewSiteHost,
  previewSiteHosts,
  previewSlug,
} from "./preview-slug.mjs";

let failed = 0;
function eq(label, actual, expected) {
  if (actual === expected) {
    console.log("ok  ", label);
  } else {
    failed += 1;
    console.error("FAIL", label, "got", actual, "want", expected);
  }
}

eq("simple", previewSlug("cursor/product-roadmap-and-platform-42e0"), "cursor-product-roadmap-and-platform-42e0");
eq("refs heads", previewSlug("refs/heads/feat/Foo_Bar"), "feat-foo-bar");
eq("empty", previewSlug(""), "pr");
eq("unicode", previewSlug("ветка/Элизия"), "pr");
eq("dots", previewSlug("..//Weird..Name!!"), "weird-name");
eq("truncate", previewSlug("a".repeat(80)).length, 48);
eq("host-from-branch", previewHost("Fix/Room"), "fix-room.abnocw.miew.ru");
eq("port pr 1", previewPort(1), 41001);
eq("port wrap", previewPort(1001), 41001);
eq("root-branch", previewRoot("Ab/Cd"), "/opt/coop-field-preview/ab-cd");
eq("id 41", previewId(41), "pr-41");
eq("id string", previewId("41"), "pr-41");
eq("root-id", previewRoot("pr-41"), "/opt/coop-field-preview/pr-41");
eq("site host pr 41", previewSiteHost(41), "pr-41.abnocw.miew.ru");
eq("site host pr string", previewSiteHost("999"), "pr-999.abnocw.miew.ru");
eq("site host bad input", previewSiteHost("не-число"), "pr-0.abnocw.miew.ru");

// Dual-host (P5): массив из двух хостов, без дублей, форматы строгое.
const hosts41 = previewSiteHosts(41);
eq("site hosts len 2", hosts41.length, 2);
eq(
  "site hosts pr 41",
  hosts41.join(";"),
  "pr-41.abnocw.miew.ru;pr-41.elisium.miew.ru",
);
eq("site hosts element 0 = previewSiteHost (compat)", hosts41[0], previewSiteHost(41));
eq("site hosts abnocw format", /^[a-z0-9][a-z0-9-]{0,23}\.abnocw\.miew\.ru$/.test(hosts41[0]), true);
eq("site hosts elisium format", /^[a-z0-9][a-z0-9-]{0,23}\.elisium\.miew\.ru$/.test(hosts41[1]), true);
eq("site hosts no dup", new Set(previewSiteHosts(1042)).size, 2);
eq("site hosts pr string", previewSiteHosts("999").join(";"), "pr-999.abnocw.miew.ru;pr-999.elisium.miew.ru");
eq("site hosts bad input", previewSiteHosts("не-число").join(";"), "pr-0.abnocw.miew.ru;pr-0.elisium.miew.ru");
// Один инстанс на PR: оба хоста деривируются из одного номера → порт общий.
eq("same port for both hosts", previewPort(hosts41[1].match(/^pr-(\d+)\./)[1]), previewPort(41));

if (failed) {
  console.error("preview slug: FAIL");
  process.exit(1);
}
console.log("preview slug: зелёный");
