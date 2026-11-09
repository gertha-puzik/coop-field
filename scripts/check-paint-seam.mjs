#!/usr/bin/env node
/**
 * Гейт шва моста «KNS Paint ↔ профиль Элизии» (#84, wave 2).
 *
 * public/paint-demo/index.html — байт-в-байт копия редактора KNS Paint
 * v8.1.2 из репо kns плюс ОДИН шов: подключение game-bridge.js перед
 * </body> (контракт PAINT-ELYSIA-AGREEMENT «Синхронизация версий»:
 * копия обновляется при релизах KNS, мост меняется на coop-field).
 *
 * Проверяет, что текущий index.html == канонический исходник KNS +
 * ровно этот шов: исходник восстанавливается вырезанием шва, его
 * sha1 сверяется с эталоном (прод kns.miew.ru/paint-demo/, PR#87).
 * Провал = копию отредактировали сверх шва (или изменили сам шов) —
 * обнови эталон ТОЛЬКО при осознанном релизе KNS Paint (новый PR:
 * копия + таблица sha1, как в PR #87).
 *
 * Использование: npm run check:paint-seam
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = path.join(ROOT, "public", "paint-demo", "index.html");
const BRIDGE = path.join(ROOT, "public", "paint-demo", "game-bridge.js");

/** Эталон исходника KNS Paint v8.1.2 (sha1 == прод kns.miew.ru/paint-demo/,
 *  зафиксирован в PR #87: 114412 B). Меняется ТОЛЬКО при релизе KNS Paint. */
const SOURCE_SHA1 = "b326a88bce32f6a4e7eb6c11f4500af277e03c71";

/** Шов — ровно эти 4 строки (3 комментария + script), без хвостовых пробелов. */
const SEAM = [
  '<!-- #84 (wave 2): шов моста профиля (game-bridge.js; в исходнике kns его нет и не будет —',
  '     PAINT-ELYSIA-AGREEMENT «Редактор на сайте»). Единственная правка относительно',
  '     байт-в-байт копии KNS Paint v8.1.2; сверка исходника: scripts/check-paint-seam.mjs. -->',
  '<script src="game-bridge.js"></script>',
].join("\n");

const problems = [];
const fail = (msg) => problems.push(msg);

const page = fs.readFileSync(PAGE, "utf8");

// Шов обязан встречаться ровно один раз (вставка перед </body> несёт
// свой ведущий перевод строки, поэтому пара "\n"+SEAM — и в split).
const seams = page.split("\n" + SEAM).length - 1;
if (seams !== 1) {
  fail(`шов встречается ${seams} раз (ожидался 1) — index.html расходится с каноническим швом`);
}

// Исходник = страница без шва; sha1 обязан совпасть с эталоном KNS.
const source = page.replace("\n" + SEAM, "");
const sourceSha1 = createHash("sha1").update(source, "utf8").digest("hex");
if (sourceSha1 !== SOURCE_SHA1) {
  fail(`исходник после снятия шва: sha1 ${sourceSha1}, эталон ${SOURCE_SHA1} — копию правили сверх шва (или сменился релиз KNS: обнови эталон осознанным PR)`);
}

// Шов стоит последним перед </body> — к моменту его исполнения
// window.PAINT уже создан inline-скриптом редактора.
const seamPos = page.indexOf(SEAM);
const bodyClose = page.lastIndexOf("</body>");
if (seamPos === -1 || bodyClose === -1 || seamPos > bodyClose) {
  fail("шов не найден перед </body>");
}

// Мост на месте и не пустой.
try {
  const bridge = fs.readFileSync(BRIDGE, "utf8");
  if (bridge.trim().length < 200) fail("game-bridge.js подозрительно мал (пуст?)");
} catch {
  fail("game-bridge.js отсутствует рядом с копией");
}

if (problems.length) {
  console.error("check-paint-seam: ПРОВАЛ");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-paint-seam: OK — копия == исходник KNS (${SOURCE_SHA1.slice(0, 12)}…) + шов game-bridge.js (1 шт., перед </body>)`);
