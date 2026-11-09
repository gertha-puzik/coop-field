import { terrainAt, terrainBrushBounds, stampTerrainRect, sanitizeTerrainElev, freeTerrainPlacement } from '@/lib/sim/terrain-shape';
import { stampElevation, type ElevationTool } from '@/lib/sim/terrain-editor';
/**
 * Verbatim editor draft operations carved out of simulator.tsx (W5b stage 2,
 * behavior-preserving): draft sync/preview/undo, open/close, tool pick,
 * object picking/placement, zone surgery, brushes, spawns, entry, save.
 * Plain per-render factory (no hooks): bodies byte-identical, closures
 * capture the same bindings, Simulator destructures at the original
 * position, so existing captures (rAF, mouse tools, JSX) keep identical
 * function identities per render.
 */
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Engine } from './sim-model';
import type { SimSettings } from '@/lib/sim/settings';
import { EDITOR_PASS_KEY, SETMAP_MIN_GAP_MS, type EditorDraft, type EditorPlace, type EditorTool } from '@/lib/sim/editor-model';
import { copyPaintCanvas, encodeDraftPaint, encodeDraftPaintAsync } from '@/lib/sim/paint';
import { createCoopClient } from '@/lib/net/coop';
import { ensurePaintDecoded, paintCellCoverage, paintPointOn, PAINT_CELL_H, PAINT_CELL_W, setPaintOverride, setTestMap, testObstacleBodies, testObjectAt } from '@/lib/sim/test-field';
import { newObjectId, newZoneId, objectBase, objectMir, objectRotDeg, objectScale, objectSprite, mapHasPaint, paintFormatError, TERRAIN_MAX_LEVEL, TEST_MAP_LIMITS, testMapConnectivityError, type GroundCover, type TestMap, type TestMapEntryDir, type TestMapObject, type TestMapSpawn, type TestMapZone, type TestMapZoneKind } from '@/lib/sim/test-map';
import { rr } from '@/lib/sim/geometry';
import { buildEditorSelect, type EditorSelState } from './editor-select';
import { buildEditorCells } from './editor-cells';

export type { EditorSelState } from './editor-select';

export interface EditorOpsParams {
  editorRef: RefObject<EditorDraft | null>;
  camRef: RefObject<{ x: number; y: number; init: boolean }>;
  netRef: RefObject<ReturnType<typeof createCoopClient> | null>;
  savedMapRef: RefObject<TestMap>;
  elevStrokeRef: RefObject<{ touched: Set<string>; flat: number } | null>;
  editorCoverRef: RefObject<GroundCover>;
  editorEntryDirRef: RefObject<TestMapEntryDir>;
  editorPlaceRef: RefObject<EditorPlace | null>;
  engineRef: RefObject<Engine>;
  lastSprRef: RefObject<{ tree: string; stone: string }>;
  settingsRef: RefObject<SimSettings>;
  patchEditorPlace: (p: Partial<EditorPlace>) => void;
  setPaintOverride: (cv: HTMLCanvasElement | null, rebuild: boolean) => void;
  setTestMap: (map: TestMap) => void;
  setEditorView: Dispatch<SetStateAction<EditorDraft | null>>;
  setEditorOpen: Dispatch<SetStateAction<boolean>>;
  setEditorMsg: Dispatch<SetStateAction<string | null>>;
  setEditorPlace: Dispatch<SetStateAction<EditorPlace | null>>;
  /** Прогресс сохранения локации (фазы: кодирование рисунка → отправка → подтверждение сервера). */
  setEditorSave: Dispatch<SetStateAction<EditorSaveState | null>>;
  /** Синхронизация размеров поля настроек с черновиком: рисунок локации тянется
   *  на px мира именно по settings.field — рассинхрон после смены размера мира
   *  растягивал/сдвигал текстуры (баг «съехавших текстур» при уменьшении). */
  patchField: (p: { cols: number; rows: number }) => void;
  /** Состояние инструмента «Перенести»: вырезанный кусок (холст + уехавшие объекты). */
  editorSelRef: RefObject<EditorSelState | null>;
}

/** Прогресс сохранения локации: фаза, размер рисунка, время старта (для секунд в UI). */
export type EditorSaveState = { phase: 'encode' | 'send' | 'wait'; bytes: number; t0: number };


export function buildEditorOps(params: EditorOpsParams) {
  const {
    editorRef,
    camRef,
    netRef,
    savedMapRef,
    elevStrokeRef,
    editorCoverRef,
    editorEntryDirRef,
    editorPlaceRef,
    engineRef,
    lastSprRef,
    settingsRef,
    patchEditorPlace,
    setPaintOverride,
    setTestMap,
    setEditorView,
    setEditorOpen,
    setEditorMsg,
    setEditorPlace,
    setEditorSave,
    patchField,
    editorSelRef,
  } = params;
  const syncEditorView = () => {
    const d = editorRef.current;
    if (!d) return;
    setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
  };

  const draftMap = (d: EditorDraft, withPaint = true): TestMap => ({
    // Правки редактора сохраняются в текущей версии конфига (v2 — деление поля
    // на траву и боевые клетки).
    v: 2,
    cols: d.cols,
    rows: d.rows,
    margin: savedMapRef.current.margin,
    seed: savedMapRef.current.seed,
    zones: d.zones.map((z) => ({ ...z })),
    objects: d.objects.map((o) => ({ ...o })),
    spawns: d.spawns.map((s) => ({ ...s })),
    ...(Object.keys(d.elev).length > 0 ? { elev: { ...d.elev } } : {}),
    // Кисть локации: холст черновика уходит в конфиг PNG base64. С рисунком
    // проталины/покрытия больше не нужны (запечены) — как в sanitize.
    ...(withPaint && d.pcv ? { paint: encodeDraftPaint(d) } : {}),
  });

  /** Черновик сразу рисуется на поле (WYSIWYG): setTestMap пересобирает кэши.
   *  Холст кисти черновика подменяет декодированный рисунок: мазки видны сразу,
   *  без PNG-декодирования на каждый росчерк. */
  const applyDraftPreview = () => {
    const d = editorRef.current;
    if (!d) return;
    setTestMap(draftMap(d));
    if (d.pcv) setPaintOverride(d.pcv, true);
  };

  const pushEditorUndo = (withPaint = false) => {
    const d = editorRef.current;
    if (!d) return;
    const entry: EditorDraft['undo'][number] = { zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), spawns: d.spawns.map((s) => ({ ...s })), elev: { ...d.elev }, cols: d.cols, rows: d.rows };
    // Инструмент «Перенести» режет и пиксельную отрисовку — её откат нужен тем же
    // шагом отмены (снимок холста кладётся в ту же запись, память — как у мазков).
    if (withPaint && d.pcv) {
      try {
        entry.paint = d.pcv.getContext('2d')?.getImageData(0, 0, d.pcv.width, d.pcv.height) ?? undefined;
      } catch {
        /* холст мог быть испорчен — отмена коснётся только данных */
      }
    }
    d.undo.push(entry);
    if (d.undo.length > 40) d.undo.shift();
  };

  const { pickEditorSelection, dragEditorSelection, dropEditorSelection } = buildEditorSelect({
    editorRef,
    editorSelRef,
    setPaintOverride,
    setEditorMsg,
    pushEditorUndo,
    applyDraftPreview,
    syncEditorView,
  });

  const { paintEditorCellObject, placeBattleCell, addEditorSpawn, toggleEditorSpawn, placeEditorEntry } = buildEditorCells({
    editorRef,
    editorCoverRef,
    editorEntryDirRef,
    setEditorMsg,
    pushEditorUndo,
    applyDraftPreview,
    syncEditorView,
  });

  const openEditor = () => {
    const m = savedMapRef.current;
    const draft: EditorDraft = {
      zones: m.zones.map((z) => ({ ...z })),
      objects: (m.objects ?? []).map((o) => ({ ...o })),
      spawns: (m.spawns ?? []).map((s) => ({ ...s })),
      elev: { ...(m.elev ?? {}) },
      elevBrush: { width: 1, depth: 1, level: 1 },
      pcv: copyPaintCanvas(),
      pmat: 'grass-1',
      psize: 24,
      pshape: 'round',
      pundo: [],
      pdirty: false,
      ppaint: m.paint ?? null,
      cols: m.cols,
      rows: m.rows,
      tool: 'cells',
      drag: null,
      selRect: null,
      selFloat: null,
      undo: [],
      sel: [],
      dirty: false,
    };
    editorRef.current = draft;
    setEditorView({ ...draft, zones: draft.zones.map((z) => ({ ...z })), objects: draft.objects.map((o) => ({ ...o })), undo: [] });
    // Рисунок локации ещё декодируется (конфиг пришёл только что): как только
    // готов, черновик получает его копию — кисть правит сохранённый рисунок.
    if (mapHasPaint(m) && !draft.pcv) {
      void ensurePaintDecoded().then((ok2) => {
        const d = editorRef.current;
        if (!ok2 || !d || d.pcv || d.pdirty) return;
        d.pcv = copyPaintCanvas();
        if (d.pcv) setPaintOverride(d.pcv, true);
        syncEditorView();
      });
    }
    patchOrClearPlace(null);
    setEditorMsg(null);
    // Удаляем устаревший пароль из хранилища старых версий клиента.
    try {
      localStorage.removeItem(EDITOR_PASS_KEY);
    } catch {
      /* приватный режим — localStorage недоступен, чистить нечего */
    }
    setEditorOpen(true);
    // Режим редактирования выключает мирную ходьбу: цель клика и маршрут гасим.
    const e = engineRef.current;
    e.ptarget = null;
    e.path = [];
    e.hover = null;
    camRef.current.init = false;
  };

  const closeEditor = () => {
    editorRef.current = null;
    setEditorOpen(false);
    setEditorView(null);
    setEditorMsg(null);
    // Черновик без записи: поле возвращается к сохранённой сервером локации.
    setTestMap(savedMapRef.current);
    // Подмену рисунка (черновой холст кисти) снимаем: декодируем заново рисунок
    // сохранённой локации, если он есть.
    void ensurePaintDecoded();
    camRef.current.init = false;
  };

  const setEditorTool = (tool: EditorTool) => {
    const d = editorRef.current;
    if (!d) return;
    // Уход с инструмента «Перенести» с «плавающим» куском — ставим его на текущее
    // место: вырезанным локация остаться не должна.
    if (d.tool === 'select' && tool !== 'select' && d.selFloat) dropEditorSelection();
    d.tool = tool;
    if (tool !== 'select') {
      d.selRect = null;
      d.selFloat = null;
      editorSelRef.current = null;
    }
    // Камень/дерево: сразу создаём «призрак» постановки — следует за курсором,
    // размер/поворот подгоняются до клика-фиксации; остальные инструменты его снимают.
    if (tool === 'tree' || tool === 'stone') {
      const p = editorPlaceRef.current;
      if (!p || p.kind !== tool) {
        patchEditorPlace({
          kind: tool,
          spr: lastSprRef.current[tool],
          anchored: false,
          pickId: null,
        });
      }
    } else {
      patchOrClearPlace(null);
    }
    syncEditorView();
  };

  /** Полная очистка ставящегося объекта (ref + state). */
  const patchOrClearPlace = (p: EditorPlace | null) => {
    editorPlaceRef.current = p;
    setEditorPlace(p);
  };

  /** Зажим точки опоры призрака в пределы мира (плюс небольшой запас по краям). */
  const clampPlacePos = (x: number, y: number): { x: number; y: number } => {
    const d = editorRef.current;
    if (!d) return { x, y };
    return {
      x: Math.min(d.cols + 0.5, Math.max(-0.5, Math.round(x * 100) / 100)),
      y: Math.min(d.rows + 1.5, Math.max(-0.2, Math.round(y * 100) / 100)),
    };
  };

  /** Препятствие под курсором (для подъёма существующего объекта в призрак).
 *  Считается расстояние до точки опоры тела; exceptId — чей-то поднятый объект. */
  const pickObstacleAt = (mx: number, my: number, exceptId: string | null): TestMapObject | null => {
    const s = settingsRef.current;
    let best: TestMapObject | null = null;
    let bestD = 34; // px вокруг точки опоры — щедрый захват
    for (const ob of testObstacleBodies()) {
      if (exceptId && ob.o.id === exceptId) continue;
      const dist = Math.hypot(mx - ob.x * s.field.cellW, my - ob.y * s.field.cellH);
      if (dist < bestD) {
        bestD = dist;
        best = ob.o;
      }
    }
    return best;
  };

  /** Подъём существующего препятствия в призрак: оригинал остаётся в черновике,
   * но скрывается — ✓ поставит правленый объект вместо него, ✕ вернёт как было. */
  const liftObstacleToPlace = (o: TestMapObject) => {
    const b = objectBase(o);
    lastSprRef.current[o.kind === 'tree' ? 'tree' : 'stone'] = objectSprite(o);
    patchEditorPlace({
      kind: o.kind === 'tree' ? 'tree' : 'stone',
      spr: objectSprite(o),
      s: objectScale(o),
      rot: objectRotDeg(o),
      mir: objectMir(o),
      x: b.x,
      y: b.y,
      anchored: true,
      pickId: o.id,
    });
  };

  /** Клик инструментом камня/дерева: фиксация/перенос точки призрака или подъём
   *  существующего объекта под курсором. */
  const editorPlacementClick = (mx: number, my: number) => {
    const p = editorPlaceRef.current;
    if (!p) return;
    const s = settingsRef.current;
    if (p.anchored) {
      // клик по другому объекту — поднимаем его; по земле — переносим точку
      const hit = pickObstacleAt(mx, my, p.pickId);
      if (hit) {
        liftObstacleToPlace(hit);
        return;
      }
      const b = clampPlacePos(mx / s.field.cellW, my / s.field.cellH);
      patchEditorPlace(b);
      return;
    }
    const hit = pickObstacleAt(mx, my, null);
    if (hit) {
      liftObstacleToPlace(hit);
      return;
    }
    const b = clampPlacePos(mx / s.field.cellW, my / s.field.cellH);
    patchEditorPlace({ ...b, anchored: true });
  };

  /** ✓ — поставить: поднятый объект заменяется, новый добавляется; призрак
   *  остаётся неприкреплённым — можно ставить следующий сразу. */
  const confirmEditorPlace = () => {
    const d = editorRef.current;
    const p = editorPlaceRef.current;
    if (!d || !p) return;
    if (d.objects.length - (p.pickId ? 1 : 0) >= TEST_MAP_LIMITS.objectsMax) {
      setEditorMsg(`Объектов не больше ${TEST_MAP_LIMITS.objectsMax}.`);
      return;
    }
    pushEditorUndo();
    d.objects = d.objects.filter((o) => o.id !== p.pickId);
    d.objects.push({
      id: newObjectId(),
      kind: p.kind,
      spr: p.spr,
      s: p.s,
      rot: p.rot,
      mir: p.mir,
      x: p.x,
      y: p.y,
      c: Math.min(d.cols - 1, Math.max(0, Math.floor(p.x))),
      r: Math.min(d.rows - 1, Math.max(0, Math.floor(p.y - 0.01))),
      pos: 'center',
    });
    d.dirty = true;
    lastSprRef.current[p.kind] = p.spr;
    patchEditorPlace({ pickId: null, anchored: false });
    applyDraftPreview();
    syncEditorView();
  };

  /** ✕ — отмена: поднятый объект возвращается (он никуда не удалялся из черновика). */
  const cancelEditorPlace = () => {
    const d = editorRef.current;
    patchOrClearPlace(null);
    if (d) {
      applyDraftPreview();
      syncEditorView();
    }
  };

  /** Смена размера мира: зоны и препятствия, вылезшие за новый край, обрезаются/удаляются. */
  const resizeEditorWorld = (cols: number, rows: number) => {
    const d = editorRef.current;
    if (!d) return;
    const nc = Math.min(TEST_MAP_LIMITS.colsMax, Math.max(TEST_MAP_LIMITS.colsMin, cols));
    const nr = Math.min(TEST_MAP_LIMITS.rowsMax, Math.max(TEST_MAP_LIMITS.rowsMin, rows));
    if (nc === d.cols && nr === d.rows) return;
    pushEditorUndo();
    d.cols = nc;
    d.rows = nr;
    const kept: TestMapZone[] = [];
    for (const z of d.zones) {
      const c1 = Math.min(z.c1, nc - 1);
      const r1 = Math.min(z.r1, nr - 1);
      if (z.c0 <= c1 && z.r0 <= r1) kept.push({ ...z, c1, r1 });
    }
    d.zones = kept;
    d.objects = d.objects.filter((o) => {
      if (o.kind === 'stone' || o.kind === 'tree') {
        const b = objectBase(o);
        return b.x < nc && b.y - 0.01 < nr;
      }
      return o.c < nc && o.r < nr;
    });
    // Клетки спавна за новым краем тоже исчезают — иначе сервер откажет всей
    // правке («спавн №N: вне границ мира»).
    d.spawns = d.spawns.filter((s) => s.c < nc && s.r < nr);
    // Клетки высот за новым краем мира исчезают вместе с краем.
    const keptElev: Record<string, number> = {};
    for (const [key, lv] of Object.entries(d.elev)) {
      const [c, r] = key.split(',').map(Number);
      if (c < nc && r < nr) keptElev[key] = lv;
    }
    d.elev = sanitizeTerrainElev(keptElev,nc,nr,TERRAIN_MAX_LEVEL) ?? {};
    // Выделение «Перенести» живёт в старых координатах — плавающий кусок
    // ставится на текущее место, само выделение снимается.
    if (d.selFloat) dropEditorSelection();
    d.selRect = null;
    d.selFloat = null;
    editorSelRef.current = null;
    // Холст кисти живёт в канонических пикселях мира: при смене размера — новый
    // холст нужного размера, старый рисунок переносится 1:1 (вылезшее — срезано,
    // добавленное — пустота за кромкой).
    if (d.pcv) {
      const next = document.createElement('canvas');
      next.width = nc * PAINT_CELL_W;
      next.height = nr * PAINT_CELL_H;
      const g = next.getContext('2d');
      if (g) {
        g.imageSmoothingEnabled = false;
        g.drawImage(d.pcv, 0, 0);
      }
      d.pcv = next;
      d.pundo = [];
      d.pdirty = true;
      setPaintOverride(next, true);
    }
    d.dirty = true;
    // Размеры поля настроек едут вместе с черновиком: отрисовка тянет рисунок
    // локации на px мира именно по ним (см. patchField в параметрах).
    patchField({ cols: nc, rows: nr });
    applyDraftPreview();
    syncEditorView();
  };

  const subtractFromZone = (
    z: TestMapZone,
    cut: { c0: number; r0: number; c1: number; r1: number },
  ): TestMapZone[] => {
    const c0 = Math.max(z.c0, cut.c0);
    const r0 = Math.max(z.r0, cut.r0);
    const c1 = Math.min(z.c1, cut.c1);
    const r1 = Math.min(z.r1, cut.r1);
    if (c0 > c1 || r0 > r1) return [z];
    const pieces: TestMapZone[] = [];
    if (z.r0 < r0) pieces.push({ ...z, id: newZoneId(), r0: z.r0, r1: r0 - 1 });
    if (z.r1 > r1) pieces.push({ ...z, id: newZoneId(), r0: r1 + 1, r1: z.r1 });
    if (z.c0 < c0) pieces.push({ ...z, id: newZoneId(), c0: z.c0, c1: c0 - 1, r0, r1 });
    if (z.c1 > c1) pieces.push({ ...z, id: newZoneId(), c0: c1 + 1, c1: z.c1, r0, r1 });
    return pieces;
  };

  /** Завершение рисунка: прямоугольник становится зоной (или стирает зоны ластиком;
   *  инструмент «Перенести» запоминает область выделением). */
  const commitEditorDrag = () => {
    const d = editorRef.current;
    if (!d || !d.drag) return;
    const drag = d.drag;
    d.drag = null;
    const c0 = Math.min(drag.c0, drag.c1);
    const c1 = Math.max(drag.c0, drag.c1);
    const r0 = Math.min(drag.r0, drag.r1);
    const r1 = Math.max(drag.r0, drag.r1);
    if (c1 < c0 || r1 < r0) {
      syncEditorView();
      return;
    }
    if (d.tool === 'select' && !drag.erase) {
      d.selRect = { c0, r0, c1, r1 };
      syncEditorView();
      return;
    }
    pushEditorUndo();
    if (drag.erase || d.tool === 'erase') {
      d.zones = d.zones.flatMap((z) => subtractFromZone(z, { c0, r0, c1, r1 }));
      // ластик снимает препятствия (по точке опоры), клеточные объекты
      // (землю/покрытие/заход) и клетки спавна внутри стёртого прямоугольника
      d.objects = d.objects.filter((o) => {
        if (o.kind === 'stone' || o.kind === 'tree') {
          const b = objectBase(o);
          const fc = Math.floor(b.x);
          const fr = Math.floor(b.y - 0.01);
          return !(fc >= c0 && fc <= c1 && fr >= r0 && fr <= r1);
        }
        return !(o.c >= c0 && o.c <= c1 && o.r >= r0 && o.r <= r1);
      });
      d.spawns = d.spawns.filter((s) => !(s.c >= c0 && s.c <= c1 && s.r >= r0 && s.r <= r1));
      // и срезает рельеф: стёртый участок возвращается к базовой земле
      if(stampTerrainRect(d.elev,{x:c0,y:r0,w:c1-c0+1,d:r1-r0+1,level:0},'height',0,new Set(),0,TERRAIN_MAX_LEVEL)) applyDraftPreview();
    } else {
      const kind: TestMapZoneKind = d.tool === 'green' ? 'green' : 'cells';
      const n = d.zones.filter((z) => z.kind === kind).length + 1;
      d.zones = [
        ...d.zones,
        {
          id: newZoneId(),
          name: kind === 'cells' ? `Клетки ${n}` : `Зелёная зона ${n}`,
          kind,
          c0,
          r0,
          c1,
          r1,
        },
      ];
    }
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  const deleteEditorZone = (id: string) => {
    const d = editorRef.current;
    if (!d) return;
    pushEditorUndo();
    d.zones = d.zones.filter((z) => z.id !== id);
    d.sel = d.sel.filter((s) => s !== id);
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  /** Отметка зоны для объединения (галка в списке зон). */
  const toggleEditorSel = (id: string) => {
    const d = editorRef.current;
    if (!d) return;
    d.sel = d.sel.includes(id) ? d.sel.filter((s) => s !== id) : [...d.sel, id];
    syncEditorView();
  };

  /** Объединение отмеченных зон в одну: общий охватывающий прямоугольник, тип и
   *  имя — от первой отмеченной в списке. Зоны — прямоугольники, поэтому союз
   *  двух угловатых областей — это всегда их охват (клетки между ними входят). */
  const mergeEditorZones = () => {
    const d = editorRef.current;
    if (!d) return;
    const chosen = d.zones.filter((z) => d.sel.includes(z.id));
    if (chosen.length < 2) return;
    pushEditorUndo();
    const first = chosen[0];
    const merged: TestMapZone = {
      id: newZoneId(),
      name: first.name,
      kind: first.kind,
      c0: Math.min(...chosen.map((z) => z.c0)),
      r0: Math.min(...chosen.map((z) => z.r0)),
      c1: Math.max(...chosen.map((z) => z.c1)),
      r1: Math.max(...chosen.map((z) => z.r1)),
    };
    d.zones = [...d.zones.filter((z) => !d.sel.includes(z.id)), merged];
    d.sel = [];
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

    /**
   * Кисть рельефа: «насыпать» (+1 уровень, предел 3), «срыть» (−1, до базовой
   * земли) и «ровно» (срезает все клетки росчерка на уровень первой клетки).
   * Росчерк пишет отмену один раз и не обрабатывает клетку дважды — протяжка
   * с зажатой кнопкой насыпает уступ целиком (см. pointerdown/pointermove).
   */
  const applyElevBrush = (mode: ElevationTool, c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    if (c < 0 || r < 0 || c >= d.cols || r >= d.rows) return false;
    const stroke = elevStrokeRef.current;
    if (!stroke) return false;
    const b = d.elevBrush ?? {width:1,depth:1,level:1};
    const rect=d.elevFree&&d.terrainCursor ? freeTerrainPlacement(d.elev,d.terrainCursor.x,d.terrainCursor.y,b.width,b.depth,b.level,d.cols,d.rows,d.elevSnap??'level',d.terrainSnapDistance) : terrainBrushBounds(c,r,b.width,b.depth,d.cols,d.rows);
    if (!stampTerrainRect(d.elev, rect, mode,b.level,stroke.touched,stroke.flat,TERRAIN_MAX_LEVEL)) return false;
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Начало росчерка кисти рельефа: копилка тронутых клеток + уровень «Ровно»
   *  (уровень первой клетки под кистью — весь росчерк срезается в неё). */
  const beginElevStroke = (mode: ElevationTool, c: number, r: number) => {
    const d = editorRef.current;
    const first = d ? terrainAt(d.elev,c+.5,r+.5) : 0;
    elevStrokeRef.current = { touched: new Set(), flat: mode === 'flat' ? first : 0 };
    applyElevBrush(mode, c, r);
  };

  const endElevStroke = () => {
    elevStrokeRef.current = null;
  };

  const renameEditorZone = (id: string, name: string) => {
    const d = editorRef.current;
    if (!d) return;
    const z = d.zones.find((zz) => zz.id === id);
    if (!z) return;
    z.name = name.slice(0, TEST_MAP_LIMITS.nameMax);
    d.dirty = true;
    syncEditorView();
  };

  const undoEditor = () => {
    const d = editorRef.current;
    if (!d || d.undo.length === 0) return;
    // Плавающий кусок «Перенести» при отмене возвращается на место — иначе
    // откат данных уедет от отрисовки (вырезанный участок так и останется пустым).
    if (d.selFloat) dropEditorSelection();
    const back = d.undo.pop()!;
    d.zones = back.zones.map((z) => ({ ...z }));
    d.objects = back.objects.map((o) => ({ ...o }));
    d.spawns = back.spawns.map((s) => ({ ...s }));
    d.elev = { ...back.elev };
    d.cols = back.cols;
    d.rows = back.rows;
    d.selRect = null;
    d.selFloat = null;
    editorSelRef.current = null;
    d.sel = d.sel.filter((id) => d.zones.some((z) => z.id === id));
    if (back.paint && d.pcv && d.pcv.width === back.paint.width && d.pcv.height === back.paint.height) {
      d.pcv.getContext('2d')?.putImageData(back.paint, 0, 0);
      setPaintOverride(d.pcv, true);
    }
    patchField({ cols: d.cols, rows: d.rows });
    applyDraftPreview();
    syncEditorView();
  };

  const resetEditor = () => {
    const d = editorRef.current;
    if (!d) return;
    pushEditorUndo();
    const m = savedMapRef.current;
    d.zones = m.zones.map((z) => ({ ...z }));
    d.objects = (m.objects ?? []).map((o) => ({ ...o }));
    d.spawns = (m.spawns ?? []).map((s) => ({ ...s }));
    d.elev = { ...(m.elev ?? {}) };
    d.cols = m.cols;
    d.rows = m.rows;
    d.selRect = null;
    d.selFloat = null;
    editorSelRef.current = null;
    d.sel = [];
    d.dirty = true;
    patchField({ cols: d.cols, rows: d.rows });
    applyDraftPreview();
    syncEditorView();
  };

  /** Предварительная проверка черновика — те же правила, что у сервера. */
  const editorDraftError = (checkPaint = true): string | null => {
    const d = editorRef.current;
    if (!d) return null;
    // Кисть локации: PNG base64 обязан быть валидным и не слишком большим.
    if (checkPaint && d.pcv) {
      const perr = paintFormatError(encodeDraftPaint(d));
      if (perr) return perr === 'рисунок локации слишком велик' ? 'Рисунок локации слишком велик — сотрите лишнее и сохраните снова.' : perr;
    }
    if (d.pcv) {
      // С рисунком зоны не обязаны быть вовсе (форма — из пикселей), но бой
      // обязан быть: зоны с клетками или одиночные боевые клетки.
      const hasBattle =
        d.zones.some((z) => z.kind === 'cells') || d.objects.some((o) => o.kind === 'battle');
      if (!hasBattle) return 'Нужна хотя бы одна боевая клетка или зона с клетками — иначе бой не работает.';
      return null;
    }
    if (d.zones.length === 0) return 'Нужна хотя бы одна зона.';
    if (!d.zones.some((z) => z.kind === 'cells')) return 'Нужна хотя бы одна зона с клетками.';
    if (d.objects.length > TEST_MAP_LIMITS.objectsMax) return `Препятствий не больше ${TEST_MAP_LIMITS.objectsMax}.`;
    return testMapConnectivityError(d.zones);
  };

  const saveEditorMap = () => {
    const d = editorRef.current;
    const net = netRef.current;
    if (!d || !net) return;
    if (!net.ready) {
      setEditorMsg('Нет связи с сервером.');
      return;
    }
    if (d.selFloat) dropEditorSelection();
    // Сохранение — долгая дорога (кодирование многимегапиксельного рисунка,
    // отправка, серверный декод и пересбор геометрии): каждый этап показываем
    // в панели с секундами, чтобы было видно, что сохранение реально идёт.
    const t0 = Date.now();
    setEditorMsg(null);
    setEditorSave({ phase: 'encode', bytes: 0, t0 });
    const err = editorDraftError(false);
    if (err) { setEditorSave(null); setEditorMsg(err); return; }
    const snapshot = draftMap(d, false);
    void encodeDraftPaintAsync(d)
      .then((paint) => {
        const perr = paint ? paintFormatError(paint) : null;
        if (perr) { setEditorSave(null); setEditorMsg(perr); return; }
        setEditorSave({ phase: 'send', bytes: paint.length, t0 });
        // Предгейт троттлинга сервера (setmap — раз в 10 с на сокет): кадр,
        // отправленный раньше срока, сервер молча отбрасывает — прогресс гас,
        // черновик оставался «не сохранён», и правка выглядела потерянной
        // при повторном открытии редактора. Честно не отправляем и объясняем.
        const nowMs = Date.now();
        const since = nowMs - (d.lastSaveSentAt ?? 0);
        if (since < SETMAP_MIN_GAP_MS) {
          setEditorSave(null);
          setEditorMsg(`Сервер принимает сохранения не чаще раза в 10 секунд — подождите ${Math.ceil((SETMAP_MIN_GAP_MS - since) / 1000)} с и сохраните снова (правка осталась в черновике).`);
          return;
        }
        d.lastSaveSentAt = nowMs;
        setEditorSave({ phase: 'wait', bytes: paint.length, t0 });
        net.emit('setmap', { map: { ...snapshot, ...(paint ? { paint } : {}) } });
      })
      .catch(() => {
        setEditorSave(null);
        setEditorMsg('Не удалось подготовить рисунок локации — попробуйте ещё раз.');
      });
  };
  return {
    syncEditorView, pushEditorUndo, openEditor, closeEditor, setEditorTool,
    clampPlacePos, editorPlacementClick, confirmEditorPlace, cancelEditorPlace,
    resizeEditorWorld, commitEditorDrag, deleteEditorZone, toggleEditorSel,
    mergeEditorZones, paintEditorCellObject, placeBattleCell, applyElevBrush,
    beginElevStroke, endElevStroke, addEditorSpawn, toggleEditorSpawn,
    placeEditorEntry, renameEditorZone, undoEditor, resetEditor, saveEditorMap,
    pickEditorSelection, dragEditorSelection, dropEditorSelection,
  };
}

