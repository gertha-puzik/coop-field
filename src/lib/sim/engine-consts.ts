/**
 * Named engine constants, storage keys and tiny scalar helpers of the canvas
 * engine — carved verbatim from the simulator.tsx module belt in W5a stage 1
 * (behavior-preserving: values, names and call sites unchanged).
 *
 * Consumers: src/components/sim/simulator.tsx (rAF loop, input, JSX) and the
 * sibling src/lib/sim modules (geometry, targeting). Nothing is imported here.
 *
 * [MIRROR] marks a value hand-copied in server.js — change both sides in one
 * PR (docs/ARCHITECTURE.md §4; parity is gated in CI since W3).
 */

/** Ключ localStorage с настройками сессии (главное хранилище движка). */
export const STORAGE_KEY = 'catwar-battle-sim-v4';

/** Поле может растягиваться сверх клеточного размера, чтобы занять весь кадр.
 *  Дальше 2× картинка начинает заметно мылить даже с dpr-рендером. */
export const FIELD_MAX_UPSCALE = 2;
/** Пауза на новые шаги после отката предикта (чуть выше серверного кулдауна 80мс):
 *  мгновенный перешаг после отката уходил в серверный кулдаун и терялся. */
export const NET_ROLLBACK_LOCK_MS = 90;
/** Темп рассылки свободной позиции в «тесте» (~12 кадров/с). */
export const FREE_EMIT_MS = 80;
/** Плавность камеры: за ~420 мс камера догоняет игрока на 63% дистанции —
 *  в несколько раз плавнее прежнего (130 мс), кот больше не «дёргает» камеру. */
export const CAMERA_TAU_MS = 420;
/** Скорость свободной ходьбы мирного режима по умолчанию, px мира в секунду:
 *  игрок движется по пикселям ровно пока зажаты клавиши (или до цели клика),
 *  без привязки к клеткам. Точное значение — настройка «Скорость ходьбы (мир)»
 *  (character.peaceSpeed). */
export const PEACE_SPEED_DEFAULT = 320;
/** Кликом пущенная ходьба отменяется, если столько мс нет прогресса к цели. */
export const PEACE_STUCK_MS = 600;
/** Зум камеры мирного режима «теста»: поле приближается — «по-домашнему» вид сверху,
 *  как в Don't Starve Together. В бою возвращается 1. Отключается кнопкой
 *  «Перспектива» в шапке (character.peaceView); поверх базового зума работает
 *  зум колесом мыши (CAM_USER_ZOOM_MIN…MAX). */
export const PEACE_ZOOM = 1.5;
/** Наклон земли мирного режима: вертикаль грунта сжата до этой доли, спрайты остаются
 *  вертикальными билбордами — та самая псевдо-глубина Don't Starve / Transformice Adventures. */
export const PEACE_TILT = 0.8;
/** Насколько центр мирного кота может углубиться в боевую зону по вертикали
 *  (доли клетки). Перпектива сжимает землю до PEACE_TILT, из-за чего при той же
 *  стенке видимый заход в зону сверху/снизу выходит заметно мельче бокового —
 *  по вертикали стенку отодвигаем вглубь, чтобы визуально кот везде заходил
 *  «до половины», как сбоку. */
export const PEACE_BATTLE_LEAN_Y = 0.12;
/** Плавность перехода зума и наклона между мирным и боевым видом, мс. */
export const CAMZOOM_TAU_MS = 350;
/** Границы зума колесом мыши: множитель поверх базового зума вида (1 — как задано
 *  режимом). Колесо вверх — ближе, вниз — дальше; работает и в мирном виде, и в бою. */
export const CAM_USER_ZOOM_MIN = 0.55;
export const CAM_USER_ZOOM_MAX = 2;
/** Шаг зума на один щелчок колеса (множитель, вверх/вниз). */
export const CAM_USER_ZOOM_STEP = 1.12;
/** Множитель спринта в мирном режиме: зажатый Shift ускоряет кота вдвое. */
export const SPRINT_MULT = 2;
/** Порог «объект закрывает игрока»: если препятствие перекрывает прямоугольник
 *  модельки своего кота хотя бы на эту долю, объект рисуется полупрозрачным —
 *  игрок видит себя за кроной/камнем. Эффект только на своем экране: чужие
 *  клиенты рисуют кот целиком спрятанным, как и положено. */
export const OCCLUDE_COVER = 0.7;
/** Альфа объекта, под которым спрятался свой кот (см. OCCLUDE_COVER). */
export const OCCLUDE_ALPHA = 0.6;

/**
 * Доля ширины/высоты спрайта, к которой закреплена стрела.
 * Откалибровано по референсу: центр клетки (со смещением −1px) при клетке 100×150
 * и размере модельки 94%: 50 / 87.73 = 75 / 131.6 ≈ 0.5699.
 * Благодаря привязке к спрайту точка закрепления «растёт» вместе с персонажем.
 */
export const ARROW_ANCHOR_F = 0.5699;

/** Цвет «потраченной» части стрелы (заполняется по мере расхода энергии). */
export const SPENT_COLOR = '#e5484d';

/** Насколько темнее хвоста наконечник стрелы (множитель яркости цвета). */
export const ARROW_TIP_SHADE = 0.55;

/** Идентификатор манекена «ПОЧУХАТЬ» — предмета комнаты, не персонажа. */
export const DUMMY_ID = 'pochuhat';
/** Рост манекена, % от высоты клетки (как у котов по умолчанию). */
export const DUMMY_SCALE = 100;
/** Темп рассылки позиции манекена при перетаскивании, мс (~25 кадров/с). */
export const DUMMY_EMIT_MS = 40;
/** Дефолтная клетка манекена (левый верх спрайта, клеточные доли) — совпадает с серверной. */
/** [MIRROR] server.js DUMMY_DEFAULT — менять только синхронно (ARCHITECTURE §4). */
export const DUMMY_DEFAULT = { x: 7, y: 2 };
/** Идентификатор боевой мишени «РАБ» — предмета комнаты в боевом режиме. */
export const RAB_ID = 'rab';
/** Рост мишени РАБ, % от высоты клетки. */
export const RAB_SCALE = 100;
/** Клетка мишени РАБ (0-based): фиксирована, совпадает с серверной RAB_CELL. */
/** [MIRROR] server.js RAB_CELL (сервер хранит её 1-based) — менять только синхронно (ARCHITECTURE §4). */
export const RAB_POS = { col: 4, row: 2 };
/** Округление клеточных долей до сотых — точность перетаскивания хватает, пакет короче. */
export const round2 = (v: number) => Math.round(v * 100) / 100;

/** Затемнение hex-цвета (#rgb / #rrggbb) множителем f — для наконечника стрелы. */
export function shadeHex(hex: string, f: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  const n = parseInt(h, 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r}, ${g}, ${b})`;
}
