#!/usr/bin/env node
import {
  previewHost,
  previewId,
  previewPort,
  previewPublicHost,
  previewRoot,
  previewShaLabel,
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
eq("sha label 8", previewShaLabel("b0f9fa412af6670010e1e7251f88215682a5ef0c"), "b0f9fa41");
eq("sha host", previewPublicHost("b0f9fa412af6670010e1e7251f88215682a5ef0c"), "b0f9fa41.abnocw.miew.ru");
eq("sha short rejected", previewShaLabel("abc"), "");
eq("sha mixed", previewShaLabel("B0F9FA41"), "b0f9fa41");

if (failed) {
  console.error("preview slug: FAIL");
  process.exit(1);
}
console.log("preview slug: зелёный");
