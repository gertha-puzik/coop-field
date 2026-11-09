/**
 * Shared terrain picking, rectangular elevation stamps and editor annotations.
 * The editor uses the game's depth-tested scene; this overlay contains guides
 * only, never a second copy of terrain, trees, rocks or character sprites.
 * All positions use the same orthographic projection as screenToWorld.
 */
import { TERRAIN_MAX_LEVEL, objectBase, objectScale, objectRotDeg, obstacleBodyPx } from './test-map';
import type { TestMapObject } from './test-map';
import type { EditorDraft, EditorPlace, EditorTool } from './editor-model';
import type { ElisionFrame } from './elision-scene';

export type ElevationTool = 'raise' | 'lower' | 'flat' | 'height';
export type ElevationBrush = { width: number; depth: number; level: number };
export type CellRect = { c0: number; r0: number; c1: number; r1: number };
export type TerrainHit = { x: number; y: number; c: number; r: number; level: number };
export const DEFAULT_ELEVATION_BRUSH: ElevationBrush = { width: 1, depth: 1, level: 1 };

export function isElevationTool(tool: EditorTool): tool is ElevationTool {
  return tool === 'raise' || tool === 'lower' || tool === 'flat' || tool === 'height';
}

export function clampBrush(brush: ElevationBrush | undefined, cols: number, rows: number): ElevationBrush {
  const integer = (value: number | undefined, fallback: number, max: number) =>
    Math.min(max, Math.max(1, Math.round(Number.isFinite(value) ? value! : fallback)));
  return {
    width: integer(brush?.width, 1, cols),
    depth: integer(brush?.depth, 1, rows),
    level: Math.min(TERRAIN_MAX_LEVEL, Math.max(0, Math.round(Number.isFinite(brush?.level) ? brush!.level : 1))),
  };
}

/** Center the stamp on the selected cell and clip it to the world. */
export function elevationBrushRect(c: number, r: number, brush: ElevationBrush | undefined, cols: number, rows: number): CellRect {
  const b = clampBrush(brush, cols, rows);
  const c0 = c - Math.floor((b.width - 1) / 2);
  const r0 = r - Math.floor((b.depth - 1) / 2);
  return { c0: Math.max(0, c0), r0: Math.max(0, r0), c1: Math.min(cols - 1, c0 + b.width - 1), r1: Math.min(rows - 1, r0 + b.depth - 1) };
}

/** Pure stamp: one stroke changes every covered cell at most once. */
export function stampElevation(
  elev: Record<string, number>, mode: ElevationTool, c: number, r: number,
  brush: ElevationBrush | undefined, cols: number, rows: number,
  touched: Set<string>, flat: number,
): boolean {
  const rect = elevationBrushRect(c, r, brush, cols, rows);
  const b = clampBrush(brush, cols, rows);
  let changed = false;
  for (let y = rect.r0; y <= rect.r1; y++) {
    for (let x = rect.c0; x <= rect.c1; x++) {
      const key = `${x},${y}`;
      if (touched.has(key)) continue;
      touched.add(key);
      const before = elev[key] ?? 0;
      const after = Math.min(TERRAIN_MAX_LEVEL, Math.max(0,
        mode === 'raise' ? before + 1 : mode === 'lower' ? before - 1 : mode === 'height' ? b.level : flat));
      if (before === after) continue;
      if (after > 0) elev[key] = after;
      else delete elev[key];
      changed = true;
    }
  }
  return changed;
}

/**
 * Orthographic terrain ray. x/y are the ground-plane coordinates obtained
 * from screenToWorld, before applying terrain height. A level L projects by
 * (-sin(yaw), -cos(yaw))*L*lift. Intersect visible tops from high to low.
 * This works at arbitrary yaw, not only the four cardinal camera angles.
 */
export function pickTerrainTop(
  x: number, y: number, cellW: number, cellH: number, cols: number, rows: number,
  levelAt: (c: number, r: number) => number, lift: number, yaw: number,
): TerrainHit {
  const sin = Math.sin(yaw), cos = Math.cos(yaw);
  // Partition the ray at every terrain level and every crossed grid boundary.
  // Inside an interval both the cell and the terrain height are constant,
  // so the first occupied interval is the nearest physical intersection.
  // This also stops a rear low top from being selected through a front wall.
  const cuts = Array.from({ length: TERRAIN_MAX_LEVEL + 1 }, (_, i) => i);
  for (const [origin, direction, size] of [[x, sin * lift, cellW], [y, cos * lift, cellH]]) {
    if (Math.abs(direction) < 1e-9) continue;
    const end = origin + direction * TERRAIN_MAX_LEVEL;
    const startCell = Math.ceil(Math.min(origin, end) / size);
    const endCell = Math.floor(Math.max(origin, end) / size);
    for (let n = startCell; n <= endCell; n++) {
      const level = (n * size - origin) / direction;
      if (level > 0 && level < TERRAIN_MAX_LEVEL) cuts.push(level);
    }
  }
  cuts.sort((a, b) => b - a);
  for (let i = 0; i < cuts.length - 1; i++) {
    const high = cuts[i], low = cuts[i + 1];
    if (high - low < 1e-9) continue;
    const midpoint = (high + low) / 2;
    const c = Math.floor((x + sin * midpoint * lift) / cellW);
    const r = Math.floor((y + cos * midpoint * lift) / cellH);
    if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
    const level = levelAt(c, r);
    if (level <= midpoint) continue;
    const entry = high - 1e-7;
    return { x: x + sin * entry * lift, y: y + cos * entry * lift, c, r, level };
  }
  // The zero-level floor is a surface too. Keep out-of-world coordinates
  // intact so the caller can choose whether to clamp its editing tools.
  const c = Math.floor(x / cellW), r = Math.floor(y / cellH);
  return { x, y, c, r, level: c >= 0 && r >= 0 && c < cols && r < rows ? levelAt(c, r) : 0 };
}

export function terrainScreenPoint(frame: ElisionFrame, x: number, y: number, lift: number) {
  const dx = x - frame.camX, dy = y - frame.camY;
  return {
    x: frame.viewW / 2 + (dx * Math.cos(frame.yaw) - dy * Math.sin(frame.yaw)) * frame.zoom,
    y: frame.viewH / 2 + (dx * Math.sin(frame.yaw) + dy * Math.cos(frame.yaw) - lift) * frame.zoom,
  };
}

/** Is this top's center actually visible, rather than hidden by another top? */
export function terrainTopVisible(frame: ElisionFrame, c: number, r: number): boolean {
  const level = frame.elev[`${c},${r}`] ?? 0;
  const lift = level * frame.terrainLiftStep;
  const x = (c + .5) * frame.cellW - Math.sin(frame.yaw) * lift;
  const y = (r + .5) * frame.cellH - Math.cos(frame.yaw) * lift;
  const hit = pickTerrainTop(x, y, frame.cellW, frame.cellH, frame.cols, frame.rows,
    (cx, ry) => frame.elev[`${cx},${ry}`] ?? 0, frame.terrainLiftStep, frame.yaw);
  return hit.c === c && hit.r === r;
}

/** Put a closed cell-top path on a screen-space overlay. */
function cellPath(g: CanvasRenderingContext2D, frame: ElisionFrame, c: number, r: number, level: number) {
  const lift = level * frame.terrainLiftStep;
  const corners = [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
  g.beginPath();
  corners.forEach(([x, y], i) => {
    const p = terrainScreenPoint(frame, x * frame.cellW, y * frame.cellH, lift);
    if (i) g.lineTo(p.x, p.y);
    else g.moveTo(p.x, p.y);
  });
  g.closePath();
}

function label(g: CanvasRenderingContext2D, x: number, y: number, text: string, fill = '#eafbe7') {
  const w = g.measureText(text).width + 14;
  g.fillStyle = 'rgba(12,24,19,.82)';
  g.beginPath();
  g.roundRect(x - w / 2, y - 9, w, 18, 7);
  g.fill();
  g.fillStyle = fill;
  g.fillText(text, x, y);
}

function outlineRect(g: CanvasRenderingContext2D, frame: ElisionFrame, rect: CellRect, color: string) {
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  for (let r = rect.r0; r <= rect.r1; r++) {
    for (let c = rect.c0; c <= rect.c1; c++) {
      cellPath(g, frame, c, r, frame.elev[`${c},${r}`] ?? 0);
      g.stroke();
    }
  }
}

/** Body guides follow the same free position, scale and rotation as the prop. */
function bodyGuide(g: CanvasRenderingContext2D, frame: ElisionFrame, object: TestMapObject, selected: boolean) {
  if (object.kind !== 'stone' && object.kind !== 'tree') return;
  const base = objectBase(object), body = obstacleBodyPx(object), scale = objectScale(object);
  const angle = objectRotDeg(object) * Math.PI / 180;
  const lift = (frame.elev[`${Math.floor(base.x)},${Math.floor(base.y)}`] ?? 0) * frame.terrainLiftStep;
  g.strokeStyle = selected ? '#b9ffd5' : 'rgba(235,255,238,.58)';
  g.lineWidth = selected ? 1.7 : 1;
  g.setLineDash([4, 3]);
  g.beginPath();
  for (let i = 0; i <= 32; i++) {
    const t = i * Math.PI / 16;
    const dx = Math.cos(t) * (body.hw * scale + 4), dy = Math.sin(t) * (body.h * scale + 4);
    const p = terrainScreenPoint(frame, base.x * frame.cellW + dx * Math.cos(angle) - dy * Math.sin(angle),
      base.y * frame.cellH + dx * Math.sin(angle) + dy * Math.cos(angle), lift);
    if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y);
  }
  g.stroke();
  g.setLineDash([]);
}

export type TerrainEditorOverlay = {
  draft: EditorDraft;
  hover: { c: number; r: number } | null;
  placement: EditorPlace | null;
  selectionCanvas?: HTMLCanvasElement | null;
};

/**
 * Annotation pass after WebGL and after the day/weather HUD has cleared.
 * Terrain itself is never repainted here: depth testing remains authoritative.
 * Height labels are hidden when a nearer top covers the labeled cell.
 */
export function drawTerrainEditorOverlay(cv: HTMLCanvasElement | null, frame: ElisionFrame, input: TerrainEditorOverlay) {
  if (!cv || !frame.editor) return;
  const g = cv.getContext('2d');
  if (!g) return;
  const { draft: d, hover, placement } = input;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  g.save();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.strokeStyle = 'rgba(240,255,235,.4)';
  g.lineWidth = 1;
  g.setLineDash([6, 4]);
  g.beginPath();
  [[0,0],[d.cols,0],[d.cols,d.rows],[0,d.rows]].forEach(([c,r],i) => {
    const p = terrainScreenPoint(frame,c*frame.cellW,r*frame.cellH,0);
    if (i) g.lineTo(p.x,p.y); else g.moveTo(p.x,p.y);
  });
  g.closePath();
  g.stroke();
  g.setLineDash([]);
  g.font = 'bold 11px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  for (const [key, level] of Object.entries(frame.elev)) {
    if (!level) continue;
    const [c, r] = key.split(',').map(Number);
    if (!terrainTopVisible(frame, c, r)) continue;
    const p = terrainScreenPoint(frame, (c + .5) * frame.cellW, (r + .5) * frame.cellH, level * frame.terrainLiftStep);
    if (p.x < -30 || p.y < -20 || p.x > frame.viewW + 30 || p.y > frame.viewH + 20) continue;
    label(g, p.x, p.y, `▲ ${level}`);
  }
  for (const object of d.objects) {
    if (object.id !== placement?.pickId) bodyGuide(g, frame, object, false);
  }
  if (placement) {
    bodyGuide(g, frame, { id: '__ghost', kind: placement.kind, c: Math.floor(placement.x), r: Math.floor(placement.y),
      x: placement.x, y: placement.y, s: placement.s, rot: placement.rot, spr: placement.spr, mir: placement.mir }, true);
  }
  for (const spawn of d.spawns) {
    const level = frame.elev[`${spawn.c},${spawn.r}`] ?? 0;
    const p = terrainScreenPoint(frame, (spawn.c + .5) * frame.cellW, (spawn.r + .5) * frame.cellH, level * frame.terrainLiftStep);
    g.fillStyle = '#f6eabb';
    g.fillText('⚑', p.x, p.y);
  }
  if (d.drag) {
    const rect = { c0: Math.min(d.drag.c0, d.drag.c1), c1: Math.max(d.drag.c0, d.drag.c1),
      r0: Math.min(d.drag.r0, d.drag.r1), r1: Math.max(d.drag.r0, d.drag.r1) };
    outlineRect(g, frame, rect, d.drag.erase ? '#ffaaaa' : '#b9e0ff');
  }
  if (d.selRect && d.tool === 'select') {
    const dx = d.selFloat?.dc ?? 0, dy = d.selFloat?.dr ?? 0;
    const rect = { c0: d.selRect.c0 + dx, r0: d.selRect.r0 + dy, c1: d.selRect.c1 + dx, r1: d.selRect.r1 + dy };
    if (d.selFloat && input.selectionCanvas) {
      const p = terrainScreenPoint(frame, rect.c0 * frame.cellW, rect.r0 * frame.cellH, 0);
      g.save();
      g.globalAlpha = .65;
      g.translate(p.x, p.y);
      g.rotate(frame.yaw);
      g.scale(frame.zoom, frame.zoom);
      g.drawImage(input.selectionCanvas, 0, 0, (rect.c1 - rect.c0 + 1) * frame.cellW, (rect.r1 - rect.r0 + 1) * frame.cellH);
      g.restore();
    }
    g.setLineDash([5, 3]);
    outlineRect(g, frame, rect, '#ffeca0');
    g.setLineDash([]);
  }
  if (hover && isElevationTool(d.tool)) {
    const rect = elevationBrushRect(hover.c, hover.r, d.elevBrush, d.cols, d.rows);
    g.lineWidth = 2;
    g.strokeStyle = '#baffd0';
    g.fillStyle = 'rgba(118,255,169,.18)';
    for (let r = rect.r0; r <= rect.r1; r++) {
      for (let c = rect.c0; c <= rect.c1; c++) {
        cellPath(g, frame, c, r, frame.elev[`${c},${r}`] ?? 0);
        g.fill();
        g.stroke();
        // A separate dashed top is the exact resulting level of a block.
        // The solid outline continues to mark the existing surface under
        // the mouse, so changing the level never detaches the selection.
        if (d.tool === 'height') {
          const target = clampBrush(d.elevBrush, d.cols, d.rows).level;
          if (target !== (frame.elev[`${c},${r}`] ?? 0)) {
            g.save();
            g.setLineDash([5, 3]);
            g.strokeStyle = '#ffe6a8';
            g.fillStyle = 'rgba(255,227,153,.07)';
            cellPath(g, frame, c, r, target);
            g.fill();
            g.stroke();
            g.restore();
          }
        }
      }
    }
    const b = clampBrush(d.elevBrush, d.cols, d.rows);
    const p = terrainScreenPoint(frame, (hover.c + .5) * frame.cellW, (hover.r + .5) * frame.cellH,
      (frame.elev[`${hover.c},${hover.r}`] ?? 0) * frame.terrainLiftStep);
    label(g, p.x, p.y - 23, `${b.width}×${b.depth}${d.tool === 'height' ? ` · высота ${b.level}` : ''}`, '#baffd0');
  } else if (hover && d.tool === 'paint') {
    const level = frame.elev[`${hover.c},${hover.r}`] ?? 0;
    const p = terrainScreenPoint(frame, (hover.c + .5) * frame.cellW, (hover.r + .5) * frame.cellH, level * frame.terrainLiftStep);
    g.strokeStyle = '#fff1bd';
    g.lineWidth = 1.5;
    g.setLineDash([5, 3]);
    if (d.pshape === 'round') {
      g.beginPath(); g.arc(p.x, p.y, Math.max(1, d.psize / 2) * frame.zoom, 0, Math.PI * 2); g.stroke();
    } else {
      cellPath(g, frame, hover.c, hover.r, level); g.stroke();
    }
    g.setLineDash([]);
  } else if (hover && ['battle', 'entry', 'spawn'].includes(d.tool)) {
    g.strokeStyle = '#c9f4d6';
    g.lineWidth = 2;
    cellPath(g, frame, hover.c, hover.r, frame.elev[`${hover.c},${hover.r}`] ?? 0);
    g.stroke();
  }
  g.restore();
}
