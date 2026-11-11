import type { LocationPlace, LocationPassage } from './location-map';
/**
 * Location-editor pure model: tool ids, brush shapes, the placing «ghost» and
 * the WYSIWYG draft of a TestMap — types plus the editor password storage key.
 * Carved verbatim from the simulator.tsx module belt (W5a stage 1,
 * behavior-preserving).
 *
 * Consumers: simulator.tsx (editor refs/state handlers) and paint.ts (the draft
 * carries the stroke canvas fields pcv/pmat/psize/pshape/pundo/pdirty/ppaint).
 * All functions that mutate a draft live in paint.ts / the component.
 */

import type { TestMapObject, TestMapSpawn, TestMapZone } from './test-map';

/** Устаревший ключ: удаляется при открытии редактора, пароль больше не нужен. */
export const EDITOR_PASS_KEY = 'catwar-editor-pass';

/** Зазор между сохранениями локации на сервере (setmap-кадры, раз в 10 с на
 *  сокет — зеркало SETMAP_MIN_GAP_MS из server/testmap.js). Клиент соблюдает
 *  его заранее: кадр, отправленный раньше срока, сервер молча отбрасывает. */
export const SETMAP_MIN_GAP_MS = 10000;

/** Инструмент редактора локации: зона с клетками, зелёная зона, ластик,
 *  объект (камень/дерево — препятствия со свободной позицией, размером и
 *  поворотом; земля — проталина-декор; покрытие — плитка/цветы/пол на клетку,
 *  красятся протяжкой) или клетка захода (вход в боевую зону с направлением шага). */
export type EditorTool =
  | 'passage'
  | 'cells'
  | 'green'
  | 'erase'
  | 'stone'
  | 'tree'
  | 'plant'
  | 'dirt'
  | 'ground'
  | 'path'
  | 'entry'
  | 'spawn'
  | 'raise'
  | 'lower'
  | 'flat'
  | 'height'
  | 'cursor'
  | 'pan'
  | 'fill'
  | 'paint'
  | 'battle'
  | 'select';

/** Форма кисти локации: свободный круг или прямоугольная область.
 *  cell/half читаются для совместимости; новые размеры задают pwidth/pheight. */
export type PaintBrushShape = 'round' | 'cell' | 'half' | 'rect';

/** Ставящийся объект редактора: «призрак» следует за курсором (свободная позиция,
 *  без привязки к клетке), клик фиксирует точку; размер — колесом и кнопками ±,
 *  поворот — кнопками; ✓ ставит объект, ✕ отменяет. pickId — объект, поднятый
 *  с поля для правки (оригинал на время правки скрыт, ✓ переносит его). */
export type EditorPlace = {
  kind: 'tree' | 'stone' | 'plant';
  spr: string;
  s: number;
  rot: number;
  /** отзеркален ли спрайт по горизонтали */
  mir: 0 | 1;
  /** точка опоры в клеточных долях мира */
  x: number;
  y: number;
  anchored: boolean;
  pickId: string | null;
};

/** Черновик локации в редакторе: рисуется на поле сразу (WYSIWYG), живёт до закрытия. */
export type EditorDraft = {
  place?:LocationPlace; passages?:LocationPassage[];
  passageBrush?:{w:number;h:number;targetId:number;link:string;direction:LocationPassage["direction"]};
  zones: TestMapZone[];
  /** Препятствия черновика (камни/деревья) — едут в конфиг вместе с зонами. */
  objects: TestMapObject[];
  /** Клетки спавна (точки появления игроков) — отдельный список конфига. */
  spawns: TestMapSpawn[];
  /** Карта высот черновика: «c,r» → уровень 1..TERRAIN_MAX_LEVEL (разреженно). */
  elev: Record<string, number>;
  /** Размер прямоугольного штампа и точная высота: только настройки инструмента. */
  elevBrush?: { width: number; depth: number; level: number };
  elevFree?: boolean;
  elevSnap?: 'off' | 'level' | 'all';
  terrainCursor?: { x: number; y: number };
  terrainSnapDistance?: number;
  /** Кисть локации: холст рисунка (канонические px мира 100×150 на клетку),
   *  материал, размер/форма кисти, снимки для отмены мазков и закодированный
   *  рисунок последнего черновика. pcv null — рисунок ещё не начат: карта без
   *  кисти остаётся без него, если инструмент «Кисть» не трогали. */
  pcv: HTMLCanvasElement | null;
  pmat: string;
  psize: number;
  pwidth?: number;
  pheight?: number;
  paintLast?: {x:number;y:number;mat:string};
  spacePan?: boolean;
  pan?: {x:number;y:number;reset?:boolean};
  panDrag?: {sx:number;sy:number;x:number;y:number};
  showGrid?: boolean;
  pshape: PaintBrushShape;
  pundo: ImageData[];
  pdirty: boolean;
  ppaint: string | null;
  cols: number;
  rows: number;
  seed?:string; margin?:number;
  tool: EditorTool;
  /** Тянущийся прямоугольник в клетках (не нормализован — углы в любом порядке). */
  drag: { c0: number; r0: number; c1: number; r1: number; erase: boolean } | null;
  /** Выделенная область инструмента «Перенести» (нормализована, в клетках). */
  selRect: { c0: number; r0: number; c1: number; r1: number } | null;
  /** Смещение «плавающей» выделенной области после переноса (в клетках, от исходного места). */
  selFloat: { dc: number; dr: number } | null;
  undo: EditorSnapshot[];
  redo?: EditorSnapshot[];
  /** Отмеченные зоны для объединения (инструмент «Объединить»). */
  sel: string[];
  dirty: boolean;
  /** Момент последней отправки setmap (Date.now): клиентский предгейт
   *  троттлинга сервера — не отправлять кадр раньше срока, а показать честное
   *  сообщение в панели. Переживает перерисовки (живёт в ref-черновике). */
  lastSaveSentAt?: number;
};


export type EditorSnapshot = {
  place?:LocationPlace;passages?:LocationPassage[];
  zones: TestMapZone[]; objects: TestMapObject[]; spawns: TestMapSpawn[];
  elev: Record<string,number>; cols:number; rows:number; seed?:string; margin?:number;
  paint?:ImageData|null; label?:string; dirty?:boolean;
};
export function editorSnapshot(d:EditorDraft,withPaint=false):EditorSnapshot {
  const snapshot:EditorSnapshot={place:d.place?{...d.place}:undefined,passages:d.passages?.map(p=>({...p})),seed:d.seed,margin:d.margin,dirty:d.dirty,zones:d.zones.map(z=>({...z})),objects:d.objects.map(o=>({...o})),spawns:d.spawns.map(s=>({...s})),elev:{...d.elev},cols:d.cols,rows:d.rows,label:d.tool==='paint'?'Мазок кисти':d.tool==='fill'?'Заливка':d.tool==='height'?'Блок высоты':d.tool==='plant'?'Растение':d.tool==='tree'?'Дерево':d.tool==='stone'?'Камень':'Изменение карты'};
  if(withPaint){
    if(!d.pcv)snapshot.paint=null;
    else snapshot.paint=d.pcv.getContext('2d')?.getImageData(0,0,d.pcv.width,d.pcv.height);
  }
  return snapshot;
}
export function trimEditorHistory(d:EditorDraft):void {
  let bytes=[...d.undo,...(d.redo??[])].reduce((sum,s)=>sum+(s.paint?.data.byteLength??0),0);
  while(d.undo.length>1&&(d.undo.length>40||bytes>96*1024*1024))bytes-=d.undo.shift()?.paint?.data.byteLength??0;
  while((d.redo?.length??0)>1&&bytes>96*1024*1024)bytes-=d.redo!.shift()?.paint?.data.byteLength??0;
}
export function restoreEditorSnapshot(d:EditorDraft,s:EditorSnapshot):void {
  d.place=s.place?{...s.place}:undefined;d.passages=s.passages?.map(p=>({...p}));
  d.seed=s.seed;d.margin=s.margin;
  d.zones=s.zones.map(z=>({...z}));d.objects=s.objects.map(o=>({...o}));d.spawns=s.spawns.map(p=>({...p}));d.elev={...s.elev};d.cols=s.cols;d.rows=s.rows;
  d.selRect=null;d.selFloat=null;d.sel=[];d.paintLast=undefined;d.dirty=s.dirty??true;
  if(s.paint===null){d.pcv=null;d.ppaint=null;d.pdirty=false;}
  else if(s.paint){
    if(!d.pcv)d.pcv=document.createElement('canvas');
    d.pcv.width=s.paint.width;d.pcv.height=s.paint.height;
    d.pcv.getContext('2d')?.putImageData(s.paint,0,0);d.pdirty=true;d.ppaint=null;
  }
}
