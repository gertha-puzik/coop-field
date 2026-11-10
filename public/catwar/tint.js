// Tint — рантайм-тонировка серых масок M2-модели по палитрам дампа (карточка t_69e8c0f2).
//
// Целевой формат досье: серые маски + тонирование на canvas в рантайме,
// кеш по (код, поза, кадр); PNG-bake опционален.
//
// Ассеты: gray/{build}/{key}_{layer}.png — 9 мех-слоёв (RGB = нормированный серый,
// A = альфа исходника) + {key}_protect.png (глаза, нос, ушные раковины — НЕ
// тонировать: глаза/нос — гейт-слоты CatWar, раковина — палитра 5, сервер 404).
// Ключи: '0' сид, '1'..'4' walk-фазы, 'N0'..'N3', 'S0'..'S3'; W = зеркало E,
// масштабирование — ближайшим соседом при отрисовке (см. досье, s = T/catH).
//
// cut_from-паритет kns.js (L546-557): их buffer = copy(mark); source-in(base) —
// форма из альфы маски, цвет из родителя. Наш «родитель» — плоская заливка
// палитры дампа (готовых цветных файлов на 24 цвета у M2 нет — вся суть
// рантайм-тонировки), тени/фактуру возвращает multiply по серой текстуре:
//   fill(hex) -> multiply(gray) -> destination-in(gray)   (на слой)
// Слои слота рисуются в обратном порядке кода: первый слой блока — СВЕРХУ
// (kns.js L477-481+L546-557, проверено на живом коде CatWar).
//
// Зависимости: catwar-manifest.js (CATWAR_MANIFEST, палитры живого дампа),
// gray/tint_meta.json (карта билдов/ключей/слоёв). Подключение:
// <script src="tint.js"></script>, затем await Tint.init().
'use strict';
(function (global) {
  const W = 100, H = 150;
  // порядок отрисовки снизу вверх; маски дизъюнктны, порядок влияет только
  // на мягкие края (alpha>0) — стыковка не пересекается. Лапы с этапа
  // «зоны 13»: fore->foreL+foreR, hind->hindL+hindR (по сторонам «на виде»).
  const FUR_LAYERS = ['body', 'chest', 'belly', 'tail', 'hindL', 'hindR', 'foreL', 'foreR', 'head', 'earL', 'earR'];
  // палитры_hex(_id) возвращает hex цвета id из палитры живого дампа (манифест).
  function palOf(idx) {
    const raw = CATWAR_MANIFEST.palettes[idx] || CATWAR_MANIFEST.palettes[0];
    return Array.isArray(raw) ? raw : (raw && raw.colours ? raw.colours : raw);
  }
  function hexOf(palette, id) {
    const p = palOf(palette);
    const c = p.find(x => String(x.id) === String(id));
    return c && c.hex ? c.hex : null;
  }
  // ---- грамматика CatWar: копия разбора index.html (applyCode), байт-в-байт ----
  function opFromCode(p) { return Math.max(0.05, Math.min(1, (Number(p) * 5 + 50) / 100)); }
  function opToCode(f) { return Math.max(0, Math.min(10, Math.round(((f !== undefined ? f : 1) * 100 - 50) / 5))); }
  function parseCode(raw) {
    const blocks = String(raw).trim().split(/\s+/).filter(Boolean);
    const next = {}; let bad = 0;
    for (let n = 0; n < 24; n++) {
      if (n >= blocks.length) continue;
      const b = blocks[n];
      if (b === '0' || b === '0/0') continue;
      const arr = [];
      for (const blk of b.split('-')) {
        if (!blk || blk === '0') continue;
        let spec = blk, opPart = null;
        const pipe = blk.indexOf('|');
        if (pipe >= 0) { spec = blk.slice(0, pipe); opPart = blk.slice(pipe + 1); }
        if (opPart !== null && !/^\d{1,2}$/.test(opPart)) { bad++; continue; }
        const layer = {};
        if (opPart !== null) layer.opacity = opFromCode(opPart);
        const parts2 = spec.split('/');
        if (parts2.length > 1) {
          if (!/^\d+$/.test(parts2[0]) || !/^\d+$/.test(parts2[1])) { bad++; continue; }
          layer.id = parts2[0]; layer.colour = parts2[1];
          if (+parts2[0] === 0 && +parts2[1] === 0) continue;
        } else {
          if (!/^\d+$/.test(spec)) { bad++; continue; }
          layer.colour = spec;
          if (+spec === 0) continue;
        }
        arr.push(layer);
      }
      if (arr.length) next[n] = arr;
    }
    if (blocks.length > 24) bad += blocks.length - 24;
    return { state: next, bad };
  }
  function encodeState(state) {
    const blocks = [];
    for (let n = 0; n < 24; n++) {
      const L = state[n] || [];
      const lines = [];
      for (const ly of L) {
        let line;
        if (ly.id === undefined || ly.id === null) line = String(ly.colour);
        else line = String(ly.id) + '/' + String(ly.colour);
        const p = opToCode(ly.opacity);
        if (p < 10) line += '|' + p;
        lines.push(line);
      }
      blocks.push(lines.length ? lines.join('-') : '0');
    }
    return blocks.join(' ');
  }

  let meta = null;
  const imgCache = {};
  const cache = new Map(); // (build|key|sig) -> canvas

  function layerFile(build, key, layer) {
    return 'gray/' + build + '/' + key + '_' + layer + '.png';
  }
  function getImage(src) {
    if (imgCache[src] !== undefined) return imgCache[src];
    const im = new Image();
    im.onerror = function () { imgCache[src] = null; };
    im.src = src;
    imgCache[src] = im;
    return im;
  }
  function ready(src) {
    const im = getImage(src);
    if (im === null) return Promise.reject(new Error('нет файла: ' + src));
    if (im.complete && im.naturalWidth > 0) return Promise.resolve(im);
    return new Promise(function (res, rej) {
      im.onload = function () { res(im); };
      im.onerror = function () { imgCache[src] = null; rej(new Error('нет файла: ' + src)); };
    });
  }
  function loadFrame(build, key) {
    const need = FUR_LAYERS.map(L => layerFile(build, key, L)).concat([layerFile(build, key, 'protect')]);
    return Promise.all(need.map(ready));
  }

  // цвета зон из parsed-state: слот зоны — meta.slotColour (tail=15, уши=17, тело=0)
  function zoneSlots() { return meta ? meta.slotColour : { tail: 15, earL: 17, earR: 17, body: 0, head: 0, foreL: 0, foreR: 0, hindL: 0, hindR: 0, chest: 0, belly: 0 }; }

  function layerStack(state, slot) {
    return state && state[slot] ? state[slot] : null;
  }

  // рендер кадра: строит (или берёт из кеша) canvas 100×150
  function renderFrame(build, key, state, solid) {
    const sig = signature(build, key, state, solid);
    if (cache.has(sig)) return cache.get(sig);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const cc = c.getContext('2d');
    const layersImgs = {};
    for (const L of FUR_LAYERS) {
      const im = getImage(layerFile(build, key, L));
      if (!im || !imgCachedOk(im)) { return null; } // кадр ещё грузится
      layersImgs[L] = im;
    }
    const prot = getImage(layerFile(build, key, 'protect'));
    if (!imgCachedOk(prot)) return null;
    const buf = document.createElement('canvas'); buf.width = W; buf.height = H;
    const bctx = buf.getContext('2d');
    const zslots = zoneSlots();
    let missing = 0;
    for (const L of FUR_LAYERS) {
      const slot = zslots[L];
      const stack = solid ? [{ _hex: solid, opacity: 1 }] : layerStack(state, slot);
      if (!stack) { missing++; continue; } // слот в коде пуст: зона не красится (CatWar: '0' = не рисовать)
      bctx.clearRect(0, 0, W, H);
      for (let i = stack.length - 1; i >= 0; i--) {
        const st = stack[i];
        const hex = st._hex || hexOf(0, st.colour);
        if (!hex) continue;
        const op = st.opacity === undefined ? 1 : st.opacity;
        bctx.globalCompositeOperation = 'source-over';
        bctx.globalAlpha = 1;
        bctx.fillStyle = hex;
        bctx.fillRect(0, 0, W, H);
        bctx.globalCompositeOperation = 'multiply';
        bctx.drawImage(layersImgs[L], 0, 0);
        bctx.globalCompositeOperation = 'destination-in';
        bctx.drawImage(layersImgs[L], 0, 0);
        bctx.globalCompositeOperation = 'source-over';
        bctx.globalAlpha = op;
        cc.drawImage(buf, 0, 0); // зона на выход (стек: первый слой блока — СВЕРХУ)
        bctx.globalAlpha = 1;
      }
    }
    cc.drawImage(prot, 0, 0); // protect поверх: глаза/нос/раковины — без тонировки
    cache.set(sig, c);
    return c;
  }
  function imgCachedOk(im) { return im && im.complete && im.naturalWidth > 0; }
  function signature(build, key, state, solid) {
    if (solid) return build + '|' + key + '|' + solid;
    const parts = [];
    for (const slot of [0, 15, 16, 17, 18]) {
      const L = state && state[slot];
      if (L) parts.push(slot + ':' + L.map(x => (x.id !== undefined ? x.id + '/' : '') + x.colour + '|' + opToCode(x.opacity)).join('-'));
    }
    return build + '|' + key + '|' + parts.join(';');
  }

  const api = {
    W: W, H: H,
    parseCode: parseCode,
    encodeState: encodeState,
    hexOf: hexOf,
    cacheSize: function () { return cache.size; },
    init: function () {
      return fetch('gray/tint_meta.json').then(r => r.json()).then(m => {
        meta = m;
        if (meta.medianLumTarget !== undefined) { /* K уже запечён в серые текстуры */ }
        return api;
      });
    },
    // frameKey: '0' sit | '1'..'4' | 'N0'..'N3' | 'S0'..'S3' | 'E0'..'E3' | 'W0'..'W3'
    normKey: function (pose, dir, k) {
      if (pose === 'sit' || pose === '0') return '0';
      const d = (dir || 'E').toUpperCase();
      if (d === 'E') return String((k % 4) + 1);
      return d + (k % 4);
    },
    isMirror: function (dir) { return String(dir || 'E').toUpperCase() === 'W'; },
    // главный вызов: state ИЛИ solid; при state({}) = дефолтный золотистый id 18
    render: function (canvasEl, opts) {
      const o = opts || {};
      const build = o.build || 'norm';
      const key = o.key ? String(o.key) : api.normKey(o.pose || 'sit', o.dir, o.frame || 0);
      let state = o.state, solid = o.solid || null;
      if (!state && !solid) state = DEFAULT_COAT();
      const c = renderFrame(build, key, state, solid);
      if (!c) return false;
      const t = canvasEl.getContext('2d');
      const scale = o.scale || 1;
      t.imageSmoothingEnabled = false;
      t.clearRect(0, 0, canvasEl.width, canvasEl.height);
      t.save();
      t.scale(scale, scale);
      if (api.isMirror(o.dir)) { t.translate(W, 0); t.scale(-1, 1); } // W = зеркало E (файлы-зеркала не хранят дублем)
      t.drawImage(c, 0, 0);
      t.restore();
      return true;
    },
    onFrameReady: function (build, key) { return loadFrame(build, key); },
    // дом-функции для демо/тестов
    _layers: FUR_LAYERS
  };

  function DEFAULT_COAT() {
    return { 0: [{ id: 1, colour: 18, opacity: 1 }], 15: [{ id: 6, colour: 18, opacity: 1 }], 17: [{ id: 3, colour: 18, opacity: 1 }] };
  }

  global.Tint = api;
})(typeof window !== 'undefined' ? window : this);
