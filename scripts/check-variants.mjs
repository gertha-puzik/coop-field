#!/usr/bin/env node
/**
 * A1-гейт изоляции вариантов сборки (аудит Z.AI 2026-11-08, находка «утечки
 * между вариантами»: в собранный www-grotto попадали маркеры Элизии —
 * ``elisium``, «Элизи», ссылки на закрытые зоны; а в www-elyria — снятые
 * легаси-маршруты /combat/ и /hunger/).
 *
 * Что проверяет (каждый пункт — точечный, с списком найденных утечек):
 *  (a) www-grotto — НИ ОДИН текстовый файл (включая _next/chunks) не содержит
 *      запрещённых маркеров Элизии/закрытых зон (список — константа ниже,
 *      НЕ из env: гейт обязан быть стабильным, случайный env не ослабляет);
 *  (b) www-elyria — не содержит снятых легаси-маршрутов /combat/ и /hunger/;
 *      и наоборот СОДЕРЖИТ признаки живой Элизии: index.html WITH 'Elysiae' и
 *      «Каталог игроков», players/index.html + admin/index.html на месте,
 *      в чанках есть '/profiles' (изоляция = каждый сайт несёт СВОЙ след);
 *  (c) оба корня: index.html существует, каталог _next непуст, чанк-цельность:
 *      каждая строка «_next/static/chunks/X.js|.css» в html/txt/js/css указывает
 *      на существующий файл (битые ссылки = битая сборка).
 *
 * Использование: node scripts/check-variants.mjs [корень-grotto] [корень-elyria]
 *   по умолчанию — www-grotto и www-elyria в корне репо (пути сборки P5).
 * Выход: 0 — изоляция чистая; 1 — список утечек/поломок в stdout.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [grottoArg = "www-grotto", elyriaArg = "www-elyria"] = process.argv.slice(2);
const GROTTO = path.isAbsolute(grottoArg) ? grottoArg : path.resolve(ROOT, grottoArg);
const ELYRIA = path.isAbsolute(elyriaArg) ? elyriaArg : path.resolve(ROOT, elyriaArg);

/**
 * Запрещённые маркеры в ПУБЛИЧНОМ корне (гроты). Значения НЕ из env — гейт
 * стабилен между запусками; правка списка — только коммитом с комментарием.
 * «Элизи» покрывает все падежи («Элизии», «Элизии.» и т.д.); elisium —
 * домен/латиницу; /auth/ /players/ /admin/ — закрытые HTTP-зоны; coop_session
 * — имя куки сессии («Зарегистри» — форма регистрации, «Каталог игроков» и
 * «Панель админа» — тексты страниц Элизии).
 */
const GROTTO_FORBIDDEN = [
  "Элизи", "elisium", "/players/", "/admin/", "/auth/",
  "coop_session", "Зарегистри", "Каталог игроков", "Панель админа",
];
/** Снятые легаси-маршруты, которых НЕ должно быть в актуальной Элизии. */
const ELYRIA_FORBIDDEN = ["/combat/", "/hunger/"];
/** Подпись живой Элизии в index.html (W2:.SiteHeader несёт навигацию). */
const ELYRIA_INDEX_MUST = ["Elysiae", "Мой профиль"];
/** Расширения, в которых ищем маркеры/ссылки (чанки Next — .js/.css/.txt). */
const TEXT_EXT = new Set([
  ".html", ".js", ".mjs", ".txt", ".json", ".css", ".map", ".svg", ".xml", ".webmanifest",
]);

const problems = [];
const fail = (msg) => problems.push(msg);

function walk(root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const p = path.join(root, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

const textFilesOf = (root) => walk(root).filter((f) => TEXT_EXT.has(path.extname(f)));

function checkRootBasics(label, root) {
  if (!fs.existsSync(path.join(root, "index.html"))) {
    fail(`${label}: нет ${path.join(root, "index.html")}`);
  }
  const nextDir = path.join(root, "_next");
  if (!fs.existsSync(nextDir)) {
    fail(`${label}: нет каталога _next (сборка без статики Next?)`);
  } else if (fs.readdirSync(nextDir).length === 0) {
    fail(`${label}: каталог _next пуст`);
  }
}

function checkNoMarkers(label, root, markers) {
  const hits = [];
  for (const file of textFilesOf(root)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const marker of markers) {
      // Мост на сайт Элизии (карточка на главной гротто, мандат владелицы
      // 2026-11-08): «elisium» в сборке гротто легален ТОЛЬКО полной формой
      // адреса https://elisium.miew.ru/ — точечно, с квотой; любое иное
      // написание остаётся утечкой, как и все прочие маркеры.
      if (label === "www-grotto" && marker === "elisium") {
        let pos = 0;
        let legal = 0;
        const broken = [];
        while ((pos = text.indexOf(marker, pos)) !== -1) {
          const left = text.slice(Math.max(0, pos - 8), pos);
          const right = text.slice(pos + marker.length, pos + marker.length + 9);
          if (left === "https://" && right === ".miew.ru/") legal += 1;
          else broken.push(pos);
          pos += marker.length;
        }
        if (broken.length) {
          const sample = text.slice(Math.max(0, broken[0] - 30), broken[0] + 40).replace(/\s+/g, " ");
          hits.push(`${path.relative(ROOT, file)}: «elisium» вне моста (пример: …${sample}…)`);
        }
        if (legal > 64) {
          hits.push(`${path.relative(ROOT, file)}: мост- адресов подозрительно много (${legal}) — норма карточки ≤ ~16`);
        }
        continue;
      }
      if (text.includes(marker)) hits.push(`${path.relative(ROOT, file)} содержит «${marker}»`);
    }
  }
  if (hits.length) {
    fail(`${label}: утечки маркеров (${hits.length}):`);
    for (const h of [...new Set(hits)].slice(0, 30)) fail(`    ${h}`);
  }
}

function checkChunkIntegrity(label, root) {
  const chunksDir = path.join(root, "_next", "static", "chunks");
  const referenced = new Set();
  // Два формата ссылок на чанки: прямые /_next/static/... (html/пререндеры)
  // и КАРТЫ turbopack внутри js — "static/chunks/X.js" относительные
  // (owner-bug 2026-11-08: карта ссылалась на чанк, которого нет в выкладке
  // → 404 → вечная «Готовим ваш профиль»; второй паттерн ловит это в CI).
  const re = /(?:^|[^\w])static\/chunks\/([A-Za-z0-9._%-]+\.(?:js|css))/g;
  for (const file of textFilesOf(root)) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(re)) referenced.add(m[1]);
  }
  const broken = [...referenced].filter((name) => !fs.existsSync(path.join(chunksDir, name)));
  if (broken.length) {
    fail(`${label}: битые ссылки на чанки (${broken.length}): ${broken.slice(0, 10).join(", ")}`);
  }
}

function main() {
  for (const [label, root] of [["www-grotto", GROTTO], ["www-elyria", ELYRIA]]) {
    if (!fs.existsSync(root)) {
      fail(`${label}: корня сборки нет (${root})`);
      return;
    }
    checkRootBasics(label, root);
    checkChunkIntegrity(label, root);
  }
  if (fs.existsSync(GROTTO)) {
    // (a) публичный корень не несёт НИЧЕГО из мира Элизии.
    checkNoMarkers("www-grotto", GROTTO, GROTTO_FORBIDDEN);
  }
  if (fs.existsSync(ELYRIA)) {
    // (b) Элизия: без снятых маршрутов, со своей подписью и закрытыми зонами.
    checkNoMarkers("www-elyria", ELYRIA, ELYRIA_FORBIDDEN);
    const idx = path.join(ELYRIA, "index.html");
    if (fs.existsSync(idx)) {
      const html = fs.readFileSync(idx, "utf8");
      for (const mark of ELYRIA_INDEX_MUST) {
        if (!html.includes(mark)) fail(`www-elyria: index.html не содержит «${mark}» (сборка не Элизия?)`);
      }
    }
    for (const zone of ["players/index.html", "admin/index.html"]) {
      if (!fs.existsSync(path.join(ELYRIA, zone))) {
        fail(`www-elyria: нет ${zone} (закрытые зоны должны собираться в свой корень)`);
      }
    }
    const chunkHits = textFilesOf(ELYRIA)
      .filter((f) => f.startsWith(path.join(ELYRIA, "_next", "static", "chunks") + path.sep))
      .filter((f) => fs.readFileSync(f, "utf8").includes("/profiles"));
    if (chunkHits.length === 0) {
      fail("www-elyria: ни один чанк не содержит '/profiles' (признак живых страниц каталога отсутствует)");
    }
  }
}

main();

if (problems.length) {
  console.error(`check-variants: FAIL (${problems.length})`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-variants: зелёный (изоляция www-grotto ↔ www-elyria чистая: маркеры — ноль, чанки — цельные)`);
