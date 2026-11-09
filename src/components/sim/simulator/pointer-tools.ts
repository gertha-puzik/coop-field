import { isElevationTool, type ElevationTool } from '@/lib/sim/terrain-editor';
/**
 * Verbatim canvas pointer tools carved out of simulator.tsx (W5b stage 2,
 * behavior-preserving): mouse move / down / up / leave / right-click /
 * click handlers of the world canvas including editor drag, dummies
 * drag-and-drop, brush strokes and click-to-move walk targeting. Contract:
 * plain per-render factory (no hooks inside), bodies byte-identical; the
 * params object is recreated every render so closures always see current
 * values, exactly as when they were inline consts. on* names are kept 1:1.
 */
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { CoopDummyPos } from '@/lib/net/coop';
import type { DummyConfig, SimSettings, SpriteId } from '@/lib/sim/settings';
import type { EditorDraft, EditorPlace } from '@/lib/sim/editor-model';
import type { Engine } from './sim-model';
import { DUMMY_EMIT_MS, DUMMY_ID, DUMMY_SCALE, round2 } from '@/lib/sim/engine-consts';
import { bfsPath } from '@/lib/sim/settings';
import { createCoopClient } from '@/lib/net/coop';
import { dummiesOf, dummyIsDrawn, othersOf, type CharRef } from '@/lib/sim/targeting';
import { ensureDraftPaint, fillPaintArea, stampPaintBrush } from '@/lib/sim/paint';
import { groundPointAtWorld, setPaintOverride, testBattleRouteBlocked, testEntryAt, testEntryStrict, testPeaceBattleBlocked, testPointInCellsZone, testPointInIsland, testWalkableCell } from '@/lib/sim/test-field';
import { peaceHalfBox, screenToWorld, spriteBoxOf } from '@/lib/sim/geometry';

export interface PointerToolsDeps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  camRef: RefObject<{ x: number; y: number; init: boolean }>;
  camFxRef: RefObject<{ z: number }>;
  camYawRef: RefObject<number>;
  cursorScreenRef: RefObject<{ x: number; y: number } | null>;
  cursorWorldRef: RefObject<{ x: number; y: number } | null>;
  dirtPaintingRef: RefObject<boolean>;
  dragRef: RefObject<{
    key: string;
    grabDX: number;
    grabDY: number;
    x: number;
    y: number;
    w: number;
    h: number;
    lastX: number;
    lastY: number;
    lastT: number;
    moved: boolean;
  } | null>;
  dummyOnRef: RefObject<boolean>;
  dummyPosRef: RefObject<CoopDummyPos | null>;
  dummySpriteRef: RefObject<SpriteId>;
  dummySyncRef: RefObject<{ at: number }>;
  editorOpenRef: RefObject<boolean>;
  editorPlaceRef: RefObject<EditorPlace | null>;
  editorRef: RefObject<EditorDraft | null>;
  engineRef: RefObject<Engine>;
  fieldFormatRef: RefObject<'grid' | 'test'>;
  inZonePrevRef: RefObject<boolean>;
  jellyRef: RefObject<Record<string, number>>;
  liveRemotesRef: RefObject<DummyConfig[]>;
  mainSavedRef: RefObject<{ col: number; row: number; angle: number } | null>;
  netRef: RefObject<ReturnType<typeof createCoopClient> | null>;
  paintStrokeRef: RefObject<boolean>;
  skipClickRef: RefObject<boolean>;
  spritesRef: RefObject<Partial<Record<SpriteId, HTMLImageElement>>>;
  settingsRef: RefObject<SimSettings>;
  objectExtras: () => CharRef[];
  patchDummy: (id: string, p: Partial<DummyConfig>) => void;
  setSettings: Dispatch<SetStateAction<SimSettings>>;
  addEditorSpawn: (c: number, r: number) => boolean;
  applyElevBrush: (mode: ElevationTool, c: number, r: number) => boolean;
  beginElevStroke: (mode: ElevationTool, c: number, r: number) => void;
  clampPlacePos: (x: number, y: number) => { x: number; y: number };
  commitEditorDrag: () => void;
  endElevStroke: () => void;
  syncEditorView: () => void;
  refreshEditorPreview: () => void;
  paintEditorCellObject: (kind: 'dirt' | 'ground', c: number, r: number) => boolean;
  placeBattleCell: (c: number, r: number) => void;
  placeEditorEntry: (c: number, r: number) => boolean;
  pushEditorUndo: (withPaint?: boolean) => void;
  toggleEditorSpawn: (c: number, r: number) => boolean;
  editorPlacementClick: (mx: number, my: number) => void;
  pickEditorSelection: (c: number, r: number) => void;
  dragEditorSelection: (c: number, r: number) => void;
  dropEditorSelection: () => void;
}

export function buildPointerTools(deps: PointerToolsDeps) {
  const {
    canvasRef,
    camRef,
    camFxRef,
    camYawRef,
    cursorScreenRef,
    cursorWorldRef,
    dirtPaintingRef,
    dragRef,
    dummyOnRef,
    dummyPosRef,
    dummySpriteRef,
    dummySyncRef,
    editorOpenRef,
    editorPlaceRef,
    editorRef,
    engineRef,
    fieldFormatRef,
    inZonePrevRef,
    jellyRef,
    liveRemotesRef,
    mainSavedRef,
    netRef,
    paintStrokeRef,
    skipClickRef,
    spritesRef,
    settingsRef,
    objectExtras,
    patchDummy,
    setSettings,
    addEditorSpawn,
    applyElevBrush,
    beginElevStroke,
    clampPlacePos,
    commitEditorDrag,
    endElevStroke,
    syncEditorView,
    refreshEditorPreview,
    paintEditorCellObject,
    placeBattleCell,
    placeEditorEntry,
    pushEditorUndo,
    toggleEditorSpawn,
    editorPlacementClick,
    pickEditorSelection,
    dragEditorSelection,
    dropEditorSelection,
  } = deps;
  const canvasPoint = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    // Хит проецируется в МИР поля (cols×cellW), а не в буфер канваса: в grid-формате
    // буфер = мир×k (k — devicePixelRatio с капом 2, см. цикл отрисовки), а рисунок
    // идёт в мировых координатах через ctx.setTransform(k). Проекция по размеру буфера
    // умножала точку ещё на k — на ретине подсветка и клики уходили ровно на k клеток
    // правее-ниже курсора. В «тест»-формате результат ниже всё равно перезаписывается
    // обратной проекцией камеры, так что правка его не затрагивает.
    const fw = settingsRef.current.field;
    const mx = ((ev.clientX - rect.left) * fw.cols * fw.cellW) / rect.width;
    const my = ((ev.clientY - rect.top) * fw.rows * fw.cellH) / rect.height;
    return { mx, my };
  };

  /** Манекен, чей спрайт накрыт точкой (mx,my) канваса (с небольшим запасом в 4px).
   *  Управляемый манекен проверяется по его фактической клетке (движок), остальные — по настройкам. */
  const hitTargetAt = (s: SimSettings, mx: number, my: number): DummyConfig | null => {
    const e = engineRef.current;
    for (const d of dummiesOf(s, liveRemotesRef.current)) {
      if (!dummyIsDrawn(d, s.controlled)) continue;
      const sprT = spritesRef.current[d.sprite] ?? null;
      const pos =
        d.id === s.controlled
          ? { x: e.col * s.field.cellW, y: e.row * s.field.cellH }
          : { x: d.col * s.field.cellW, y: d.row * s.field.cellH };
      const b = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, 0, 0, d.scale);
      if (mx >= pos.x - 4 && mx <= pos.x + b.w + 4 && my >= pos.y - 4 && my <= pos.y + b.h + 4) return d;
    }
    return null;
  };

  /** Прямоугольник манекена под точкой (mx,my) канваса — px и размеры спрайта, либо null.
   *  Пока манекен тащат, проверка не нужна: его уже удерживает захват указателя. */
  const hitDummyObjAt = (s: SimSettings, mx: number, my: number) => {
    if (!dummyOnRef.current) return null;
    const pos = dummyPosRef.current;
    if (!pos) return null;
    const sprT = spritesRef.current[dummySpriteRef.current] ?? null;
    const b = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, 0, 0, DUMMY_SCALE);
    const px = pos.x * s.field.cellW;
    const py = pos.y * s.field.cellH;
    if (mx >= px - 4 && mx <= px + b.w + 4 && my >= py - 4 && my <= py + b.h + 4) {
      return { x: px, y: py, w: b.w, h: b.h };
    }
    return null;
  };

  const onMove = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    const s = settingsRef.current;
    const e = engineRef.current;
    const testMode = fieldFormatRef.current === 'test';
    const pan=editorOpenRef.current?editorRef.current?.panDrag:null;
    if(pan&&editorRef.current){
      const dx=(ev.clientX-pan.sx)/camFxRef.current.z,dy=(ev.clientY-pan.sy)/camFxRef.current.z,yaw=camYawRef.current;
      editorRef.current.pan={x:pan.x-dx*Math.cos(yaw)-dy*Math.sin(yaw),y:pan.y+dx*Math.sin(yaw)-dy*Math.cos(yaw)};
      return;
    }
    // «Тест»: мир больше вьюпорта — курсор переводится в мировые координаты через камеру
    let { mx, my } = canvasPoint(ev);
    if (testMode) {
      const cvp = canvasRef.current;
      if (cvp) {
        const rect = cvp.getBoundingClientRect();
        // Последняя экранная позиция курсора (css px от угла канваса): кадр
        // пересчитывает по ней мировую точку прицела ПОСЛЕ движения камеры —
        // иначе в прыжке/приседе камера уезжает под неподвижным курсором,
        // а прицел, посчитанный только по событию, отлипает от видимой точки.
        cursorScreenRef.current = { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
        const wpt = screenToWorld(
          ev.clientX - rect.left,
          ev.clientY - rect.top,
          cvp.clientWidth,
          cvp.clientHeight,
          camRef.current.x,
          camRef.current.y,
          camFxRef.current.z,
          camYawRef.current,
        );
        mx = wpt.x;
        my = wpt.y;
      }
      // Редактор: курсор ведёт тянущийся прямоугольник (и подсвечивает клетку);
      // «Земля»/«Покрытие» при зажатой кнопке красят протяжкой; «призрак»
      // камня/дерева следует за курсором, пока точка не зафиксирована кликом.
      const ed = editorRef.current;
      if (editorOpenRef.current && ed) {
        const ground = groundPointAtWorld(mx, my, s.field.cellW, s.field.cellH, camYawRef.current);
        mx = ground.x; my = ground.y;
        ed.terrainCursor={x:mx/s.field.cellW,y:my/s.field.cellH};
        ed.terrainSnapDistance=10/(s.field.cellW*camFxRef.current.z);
        const c = Math.min(ed.cols - 1, Math.max(0, Math.floor(mx / s.field.cellW)));
        const r = Math.min(ed.rows - 1, Math.max(0, Math.floor(my / s.field.cellH)));
        if (ed.drag) {
          ed.drag.c1 = c;
          ed.drag.r1 = r;
        }
        // «Перенести»: плавающий кусок следует за курсором после вырезания
        if (ed.selFloat && ed.tool === 'select') dragEditorSelection(c, r);
        if (dirtPaintingRef.current && (ed.tool === 'dirt' || ed.tool === 'ground') && ev.buttons & 1) {
          paintEditorCellObject(ed.tool === 'ground' ? 'ground' : 'dirt', c, r);
        }
        // протяжка «Спавна» — только добавляет точки (снимает кликом)
        if (dirtPaintingRef.current && ed.tool === 'spawn' && ev.buttons & 1) {
          addEditorSpawn(c, r);
        }
        // протяжка кистей рельефа: каждая клетка росчерка — один раз
        if (dirtPaintingRef.current && isElevationTool(ed.tool) && ev.buttons & 1) {
          applyElevBrush(ed.tool, c, r);
        }
        // мазок кисти локации: ЛКМ — материал, ПКМ — ластик; холст черновика
        // становится активным рисунком сразу (маска обновляется, контур — по
        // окончании росчерка, см. onUp)
        if (paintStrokeRef.current && ed.tool === 'paint' && ed.pcv) {
          if (ev.buttons & 2) stampPaintBrush(ed, 'erase', mx, my, s.field.cellW, s.field.cellH);
          else if (ev.buttons & 1) stampPaintBrush(ed, ed.pmat, mx, my, s.field.cellW, s.field.cellH);
          setPaintOverride(ed.pcv, false);
        }
        const pG = editorPlaceRef.current;
        if (pG && !pG.anchored) {
          // пишем прямо в ref: кадр читает его каждый тик, панель позиции не показывает
          const b = clampPlacePos(mx / s.field.cellW, my / s.field.cellH);
          pG.x = b.x;
          pG.y = b.y;
        }
        e.hover = { c, r };
        const cvE = canvasRef.current;
        if (cvE) cvE.style.cursor = 'crosshair';
        return;
      }
      // Прицел прыжка: курсор в мире с поправкой на подъём земли — клик по
      // видимой поверхности возвышенности указывает в её клетку, а не в землю
      // перед обрывом. В редакторе прицел не нужен (прыжка там нет).
      cursorWorldRef.current = groundPointAtWorld(mx, my, s.field.cellW, s.field.cellH, camYawRef.current);
    }
    const dg = dragRef.current;
    if (dg) {
      // перетаскивание: спрайт следует за курсором в пределах поля,
      // скорость мыши раскачивает «желе» — быстрое дрожание качает манекен
      const nowT = performance.now();
      const dtm = Math.max(1, nowT - dg.lastT);
      const speed = Math.hypot(mx - dg.lastX, my - dg.lastY) / dtm; // px/мс
      jellyRef.current[dg.key] = Math.max(jellyRef.current[dg.key] ?? 0, Math.min(1, speed / 2.2));
      dg.x = Math.min(Math.max(mx - dg.grabDX, 0), s.field.cols * s.field.cellW - dg.w);
      dg.y = Math.min(Math.max(my - dg.grabDY, 0), s.field.rows * s.field.cellH - dg.h);
      if (Math.abs(mx - dg.lastX) > 2 || Math.abs(my - dg.lastY) > 2) dg.moved = true;
      dg.lastX = mx;
      dg.lastY = my;
      dg.lastT = nowT;
      if (dg.key === DUMMY_ID) {
        // Манекен — общий: пока тащим, позиция уходит на сервер с постоянным темпом,
        // чтобы остальные видели движение в реальном времени.
        const net = netRef.current;
        if (net?.ready && nowT - dummySyncRef.current.at >= DUMMY_EMIT_MS) {
          dummySyncRef.current.at = nowT;
          net.emit('dummyMove', { x: round2(dg.x / s.field.cellW), y: round2(dg.y / s.field.cellH) });
        }
      }
      return;
    }
    const c = Math.floor(mx / s.field.cellW);
    const r = Math.floor(my / s.field.cellH);
    // подсветка клетки — в бою и только по проходимым зонам «теста» (и по заходам)
    const hoverOk =
      c >= 0 &&
      c < s.field.cols &&
      r >= 0 &&
      r < s.field.rows &&
      (!testMode || (s.arrow.battleMode && (testWalkableCell(c, r) || !!testEntryAt(c, r))));
    if (hoverOk) e.hover = { c, r };
    else e.hover = null;
    const cv = canvasRef.current;
    if (testMode) {
      // манекена в «тесте» нет — таскать нечего; ходьба свободная, курсор обычный
      if (cv) cv.style.cursor = '';
      return;
    }
    const hov = hitTargetAt(s, mx, my);
    const hovT = hitDummyObjAt(s, mx, my);
    if (cv) cv.style.cursor = hovT || (hov && hov.id !== s.controlled) ? 'grab' : '';
  };

  const onLeave = () => {
    cursorScreenRef.current = null;
    cursorWorldRef.current = null;
    const e = engineRef.current;
    e.hover = null;
    const cv = canvasRef.current;
    if (cv && !dragRef.current) cv.style.cursor = '';
  };

  /** Захват манекена: зажатая ЛКМ на его спрайте начинает перетаскивание.
   *  В редакторе локации зажатая кнопка начинает рисунок зоны (ПКМ — стирание). */
  const onPointerDown = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const ed = editorRef.current;
    if (editorOpenRef.current && ed) {
      if (ev.button !== 0 && ev.button !== 2 && ev.button !== 1) return;
      const s = settingsRef.current;
      const cvp = canvasRef.current;
      let mx = 0;
      let my = 0;
      if (cvp) {
        const rect = cvp.getBoundingClientRect();
        const wpt = screenToWorld(
          ev.clientX - rect.left,
          ev.clientY - rect.top,
          cvp.clientWidth,
          cvp.clientHeight,
          camRef.current.x,
          camRef.current.y,
          camFxRef.current.z,
          camYawRef.current,
        );
        mx = wpt.x;
        my = wpt.y;
      }
      if(ed.tool==='pan'||ed.spacePan||ev.button===1){
        ed.panDrag={sx:ev.clientX,sy:ev.clientY,x:ed.pan?.x??0,y:ed.pan?.y??0};
        ev.currentTarget.setPointerCapture(ev.pointerId);ev.currentTarget.style.cursor='grabbing';ev.preventDefault();return;
      }
      const ground = groundPointAtWorld(mx, my, s.field.cellW, s.field.cellH, camYawRef.current);
      mx = ground.x; my = ground.y;
      ed.terrainCursor={x:mx/s.field.cellW,y:my/s.field.cellH};
      ed.terrainSnapDistance=10/(s.field.cellW*camFxRef.current.z);
      const c = Math.min(ed.cols - 1, Math.max(0, Math.floor(mx / s.field.cellW)));
      const r = Math.min(ed.rows - 1, Math.max(0, Math.floor(my / s.field.cellH)));
      // Инструменты препятствий: призрак постановки (клик — фиксация/подъём);
      // «Земля» и «Покрытие» красятся кликом и протяжкой (одна отмена на росчерк);
      // ПКМ по-прежнему рисует ластик, чтобы стирать зоны и объекты протяжкой.
      if(ev.button===0&&ed.tool==='cursor'){editorPlacementClick(mx,my);ev.preventDefault();return;}
      if (ev.button === 0 && ed.tool === 'entry') {
        placeEditorEntry(c, r);
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && ed.tool === 'spawn') {
        // Клик — поставить/снять точку появления; протяжка — только ставит
        // (без снятия), как у «Земли»/«Покрытия».
        pushEditorUndo();
        toggleEditorSpawn(c, r);
        dirtPaintingRef.current = true;
        ev.currentTarget.setPointerCapture(ev.pointerId);
        ev.currentTarget.style.cursor = 'crosshair';
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && (ed.tool === 'stone' || ed.tool === 'tree')) {
        editorPlacementClick(mx, my);
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && ed.tool === 'battle') {
        placeBattleCell(c, r);
        ev.preventDefault();
        return;
      }
      if ((ev.button === 0 || ev.button === 2) && (ed.tool === 'paint'||ed.tool==='fill')) {
        // Кисть локации: ЛКМ — выбранный материал, ПКМ — ластик. Росчерк ставит
        // один снимок отмены; контур локации пересчитается на отпускании.
        ensureDraftPaint(ed);
        pushEditorUndo(true);
        ed.paintLast=undefined;
        if(ed.tool==='fill'){
          fillPaintArea(ed,ev.button===2?'erase':ed.pmat,mx,my,s.field.cellW,s.field.cellH);
          setPaintOverride(ed.pcv,true);ed.dirty=true;refreshEditorPreview();syncEditorView();ev.preventDefault();return;
        }
        paintStrokeRef.current = true;
        stampPaintBrush(ed, ev.button === 2 ? 'erase' : ed.pmat, mx, my, s.field.cellW, s.field.cellH);
        if (ed.pcv) setPaintOverride(ed.pcv, false);
        ed.dirty = true;
        ev.currentTarget.setPointerCapture(ev.pointerId);
        ev.currentTarget.style.cursor = 'crosshair';
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && (ed.tool === 'dirt' || ed.tool === 'ground')) {
        pushEditorUndo();
        dirtPaintingRef.current = true;
        paintEditorCellObject(ed.tool === 'ground' ? 'ground' : 'dirt', c, r);
        ev.currentTarget.setPointerCapture(ev.pointerId);
        ev.currentTarget.style.cursor = 'crosshair';
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && isElevationTool(ed.tool)) {
        pushEditorUndo();
        dirtPaintingRef.current = true;
        beginElevStroke(ed.tool, c, r);
        if(ed.elevFree){endElevStroke();dirtPaintingRef.current=false;}
        ev.currentTarget.setPointerCapture(ev.pointerId);
        ev.currentTarget.style.cursor = 'crosshair';
        ev.preventDefault();
        return;
      }
      if (ev.button === 0 && ed.tool === 'select') {
        // «Перенести»: клик внутри выделения — вырезать кусок и повести его за
        // курсором (поставится на отпускании); клик мимо — рисуем новое выделение.
        const inside =
          ed.selRect && c >= ed.selRect.c0 && c <= ed.selRect.c1 && r >= ed.selRect.r0 && r <= ed.selRect.r1;
        if (ed.selFloat) dropEditorSelection();
        if (inside) {
          pickEditorSelection(c, r);
          ev.currentTarget.setPointerCapture(ev.pointerId);
          ev.currentTarget.style.cursor = 'move';
          ev.preventDefault();
          return;
        }
      }
      ed.drag = { c0: c, r0: r, c1: c, r1: r, erase: ev.button === 2 };
      ev.currentTarget.setPointerCapture(ev.pointerId);
      ev.currentTarget.style.cursor = 'crosshair';
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    const s = settingsRef.current;
    const { mx, my } = canvasPoint(ev);
    // Манекен тащится всегда (и в комнате с игроками — это его смысл):
    // захват до проверки манекенов, чтобы живые коты его не блокировали.
    const tObj = hitDummyObjAt(s, mx, my);
    if (tObj) {
      dragRef.current = {
        key: DUMMY_ID,
        grabDX: mx - tObj.x,
        grabDY: my - tObj.y,
        x: tObj.x,
        y: tObj.y,
        w: tObj.w,
        h: tObj.h,
        lastX: mx,
        lastY: my,
        lastT: performance.now(),
        moved: false,
      };
      // Комната видит курсор с именем тащщего; своё имя рисуем тоже — после dummyGrab.
      const net = netRef.current;
      if (net?.ready) net.emit('dummyGrab');
      ev.currentTarget.setPointerCapture(ev.pointerId);
      ev.currentTarget.style.cursor = 'grabbing';
      ev.preventDefault();
      return;
    }
    const t = hitTargetAt(s, mx, my);
    if (!t) return;
    if (liveRemotesRef.current.length > 0) return; // чужих игроков не таскаем
    if (t.id === s.controlled) return; // активную (управляемую) модель перетаскивать нельзя
    const sprT = spritesRef.current[t.sprite] ?? null;
    const pos = { x: t.col * s.field.cellW, y: t.row * s.field.cellH };
    const b = spriteBoxOf(s, sprT ? sprT.width / sprT.height : 2 / 3, 0, 0, t.scale);
    dragRef.current = {
      key: t.id,
      grabDX: mx - pos.x,
      grabDY: my - pos.y,
      x: pos.x,
      y: pos.y,
      w: b.w,
      h: b.h,
      lastX: mx,
      lastY: my,
      lastT: performance.now(),
      moved: false,
    };
    // захват указателя: move/up продолжают приходить даже за пределами канваса
    ev.currentTarget.setPointerCapture(ev.pointerId);
    ev.currentTarget.style.cursor = 'grabbing';
    ev.preventDefault();
  };

  /** Завершение перетаскивания: манекен ставится в клетку под его центром; если она
   *  занята другим персонажем — берётся ближайшая свободная. */
  const dropTarget = () => {
    const dg = dragRef.current;
    if (!dg) return;
    dragRef.current = null;
    skipClickRef.current = dg.moved;
    const cv = canvasRef.current;
    if (cv) cv.style.cursor = '';
    const s = settingsRef.current;
    let c = Math.floor((dg.x + dg.w / 2) / s.field.cellW);
    let r = Math.floor((dg.y + dg.h / 2) / s.field.cellH);
    c = Math.min(Math.max(c, 0), s.field.cols - 1);
    r = Math.min(Math.max(r, 0), s.field.rows - 1);
    if (dg.key === DUMMY_ID) {
      // Манекен — общий предмет: с котами не конфликтует, ставится в клетку под центром
      // и отправляет финальную позицию на сервер (без ожидания темпа рассылки).
      dummyPosRef.current = { x: c, y: r };
      dummySyncRef.current.at = performance.now();
      const net = netRef.current;
      if (net?.ready) {
        net.emit('dummyMove', { x: c, y: r });
        net.emit('dummyDrop');
      }
      return;
    }
    const e = engineRef.current;
    const mp = s.controlled === 'main' ? null : mainSavedRef.current;
    // занято любым персонажем, кроме перетаскиваемого: управляемый (движок),
    // свой кот (когда стоит сам) и остальные манекены
    const occupied = (cc: number, cr: number) => {
      if (dg.key !== s.controlled && e.col === cc && e.row === cr) return true;
      if (s.controlled !== 'main' && mp && mp.col === cc && mp.row === cr) return true;
      return dummiesOf(s, liveRemotesRef.current).some((d) => d.id !== dg.key && d.col === cc && d.row === cr);
    };
    if (occupied(c, r)) {
      search: for (let rad = 1; rad <= 4; rad++) {
        for (let drr = -rad; drr <= rad; drr++) {
          for (let dcc = -rad; dcc <= rad; dcc++) {
            if (Math.max(Math.abs(dcc), Math.abs(drr)) !== rad) continue;
            const cc = c + dcc;
            const cr = r + drr;
            if (cc < 0 || cc >= s.field.cols || cr < 0 || cr >= s.field.rows) continue;
            if (!occupied(cc, cr)) {
              c = cc;
              r = cr;
              break search;
            }
          }
        }
      }
    }
    const cur = s.dummies.find((d) => d.id === dg.key);
    if (!cur || (cur.col === c && cur.row === r)) return; // позиция не изменилась
    patchDummy(dg.key, { col: c, row: r });
  };

  const onUp = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    // Редактор: отпускание кнопки завершает рисунок — прямоугольник становится
    // зоной; росчерк «Земли» просто заканчивается (отмена уже записана).
    const ed = editorRef.current;
    if(ed){ed.panDrag=undefined;ed.paintLast=undefined;}
    dirtPaintingRef.current = false;
    endElevStroke();
    // Мазок кисти закончен: пересчитываем контур локации по обновлённой маске.
    if (paintStrokeRef.current) {
      paintStrokeRef.current = false;
      if (ed?.pcv) {setPaintOverride(ed.pcv, true);refreshEditorPreview();}
    }
    if (editorOpenRef.current && ed) {
      try {
        ev.currentTarget.releasePointerCapture(ev.pointerId);
      } catch {
        /* захват мог уже сняться */
      }
      // «Перенести»: отпускание кнопки ставит плавающий кусок на место.
      if (ed.selFloat) dropEditorSelection();
      commitEditorDrag();
      syncEditorView();
      const cvE = canvasRef.current;
      if (cvE) cvE.style.cursor = 'crosshair';
      return;
    }
    if (!dragRef.current) return;
    try {
      ev.currentTarget.releasePointerCapture(ev.pointerId);
    } catch {
      /* захват мог уже сняться */
    }
    dropTarget();
  };

  /** ПКМ в редакторе — стирание без смены инструмента; вне редактора меню не нужно. */
  const onContextMenu = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    ev.preventDefault();
  };

  const onClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    // клик сразу после перетаскивания маршрут не строит
    if (skipClickRef.current) {
      skipClickRef.current = false;
      return;
    }
    // В редакторе клики обрабатывает рисунок зон (pointer down/up) — маршруты не строим.
    if (editorOpenRef.current && editorRef.current) return;
    const s = settingsRef.current;
    const e = engineRef.current;
    const testMode = fieldFormatRef.current === 'test';
    let { mx, my } = canvasPoint(ev);
    if (testMode) {
      const cvp = canvasRef.current;
      if (!cvp) return;
      const rect = cvp.getBoundingClientRect();
      const wpt = screenToWorld(
        ev.clientX - rect.left,
        ev.clientY - rect.top,
        cvp.clientWidth,
        cvp.clientHeight,
        camRef.current.x,
        camRef.current.y,
        camFxRef.current.z,
        camYawRef.current,
      );
      mx = wpt.x;
      my = wpt.y;
      // Поправка на подъём земли: клик по видимой поверхности возвышенности
      // указывает в её клетку, а не в землю перед обрывом — с ближнего ракурса
      // на возвышенность теперь можно и кликнуть, и забраться.
      const ground = groundPointAtWorld(mx, my, s.field.cellW, s.field.cellH, camYawRef.current);
      mx = ground.x;
      my = ground.y;
      if (!s.arrow.battleMode) {
        // мирный «тест»: клик пускает свободную ходьбу до точки (по прямой,
        // стены обкатываются скольжением); клавиши перебивают цель.
        // Со строгими заходами клик в боевую зону цель не ставит: туда
        // всё равно не пустит ходьба — вход только через клетку захода.
        const wx = mx / s.field.cellW;
        const wy = my / s.field.cellH;
        if (!testPointInIsland(wx, wy)) return;
        if (testEntryStrict() && testPeaceBattleBlocked(wx, wy)) return;
        const hb = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        e.ptarget = { x: wx - hb.dx, y: wy - hb.dy, stuck: 0, lastD: 1e9 };
        return;
      }
      // боевой «тест»: клик по проходимой клетке или клетке захода строит маршрут
      // по клеткам; при открытой логике (без заходов) клик по траве вне зоны —
      // выход в мирный режим и ходьба к точке
      const wxB = mx / s.field.cellW;
      const wyB = my / s.field.cellH;
      const cB = Math.floor(wxB);
      const rB = Math.floor(wyB);
      const walkableClick =
        cB >= 0 && cB < s.field.cols && rB >= 0 && rB < s.field.rows && (testWalkableCell(cB, rB) || !!testEntryAt(cB, rB));
      if (
        !walkableClick &&
        !testEntryStrict() &&
        !testPointInCellsZone(wxB, wyB) &&
        testPointInIsland(wxB, wyB)
      ) {
        const hbB = peaceHalfBox(s, spritesRef.current[s.character.sprite]);
        e.ptarget = { x: wxB - hbB.dx, y: wyB - hbB.dy, stuck: 0, lastD: 1e9 };
        inZonePrevRef.current = true; // ещё внутри зоны — бой выключится по выходу центра
        setSettings((p) => ({ ...p, arrow: { ...p.arrow, battleMode: false } }));
        return;
      }
      if (!walkableClick) return;
      const c = cB;
      const r = rB;
      // клетки персонажей непроходимы — маршрут через/на них не строится;
      // в «тесте» непроходимы и клетки вне зон клеточной ходьбы
      const mp = s.controlled === 'main' ? null : mainSavedRef.current;
      e.path = bfsPath(
        e.col,
        e.row,
        c,
        r,
        s.field.cols,
        s.field.rows,
        [
          ...othersOf(s, s.controlled, mp, liveRemotesRef.current, objectExtras()).map((t) => ({ c: t.col, r: t.row })),
          ...(testMode ? testBattleRouteBlocked() : []),
        ],
      );
      return;
    }
    const c2 = Math.floor(mx / s.field.cellW);
    const r2 = Math.floor(my / s.field.cellH);
    if (c2 < 0 || c2 >= s.field.cols || r2 < 0 || r2 >= s.field.rows) return;
    // клетки персонажей непроходимы — маршрут через/на них не строится
    const mp2 = s.controlled === 'main' ? null : mainSavedRef.current;
    e.path = bfsPath(
      e.col,
      e.row,
      c2,
      r2,
      s.field.cols,
      s.field.rows,
      othersOf(s, s.controlled, mp2, liveRemotesRef.current, objectExtras()).map((t) => ({ c: t.col, r: t.row })),
    );
  };
  return { canvasPoint, hitTargetAt, hitDummyObjAt, onMove, onLeave, onPointerDown, onUp, onContextMenu, onClick, dropTarget };
}

