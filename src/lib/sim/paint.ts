/**
 * PaintXP — the location brush of the map editor: materials, stamps, undo
 * snapshots, PNG encoding and the lazy WYSIWYG draft canvas. Carved verbatim
 * from the simulator.tsx module belt (W5a stage 1, behavior-preserving).
 *
 * Consumers: simulator.tsx editor handlers (draft lifecycle, save) call the
 * exported functions with the EditorDraft they own; test-field.ts paints the
 * committed layer. Module state: paintDirtTile is a process-wide cache tile —
 * one Simulator mount per process (ARCHITECTURE.md §6).
 *
 * GROUND_COVER_IDS below is a [MIRROR] copy (test-map.ts + server.js hold the
 * other two) — change all sides in one PR (ARCHITECTURE.md §4).
 */

import { GROUND_COVER_OPTS, objectPosOffset, type GroundCover } from './test-map';
import {
  currentTestMap,
  drawDirtPatch,
  hashStr,
  PAINT_CELL_H,
  PAINT_CELL_W,
  paintCanvas,
  paintReady,
  setPaintOverride,
  testFieldGeometry,
} from './test-field';
import { coverPattern, grassPattern } from './textures';
import type { EditorDraft } from './editor-model';

/* ---------- кисть локации: материалы, штампы, отмена мазков ---------- */

/** Множество id покрытий пака — проверка материала кисти. */
/** [MIRROR] одна из трёх независимых копий (test-map.ts:106, server.js) —
 *  менять только синхронно (ARCHITECTURE §4). */
export const GROUND_COVER_IDS = new Set<string>(GROUND_COVER_OPTS.map((c) => c.id));

/** Материалы кисти: покрытия пака (тайлы 16 px), земля (процедурная плитка) и
 *  ластик (стирает до пустоты за кромкой). */
export const PAINT_MATS: { id: string; label: string }[] = [
  ...GROUND_COVER_OPTS.map((c) => ({ id: c.id as string, label: c.label })),
  { id: 'dirt', label: 'Земля' },
  { id: 'erase', label: 'Ластик' },
];

/** Процедурная плитка «Земля» (16 px): коричневый шум — кисти нужен узор, а
 *  спрайта проталины-тайла в паке нет. */
let paintDirtTile: HTMLCanvasElement | null = null;
function paintDirtPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  if (!paintDirtTile) {
    const cv = document.createElement('canvas');
    cv.width = 16;
    cv.height = 16;
    const g = cv.getContext('2d');
    if (!g) return null;
    g.fillStyle = '#58422c';
    g.fillRect(0, 0, 16, 16);
    let v = 7;
    const rnd = () => {
      v = (v * 1103515245 + 12345) & 0x7fffffff;
      return v / 0x7fffffff;
    };
    for (let i = 0; i < 26; i++) {
      g.fillStyle = rnd() > 0.5 ? 'rgba(38, 27, 16, 0.5)' : 'rgba(122, 98, 66, 0.45)';
      g.fillRect(Math.floor(rnd() * 16), Math.floor(rnd() * 16), 1 + Math.floor(rnd() * 2), 1);
    }
    paintDirtTile = cv;
  }
  return ctx.createPattern(paintDirtTile, 'repeat');
}

/** Паттерн материала кисти (null — ластик); строка — запасной цвет. */
function paintPatternFor(ctx: CanvasRenderingContext2D, mat: string): CanvasPattern | string | null {
  if (mat === 'erase') return null;
  if (mat === 'dirt') return paintDirtPattern(ctx) ?? '#58422c';
  if (GROUND_COVER_IDS.has(mat)) return coverPattern(ctx, mat as GroundCover) ?? '#42582c';
  return '#42582c';
}

/** Штамп кисти по черновому холсту (канонические px мира). Круг — по курсору;
 *  пресеты «клетка»/«полклетки» — готовая область, привязанная к сетке клеток:
 *  штампуется ровно та клетка (или полклетка), под которой курсор. */
export function stampPaintBrush(
  d: EditorDraft,
  mat: string,
  mx: number,
  my: number,
  cellW: number,
  cellH: number,
): void {
  const cv = d.pcv;
  if (!cv) return;
  const g = cv.getContext('2d');
  if (!g) return;
  const cx = (mx / cellW) * PAINT_CELL_W;
  const cy = (my / cellH) * PAINT_CELL_H;
  g.save();
  if (mat === 'erase') {
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = 'rgba(0,0,0,1)';
  } else {
    g.fillStyle = (paintPatternFor(g, mat) ?? '#42582c') as CanvasPattern | string;
  }
  g.imageSmoothingEnabled = false;
  if (d.pshape === 'round') {
    const r = Math.max(0.5, d.psize / 2);
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
  } else {
    const w = d.pshape === 'cell' ? PAINT_CELL_W : PAINT_CELL_W / 2;
    const h = d.pshape === 'cell' ? PAINT_CELL_H : PAINT_CELL_H / 2;
    g.fillRect(Math.floor(cx / w) * w, Math.floor(cy / h) * h, w, h);
  }
  g.restore();
  d.pdirty = true;
}

/** Снимок холста под мазок (отмена): бюджет памяти 96 МБ — крупные миры хранят
 *  меньше шагов, самые большие не отменяются вовсе (кисть и так дешёвая). */
export function pushPaintUndo(d: EditorDraft): void {
  if (!d.pcv) return;
  const g = d.pcv.getContext('2d');
  if (!g) return;
  let bytes = d.pundo.reduce((acc, im) => acc + im.data.byteLength, 0);
  const snapBytes = d.pcv.width * d.pcv.height * 4;
  if (snapBytes > 96 * 1024 * 1024) return;
  try {
    d.pundo.push(g.getImageData(0, 0, d.pcv.width, d.pcv.height));
    bytes += snapBytes;
    while (d.pundo.length > 1 && bytes > 96 * 1024 * 1024) {
      const dropped = d.pundo.shift();
      bytes -= dropped ? dropped.data.byteLength : 0;
    }
  } catch {
    /* холст мог быть испорчен — отмена просто недоступна */
  }
}

/** Отменить последний мазок (true — был что отменять). */
export function undoPaintStroke(d: EditorDraft): boolean {
  const snap = d.pundo.pop();
  if (!snap || !d.pcv) return false;
  d.pcv.getContext('2d')?.putImageData(snap, 0, 0);
  d.pdirty = true;
  setPaintOverride(d.pcv, true);
  return true;
}

/** Закодировать рисунок черновика в PNG base64 (кэш до следующего мазка).
 *  Холст обязан совпадать с миром в канонических пикселях: если размер разъехался
 *  (правка мира при открытом холсте), содержимое переносится в холст нужного
 *  размера 1:1, чтобы сохранение не блокировалось. */
export function encodeDraftPaint(d: EditorDraft): string {
  if (!d.pdirty && d.ppaint) return d.ppaint;
  if (!d.pcv) {
    d.ppaint = null;
    return '';
  }
  const wNeed = d.cols * PAINT_CELL_W;
  const hNeed = d.rows * PAINT_CELL_H;
  if (d.pcv.width !== wNeed || d.pcv.height !== hNeed) {
    const cv = document.createElement('canvas');
    cv.width = wNeed;
    cv.height = hNeed;
    const g = cv.getContext('2d');
    if (g) {
      g.imageSmoothingEnabled = false;
      g.drawImage(d.pcv, 0, 0);
    }
    d.pcv = cv;
    d.pundo = [];
    setPaintOverride(cv, true);
  }
  const url = d.pcv.toDataURL('image/png');
  const b64 = url.slice(url.indexOf(',') + 1);
  d.ppaint = b64;
  d.pdirty = false;
  return b64;
}

/** Копия активного рисунка в черновик (правка не портит сохранённую локацию). */
export function copyPaintCanvas(): HTMLCanvasElement | null {
  const src = paintCanvas();
  if (!src || !paintReady()) return null;
  const cv = document.createElement('canvas');
  cv.width = src.width;
  cv.height = src.height;
  const g = cv.getContext('2d');
  if (!g) return null;
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0);
  return cv;
}

/**
 * Черновой холст кисти: копия сохранённого рисунка или первичная миграция карты
 * без кисти — заливка нарисованного островка травой и запекание проталин и
 * покрытий в пиксели (дальше рисунок — единственный источник вида локации).
 * Вызывается лениво, при первом мазке: карта без кисти, сохранённая без правок
 * кисти, остаётся без рисунка.
 */
export function ensureDraftPaint(d: EditorDraft): HTMLCanvasElement {
  if (d.pcv) return d.pcv;
  const cv = document.createElement('canvas');
  cv.width = d.cols * PAINT_CELL_W;
  cv.height = d.rows * PAINT_CELL_H;
  const g = cv.getContext('2d');
  if (!g) {
    d.pcv = cv;
    return cv;
  }
  g.imageSmoothingEnabled = false;
  const src = paintCanvas();
  if (src && paintReady()) {
    g.drawImage(src, 0, 0, src.width, src.height, 0, 0, cv.width, cv.height);
  } else {
    // миграция: островок из зон заливается травяным паттерном (полигон — в
    // канонических px), затем проталины и покрытия поверх. Заливка —
    // grassPattern (бесшовный тайл grass-ground с травинками и цветами),
    // а НЕ плоский спрайт-покров grass-1: тот одноцветный, и вся локация
    // после миграции становилась одним плоским пятном без текстуры.
    const geo = testFieldGeometry(PAINT_CELL_W, PAINT_CELL_H);
    const pat = grassPattern(g);
    if (pat) {
      g.fillStyle = pat;
      g.fill(geo.path);
    } else {
      g.fillStyle = '#42582c';
      g.fill(geo.path);
    }
    for (const o of currentTestMap().objects ?? []) {
      if (o.kind === 'dirt') {
        const po = objectPosOffset(o);
        drawDirtPatch(
          g,
          PAINT_CELL_W,
          PAINT_CELL_H,
          (o.c + 0.5 + po.dx) * PAINT_CELL_W,
          (o.r + 0.5 + po.dy) * PAINT_CELL_H,
          hashStr(o.id) & 7,
        );
      } else if (o.kind === 'ground') {
        const pat2 = GROUND_COVER_IDS.has(o.cv ?? '') ? coverPattern(g, (o.cv ?? 'flower-1') as GroundCover) : null;
        g.save();
        if (pat2) g.fillStyle = pat2;
        else g.fillStyle = '#4a6b33';
        g.fillRect(o.c * PAINT_CELL_W, o.r * PAINT_CELL_H, PAINT_CELL_W, PAINT_CELL_H);
        g.restore();
      }
    }
  }
  d.pcv = cv;
  d.pdirty = true;
  setPaintOverride(cv, true);
  return cv;
}
