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

import { sanitizeTestMap, type TestMap, GROUND_COVER_OPTS, objectPosOffset, type GroundCover } from './test-map';
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
  // Кастомные покрытия/поверхности из live-каталога (ещё не попали в Set до refresh).
  const pat = coverPattern(ctx, mat as GroundCover);
  if (pat) return pat;
  return '#42582c';
}

/** Множитель размера кисти от PointerEvent.pressure.
 *  Только перо планшета (`pointerType === 'pen'`): 1 = полный диаметр слайдера,
 *  лёгкое касание → тонкая линия (пол PRESSURE_MIN). Мышь/тач — всегда 1,
 *  у мыши pressure фиктивно 0.5 и не должен менять размер. */
export const PAINT_PRESSURE_MIN = 0.08;
export function paintPressureFactor(pointerType: string, pressure: number): number {
  if (pointerType !== 'pen') return 1;
  if (!Number.isFinite(pressure) || pressure <= 0) return PAINT_PRESSURE_MIN;
  return Math.min(1, Math.max(PAINT_PRESSURE_MIN, pressure));
}

/** AABB мазка в px холста кисти — WebGL заливает только этот кусок, не весь мир. */
export type PaintDirtyRect = { x: number; y: number; w: number; h: number };
let strokeDirty: { x0: number; y0: number; x1: number; y1: number } | null = null;

function markStrokeDirty(x0: number, y0: number, x1: number, y1: number): void {
  if (!strokeDirty) {
    strokeDirty = { x0, y0, x1, y1 };
    return;
  }
  strokeDirty.x0 = Math.min(strokeDirty.x0, x0);
  strokeDirty.y0 = Math.min(strokeDirty.y0, y0);
  strokeDirty.x1 = Math.max(strokeDirty.x1, x1);
  strokeDirty.y1 = Math.max(strokeDirty.y1, y1);
}

/** Забрать накопленный dirty с прошлого штампа (null — полный пересбор атласа). */
export function takePaintDirty(canvasW: number, canvasH: number): PaintDirtyRect | null {
  if (!strokeDirty || canvasW < 1 || canvasH < 1) {
    strokeDirty = null;
    return null;
  }
  const x = Math.max(0, Math.floor(strokeDirty.x0));
  const y = Math.max(0, Math.floor(strokeDirty.y0));
  const x1 = Math.min(canvasW, Math.ceil(strokeDirty.x1));
  const y1 = Math.min(canvasH, Math.ceil(strokeDirty.y1));
  strokeDirty = null;
  if (x1 <= x || y1 <= y) return null;
  return { x, y, w: x1 - x, h: y1 - y };
}

export function clearPaintDirty(): void {
  strokeDirty = null;
}

/** Штамп кисти по черновому холсту (канонические px мира). Круг — по курсору;
 *  прямоугольные пресеты — свободные области с центром под курсором.
 *  Паттерн материала выравнивается по миру (fill/stroke на холсте), как в #142:
 *  tip-кэш с локальным узором давал «змейки» одинаковых цветков вдоль мазка. */
export function stampPaintBrush(
  d: EditorDraft,
  mat: string,
  mx: number,
  my: number,
  cellW: number,
  cellH: number,
  /** Сила нажатия пера 0..1 (PointerEvent.pressure); без пера не передавать. */
  pressure = 1,
  pointerType = 'mouse',
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
  const factor = paintPressureFactor(pointerType, pressure);
  const base = paintBrushSize(d);
  const size = { w: Math.max(1, base.w * factor), h: Math.max(1, base.h * factor) };
  const previous = d.paintLast?.mat === mat ? d.paintLast : null;
  let dirtyPad = Math.max(size.w, size.h) / 2 + 2;
  if (d.pshape === 'round') {
    const r = Math.max(0.5, size.w / 2);
    const prevR = previous ? Math.max(0.5, (previous.w ?? size.w) / 2) : r;
    dirtyPad = Math.max(r, prevR) + 2;
    // Постоянный радиус (мышь / ровное перо): один stroke как в #142 — бесшовный
    // узор и дёшево. Смена давления — круги с мировым паттерном вдоль сегмента.
    if (!previous || Math.abs(r - prevR) < 0.5) {
      g.beginPath();
      g.arc(cx, cy, r, 0, Math.PI * 2);
      g.fill();
      if (previous) {
        g.strokeStyle = g.fillStyle as CanvasPattern | string;
        g.lineWidth = r * 2;
        g.lineCap = 'round';
        g.beginPath();
        g.moveTo(previous.x, previous.y);
        g.lineTo(cx, cy);
        g.stroke();
      }
    } else {
      const dist = Math.hypot(cx - previous.x, cy - previous.y);
      const step = Math.max(1, Math.min(r, prevR) * 0.5);
      const steps = Math.max(1, Math.ceil(dist / step));
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const x = previous.x + (cx - previous.x) * t;
        const y = previous.y + (cy - previous.y) * t;
        const rr = prevR + (r - prevR) * t;
        g.beginPath();
        g.arc(x, y, rr, 0, Math.PI * 2);
        g.fill();
      }
    }
  } else {
    const prevW = previous?.w ?? size.w;
    const prevH = previous?.h ?? size.h;
    dirtyPad = Math.max(size.w, size.h, prevW, prevH) / 2 + 2;
    const steps = previous
      ? Math.max(
          1,
          Math.ceil(
            Math.hypot(cx - previous.x, cy - previous.y) /
              Math.max(1, Math.min(size.w, size.h, prevW, prevH) / 3),
          ),
        )
      : 1;
    for (let i = 1; i <= steps; i++) {
      const t = previous ? i / steps : 1;
      const x = previous ? previous.x + (cx - previous.x) * t : cx;
      const y = previous ? previous.y + (cy - previous.y) * t : cy;
      const w = previous ? prevW + (size.w - prevW) * t : size.w;
      const h = previous ? prevH + (size.h - prevH) * t : size.h;
      g.fillRect(x - w / 2, y - h / 2, w, h);
    }
  }
  if (previous) {
    markStrokeDirty(
      Math.min(previous.x, cx) - dirtyPad,
      Math.min(previous.y, cy) - dirtyPad,
      Math.max(previous.x, cx) + dirtyPad,
      Math.max(previous.y, cy) + dirtyPad,
    );
  } else {
    markStrokeDirty(cx - dirtyPad, cy - dirtyPad, cx + dirtyPad, cy + dirtyPad);
  }
  d.paintLast = { x: cx, y: cy, mat, w: size.w, h: size.h };
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

/**
 * То же кодирование черновика в PNG base64, но без блокировки потока:
 * toBlob кодирует вне главного потока — большой холст локации (десятки
 * мегапикселей) не подвешивает интерфейс на секунды. Результат кэшируется
 * так же, как у синхронной версии (ppaint/pdirty), — последующий синхронный
 * вызов вернёт готовый кэш. Используется сохранением локации (прогресс
 * «Готовлю рисунок…»), синхронная — предпросмотром черновика.
 */
export function encodeDraftPaintAsync(d: EditorDraft): Promise<string> {
  if (!d.pdirty && d.ppaint) return Promise.resolve(d.ppaint);
  if (!d.pcv) {
    d.ppaint = null;
    return Promise.resolve('');
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
  return new Promise((resolve) => {
    const cv = d.pcv;
    if (!cv) return resolve('');
    if (typeof cv.toBlob !== 'function') {
      resolve(encodeDraftPaint(d));
      return;
    }
    cv.toBlob((blob) => {
      if (!blob) {
        resolve(encodeDraftPaint(d));
        return;
      }
      const rd = new FileReader();
      rd.onload = () => {
        const url = String(rd.result || '');
        const b64 = url.slice(url.indexOf(',') + 1);
        d.ppaint = b64;
        d.pdirty = false;
        resolve(b64);
      };
      rd.onerror = () => resolve(encodeDraftPaint(d));
      rd.readAsDataURL(blob);
    }, 'image/png');
  });
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


/** Raster presets are free-positioned areas, independent of the terrain grid. */
export function paintBrushSize(d:Pick<EditorDraft,'pshape'|'psize'|'pwidth'|'pheight'>):{w:number;h:number}{
  if(d.pshape==='round')return {w:d.psize,h:d.psize};
  if(d.pshape==='rect')return {w:d.pwidth??150,h:d.pheight??100};
  return {w:PAINT_CELL_W*(d.pshape==='half'?.5:1),h:PAINT_CELL_H*(d.pshape==='half'?.5:1)};
}
/** Scanline flood fill: stores one source image and compact horizontal spans.
 * The connected color region is replaced with the chosen repeating material.
 */
export function fillPaintArea(d:EditorDraft,mat:string,mx:number,my:number,cellW:number,cellH:number):void {
  const cv=d.pcv,g=cv?.getContext('2d');if(!cv||!g)return;
  const w=cv.width,h=cv.height,x=Math.floor(mx/cellW*PAINT_CELL_W),y=Math.floor(my/cellH*PAINT_CELL_H);
  if(x<0||y<0||x>=w||y>=h)return;
  const source=g.getImageData(0,0,w,h).data,index=(y*w+x)*4;
  const target=[source[index],source[index+1],source[index+2],source[index+3]];
  const seen=new Uint8Array(w*h),stack=[y*w+x],spans:number[][]=[];
  const match=(i:number)=>!seen[i]&&Math.abs(source[i*4+3]-target[3])<32&&
    (target[3]<32||Math.max(Math.abs(source[i*4]-target[0]),Math.abs(source[i*4+1]-target[1]),Math.abs(source[i*4+2]-target[2]))<=48);
  while(stack.length){
    const i=stack.pop()!,row=Math.floor(i/w);let left=i%w,right=left;
    if(!match(i))continue;
    while(left>0&&match(row*w+left-1))left--;
    while(right<w-1&&match(row*w+right+1))right++;
    for(let xx=left;xx<=right;xx++)seen[row*w+xx]=1;
    spans.push([left,row,right-left+1]);
    for(const yy of [row-1,row+1])if(yy>=0&&yy<h){
      let inside=false;
      for(let xx=left;xx<=right;xx++){
        const hit=match(yy*w+xx);if(hit&&!inside)stack.push(yy*w+xx);inside=hit;
      }
    }
  }
  g.save();g.fillStyle=mat==='erase'?'#000':paintPatternFor(g,mat)??'#42582c';
  if(mat==='erase')g.globalCompositeOperation='destination-out';
  for(const [xx,yy,width] of spans)g.fillRect(xx,yy,width,1);
  g.restore();d.pdirty=true;d.paintLast=undefined;
}

/** Portable editor archive. ZIP/store deliberately needs no runtime package.
 * One versioned map.json contains the complete map, including its PNG paint.
 * Import accepts only this format and validates bytes before touching a draft.
 */

const MAX_BYTES=16*1024*1024;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const filename=encoder.encode('map.json');
export function archiveCrc32(bytes:Uint8Array):number {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte;for(let j=0;j<8;j++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}
export function encodeMapArchive(map:TestMap):Uint8Array<ArrayBuffer> {
  const result=sanitizeTestMap(map);
  if(!result.map)throw new Error(result.error??'Некорректная карта');
  const data=encoder.encode(JSON.stringify({format:'coop-field-location',version:1,map:result.map}));
  if(data.length>MAX_BYTES)throw new Error('Архив локации слишком велик');
  const n=filename.length,local=30+n+data.length,central=46+n;
  const bytes=new Uint8Array(local+central+22),v=new DataView(bytes.buffer),crc=archiveCrc32(data);
  v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);
  v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,n,true);
  bytes.set(filename,30);bytes.set(data,30+n);
  v.setUint32(local,0x02014b50,true);v.setUint16(local+4,20,true);v.setUint16(local+6,20,true);
  v.setUint32(local+16,crc,true);v.setUint32(local+20,data.length,true);v.setUint32(local+24,data.length,true);v.setUint16(local+28,n,true);
  bytes.set(filename,local+46);
  const end=local+central;v.setUint32(end,0x06054b50,true);v.setUint16(end+8,1,true);v.setUint16(end+10,1,true);
  v.setUint32(end+12,central,true);v.setUint32(end+16,local,true);
  return bytes;
}
export function decodeMapArchive(bytes:Uint8Array):TestMap {
  if(bytes.length>MAX_BYTES+1024||bytes.length<30)throw new Error('Неверный размер архива');
  const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  if(v.getUint32(0,true)!==0x04034b50||v.getUint16(6,true)!==0||v.getUint16(8,true)!==0)
    throw new Error('Выберите ZIP-архив, созданный редактором локации');
  const size=v.getUint32(18,true),n=v.getUint16(26,true),extra=v.getUint16(28,true),start=30+n+extra;
  if(size!==v.getUint32(22,true)||size>MAX_BYTES||start+size>bytes.length||decoder.decode(bytes.subarray(30,30+n))!=='map.json')
    throw new Error('Архив повреждён: не найден map.json');
  const data=bytes.subarray(start,start+size);
  if(archiveCrc32(data)!==v.getUint32(14,true))throw new Error('Архив повреждён: контрольная сумма не совпала');
  const raw=JSON.parse(decoder.decode(data));
  if(raw?.format!=='coop-field-location'||raw.version!==1)throw new Error('Неизвестная версия архива локации');
  const result=sanitizeTestMap(raw.map);
  if(!result.map)throw new Error(result.error??'Некорректная карта в архиве');
  return result.map;
}
/** Decode into an isolated canvas; failure never changes the active map. */
export async function archivePaintCanvas(map:TestMap):Promise<HTMLCanvasElement|null> {
  if(!map.paint)return null;
  const img=new Image();
  await new Promise<void>((resolve,reject)=>{img.onload=()=>resolve();img.onerror=()=>reject(new Error('Не удалось прочитать рисунок карты'));img.src=`data:image/png;base64,${map.paint}`;});
  if(img.naturalWidth!==map.cols*100||img.naturalHeight!==map.rows*150)throw new Error('Размер рисунка не соответствует карте');
  const cv=document.createElement('canvas');cv.width=img.naturalWidth;cv.height=img.naturalHeight;
  const g=cv.getContext('2d');if(!g)throw new Error('Не удалось подготовить рисунок карты');
  g.drawImage(img,0,0);return cv;
}
