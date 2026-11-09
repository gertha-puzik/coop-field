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
  | 'cells'
  | 'green'
  | 'erase'
  | 'stone'
  | 'tree'
  | 'dirt'
  | 'ground'
  | 'entry'
  | 'spawn'
  | 'raise'
  | 'lower'
  | 'flat'
  | 'height'
  | 'paint'
  | 'battle'
  | 'select';

/** Форма кисти локации: круглый мазок или готовые области — клетка (150×100 px)
 *  и полклетки (75×50), с привязкой к сетке. */
export type PaintBrushShape = 'round' | 'cell' | 'half';

/** Ставящийся объект редактора: «призрак» следует за курсором (свободная позиция,
 *  без привязки к клетке), клик фиксирует точку; размер — колесом и кнопками ±,
 *  поворот — кнопками; ✓ ставит объект, ✕ отменяет. pickId — объект, поднятый
 *  с поля для правки (оригинал на время правки скрыт, ✓ переносит его). */
export type EditorPlace = {
  kind: 'tree' | 'stone';
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
  pshape: PaintBrushShape;
  pundo: ImageData[];
  pdirty: boolean;
  ppaint: string | null;
  cols: number;
  rows: number;
  tool: EditorTool;
  /** Тянущийся прямоугольник в клетках (не нормализован — углы в любом порядке). */
  drag: { c0: number; r0: number; c1: number; r1: number; erase: boolean } | null;
  /** Выделенная область инструмента «Перенести» (нормализована, в клетках). */
  selRect: { c0: number; r0: number; c1: number; r1: number } | null;
  /** Смещение «плавающей» выделенной области после переноса (в клетках, от исходного места). */
  selFloat: { dc: number; dr: number } | null;
  undo: { zones: TestMapZone[]; objects: TestMapObject[]; spawns: TestMapSpawn[]; elev: Record<string, number>; cols: number; rows: number; paint?: ImageData }[];
  /** Отмеченные зоны для объединения (инструмент «Объединить»). */
  sel: string[];
  dirty: boolean;
  /** Момент последней отправки setmap (Date.now): клиентский предгейт
   *  троттлинга сервера — не отправлять кадр раньше срока, а показать честное
   *  сообщение в панели. Переживает перерисовки (живёт в ref-черновике). */
  lastSaveSentAt?: number;
};
