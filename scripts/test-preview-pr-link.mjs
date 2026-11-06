#!/usr/bin/env node
/**
 * Guards of withPreviewHeader (scripts/preview-pr-link.mjs): the preview link
 * goes to the top of the PR body, replaces its previous copy in place, never
 * stacks, and survives marker-less or marker-corrupted bodies. Pure, no network.
 */
import { withPreviewHeader, PREVIEW_HEADER_BEGIN, PREVIEW_HEADER_END } from "./preview-pr-link.mjs";

let failed = 0;

function eq(label, actual, expected) {
  if (actual === expected) {
    console.log("ok  ", label);
  } else {
    failed += 1;
    console.error("FAIL", label, "got", actual, "want", expected);
  }
}

const BLOCK = "> 🚀 **Preview:** http://pr-41.abnocw.miew.ru — сборка `deadbee`.";

// Пустое тело: блок ставится целиком.
const empty = withPreviewHeader("", BLOCK);
eq("empty body starts with marker", empty.startsWith(PREVIEW_HEADER_BEGIN), true);
eq("empty body holds block", empty.includes(BLOCK), true);
eq("empty body closes marker", empty.includes(PREVIEW_HEADER_END), true);

// Тело без маркера: блок в самое начало, исходный текст не тронут.
const plain = "Description line.\nSecond line.";
const got = withPreviewHeader(plain, BLOCK);
eq("prepends above existing text", got.endsWith(plain), true);
eq("one blank line after block", got.includes(`${PREVIEW_HEADER_END}\n\n`), true);
eq("buried body kept verbatim", got.includes("\n\nDescription line."), true);

// Повторный прогон: замена на месте, без накопления копий.
const once = withPreviewHeader("Header\n\nTail line", BLOCK);
eq("idempotent rerun", withPreviewHeader(once, BLOCK) === once, true);
const twice = withPreviewHeader(once, `${BLOCK} (update)`);
eq("block replaced, not stacked", (twice.match(new RegExp(PREVIEW_HEADER_BEGIN, "g")) || []).length, 1);
eq("updated text arrives", twice.includes("(update)"), true);
eq("tail survives update", twice.endsWith("Tail line"), true);

// Битый маркер (начало без конца) не ломает тело: блок пересобирается на месте,
// текст до и после сохраняется, структура становится валидной.
const malformed = `Before. ${PREVIEW_HEADER_BEGIN} tail without end`;
const fixed = withPreviewHeader(malformed, BLOCK);
eq("malformed repaired in place", fixed.startsWith("Before. "), true);
eq("malformed block rebuilt", fixed.includes(BLOCK), true);
eq("malformed now well-formed", fixed.includes(PREVIEW_HEADER_END), true);
eq("malformed tail kept", fixed.endsWith("tail without end"), true);

// Обновление URL: старая ссылка уходит, новая приходит (формат URL может смениться —
// SHA-хост ушли, теперь pr-< номер>).
const v1 = withPreviewHeader("body", "> 🚀 **Preview:** http://b0f9fa41.abnocw.miew.ru");
const v2 = withPreviewHeader(v1, "> 🚀 **Preview:** http://pr-41.abnocw.miew.ru");
eq("old url replaced", v2.includes("b0f9fa41"), false);
eq("new format url in place", v2.includes("pr-41.abnocw.miew.ru"), true);

if (failed) {
  console.error("preview link: FAIL", failed);
  process.exit(1);
}
console.log("preview link: зелёный");
