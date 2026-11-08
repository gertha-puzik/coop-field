#!/usr/bin/env node
/**
 * Guards of withPreviewHeader (scripts/preview-pr-link.mjs): the preview link
 * block goes to the top of the PR body, replaces its previous copy in place,
 * never stacks, and survives marker-less or marker-corrupted bodies. Pure,
 * no network. Dual-host (P5): the header now carries BOTH preview links —
 * the public grottoes at pr-N.abnocw.miew.ru and Elyria at
 * pr-N.elisium.miew.ru — for every run and every status wording.
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

// Блок из ДВУХ ссылок — как его собирает preview-deploy.yml для шапки PR.
const BLOCK = [
  "> 🚀 **Гроты:** https://pr-41.abnocw.miew.ru — сборка с коммита `deadbee`, данные прода не используются.",
  "> 🚀 **Элизия:** https://pr-41.elisium.miew.ru — тот же коммит и та же комната.",
].join("\n");

// Пустое тело: блок ставится целиком, обе ссылки на месте.
const empty = withPreviewHeader("", BLOCK);
eq("empty body starts with marker", empty.startsWith(PREVIEW_HEADER_BEGIN), true);
eq("empty body holds block", empty.includes(BLOCK), true);
eq("empty body closes marker", empty.includes(PREVIEW_HEADER_END), true);
eq("both hosts linked", empty.includes("https://pr-41.abnocw.miew.ru") && empty.includes("https://pr-41.elisium.miew.ru"), true);

// Тело без маркера: блок в самое начало, исходный текст не тронут.
const plain = "Description line.\nSecond line.";
const got = withPreviewHeader(plain, BLOCK);
eq("prepends above existing text", got.endsWith(plain), true);
eq("one blank line after block", got.includes(`${PREVIEW_HEADER_END}\n\n`), true);
eq("buried body kept verbatim", got.includes("\n\nDescription line."), true);
eq("grottoes link before elyria link", got.indexOf("abnocw.miew.ru") < got.indexOf("elisium.miew.ru"), true);

// Повторный прогон: замена на месте, без накопления копий.
const once = withPreviewHeader("Header\n\nTail line", BLOCK);
eq("idempotent rerun", withPreviewHeader(once, BLOCK) === once, true);
const twice = withPreviewHeader(once, `${BLOCK}\n> 🚀 **Элизия:** обновление.`);
eq("block replaced, not stacked", (twice.match(new RegExp(PREVIEW_HEADER_BEGIN, "g")) || []).length, 1);
eq("updated text arrives", twice.includes("обновление"), true);
eq("tail survives update", twice.endsWith("Tail line"), true);
eq("both hosts survive update", twice.includes("pr-41.elisium.miew.ru"), true);

// Битый маркер (начало без конца) не ломает тело: блок пересобирается на месте,
// текст до и после сохраняется, структура становится валидной.
const malformed = `Before. ${PREVIEW_HEADER_BEGIN} tail without end`;
const fixed = withPreviewHeader(malformed, BLOCK);
eq("malformed repaired in place", fixed.startsWith("Before. "), true);
eq("malformed block rebuilt", fixed.includes(BLOCK), true);
eq("malformed now well-formed", fixed.includes(PREVIEW_HEADER_END), true);
eq("malformed tail kept", fixed.endsWith("tail without end"), true);

// Обновление формата ссылок: старый single-host блок уходит, оба новых
// хоста приходят (пример: статус live после needs-secret).
const v1 = withPreviewHeader("body", "> 🚀 **Preview:** ещё не выложен — не задан секрет PREVIEW_SSH_KEY. Будет: https://pr-41.abnocw.miew.ru");
const v2 = withPreviewHeader(v1, BLOCK);
eq("old single-host header replaced", v2.includes("не задан секрет"), false);
eq("abnocw host present", v2.includes("https://pr-41.abnocw.miew.ru"), true);
eq("second host arrived", v2.includes("https://pr-41.elisium.miew.ru"), true);

if (failed) {
  console.error("preview link: FAIL");
  process.exit(1);
}
console.log("preview link: зелёный");
