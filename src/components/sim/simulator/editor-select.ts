import { sanitizeTerrainElev, invalidateTerrain } from '@/lib/sim/terrain-shape';
/**
 * Tool «Перенести» of the location editor: cut a selected region (paint pixels,
 * zones fully inside, objects by base/cell, spawns, elevation cells) into a
 * floating buffer, drag it, drop it at the new place. Carved from editor-ops
 * (god-file diet, ARCHITECTURE §8). The cut keeps one combined undo entry —
 * the paint snapshot travels with the data (pushEditorUndo(true)).
 */
import type { RefObject } from 'react';
import type { EditorDraft } from '@/lib/sim/editor-model';
import { PAINT_CELL_H, PAINT_CELL_W, setPaintOverride } from '@/lib/sim/test-field';
import { objectBase, type TestMapObject, type TestMapSpawn, type TestMapZone } from '@/lib/sim/test-map';

/** Вырезанный кусок локации: пиксельная отрисовка области, уехавшие с ней
 *  зоны/объекты/спавны/рельеф и исходный прямоугольник (клетки). */
export type EditorSelState = {
  cv: HTMLCanvasElement | null;
  c0: number;
  r0: number;
  c1: number;
  r1: number;
  zones: TestMapZone[];
  objects: TestMapObject[];
  spawns: TestMapSpawn[];
  elev: Record<string, number>;
};

export interface EditorSelectDeps {
  editorRef: RefObject<EditorDraft | null>;
  editorSelRef: RefObject<EditorSelState | null>;
  setPaintOverride: (cv: HTMLCanvasElement | null, rebuild: boolean) => void;
  setEditorMsg: (msg: string | null) => void;
  pushEditorUndo: (withPaint?: boolean) => void;
  applyDraftPreview: () => void;
  syncEditorView: () => void;
}

export function buildEditorSelect({
  editorRef,
  editorSelRef,
  setPaintOverride,
  setEditorMsg,
  pushEditorUndo,
  applyDraftPreview,
  syncEditorView,
}: EditorSelectDeps) {
  /** Вырезание выделенного куска (инструмент «Перенести»): пиксельная отрисовка
   *  области уезжает в буфер вместе с зонами целиком внутри, объектами по точке
   *  опоры/клетке, спавнами и клетками рельефа. Одна запись отмены на всё. */
  const pickEditorSelection = (c: number, r: number) => {
    const d = editorRef.current;
    if (!d || !d.selRect || d.selFloat) return;
    const rect = d.selRect;
    const inRect = (cc: number, rr: number) => cc >= rect.c0 && cc <= rect.c1 && rr >= rect.r0 && rr <= rect.r1;
    pushEditorUndo(true);
    // пиксельная отрисовка: копия области + вырезание (альфа в ноль)
    let cv: HTMLCanvasElement | null = null;
    if (d.pcv) {
      const w = (rect.c1 - rect.c0 + 1) * PAINT_CELL_W;
      const h = (rect.r1 - rect.r0 + 1) * PAINT_CELL_H;
      cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const g = cv.getContext('2d');
      const gSrc = d.pcv.getContext('2d');
      if (g && gSrc) {
        g.imageSmoothingEnabled = false;
        g.drawImage(d.pcv, rect.c0 * PAINT_CELL_W, rect.r0 * PAINT_CELL_H, w, h, 0, 0, w, h);
        gSrc.clearRect(rect.c0 * PAINT_CELL_W, rect.r0 * PAINT_CELL_H, w, h);
      }
    }
    const zones: TestMapZone[] = [];
    const kept: TestMapZone[] = [];
    for (const z of d.zones) {
      if (z.c0 >= rect.c0 && z.c1 <= rect.c1 && z.r0 >= rect.r0 && z.r1 <= rect.r1) zones.push(z);
      else kept.push(z);
    }
    d.zones = kept;
    const objects: TestMapObject[] = [];
    d.objects = d.objects.filter((o) => {
      if (o.kind === 'stone' || o.kind === 'tree') {
        const b = objectBase(o);
        if (inRect(Math.floor(b.x), Math.floor(b.y - 0.01))) {
          objects.push(o);
          return false;
        }
        return true;
      }
      if (inRect(o.c, o.r)) {
        objects.push(o);
        return false;
      }
      return true;
    });
    const spawns: TestMapSpawn[] = [];
    d.spawns = d.spawns.filter((s) => {
      if (inRect(s.c, s.r)) {
        spawns.push(s);
        return false;
      }
      return true;
    });
    const elev: Record<string, number> = {};
    for (const key of Object.keys(d.elev)) {
      const [cc, rr] = key.split(',').map(Number);
      if (inRect(cc, rr)) {
        elev[key] = d.elev[key];
        delete d.elev[key];
      }
    }
    invalidateTerrain(d.elev);
    editorSelRef.current = { cv, c0: rect.c0, r0: rect.r0, c1: rect.c1, r1: rect.r1, zones, objects, spawns, elev };
    d.selFloat = { dc: 0, dr: 0 };
    d.dirty = true;
    setEditorMsg('Кусок вырезан — ведите мышью и кликните, чтобы поставить на место. Esc вернёт обратно.');
    applyDraftPreview();
    syncEditorView();
  };

  /** Смещение «плавающего» куска (протяжка после вырезания). Дельта зажимается
   *  так, чтобы прямоугольник оставался в пределах мира. */
  const dragEditorSelection = (c: number, r: number) => {
    const d = editorRef.current;
    const buf = editorSelRef.current;
    if (!d || !buf || !d.selFloat) return;
    const w = buf.c1 - buf.c0 + 1;
    const h = buf.r1 - buf.r0 + 1;
    const dc = Math.min(d.cols - w - buf.c0, Math.max(-buf.c0, c - buf.c0));
    const dr = Math.min(d.rows - h - buf.r0, Math.max(-buf.r0, r - buf.r0));
    if (dc === d.selFloat.dc && dr === d.selFloat.dr) return;
    d.selFloat = { dc, dr };
    syncEditorView();
  };

  /** Постановка «плавающего» куска на место (клик; Esc — возврат на исходное,
   *  т.к. дельта остаётся текущей). Данные и рисунок едут одной дельтой. */
  const dropEditorSelection = () => {
    const d = editorRef.current;
    const buf = editorSelRef.current;
    if (!d || !buf || !d.selFloat) return;
    const { dc, dr } = d.selFloat;
    // рисунок: копия области вставляется целиком на новое место
    if (d.pcv && buf.cv) {
      const g = d.pcv.getContext('2d');
      if (g) {
        g.imageSmoothingEnabled = false;
        g.drawImage(buf.cv, (buf.c0 + dc) * PAINT_CELL_W, (buf.r0 + dr) * PAINT_CELL_H);
      }
      setPaintOverride(d.pcv, true);
    }
    for (const z of buf.zones) {
      const nz: TestMapZone = { ...z, c0: z.c0 + dc, c1: z.c1 + dc, r0: z.r0 + dr, r1: z.r1 + dr };
      if (nz.c0 < 0 || nz.r0 < 0 || nz.c1 >= d.cols || nz.r1 >= d.rows) continue;
      d.zones.push(nz);
    }
    for (const o of buf.objects) {
      const no: TestMapObject = { ...o };
      if (no.kind === 'stone' || no.kind === 'tree') {
        const b = objectBase(o);
        const nx = b.x + dc;
        const ny = b.y + dr;
        if (nx < 0 || ny < 0 || nx >= d.cols || ny >= d.rows) continue;
        no.x = nx;
        no.y = ny;
        no.c = Math.min(d.cols - 1, Math.max(0, Math.floor(nx)));
        no.r = Math.min(d.rows - 1, Math.max(0, Math.floor(ny - 0.01)));
      } else {
        const nc = o.c + dc;
        const nr = o.r + dr;
        if (nc < 0 || nr < 0 || nc >= d.cols || nr >= d.rows) continue;
        no.c = nc;
        no.r = nr;
      }
      d.objects.push(no);
    }
    for (const s of buf.spawns) {
      const nc = s.c + dc;
      const nr = s.r + dr;
      if (nc < 0 || nr < 0 || nc >= d.cols || nr >= d.rows) continue;
      d.spawns.push({ c: nc, r: nr });
    }
    for (const [key, lv] of Object.entries(buf.elev)) {
      const [cc, rr] = key.split(',').map(Number);
      const nc = cc + dc;
      const nr = rr + dr;
      if (nc < 0 || nr < 0 || nc >= d.cols || nr >= d.rows) continue;
      const parts=key.split(',');
      d.elev[[nc,nr,...parts.slice(2)].join(',')] = lv;
    }
    d.elev = sanitizeTerrainElev(d.elev,d.cols,d.rows,20) ?? {};
    d.selRect = { c0: buf.c0 + dc, r0: buf.r0 + dr, c1: buf.c1 + dc, r1: buf.r1 + dr };
    d.selFloat = null;
    editorSelRef.current = null;
    d.dirty = true;
    setEditorMsg(null);
    applyDraftPreview();
    syncEditorView();
  };

  return { pickEditorSelection, dragEditorSelection, dropEditorSelection };
}
