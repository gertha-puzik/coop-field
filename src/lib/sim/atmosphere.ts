/**
 * Атмосфера поля: тени облаков и дождь — PixiJS-слой поверх игрового холста,
 * цветокоррекция времени суток — композиторный фильтр на самом мировом холсте.
 *
 * Как устроено. Игровой цикл по-прежнему рисует весь мир (и HUD, и редактор)
 * на обычном 2D-канвасе. Канвас остаётся на экране как есть, а поверх него
 * живёт прозрачный Pixi-слой с облаками и дождём. Цветокоррекция (утро/день/
 * вечер/ночь — та же матрица 5×4, что раньше гонялась через ColorMatrixFilter)
 * применяется к мировому холству через CSS `filter: url(#feColorMatrix)` —
 * её считает композитор на GPU, без единого байта копирования.
 *
 * Почему мир больше не заливается в Pixi текстурой: прежняя схема каждый кадр
 * делала texImage2D всего холста (на ретине — десятки мегабайт за кадр) плюс
 * полноэкранный проход фильтра — на слабых машинах это и было «сильным лагом».
 * Теперь пересылаемого ноль: мир рисуется один раз обычным канвасом, тонировка
 * и частицы — дешёвые надстройки. Вид картинки не меняется: матрица та же.
 *
 * Время суток и погода комнаты — общие для всех игроков (состояние комнаты,
 * событие «atmo»), но сам этот модуль про сеть ничего не знает: ему говорят
 * setDaypart/setWeather, а дальше он плавно едет к нужной картинке.
 *
 * Если WebGL недоступен, Atmosphere.create отклонится — игра просто останется
 * на прежнем 2D-канвасе: без облаков и дождя, но цветокоррекция (CSS-фильтр)
 * продолжит работать — она WebGL не требует.
 */

import { Application, Container, Sprite, Texture } from 'pixi.js';
import type { ColorMatrix } from 'pixi.js';
import type { DayPart, WeatherKind } from './settings';

/** Параметры картинки: цветовые усиления каналов, насыщенность, яркость. */
interface Grade {
  gain: [number, number, number];
  sat: number;
  bright: number;
}

/** Профиль погоды: плотность/скорость теней облаков, их цвет и сила дождя. */
interface CloudProfile {
  cloudCount: number;
  cloudAlpha: number;
  cloudSpeed: number;
  cloudTint: [number, number, number];
  rain: number;
}

type AtmoProfile = Grade & CloudProfile;

/** Порядок частей суток в цикле: утро → день → вечер → ночь → утро… */
const DAYPART_KEYS: DayPart[] = ['morning', 'day', 'evening', 'night'];

/** Базовые пресеты времени суток (умножаются на пресет погоды). */
const DAYPART_PROFILE: Record<DayPart, AtmoProfile> = {
  morning: { gain: [1.06, 1.0, 0.93], sat: 1.05, bright: 1.03, cloudCount: 4, cloudAlpha: 0.06, cloudSpeed: 10, cloudTint: [0.4, 0.46, 0.6], rain: 0 },
  day:     { gain: [1.0, 1.0, 1.0],   sat: 1.0,  bright: 1.0,  cloudCount: 5, cloudAlpha: 0.07, cloudSpeed: 14, cloudTint: [0.36, 0.42, 0.58], rain: 0 },
  evening: { gain: [1.1, 0.87, 0.74], sat: 1.03, bright: 0.9,  cloudCount: 6, cloudAlpha: 0.1,  cloudSpeed: 12, cloudTint: [0.32, 0.32, 0.46], rain: 0 },
  night:   { gain: [0.64, 0.72, 1.05], sat: 0.85, bright: 0.64, cloudCount: 7, cloudAlpha: 0.12, cloudSpeed: 18, cloudTint: [0.24, 0.28, 0.42], rain: 0 },
};

/** Пресеты погоды (тени облаков и дождь — целиком погодные параметры).
 *  Солнечно — небо ЧИСТОЕ: ни облаков, ни дождя, ничего не «наложено» на поле;
 *  тени облаков принадлежат только пасмурной погоде и дождю. */
const WEATHER_PROFILE: Record<WeatherKind, AtmoProfile> = {
  sun:   { gain: [1.02, 1.01, 0.99], sat: 1.05, bright: 1.04, cloudCount: 0,  cloudAlpha: 0,    cloudSpeed: 10, cloudTint: [0.42, 0.48, 0.62], rain: 0 },
  cloud: { gain: [0.98, 1.0, 1.04],  sat: 0.84, bright: 0.9,  cloudCount: 10, cloudAlpha: 0.13, cloudSpeed: 22, cloudTint: [0.3, 0.35, 0.48], rain: 0 },
  rain:  { gain: [0.92, 0.97, 1.06], sat: 0.62, bright: 0.78, cloudCount: 14, cloudAlpha: 0.18, cloudSpeed: 32, cloudTint: [0.22, 0.26, 0.38], rain: 1 },
};

/** Текущее (сглаживаемое) состояние атмосферы. */
interface AtmoState {
  gain: [number, number, number];
  sat: number;
  bright: number;
  cloudCount: number;
  cloudAlpha: number;
  cloudSpeed: number;
  cloudTint: [number, number, number];
  rain: number;
}

function stateOf(p: AtmoProfile): AtmoState {
  return { gain: [...p.gain], sat: p.sat, bright: p.bright, cloudCount: p.cloudCount, cloudAlpha: p.cloudAlpha, cloudSpeed: p.cloudSpeed, cloudTint: [...p.cloudTint], rain: p.rain };
}

function combine(dp: AtmoProfile, w: AtmoProfile): AtmoProfile {
  return {
    gain: [dp.gain[0] * w.gain[0], dp.gain[1] * w.gain[1], dp.gain[2] * w.gain[2]],
    sat: dp.sat * w.sat,
    bright: dp.bright * w.bright,
    // Облака — погодный параметр, но ночью тени темнее (умножаем на яркость времени суток).
    cloudCount: w.cloudCount,
    cloudAlpha: w.cloudAlpha,
    cloudSpeed: w.cloudSpeed,
    cloudTint: [w.cloudTint[0] * dp.bright, w.cloudTint[1] * dp.bright, w.cloudTint[2] * dp.bright],
    rain: w.rain,
  };
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
/** Плавный переход 0→1: медленный старт, ровная середина, мягкая посадка. */
const smoothstep = (t: number) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

/** Смесь двух профилей (k: 0 — a, 1 — b) — так сутки перетекают друг в друга. */
function mixProfiles(a: AtmoProfile, b: AtmoProfile, k: number): AtmoProfile {
  return {
    gain: [lerp(a.gain[0], b.gain[0], k), lerp(a.gain[1], b.gain[1], k), lerp(a.gain[2], b.gain[2], k)],
    sat: lerp(a.sat, b.sat, k),
    bright: lerp(a.bright, b.bright, k),
    cloudCount: lerp(a.cloudCount, b.cloudCount, k),
    cloudAlpha: lerp(a.cloudAlpha, b.cloudAlpha, k),
    cloudSpeed: lerp(a.cloudSpeed, b.cloudSpeed, k),
    cloudTint: [lerp(a.cloudTint[0], b.cloudTint[0], k), lerp(a.cloudTint[1], b.cloudTint[1], k), lerp(a.cloudTint[2], b.cloudTint[2], k)],
    rain: lerp(a.rain, b.rain, k),
  };
}

/** Матрица ColorMatrix: насыщенность × усиления каналов × яркость.
 *  Формат 5×4 один в один с feColorMatrix (SVG) — та же математика, что была
 *  у ColorMatrixFilter Pixi. */
function gradeToMatrix(g: AtmoState): ColorMatrix {
  const L = [0.213, 0.715, 0.072];
  const s = Math.max(0, Math.min(2, g.sat));
  const gain = [g.gain[0] * g.bright, g.gain[1] * g.bright, g.gain[2] * g.bright];
  const m = new Array<number>(20).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      m[r * 5 + c] = (L[c] * (1 - s) + (c === r ? s : 0)) * gain[c];
    }
  }
  m[15] = 1; // альфа без изменений
  return m as unknown as ColorMatrix;
}

/** Мягкое пятно-тень облака: белый радиальный градиент, цвет задаёт tint. */
function makeBlobTexture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 160;
  c.height = 160;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(80, 80, 6, 80, 80, 78);
    grad.addColorStop(0, 'rgba(255,255,255,0.66)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.36)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 160, 160);
  }
  return c;
}

/** Капля дождя: вертикальный штрих, ярче в середине. */
function makeDropTexture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 22;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createLinearGradient(0, 0, 0, 22);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.5, 'rgba(224,238,255,0.9)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 4, 22);
  }
  return c;
}

const CLOUD_MAX = 14;
const RAIN_MAX = 150;
/** Запас за краями экрана, чтобы облака/капли появлялись мягко. */
const WRAP_MARGIN = 170;

interface CloudBlob {
  spr: Sprite;
  x: number;
  y: number;
  scale: number;
  jitter: number;
  speedJ: number;
}

interface RainDrop {
  spr: Sprite;
  x: number;
  y: number;
  speedJ: number;
}

export class Atmosphere {
  private app: Application | null = null;
  private cloudC: Container | null = null;
  private rainC: Container | null = null;
  private clouds: CloudBlob[] = [];
  private drops: RainDrop[] = [];
  private dropTex: Texture | null = null;

  private cur: AtmoState = stateOf(combine(DAYPART_PROFILE.day, WEATHER_PROFILE.sun));
  private target: AtmoState = stateOf(combine(DAYPART_PROFILE.day, WEATHER_PROFILE.sun));

  /** Непрерывное время суток 0..4 (0 — утро, 1 — день, 2 — вечер, 3 — ночь).
   *  Дробная часть — позиция внутри части суток: цикл едет сам, картинка
   *  перетекает без щелчков. */
  private dayP = 1.5;

  private wKind: WeatherKind = 'sun';

  private w = 0;
  private h = 0;
  private dpr = 1;
  /** Видимость слоя: выключается дебаг-тумблером — слой прячется и не рендерится. */
  private visible = true;

  /** CSS-фильтр цветокоррекции мирового холста (feColorMatrix в скрытом SVG). */
  private filterId = `catwar-atmo-${Math.random().toString(36).slice(2, 8)}`;
  private svgEl: SVGSVGElement | null = null;
  private feNode: SVGFEColorMatrixElement | null = null;
  private lastMatrix = '';

  private constructor(private view: HTMLCanvasElement, private world: HTMLCanvasElement) {}

  /** Создаёт Pixi-приложение на готовом canvas-элементе. Отклоняется без WebGL. */
  static async create(view: HTMLCanvasElement, world: HTMLCanvasElement): Promise<Atmosphere> {
    const a = new Atmosphere(view, world);
    await a.init();
    if (typeof window !== 'undefined') {
      (window as unknown as { __atmo?: Atmosphere }).__atmo = a; // отладка: живое состояние слоя
    }
    return a;
  }

  private async init(): Promise<void> {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const app = new Application();
    await app.init({
      canvas: this.view,
      // Размер — с мирового холста: у Pixi-канваса autoDensity сразу пишет
      // инлайн-стиль width/height, и его clientWidth после этого врёт.
      width: Math.max(1, this.world.clientWidth || 800),
      height: Math.max(1, this.world.clientHeight || 600),
      backgroundAlpha: 0,
      antialias: false,
      resolution: this.dpr,
      autoDensity: true,
      autoStart: false,
      preference: 'webgl',
      clearBeforeRender: true,
    });
    this.app = app;

    // Тени облаков.
    this.cloudC = new Container();
    const blobTex = Texture.from(makeBlobTexture());
    for (let i = 0; i < CLOUD_MAX; i++) {
      const s = new Sprite(blobTex);
      s.anchor.set(0.5);
      this.cloudC.addChild(s);
      this.clouds.push({
        spr: s,
        x: Math.random(),
        y: Math.random(),
        scale: 1.7 + Math.random() * 1.8,
        jitter: 0.6 + Math.random() * 0.4,
        speedJ: 0.75 + Math.random() * 0.6,
      });
    }

    // Дождь.
    this.rainC = new Container();
    this.dropTex = Texture.from(makeDropTexture());
    const dropRot = Math.atan2(-135, 1150);
    for (let i = 0; i < RAIN_MAX; i++) {
      const s = new Sprite(this.dropTex);
      s.anchor.set(0.5);
      s.rotation = dropRot;
      s.alpha = 0.24 + Math.random() * 0.2;
      s.scale.set(0.8 + Math.random() * 0.55);
      this.rainC.addChild(s);
      this.drops.push({ spr: s, x: Math.random(), y: Math.random(), speedJ: 0.85 + Math.random() * 0.4 });
    }
    this.rainC.visible = false;

    app.stage.addChild(this.cloudC, this.rainC);
    this.w = 0;
    this.h = 0;
    this.ensureGradeFilter();
  }

  /**
   * Цветокоррекция мирового холста: скрытый SVG с feColorMatrix + CSS-фильтр
   * url(#…) на элементе канваса. Матрица та же, что раньше считал
   * ColorMatrixFilter Pixi поверх залитой в GPU текстуры мира, — только теперь
   * её применяет композитор, без копирования холста в видеокарту каждый кадр.
   */
  private ensureGradeFilter(): void {
    if (this.svgEl || typeof document === 'undefined') return;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.position = 'absolute';
    const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', this.filterId);
    filter.setAttribute('color-interpolation-filters', 'sRGB');
    const fe = document.createElementNS('http://www.w3.org/2000/svg', 'feColorMatrix');
    fe.setAttribute('type', 'matrix');
    fe.setAttribute('values', '');
    filter.appendChild(fe);
    svg.appendChild(filter);
    document.body.appendChild(svg);
    this.svgEl = svg;
    this.feNode = fe;
    this.world.style.filter = `url(#${this.filterId})`;
  }

  /** Текущая матрица строкой (с квантованием) — чтобы не дёргать DOM каждый кадр. */
  private applyGradeMatrix(m: ColorMatrix): void {
    if (!this.feNode) return;
    let out = '';
    for (let i = 0; i < 20; i++) out += `${Math.round((m[i] ?? 0) * 10000) / 10000} `;
    if (out !== this.lastMatrix) {
      this.lastMatrix = out;
      this.feNode.setAttribute('values', out);
    }
  }

  /**
   * Показать/спрятать слой. Дебаг-тумблер: слой выключается локально у одного
   * клиента (например, чтобы сравнить поле с тонировкой и без). HUD часов и
   * погоды рисуется отдельным канвасом и остаётся.
   */
  setVisible(on: boolean): void {
    this.visible = on;
    this.view.style.display = on ? '' : 'none';
    this.world.style.filter = on ? `url(#${this.filterId})` : 'none';
  }

  /**
   * Непрерывное время суток 0..4 (утро/день/вечер/ночь — целые части). Вызывается
   * каждый кадр: профиль части суток держится ровным, а на последних 30% плавно
   * подмешивает следующий — рассветы и закаты «наливаются», а не щёлкают.
   */
  setDayProgress(p: number): void {
    this.dayP = ((p % 4) + 4) % 4;
  }

  /** Поставить конкретную часть суток (середина её диапазона) — кнопки перемотки. */
  setDaypart(dp: DayPart): void {
    const idx = DAYPART_KEYS.indexOf(dp);
    this.dayP = (idx >= 0 ? idx : 1) + 0.5;
  }

  /** Сменить погоду (значение комнаты) — дальше она плавно наезжает за несколько секунд. */
  setWeather(w: WeatherKind): void {
    this.wKind = w;
  }

  /** Профиль текущей части суток с перетеканием к следующей. */
  private blendDaypart(): AtmoProfile {
    const i = Math.floor(this.dayP) % 4;
    const f = this.dayP - Math.floor(this.dayP);
    const k = smoothstep((f - 0.7) / 0.3);
    const a = DAYPART_PROFILE[DAYPART_KEYS[i]];
    if (k <= 0.001) return a;
    return mixProfiles(a, DAYPART_PROFILE[DAYPART_KEYS[(i + 1) % 4]], k);
  }

  /**
   * Кадр атмосферы: сглаживание к целевому состоянию, облака и дождь, затем
   * рендер Pixi (только частицы — мир под ними уже нарисован канвасом).
   * Вызывается из игрового цикла.
   */
  frame(_now: number, dtMs: number, camDx: number, camDy: number): void {
    const app = this.app;
    if (!app || !this.cloudC || !this.rainC) return;

    // Размер вьюпорта — с мирового холста, НЕ с Pixi-канваса: autoDensity ставит
    // на него инлайн-стиль width/height, после чего его clientWidth застревает на
    // старом размере (вьюпорт перестаёт отслеживать ресайз — минует и resize
    // рендерера, и масштаб мира; при сжатии поля картинка уезжает). Мировой холст
    // лежит в той же обёртке без инлайн-стилей и всегда честный.
    const cw = this.world.clientWidth;
    const ch = this.world.clientHeight;
    // dpr живёт в зуме браузера: перечитываем независимо от мира — Ctrl+/- и
    // перетаскивание окна на монитор с другой плотностью меняют devicePixelRatio
    // на лету. Сверяем каждый кадр и при смене отдаём новое разрешение третьим
    // аргументом resize: в pixi 8.22 он поддержан.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cw > 0 && ch > 0 && (cw !== this.w || ch !== this.h || dpr !== this.dpr)) {
      this.w = cw;
      this.h = ch;
      this.dpr = dpr;
      app.renderer.resize(cw, ch, dpr);
    }
    if (this.w <= 0 || this.h <= 0) return;

    // Слой выключен дебаг-тумблером: частицы не рендерим, но цветокоррекцию
    // держим включённой (она живёт на мировом холсте) — гаснет вместе со слоем
    // через setVisible.
    if (!this.visible) return;

    const dt = Math.min(50, Math.max(1, dtMs)) / 1000;
    // Цель пересчитывается каждый кадр: сутки едут непрерывно, погода включается
    // событием. К цели сглаживаем двумя темпами: цветокоррекция — быстро,
    // облака и дождь — за пару секунд, чтобы смена погоды не щёлкала, но и
    // не «висела» на экране после её окончания.
    this.target = stateOf(combine(this.blendDaypart(), WEATHER_PROFILE[this.wKind] ?? WEATHER_PROFILE.sun));
    const kc = 1 - Math.exp(-dt / 0.6);
    const kw = 1 - Math.exp(-dt / 1.2);
    const c = this.cur;
    const t = this.target;
    c.gain[0] = lerp(c.gain[0], t.gain[0], kc);
    c.gain[1] = lerp(c.gain[1], t.gain[1], kc);
    c.gain[2] = lerp(c.gain[2], t.gain[2], kc);
    c.sat = lerp(c.sat, t.sat, kc);
    c.bright = lerp(c.bright, t.bright, kc);
    c.cloudCount = lerp(c.cloudCount, t.cloudCount, kw);
    c.cloudAlpha = lerp(c.cloudAlpha, t.cloudAlpha, kw);
    c.cloudSpeed = lerp(c.cloudSpeed, t.cloudSpeed, kw);
    c.cloudTint[0] = lerp(c.cloudTint[0], t.cloudTint[0], kw);
    c.cloudTint[1] = lerp(c.cloudTint[1], t.cloudTint[1], kw);
    c.cloudTint[2] = lerp(c.cloudTint[2], t.cloudTint[2], kw);
    c.rain = lerp(c.rain, t.rain, kw);
    // Хвост экспоненты срезается: без этого последние доли процента дождя и
    // облаков висят на экране заметно дольше видимой части перехода.
    if (t.rain === 0 && c.rain < 0.02) c.rain = 0;
    if (t.cloudAlpha === 0 && c.cloudAlpha < 0.004) {
      c.cloudAlpha = 0;
      c.cloudCount = 0;
    }

    // Цветокоррекция — композиторный фильтр мирового холста (тот же вид, что
    // раньше давал ColorMatrixFilter поверх залитой в GPU текстуры мира).
    this.applyGradeMatrix(gradeToMatrix(c));

    // Облака: плывут по ветру, чуть сдвигаются против камеры (глубина).
    const count = c.cloudCount;
    const spanX = Math.max(1, this.w + WRAP_MARGIN * 2);
    const spanY = Math.max(1, this.h + WRAP_MARGIN * 2);
    for (let i = 0; i < this.clouds.length; i++) {
      const b = this.clouds[i];
      const sp = b.spr;
      const on = Math.max(0, Math.min(1, count - i));
      b.x += (c.cloudSpeed * 0.92 * b.speedJ * dt) / spanX;
      b.y += (c.cloudSpeed * 0.4 * b.speedJ * dt) / spanY;
      b.x -= (camDx * 0.25) / spanX;
      b.y -= (camDy * 0.25) / spanY;
      if (b.x > 1.5) b.x -= 2;
      if (b.x < -0.5) b.x += 2;
      if (b.y > 1.5) b.y -= 2;
      if (b.y < -0.5) b.y += 2;
      sp.x = b.x * spanX - WRAP_MARGIN;
      sp.y = b.y * spanY - WRAP_MARGIN;
      const blobW = 160 * b.scale;
      sp.width = blobW;
      sp.height = blobW * 0.72; // облако приплюснуто — вид сверху
      sp.tint = this.rgbTint(c.cloudTint);
      sp.alpha = c.cloudAlpha * b.jitter * on;
      sp.visible = on > 0.01 && c.cloudAlpha > 0.005;
    }

    // Дождь.
    const rainOn = c.rain > 0.02;
    this.rainC.visible = rainOn;
    if (rainOn) {
      this.rainC.alpha = Math.min(1, c.rain * 1.15);
      for (const d of this.drops) {
        d.x += (-135 * d.speedJ * dt) / Math.max(1, this.w + WRAP_MARGIN * 2);
        d.y += (1150 * d.speedJ * dt) / Math.max(1, this.h + WRAP_MARGIN * 2);
        if (d.y > 1.12 || d.x < -0.02) {
          d.y = -0.12;
          d.x = Math.random();
        }
        d.spr.x = d.x * (this.w + WRAP_MARGIN * 2) - WRAP_MARGIN;
        d.spr.y = d.y * (this.h + WRAP_MARGIN * 2) - WRAP_MARGIN;
      }
    }

    app.render();
  }

  /** RGB в число для tint Pixi. */
  private rgbTint(rgb: [number, number, number]): number {
    const r = Math.max(0, Math.min(255, Math.round(rgb[0] * 255)));
    const g = Math.max(0, Math.min(255, Math.round(rgb[1] * 255)));
    const b = Math.max(0, Math.min(255, Math.round(rgb[2] * 255)));
    return (r << 16) | (g << 8) | b;
  }

  destroy(): void {
    // Отладочная глобаль не должна переживать слой: иначе после unmount
    // (смена комнаты/этапа, второй проход dev-StrictMode) window.__atmo
    // смотрит на мёртвый объект и сбивает отладку. Снимаем только свою
    // глобаль — если успел подняться более поздний живой слой, не трогаем.
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __atmo?: Atmosphere };
      if (w.__atmo === this) delete w.__atmo;
    }
    // Фильтр и его SVG — свои: снимаем с холста, чтобы тонировка не пережила слой.
    this.world.style.filter = 'none';
    this.svgEl?.remove();
    this.svgEl = null;
    this.feNode = null;
    try {
      this.app?.destroy(false, { children: true, texture: false });
    } catch {
      /* пиксель-в-пиксель не важно: приложение уже мертво */
    }
    this.app = null;
    this.cloudC = null;
    this.rainC = null;
    this.clouds = [];
    this.drops = [];
  }
}
