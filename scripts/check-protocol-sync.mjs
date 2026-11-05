#!/usr/bin/env node
/**
 * Гейт синхронизации протокола и документации (W3). Ноль зависимостей — только
 * node:fs/node:path. Проверяет две вещи (запускается в CI после arch:check):
 *
 *  1. ДОК ↔ РЕЕСТР: имена событий из док-таблиц AGENTS.md
 *     «### Client → server (22)» и «### Server → client (22)» (первый столбец,
 *     в бэктиках) совпадают с реестрами server/protocol.js — как множества
 *     (порядок держит test-protocol-parity с клиентской стороной).
 *  2. БЕЗ ДУБЛЕЙ: server.js не содержит строковых литералов имён событий в КОДЕ
 *     (комментарии не в счёт) — имена ходят только импортом EV.* из
 *     server/protocol.js. Иначе правка канона расходится со скопированной
 *     строкой тихо.
 *
 * Запуск: node scripts/check-protocol-sync.mjs (npm-раннер: npm run check-protocol-sync).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as protocol from "../server/protocol.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];

/* ---------- 1. Док-таблицы AGENTS.md ---------- */

const agents = readFileSync(path.join(ROOT, "AGENTS.md"), "utf8").split("\n");

/** Вытащить имена событий из таблицы секции: первая колонка может содержать
 *  несколько бэктик-имён через «/» (например `dummyGrab` / `dummyDrop`). */
function docEvents(heading) {
  const start = agents.findIndex((l) => l.replace(/\u2192/g, "→").trim() === heading.trim());
  if (start === -1) {
    problems.push(`AGENTS.md: секция «${heading}» не найдена — таблица протокола обязательна.`);
    return [];
  }
  const names = [];
  for (let i = start + 1; i < agents.length; i++) {
    const line = agents[i];
    if (/^#{1,6}\s/.test(line)) break; // любая следующая секция — конец таблицы
    if (!/^\|/.test(line)) continue;
    const cell = line.slice(1, line.indexOf("|", 1) === -1 ? undefined : line.indexOf("|", 1));
    for (const m of cell.matchAll(/`([^`]+)`/g)) names.push(m[1]);
  }
  return names;
}

const docClient = docEvents("### Client → server (22)");
const docServer = docEvents("### Server → client (22)");
const regClient = [...protocol.CLIENT_EVENTS];
const regServer = [...protocol.SERVER_EVENTS];

function diffLabel(kind, doc, registry) {
  const docLine = (name) => {
    const idx = agents.findIndex((l) => l.includes("`" + name + "`"));
    return idx === -1 ? "(no line)" : `${idx + 1}`;
  };
  for (const name of registry) {
    if (!doc.includes(name)) {
      problems.push(`AGENTS.md ${kind}-таблица: события \`${name}\` нет в доке (реестр server/protocol.js его держит) — добавь строку.`);
    }
  }
  for (const name of doc) {
    if (!registry.includes(name)) {
      problems.push(`AGENTS.md:${docLine(name)}: событие \`${name}\` описано в доке, но его нет в реестре server/protocol.js — убери из таблицы или добавь в реестр.`);
    }
  }
  if (doc.length !== 22) {
    problems.push(`AGENTS.md ${kind}-таблица: строк событий ${doc.length}, ожидается 22 — счётчик в заголовке секции обязан сходиться.`);
  }
}

diffLabel("client→server", docClient, regClient);
diffLabel("server→client", docServer, regServer);

/* ---------- 2. server.js: имена только через импорт EV.* ---------- */

const serverJs = readFileSync(path.join(ROOT, "server.js"), "utf8");

if (!/from\s+"\.\/server\/protocol\.js"/.test(serverJs)) {
  problems.push("server.js не импортирует \"./server/protocol.js\": имена событий обязаны ходить импортом (W3-канон).");
}

/** Срезаем комментарии (построчные и блочные), не трогая содержимое строк:
 *  трекаем кавычки, чтобы `http://` внутри строки не выглядел как комментарий. */
function stripComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  let block = false;
  let quote = null;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (block) {
      if (c === "*" && c2 === "/") {
        block = false;
        i += 2;
        out += " ";
      } else i++;
      continue;
    }
    if (quote) {
      if (c === "\\") {
        out += c + (c2 ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && c2 === "/") {
      // до конца строки всё игнорируем, перевод строки сохраним (для нумерации)
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && c2 === "*") {
      block = true;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const codeOnly = stripComments(serverJs);
const codeLines = codeOnly.split("\n");
const allNames = new Set([...regClient, ...regServer]);
const seen = new Map();
for (let ln = 0; ln < codeLines.length; ln++) {
  const re = /(["'`])([^"'`]+)\1/g;
  let m;
  while ((m = re.exec(codeLines[ln])) !== null) {
    if (allNames.has(m[2])) {
      const key = m[2];
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push(ln + 1);
    }
  }
}
for (const [name, lines] of seen) {
  problems.push(
    `server.js:${lines.join(",")}: имя события "${name}" продублировано строкой в коде — импортируй его из server/protocol.js (EV.*), литерал в коде расходится с каноном тихо.`
  );
}

/* ---------- отчёт ---------- */

if (problems.length) {
  console.error(`Синхронизация протокола: проблем — ${problems.length}.`);
  for (const p of problems) console.error("  — " + p);
  console.error("  Куда смотреть: AGENTS.md (таблицы секций Client → server / Server → client),");
  console.error("  server/protocol.js (реестры имён/констант), scripts/test-protocol-parity.mjs (клиентская сторона).");
  process.exit(1);
}

console.log(
  `protocol sync — зелёный: док-таблицы AGENTS.md (${regClient.length}+${regServer.length} событий) совпадают с server/protocol.js;` +
    ` дублей литералов в server.js нет (${Object.keys(protocol.EV).length} имён в одном источнике).`
);
