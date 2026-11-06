#!/usr/bin/env node
import { previewHost, previewPort, previewRoot, previewSlug } from "./preview-slug.mjs";

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
eq("host", previewHost("Fix/Room"), "fix-room.abnocw.miew.ru");
eq("port pr 1", previewPort(1), 41001);
eq("port wrap", previewPort(1001), 41001);
eq("root", previewRoot("Ab/Cd"), "/opt/coop-field-preview/ab-cd");

if (failed) {
  console.error("preview slug: FAIL");
  process.exit(1);
}
console.log("preview slug: зелёный");
