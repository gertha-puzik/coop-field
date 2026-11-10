/**
 * Окрас по коду CatWar (#84 волна 3): клиентский конвейер «код → котик → PNG»
 * для зоны «Свой окрас» профиля (∂ src/lib/paint — как paint-механика симулятора).
 *
 * Игрок вставляет текстовый код окраса из конструктора KNS (kns.miew.ru) —
 * тот самый, что работает на catwar.su. Движок рендера — vendor-копия
 * public/catwar/tint.js (IIFE-глобал window.Tint, байт-в-байт из репо kns;
 * канон и sha-гейт — scripts/check-catwar-vendor.mjs), маски — public/catwar/gray/.
 * Серверный путь не меняется: PNG уходит существующим POST /sprites/mine
 * (http-my-sprites.ts), как у файловой загрузки и редактора KNS Paint.
 *
 * Изоляция §10.4: модуль НЕ импортируется статически — компонент зоны
 * «Свой окрас» тянет его динамическим import() при первом действии игрока,
 * гроттовый/симуляторный бандл/vendor-каталог его не содержат (prune-export
 * вырезает public/catwar из www-grotto). Скрипты движка подключаются
 * <script> только в момент первого обращения.
 *
 * Геометрия кадра: CatWar 100×150, сид-кадр '0'; кроп по силуэту с паддингом
 * 2px слева/сверху/справа, 0 снизу (принцип silhouetteBBox-кропа редактора
 * KNS Paint); если сторона кропа меньше серверного минимума 100 px —
 * Integer-апскейл ближайшим соседом (пиксель-арт, детерминизм сохранён).
 */

/** Кадр CatWar: 100×150, сид «0» (модельные константы движка). */
const FRAME_W = 100;
const FRAME_H = 150;
/** Паддинг кропа: сверху-сбоку дают «воздух», снизу 0 — лапы у кромки. */
const PAD_XY = 2;
/** Сервер /sprites/mine: сторона PNG 100–1000 — минимум отсюда. */
const MIN_SIDE = 100;
/** Корень vendor-копии движка (public/catwar — маршрут статики). */
const CATWAR_ROOT = "/catwar";

/** Слой кода окраса (грамматика CatWar — разбор из vendor tint.js). */
export type CatwarLayer = { id?: string; colour: string; opacity?: number };
/** Состояние окраса: слот → стек слоёв (первый слой блока ложится сверху). */
export type CatwarState = Record<number, CatwarLayer[]>;

/** Публичный API window.Tint (vendor public/catwar/tint.js — глобал IIFE). */
type TintApi = {
  W: number;
  H: number;
  parseCode(raw: string): { state: CatwarState; bad: number };
  encodeState(state: CatwarState): string;
  hexOf(palette: number, id: string | number): string | null;
  init(): Promise<TintApi>;
  render(canvas: HTMLCanvasElement, opts: Record<string, unknown>): boolean;
  onFrameReady(build: string, key: string): Promise<unknown>;
};

/**
 * Слоты, которые красит M2-тонировка (gray/tint_meta.json slotColour):
 * 0 — основа/тело, 15 — хвост, 17 — уши. Глаза/нос/раковины — protect-слой,
 * полноцветные CatWar-элементы на паре M2 ещё не отрисованы (этап KNS §47) —
 * поэтому код без этих слотов красить нечего («нет основных зон окраса»).
 */
const COAT_SLOTS = [0, 15, 17] as const;

/** Причина отказа конвейера (UI переводит каждую в человеческий текст). */
export type CatwarFailReason = "bad_syntax" | "no_coat_zones" | "engine_unavailable";

export type CatwarParse = { ok: true; state: CatwarState } | { ok: false; reason: CatwarFailReason };

let enginePromise: Promise<TintApi> | null = null;

/**
 * tint.js Резолвит свои ассеты ОТНОСИТЕЛЬНО АДРЕСА СТРАНИЦЫ ('gray/…',
 * fetch('gray/tint_meta.json')) — на /players/ это не /catwar/. Копию править
 * нельзя (байт-в-байт из kns), поэтому шимим точечно: переписываем только
 * строки с префиксом 'gray/' — остальные fetch/Image проходят насквозь.
 * Устанавливается один раз вместе с движком, живёт страницу профиля.
 */
function installVendorUrlShims(): void {
  if (typeof window === "undefined") return;
  const w = window as Window & { __catwarShims?: boolean };
  if (w.__catwarShims) return;
  w.__catwarShims = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    nativeFetch(
      typeof input === "string" && input.startsWith("gray/") ? `${CATWAR_ROOT}/${input}` : input,
      init,
    )) as typeof fetch;

  const NativeImage = window.Image;
  const srcDesc =
    Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src") ?? null;
  // Function-конструктор с own-accessor 'src': «new Image()» в tint.js получает
  // настоящий <img>, но запись src перехватываем только для 'gray/'-путей;
  // чтение возвращает исходное значение (ключи кеша tint.js — как в оригинале).
  function CatwarImage(): HTMLImageElement {
    const el = new NativeImage();
    let raw = "";
    Object.defineProperty(el, "src", {
      configurable: true,
      get() {
        return raw;
      },
      set(v: string) {
        raw = String(v);
        const resolved = raw.startsWith("gray/") ? `${CATWAR_ROOT}/${raw}` : raw;
        if (srcDesc?.set) srcDesc.set.call(el, resolved);
      },
    });
    return el;
  }
  window.Image = CatwarImage as unknown as typeof Image; // own-«src» обёртка, не конструктор-подкласс
}

/** Динамический <script> с промисом (порядок манифест → движок обязателен). */
function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = false; // сохраняем порядок на фоне параллельных подключений
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`не загрузился ${src}`));
    document.head.appendChild(el);
  });
}

/**
 * Ленивая загрузка движка: шимы → catwar-manifest.js (палитры дампа) →
 * tint.js → Tint.init(). Кешится: повторные клики не инжектят повторно.
 */
export async function loadCatwarEngine(): Promise<TintApi> {
  if (enginePromise) return enginePromise;
  enginePromise = (async () => {
    installVendorUrlShims();
    const w = window as Window & { Tint?: TintApi };
    if (!w.Tint) {
      await injectScript(`${CATWAR_ROOT}/catwar-manifest.js`);
      await injectScript(`${CATWAR_ROOT}/tint.js`);
    }
    if (!w.Tint) throw new Error("движок окраса не инициализировался");
    await w.Tint.init();
    return w.Tint;
  })();
  try {
    return await enginePromise;
  } catch (err) {
    enginePromise = null; // сетевой сбой — даём повторить с чистого листа
    throw err;
  }
}

/**
 * Разбор кода по грамматике vendor tint.js: синтаксис + наличие главных
 * зон окраса. Грамматику не выдумываем — parseCode байт-в-байт из kns.
 */
export async function parseCatwarCode(raw: string): Promise<CatwarParse> {
  let Tint: TintApi;
  try {
    Tint = await loadCatwarEngine();
  } catch {
    return { ok: false, reason: "engine_unavailable" };
  }
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, reason: "bad_syntax" };
  let parsed: { state: CatwarState; bad: number };
  try {
    parsed = Tint.parseCode(trimmed);
  } catch {
    return { ok: false, reason: "bad_syntax" };
  }
  if (parsed.bad > 0) return { ok: false, reason: "bad_syntax" };
  const hasCoat = COAT_SLOTS.some((slot) => (parsed.state[slot] ?? []).length > 0);
  if (!hasCoat) return { ok: false, reason: "no_coat_zones" };
  // Грамматика CatWar допускает любой номер цвета, но палитра дампа — 24: код,
  // где НИ ОДНА зона не берёт известный цвет, отрисует пустого кота — гасим здесь.
  const hasKnownColor = COAT_SLOTS.some((slot) =>
    (parsed.state[slot] ?? []).some((layer) => Tint.hexOf(0, layer.colour) !== null),
  );
  if (!hasKnownColor) return { ok: false, reason: "no_coat_zones" };
  return { ok: true, state: parsed.state };
}

/** Кроп-прямоугольник по силуэту (alpha>0) с паддингом — как у редактора KNS. */
function silhouetteCrop(w: number, h: number, data: Uint8ClampedArray) {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null; // пустой кадр — красить было нечего
  const cx0 = Math.max(0, x0 - PAD_XY);
  const cy0 = Math.max(0, y0 - PAD_XY);
  const cx1 = Math.min(w, x1 + 1 + PAD_XY);
  const cy1 = Math.min(h, y1 + 1); // снизу 0: лапы у нижней кромки кадра
  return { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
}

/** Отказ рендера (thrown) → машинная причина (превью и сохранение в один словарь). */
function failReasonOf(err: unknown): CatwarFailReason {
  const msg = err instanceof Error ? err.message : "";
  if (msg === "bad_syntax") return "bad_syntax";
  if (msg === "no_coat_zones" || msg === "empty_silhouette") return "no_coat_zones";
  return "engine_unavailable";
}

export type CatwarCoatPng = {
  /** PNG с котиком (готов к POST /sprites/mine). */
  blob: Blob;
  width: number;
  height: number;
};

/**
 * Код → сид-кадр '0' (100×150) → кроп по силуэту → при тонком силуэте
 * integer-апскейл NEAREST до серверного минимума стороны 100 px → PNG-blob.
 * Детерминизм: одинаковый код + одинаковые маски → одинаковые байты.
 */
export async function catwarCoatPng(raw: string): Promise<CatwarCoatPng> {
  const coat = await renderCoatCanvas(raw);
  const blob = await new Promise<Blob | null>((resolve) => coat.canvas.toBlob(resolve, "image/png"));
  if (!blob || blob.size === 0) throw new Error("engine_unavailable");
  return { blob, width: coat.canvas.width, height: coat.canvas.height };
}

/** Рендер и кроп без кодирования: общая база для превью и PNG-экспорта. */
async function renderCoatCanvas(raw: string): Promise<{ canvas: HTMLCanvasElement }> {
  const parsed = await parseCatwarCode(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  const Tint = await loadCatwarEngine();
  await Tint.onFrameReady("norm", "0");

  const frame = document.createElement("canvas");
  frame.width = FRAME_W;
  frame.height = FRAME_H;
  if (!Tint.render(frame, { build: "norm", key: "0", state: parsed.state })) {
    throw new Error("engine_unavailable");
  }
  const ctx = frame.getContext("2d");
  const shot = ctx?.getImageData(0, 0, FRAME_W, FRAME_H) ?? null;
  const crop = shot ? silhouetteCrop(FRAME_W, FRAME_H, shot.data) : null;
  if (!crop) throw new Error("empty_silhouette"); // красить нечего — код без зон окраса

  const k = Math.max(1, Math.ceil(MIN_SIDE / Math.min(crop.w, crop.h)));
  const out = document.createElement("canvas");
  out.width = crop.w * k;
  out.height = crop.h * k;
  const octx = out.getContext("2d");
  if (!octx) throw new Error("engine_unavailable");
  octx.imageSmoothingEnabled = false; // NEAREST — пиксель-арт без размытия
  octx.drawImage(frame, crop.x, crop.y, crop.w, crop.h, 0, 0, out.width, out.height);
  return { canvas: out };
}

export type CatwarPreviewResult =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: CatwarFailReason };

/**
 * Живое превью в канве вызывающего: силуэт кропа якорем НИЗ-ЦЕНТР, пропорции
 * сохранены, не растягиваем — при маленькой канве чистый даунскейл, апскейла нет.
 */
export async function drawCatwarPreview(canvas: HTMLCanvasElement, raw: string): Promise<CatwarPreviewResult> {
  let coat: { canvas: HTMLCanvasElement };
  try {
    coat = await renderCoatCanvas(raw);
  } catch (err) {
    return { ok: false, reason: failReasonOf(err) };
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, reason: "engine_unavailable" };
  const cw = coat.canvas.width;
  const chh = coat.canvas.height;
  const scale = Math.min(1, canvas.width / cw, canvas.height / chh);
  const dw = Math.round(cw * scale);
  const dh = Math.round(chh * scale);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = scale < 1; // 1:1 и крупнее — честный NEAREST пиксель-арта
  ctx.drawImage(coat.canvas, (canvas.width - dw) >> 1, canvas.height - dh, dw, dh);
  return { ok: true, width: cw, height: chh };
}
