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
import { EDITOR_PASS_KEY, type EditorDraft, type EditorPlace, type EditorTool } from '@/lib/sim/editor-model';
import { copyPaintCanvas, encodeDraftPaint } from '@/lib/sim/paint';
import { createCoopClient } from '@/lib/net/coop';
import { ensurePaintDecoded, paintCellCoverage, paintPointOn, PAINT_CELL_H, PAINT_CELL_W, setPaintOverride, setTestMap, testObstacleBodies, testObjectAt } from '@/lib/sim/test-field';
import { newObjectId, newZoneId, objectBase, objectMir, objectRotDeg, objectScale, objectSprite, mapHasPaint, paintFormatError, TERRAIN_MAX_LEVEL, TEST_MAP_LIMITS, testMapConnectivityError, type GroundCover, type TestMap, type TestMapEntryDir, type TestMapObject, type TestMapZone, type TestMapZoneKind } from '@/lib/sim/test-map';
import { rr } from '@/lib/sim/geometry';

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
  setEditorPass: Dispatch<SetStateAction<string>>;
  setEditorPlace: Dispatch<SetStateAction<EditorPlace | null>>;
  editorPass: string;
}

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
    setEditorPass,
    setEditorPlace,
    editorPass,
  } = params;
  const syncEditorView = () => {
    const d = editorRef.current;
    if (!d) return;
    setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
  };

  const draftMap = (d: EditorDraft): TestMap => ({
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
    ...(d.pcv ? { paint: encodeDraftPaint(d) } : {}),
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

  const pushEditorUndo = () => {
    const d = editorRef.current;
    if (!d) return;
    d.undo.push({ zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), spawns: d.spawns.map((s) => ({ ...s })), elev: { ...d.elev }, cols: d.cols, rows: d.rows });
    if (d.undo.length > 40) d.undo.shift();
  };

  const openEditor = () => {
    const m = savedMapRef.current;
    const draft: EditorDraft = {
      zones: m.zones.map((z) => ({ ...z })),
      objects: (m.objects ?? []).map((o) => ({ ...o })),
      spawns: (m.spawns ?? []).map((s) => ({ ...s })),
      elev: { ...(m.elev ?? {}) },
      pcv: copyPaintCanvas(),
      pmat: 'grass-1',
      psize: 24,
      pshape: 'round',
      pundo: [],
      pdirty: false,
      ppaint: null,
      cols: m.cols,
      rows: m.rows,
      tool: 'cells',
      drag: null,
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
    try {
      setEditorPass(localStorage.getItem(EDITOR_PASS_KEY) || '');
    } catch {
      /* приватный режим — пароль вводится вручную */
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
    d.tool = tool;
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
    // Клетки высот за новым краем мира исчезают вместе с краем.
    const keptElev: Record<string, number> = {};
    for (const [key, lv] of Object.entries(d.elev)) {
      const [c, r] = key.split(',').map(Number);
      if (c < nc && r < nr) keptElev[key] = lv;
    }
    d.elev = keptElev;
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
    applyDraftPreview();
    syncEditorView();
  };

  /** Вычитание прямоугольника из зоны: остаток распадается максимум на 4 полосы. */
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

  /** Завершение рисунка: прямоугольник становится зоной (или стирает зоны ластиком). */
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
      let elevChanged = false;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (`${c},${r}` in d.elev) {
            delete d.elev[`${c},${r}`];
            elevChanged = true;
          }
        }
      }
      if (elevChanged) applyDraftPreview();
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

  /** Протяжка «Земли»/«Покрытия»: насыпает клетки без снятия и без записи отмены
   *  на каждую клетку (отмена пишется один раз на росчерк — см. pointerdown).
   *  Земля и покрытие не совмещаются на одной клетке: покрытие заменяет проталину. */
  const paintEditorCellObject = (kind: 'dirt' | 'ground', c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    if (d.objects.some((o) => (o.kind === 'dirt' || o.kind === 'ground') && o.c === c && o.r === r)) return false;
    if (d.objects.length >= TEST_MAP_LIMITS.objectsMax) {
      setEditorMsg(`Объектов не больше ${TEST_MAP_LIMITS.objectsMax}.`);
      return false;
    }
    d.objects.push(
      kind === 'ground'
        ? { id: newObjectId(), kind: 'ground', c, r, cv: editorCoverRef.current, pos: 'center' }
        : { id: newObjectId(), kind: 'dirt', c, r, pos: 'center' },
    );
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Клетка спавна разрешена только на траве (зелёной зоне) и не на боевых
   *  клетках: новичок появляется в мирном режиме (это же проверяет сервер). */
  /** Поставить/снять одиночную боевую клетку (kind «battle»). Боевая клетка —
   *  область 150×100: ставится только на место, покрашенное кистью целиком;
   *  если место не соответствует размерам — клетка не ставится. Повторный клик
   *  по уже стоящей клетке снимает её. */
  const placeBattleCell = (c: number, r: number) => {
    const d = editorRef.current;
    if (!d) return;
    const existing = d.objects.some((o) => o.kind === 'battle' && o.c === c && o.r === r);
    if (!existing && !d.pcv) {
      setEditorMsg(
        'Боевая клетка ставится на закрашенное кистью место: проведите кистью (пресет «Клетка 150×100»), затем кликните по клетке.',
      );
      return;
    }
    if (!existing && paintCellCoverage(c, r) < 0.995) {
      setEditorMsg(
        `Боевая клетка ${c + 1}×${r + 1} не поставлена: место покрашено не целиком. Закрасьте область клетки пресетом кисти «Клетка 150×100».`,
      );
      return;
    }
    if (!existing && testObjectAt(c, r)) {
      setEditorMsg(`Боевая клетка ${c + 1}×${r + 1} не поставлена: на клетке уже стоит другой объект.`);
      return;
    }
    pushEditorUndo();
    if (existing) {
      d.objects = d.objects.filter((o) => !(o.kind === 'battle' && o.c === c && o.r === r));
    } else {
      d.objects.push({ id: newObjectId(), kind: 'battle', c, r, pos: 'center' });
    }
    d.dirty = true;
    setEditorMsg(existing ? `Боевая клетка ${c + 1}×${r + 1} снята.` : null);
    syncEditorView();
    applyDraftPreview();
  };

  const editorSpawnAllowed = (d: EditorDraft, c: number, r: number): boolean => {
    const onBattle =
      d.zones.some((z) => z.kind === 'cells' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1) ||
      d.objects.some((o) => o.kind === 'battle' && o.c === c && o.r === r);
    if (onBattle) return false;
    // С рисунком кисти спавн — на любом закрашенном месте (не на боевых клетках);
    // без рисунка — по-старому, только в зелёной зоне.
    if (d.pcv) return paintPointOn(c + 0.5, r + 0.5);
    return d.zones.some((z) => z.kind === 'green' && c >= z.c0 && c <= z.c1 && r >= z.r0 && r <= z.r1);
  };

  /**
   * Кисть рельефа: «насыпать» (+1 уровень, предел 3), «срыть» (−1, до базовой
   * земли) и «ровно» (срезает все клетки росчерка на уровень первой клетки).
   * Росчерк пишет отмену один раз и не обрабатывает клетку дважды — протяжка
   * с зажатой кнопкой насыпает уступ целиком (см. pointerdown/pointermove).
   */
  const applyElevBrush = (mode: 'raise' | 'lower' | 'flat', c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    if (c < 0 || r < 0 || c >= d.cols || r >= d.rows) return false;
    const stroke = elevStrokeRef.current;
    if (!stroke) return false;
    const key = `${c},${r}`;
    if (stroke.touched.has(key)) return false;
    stroke.touched.add(key);
    const cur = d.elev[key] ?? 0;
    let next: number;
    if (mode === 'raise') next = Math.min(TERRAIN_MAX_LEVEL, cur + 1);
    else if (mode === 'lower') next = Math.max(0, cur - 1);
    else next = Math.min(TERRAIN_MAX_LEVEL, Math.max(0, stroke.flat));
    if (next === cur) return false;
    if (next <= 0) delete d.elev[key];
    else d.elev[key] = next;
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Начало росчерка кисти рельефа: копилка тронутых клеток + уровень «Ровно»
   *  (уровень первой клетки под кистью — весь росчерк срезается в неё). */
  const beginElevStroke = (mode: 'raise' | 'lower' | 'flat', c: number, r: number) => {
    const d = editorRef.current;
    const first = d ? d.elev[`${c},${r}`] ?? 0 : 0;
    elevStrokeRef.current = { touched: new Set(), flat: mode === 'flat' ? first : 0 };
    applyElevBrush(mode, c, r);
  };

  const endElevStroke = () => {
    elevStrokeRef.current = null;
  };

  /** Добавить клетку спавна (клик/протяжка инструмента «Спавн»): одна точка
   *  на клетку, лимит TEST_MAP_LIMITS.spawnsMax. */
  const addEditorSpawn = (c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    if (d.spawns.some((s) => s.c === c && s.r === r)) return true;
    if (!editorSpawnAllowed(d, c, r)) {
      setEditorMsg('Клетка спавна ставится на траве (зелёной зоне), не на боевых клетках.');
      return false;
    }
    if (d.spawns.length >= TEST_MAP_LIMITS.spawnsMax) {
      setEditorMsg(`Клеток спавна не больше ${TEST_MAP_LIMITS.spawnsMax}.`);
      return false;
    }
    d.spawns.push({ c, r });
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Клик инструментом «Спавн»: клетка со спавном — снимает, без — ставит. */
  const toggleEditorSpawn = (c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    const idx = d.spawns.findIndex((s) => s.c === c && s.r === r);
    if (idx < 0) return addEditorSpawn(c, r);
    d.spawns.splice(idx, 1);
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
  };

  /** Постановка клетки захода (инструмент «Заход»): клик ставит заход с выбранным
   *  направлением, клик по тому же заходу с тем же направлением — убирает, с другим —
   *  меняет направление. На боевой клетке заход не ставится; по направлению шага
   *  обязана быть боевая клетка (это же проверяет сервер при сохранении). */
  const placeEditorEntry = (c: number, r: number): boolean => {
    const d = editorRef.current;
    if (!d) return false;
    const dir = editorEntryDirRef.current;
    const idx = d.objects.findIndex((o) => o.c === c && o.r === r);
    if (idx >= 0 && d.objects[idx].kind === 'entry') {
      pushEditorUndo();
      if (d.objects[idx].dir === dir) d.objects.splice(idx, 1);
      else d.objects[idx] = { ...d.objects[idx], dir };
      d.dirty = true;
      applyDraftPreview();
      syncEditorView();
      return true;
    }
    const isBattleAt = (cc: number, rr: number): boolean =>
      d.zones.some((z) => z.kind === 'cells' && cc >= z.c0 && cc <= z.c1 && rr >= z.r0 && rr <= z.r1) ||
      d.objects.some((o) => o.kind === 'battle' && o.c === cc && o.r === rr);
    const battleCell = isBattleAt(c, r);
    const targetBattle = isBattleAt(
      c + (dir === 'left' ? -1 : dir === 'right' ? 1 : 0),
      r + (dir === 'up' ? -1 : dir === 'down' ? 1 : 0),
    );
    if (battleCell) {
      setEditorMsg('Клетка захода ставится на траве рядом с боевой зоной, не на боевых клетках.');
      return false;
    }
    if (!targetBattle) {
      setEditorMsg('По направлению шага должна быть боевая клетка — выберите направление в сторону зоны.');
      return false;
    }
    // Логика боевых клеток — и для заходов: заход занимает клетку 150×100 и
    // ставится только на место, покрашенное кистью целиком.
    if (d.pcv && paintCellCoverage(c, r) < 0.995) {
      setEditorMsg(
        `Заход ${c + 1}×${r + 1} не поставлен: место покрашено не целиком. Закрасьте область клетки пресетом кисти «Клетка 150×100».`,
      );
      return false;
    }
    if (idx < 0 && d.objects.length >= TEST_MAP_LIMITS.objectsMax) {
      setEditorMsg(`Объектов не больше ${TEST_MAP_LIMITS.objectsMax}.`);
      return false;
    }
    pushEditorUndo();
    if (idx >= 0) d.objects.splice(idx, 1); // замена другого объекта на заход
    d.objects.push({ id: newObjectId(), kind: 'entry', c, r, pos: 'center', dir });
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
    return true;
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
    const back = d.undo.pop()!;
    d.zones = back.zones.map((z) => ({ ...z }));
    d.objects = back.objects.map((o) => ({ ...o }));
    d.spawns = back.spawns.map((s) => ({ ...s }));
    d.elev = { ...back.elev };
    d.cols = back.cols;
    d.rows = back.rows;
    d.sel = d.sel.filter((id) => d.zones.some((z) => z.id === id));
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
    d.sel = [];
    d.dirty = true;
    applyDraftPreview();
    syncEditorView();
  };

  /** Предварительная проверка черновика — те же правила, что у сервера. */
  const editorDraftError = (): string | null => {
    const d = editorRef.current;
    if (!d) return null;
    // Кисть локации: PNG base64 обязан быть валидным и не слишком большим.
    if (d.pcv) {
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
    const err = editorDraftError();
    if (err) {
      setEditorMsg(err);
      return;
    }
    try {
      localStorage.setItem(EDITOR_PASS_KEY, editorPass);
    } catch {
      /* приватный режим — просто не запоминаем */
    }
    net.emit('setmap', { pass: editorPass, map: draftMap(d) });
    setEditorMsg('Сохраняем…');
  };
  return {
    syncEditorView, pushEditorUndo, openEditor, closeEditor, setEditorTool,
    clampPlacePos, editorPlacementClick, confirmEditorPlace, cancelEditorPlace,
    resizeEditorWorld, commitEditorDrag, deleteEditorZone, toggleEditorSel,
    mergeEditorZones, paintEditorCellObject, placeBattleCell, applyElevBrush,
    beginElevStroke, endElevStroke, addEditorSpawn, toggleEditorSpawn,
    placeEditorEntry, renameEditorZone, undoEditor, resetEditor, saveEditorMap,
  };
}

