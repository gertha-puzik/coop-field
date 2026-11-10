#!/usr/bin/env node
/**
 * Окрас по коду CatWar (#84 волна 3) — самодостаточный тест конвейера
 * «код → котик → PNG» без сервера и сети: только node и vendor-копия.
 *
 * Четверо гейтов:
 *  (г) vendor-канон: spawn scripts/check-catwar-vendor.mjs — все sha256
 *      public/catwar сходятся с эталонами (tint.js + манифест + 468 масок);
 *  (а) рендер живого кода (24 блока, грамматика CatWar): непрозрачных
 *      пикселей в кадре больше порога, кроп проходит серверные габариты
 *      (сторона >= 100, IHDR совпадает с расчётной рамкой, файл от 1,5 КБ);
 *  (б) битые коды: валидация отказывает по правилам UI (никаких крэшей):
 *      мусор/перебор блоков/пусто — отказ, рендер не запускается;
 *  (в) детерминизм: повторный полный прогон рендера даёт БАЙТ-В-БАЙТ
 *      одинаковый PNG (композит и энкодер реплики чисто детерминированы).
 *
 * Источник грамматики — НЕ выдуманный: настоящий vendor-tint.js исполнен
 * в node:vm (catwar-manifest.js + tint.js одним скриптом, IIFE вешает
 * глобал Tint; DOM нужен только рендеру в браузере, parseCode/encodeState/
 * hexOf — чистые функции). Пиксельный композит — node-реплика операций
 * крօина канвы tint.js (fill → multiply → destination-in → source-over,
 * порядок слоёв наоборот, protect поверх) по формулам W3C compositing:
 * живой браузерный путь получит отдельный смоук на стенде, реплика
 * закрепляет алгоритм и детерминизм в CI, где браузера нет.
 * Правила валидации/кропа — ДУБЛЬ src/lib/paint/catwar-coat.ts
 * (bad==0 + слоты 0/15/17 + палитра; alpha>0 bbox, PAD 2/2/2/0,
 * integer-NEAREST до min стороны 100): правки — синхронно в оба места.
 *
 * Запуск: node scripts/test-catwar-coat.mjs (npm run test:catwar-coat).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { deflateSync, inflateSync, crc32 } from "node:zlib";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(ROOT, "public", "catwar");

let fails = 0;
let passes = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond || !extra ? "" : ` — ${extra}`}`);
  if (cond) passes++;
  else fails++;
};

/* ---------- (г) vendor-канон: гейт sha256 как отдельный прогон ---------- */
{
  const res = spawnSync(process.execPath, [path.join("scripts", "check-catwar-vendor.mjs")], {
    cwd: ROOT,
    encoding: "utf8",
  });
  ok(
    res.status === 0,
    "(г) vendor-shas: check-catwar-vendor зелёный",
    `exit=${res.status} ${(res.stdout || res.stderr || "").trim()}`,
  );
}

/* ---------- грамматика: vendor tint.js в node:vm (без DOM) ---------- */
const ctx = vm.createContext({ console });
vm.runInContext(
  readFileSync(path.join(VENDOR, "catwar-manifest.js"), "utf8") +
    "\n" +
    readFileSync(path.join(VENDOR, "tint.js"), "utf8"),
  ctx,
  { filename: "catwar-vendor.js" },
);
const Tint = ctx.Tint;
ok(typeof Tint?.parseCode === "function", "vendor tint.js исполнен в vm: Tint.parseCode доступен");
if (typeof Tint?.parseCode !== "function") {
  console.error("движок не загрузился — дальше нет смысла");
  process.exit(1);
}

/* ---------- минимальный PNG-кодек (RGBA8, декод — все 5 фильтров) ---------- */
function chunkType(d, i) {
  return String.fromCharCode(d[i + 4], d[i + 5], d[i + 6], d[i + 7]);
}
/** Декод PNG из БУФЕРА (RGBA8, без interlace); файлы масок идут через неё же. */
function decodePngBuf(d) {
  if (d.readUInt32BE(0) !== 0x89504e47) throw new Error("не PNG: нет магии");
  let w = 0;
  let h = 0;
  let bd = 0;
  let ct = 0;
  const idat = [];
  let pos = 8;
  while (pos < d.length) {
    const len = d.readUInt32BE(pos);
    const type = chunkType(d, pos);
    const data = d.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bd = data[8];
      ct = data[9];
      if (bd !== 8 || ct !== 6) throw new Error(`masки — только RGBA8, а тут bd=${bd} ct=${ct}`);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (!w || !h) throw new Error("пустой IHDR");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const out = Buffer.alloc(h * stride);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? cur[x - 4] : 0;
      const b = prev[x];
      const c = x >= 4 ? prev[x - 4] : 0;
      let v = row[x];
      if (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      cur[x] = v;
    }
    cur.copy(prev);
  }
  return { w, h, rgba: out };
}

function decodePng(file) {
  return decodePngBuf(readFileSync(file));
}

/** Целочисленная сборка PNG (все строки — фильтр 0): детерминизм на байтах. */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // фильтр None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const push = (type, data) => {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, "ascii");
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
    parts.push(chunk);
  };
  push("IHDR", ihdr);
  push("IDAT", deflateSync(raw, { level: 9 }));
  push("IEND", Buffer.alloc(0));
  return Buffer.concat(parts);
}

/* ---------- кеш масок + композит-реплика операций tint.js ---------- */
const maskCache = new Map();
function mask(build, key, layer) {
  const k = `${build}/${key}/${layer}`;
  let m = maskCache.get(k);
  if (!m) {
    m = decodePng(path.join(VENDOR, "gray", build, `${key}_${layer}.png`));
    maskCache.set(k, m);
  }
  return m;
}

/** Заливки FUR-слоёв tint.js:MetaData слоты → порядок снизу вверх. */
const FUR_LAYERS = ["body", "chest", "belly", "tail", "hindL", "hindR", "foreL", "foreR", "head", "earL", "earR"];
const SLOT_OF = {
  tail: 15,
  earL: 17,
  earR: 17,
  body: 0,
  head: 0,
  foreL: 0,
  foreR: 0,
  hindL: 0,
  hindR: 0,
  chest: 0,
  belly: 0,
};
const W = 100;
const H = 150;

/** hex палитры дампа («#rrggbb») → [r,g,b]. */
function hexOf(id) {
  const hex = Tint.hexOf(0, id);
  if (!hex) return null;
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/**
 * Реплика renderFrame('norm','0'): для каждого мех-слоя — стек его слота в
 * ОБРАТНОМ порядке; каждый слой = fill(hex)×multiply(gray)×destination-in(gray)
 * с итоговой alpha=op; protect последним. Накопитель — premultiplied, как
 * у канвы; на выходе — straight RGBA (готово к кропу/энкоду).
 */
function renderReplica(state) {
  const premul = new Float64Array(W * H * 4); // premul RGB, A — ровно альфа
  const blendLayer = (L, stack) => {
    const { rgba: gray, w: mw } = mask("norm", "0", L);
    if (mw !== W) throw new Error(`маска ${L} не 100 px шириной`);
    for (let i = stack.length - 1; i >= 0; i--) {
      const st = stack[i];
      const rgb = st._hex ? hexOf(st._hex) : hexOf(st.colour);
      if (!rgb) continue;
      const op = st.opacity === undefined ? 1 : st.opacity;
      for (let p = 0; p < W * H; p++) {
        const ga = gray[p * 4 + 3] / 255;
        if (ga === 0) continue;
        // multiply поверх плоской заливки (α фона = 1), затем dest-in gray:
        const cr = [0, 1, 2].map((c) => (1 - ga) * rgb[c] + ga * ((rgb[c] * gray[p * 4 + c]) / 255));
        const as = ga * op; // source-over c globalAlpha=op
        const ab = premul[p * 4 + 3];
        const ao = as + ab * (1 - as);
        for (let c = 0; c < 3; c++) {
          premul[p * 4 + c] = cr[c] * as + premul[p * 4 + c] * (1 - as);
        }
        premul[p * 4 + 3] = ao;
      }
    }
  };
  let missing = 0;
  for (const L of FUR_LAYERS) {
    const stack = state[SLOT_OF[L]];
    if (!stack) {
      missing++;
      continue;
    }
    blendLayer(L, stack);
  }
  const prot = mask("norm", "0", "protect").rgba;
  const out = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    const pa = prot[p * 4 + 3] / 255;
    const pr = [prot[p * 4], prot[p * 4 + 1], prot[p * 4 + 2]];
    const ab = premul[p * 4 + 3];
    const ao = pa + ab * (1 - pa);
    for (let c = 0; c < 3; c++) {
      const mix = pr[c] * pa + premul[p * 4 + c] * (1 - pa);
      out[p * 4 + c] = ao > 0 ? Math.round(Math.min(255, mix / ao)) : 0;
    }
    out[p * 4 + 3] = Math.round(ao * 255);
  }
  return out;
}

/** Кроп по силуэту (alpha>0, PAD 2/2/2/0) + NEAREST ×k до стороны 100 — дубль правил. */
const PAD = 2;
const MIN_SIDE = 100;
function cropUpscale(rgba) {
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (rgba[(y * W + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const cx = Math.max(0, x0 - PAD);
  const cy = Math.max(0, y0 - PAD);
  const cw = Math.min(W, x1 + 1 + PAD) - cx;
  const chh = Math.min(H, y1 + 1) - cy;
  const k = Math.max(1, Math.ceil(MIN_SIDE / Math.min(cw, chh)));
  const out = Buffer.alloc(cw * k * chh * k * 4);
  const putPx = (dx, dy, sx, sy) => {
    const s = (sy * W + sx) * 4;
    const t = (dy * cw * k + dx) * 4;
    out[t] = rgba[s];
    out[t + 1] = rgba[s + 1];
    out[t + 2] = rgba[s + 2];
    out[t + 3] = rgba[s + 3];
  };
  for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) putPx(x, y, cx + x, cy + y);
  for (let dy = 0; dy < chh * k; dy++)
    for (let dx = 0; dx < cw * k; dx++) putPx(dx, dy, cx + Math.floor(dx / k), cy + Math.floor(dy / k));
  return { png: encodePng(cw * k, chh * k, out), w: cw * k, h: chh * k, k };
}

/** Полный конвейер реплики: код → parse → композит → кроп → PNG (детерминирован). */
function pipelineReplica(code) {
  const parsed = Tint.parseCode(code);
  const v = validate(parsed);
  if (!v.ok) return { ok: false, reason: v.reason };
  const rgba = renderReplica(parsed.state);
  const shot = cropUpscale(rgba);
  if (!shot) return { ok: false, reason: "empty_silhouette" };
  return { ok: true, png: shot.png, w: shot.w, h: shot.h, opaque: countOpaque(rgba) };
}

function countOpaque(rgba) {
  let n = 0;
  for (let p = 0; p < W * H; p++) if (rgba[p * 4 + 3] > 0) n++;
  return n;
}

/* ---------- валидация кода — ДУБЛЬ правил src/lib/paint/catwar-coat.ts ---------- */
const COAT_SLOTS = [0, 15, 17];
function validate(parsed) {
  if (parsed.bad > 0) return { ok: false, reason: "bad_syntax" };
  const has = COAT_SLOTS.some((s) => (parsed.state[s] ?? []).length > 0);
  if (!has) return { ok: false, reason: "no_coat_zones" };
  const known = COAT_SLOTS.some((s) =>
    (parsed.state[s] ?? []).some((ly) => Tint.hexOf(0, ly.colour) !== null),
  );
  if (!known) return { ok: false, reason: "no_coat_zones" };
  return { ok: true };
}

/* ---------- тест-векторы ---------- */
const LIVE_CODE =
  "1/18 17|5-16 14/2-8/18-9/2|4-13/14 18/15-8/18-9/2|4-13/14 31/18-41/14|2-19/18 31/12|6-64/1|2-51/12|1-42/2|0-45/17|7-38/2 9/2|9-4/12|7-13/14 2/11|0 2/12|0 9/2|7 1/12-2/12 0 3/2|5 33/17-34/2|5-39/18-15/2-20/14 37/18-17/2|5-22/14 6/18 3/18 3/17 3/18 16|0 11/16|0-3/18-6/12|0 2/2 3/1 0";
const synth = (blocks) => blocks.join(" ");
const SYNTH_BASE = synth(["18", ...Array(23).fill("0")]);
const SYNTH_FORMS = synth(["1/16", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0", "6/17", "3/17", "0", "0", "0", "0", "0", "0", "0", "0"]);

/* ---------- проверки ---------- */
{
  const live = Tint.parseCode(LIVE_CODE);
  ok(live.bad === 0, "(а) живой код: parseCode чист (bad=0)", `bad=${live.bad}`);
  const liveOk = validate(live);
  ok(liveOk.ok === true, "(а) живой код: валидация UI пропускает", `reason=${liveOk.reason}`);
  const slotsSet = new Set(Object.keys(live.state).map(Number));
  ok(
    slotsSet.has(0) && slotsSet.has(15) && slotsSet.has(17),
    "(а) живой код: покрашенные слоты 0/15/17 на месте",
    [...slotsSet].join(","),
  );
  const round = Tint.encodeState(live.state);
  ok(round === LIVE_CODE, "(а) живой код: roundtrip encodeState байт-в-байт");

  const run = pipelineReplica(LIVE_CODE);
  ok(run.ok, "(а) живой код: рендер-конвейер собрался", run.reason);
  if (run.ok) {
    ok(run.opaque > 3000, `(а) живой код: непрозрачных пикселей > 3000 (${run.opaque})`);
    ok(run.png.length >= 1536, `(а) живой код: PNG от 1,5 КБ — серверный минимум (${run.png.length} Б)`);
    ok(run.w >= 100 && run.h >= 100, `(а) кроп проходит серверные габариты (${run.w}×${run.h})`);
    ok(
      run.png[0] === 0x89 && run.png[1] === 0x50 && run.png[2] === 0x4e && run.png[3] === 0x47,
      "(а) PNG-магия на месте",
    );
    const ihdrW = run.png.readUInt32BE(16);
    const ihdrH = run.png.readUInt32BE(20);
    ok(ihdrW === run.w && ihdrH === run.h, `(а) IHDR равен рамке кропа (${ihdrW}×${ihdrH})`);

    const again = pipelineReplica(LIVE_CODE);
    ok(
      Buffer.compare(again.png, run.png) === 0,
      "(в) повторный рендер: PNG байт-в-байт идентичен",
      `${again.png.length} vs ${run.png.length}`,
    );
    const shot = decodePngBuf(run.png);
    const redo = encodePng(shot.w, shot.h, shot.rgba);
    ok(
      Buffer.compare(redo, run.png) === 0,
      "(в) decode→re-encode того же кадра идемпотентен",
      `${redo.length} vs ${run.png.length}`,
    );
  }
}

{
  // (б) битые коды: отказ без падения; валидация — та же, что в UI.
  const broken = ["", "abc def/ghi", "18/18/17|xx", "zz/18", synth(Array(25).fill("18"))];
  let badHandled = 0;
  let crash = null;
  for (const code of broken) {
    try {
      const parsed = Tint.parseCode(code);
      const v = validate(parsed);
      if (!v.ok) badHandled++;
      else badHandled += 0; // прошёл — не жfail, но засчитаем ниже отдельной строкой
    } catch (e) {
      crash = `${code} → ${e.message}`;
      break;
    }
  }
  ok(crash === null, "(б) битые коды: parseCode не бросает исключений", crash);
  ok(badHandled === broken.length, `(б) битые коды: все ${broken.length} отклонены валидацией UI`, `отклонено ${badHandled}`);
  const eyesOnly = synth(["0", "2/7", ...Array(22).fill("0")]);
  const vEyes = validate(Tint.parseCode(eyesOnly));
  ok(vEyes.ok === false && vEyes.reason === "no_coat_zones", "(б) код без зон окраса (только глаза): честный отказ", vEyes.reason);
}

{
  // синтетика: разные палитры тоже красятся; счёт слоёв растёт с формами.
  const base = pipelineReplica(SYNTH_BASE);
  const forms = pipelineReplica(SYNTH_FORMS);
  ok(base.ok && forms.ok, "синтетика: оба кода рендерятся", `${base.reason}/${forms.reason}`);
  if (base.ok && forms.ok) {
    ok(base.opaque > 2000, `синтетика: только основа красится (${base.opaque} px)`);
    const again = pipelineReplica(SYNTH_FORMS);
    ok(
      Buffer.compare(again.png, forms.png) === 0,
      "синтетика: детерминизм и на втором коде",
      `${again.png.length} vs ${forms.png.length}`,
    );
  }
}

console.log(`\ntest-catwar-coat: ${passes} PASS, ${fails} FAIL`);
process.exit(fails ? 1 : 0);
