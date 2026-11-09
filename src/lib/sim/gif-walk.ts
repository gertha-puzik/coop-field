/**
 * Пробная GIF-анимация ходьбы (первый анимированный скин — test1): кадры
 * Animated GIF декодируются в браузере WebCodecs-классом ImageDecoder
 * (Chrome/Edge/Opera; Safari/Firefox класса не имеют) — каждый кадр переносится
 * на собственный канвас один раз при загрузке, игровой цикл затем просто
 * выбирает кадр по времени (walkFrameAt). Ресурс — обычная статика
 * /sprites/<id>-walk.gif, без новых зависимостей и без сборки спрайт-листов.
 *
 * Грейсфолбэк: где ImageDecoder нет (или GIF битый) — записи в кэше просто не
 * появляется, и скин рисуется статичным PNG ровно как раньше; анимация —
 * строго улучшение поверх текущей картинки, поломок быть не может.
 * Направление (flip) кадрам не нужно: кадры проходят тот же drawChar, что и
 * статичный спрайт — зеркалит его существующая механика «смотрят влево».
 */

/** Раскодированный GIF ходьбы: кадры-канвасы + длительности (мс) по кадрам. */
export interface WalkGif {
  frames: HTMLCanvasElement[];
  /** Длительность показа каждого кадра, мс (из GIF; без метки — 100 мс). */
  durations: number[];
  /** Сумма durations — полный цикл. */
  total: number;
}

/** Узкие структурные типы поверх WebCodecs: не зависят от версии lib.dom. */
interface GifVideoFrameLike {
  displayWidth: number;
  displayHeight: number;
  /** Микросекунды показа кадра; у части кодеков null. */
  duration: number | null;
  close(): void;
}

interface GifImageDecoderLike {
  tracks: {
    ready: Promise<unknown>;
    selectedTrack: { frameCount?: number } | null;
  };
  /** Резолвится, когда весь файл декодирован — после него frameCount достоверен. */
  completed: Promise<unknown>;
  decode(options: { frameIndex: number }): Promise<{ image: GifVideoFrameLike }>;
}

type GifImageDecoderCtor = new (init: {
  data: AllowSharedBufferSource;
  type: string;
}) => GifImageDecoderLike;

/** Конструктор ImageDecoder или null (браузер без WebCodecs ImageDecoder). */
function imageDecoderCtor(): GifImageDecoderCtor | null {
  const g = globalThis as { ImageDecoder?: GifImageDecoderCtor };
  return typeof g.ImageDecoder === "function" ? g.ImageDecoder : null;
}

/** Длительность кадра в мс: из GIF (µs → мс) или дефолт 100. */
function frameDurationMs(frame: GifVideoFrameLike): number {
  const ms = frame.duration != null ? frame.duration / 1000 : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : 100;
}

/**
 * Раскодировать Animated GIF в кадры-канвасы. Бросает исключение, если
 * ImageDecoder нет или GIF не читается — вызывающий код решает фолбэк.
 * Каждый VideoFrame немедленно переносится на канвас и закрывается
 * (VideoFrame держит память декодера — жить дольше переноса нельзя).
 */
export async function decodeGifFrames(data: ArrayBuffer): Promise<WalkGif> {
  const Ctor = imageDecoderCtor();
  if (!Ctor) throw new Error("ImageDecoder недоступен — фолбэк на статичный спрайт");
  const decoder = new Ctor({ data, type: "image/gif" });
  await decoder.tracks.ready;
  await decoder.completed;
  const count = decoder.tracks.selectedTrack?.frameCount ?? 0;
  if (!Number.isFinite(count) || count <= 0) throw new Error("GIF без кадров");
  const frames: HTMLCanvasElement[] = [];
  const durations: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const { image } = await decoder.decode({ frameIndex: i });
    const canvas = document.createElement("canvas");
    canvas.width = image.displayWidth;
    canvas.height = image.displayHeight;
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(image as unknown as CanvasImageSource, 0, 0);
    const ms = frameDurationMs(image);
    image.close();
    frames.push(canvas);
    durations.push(ms);
  }
  const total = durations.reduce((sum, ms) => sum + ms, 0);
  if (!total) throw new Error("GIF нулевой длительности");
  return { frames, durations, total };
}

/** Фаза цикла конкретного кота: разные коты идут не в ногу (хэш id), чтобы
 *  два test1 рядом не двигали лапами синхронно. Детерминирован — и свой,
 *  и чужие коты считают одну фазу из локальных часов + seed. */
export function walkPhaseOf(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 9973;
  return hash;
}

/** Кадр для показа в момент nowMs: таймлайн цикла с фазой конкретного кота.
 *  Чистая функция над временем — без состояния, кадр всегда детерминирован. */
export function walkFrameAt(walk: WalkGif, nowMs: number, phase: number): HTMLCanvasElement {
  const t = (((nowMs + phase) % walk.total) + walk.total) % walk.total;
  let acc = 0;
  for (let i = 0; i < framesCount(walk); i += 1) {
    acc += walk.durations[i];
    if (t < acc) return walk.frames[i];
  }
  return walk.frames[walk.frames.length - 1];
}

function framesCount(walk: WalkGif): number {
  return Math.min(walk.frames.length, walk.durations.length);
}
