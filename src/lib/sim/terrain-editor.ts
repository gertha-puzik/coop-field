import { terrainAt, terrainBrushBounds, pickTerrainTop, terrainScreenPoint, decodeTerrainRect, isElevationTool, clampBrush } from './terrain-shape';
export { pickTerrainTop, terrainScreenPoint, terrainTopVisible, clampBrush, elevationBrushRect, stampElevation, isElevationTool } from './terrain-shape';
export type { ElevationTool, ElevationBrush, CellRect } from './terrain-shape';
import type { CellRect } from './terrain-shape';
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

/** Put a closed cell-top path on a screen-space overlay. */
function cellPath(g: CanvasRenderingContext2D, frame: ElisionFrame, c: number, r: number, level: number, w=1, d=1) {
  const lift = level * frame.terrainLiftStep;
  const corners = [[c, r], [c + w, r], [c + w, r + d], [c, r + d]];
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
      cellPath(g, frame, c, r, terrainAt(frame.elev,c+.5,r+.5));
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
    const b=decodeTerrainRect(key,level);if(!b)continue;
    const cx=b.x+b.w/2,ry=b.y+b.d/2;
    if(terrainAt(frame.elev,cx,ry)!==level)continue;
    const lift=level*frame.terrainLiftStep;
    const hit=pickTerrainTop(cx*frame.cellW-Math.sin(frame.yaw)*lift,ry*frame.cellH-Math.cos(frame.yaw)*lift,
      frame.cellW,frame.cellH,frame.cols,frame.rows,(c,r)=>terrainAt(frame.elev,c+.5,r+.5),frame.terrainLiftStep,frame.yaw,frame.elev);
    if(Math.abs(hit.level-level)>.001)continue;
    const p=terrainScreenPoint(frame,cx*frame.cellW,ry*frame.cellH,lift);
    if(p.x < -30 || p.y < -20 || p.x > frame.viewW+30 || p.y > frame.viewH+20)continue;
    label(g,p.x,p.y,`▲ ${level}`);
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
    const b = clampBrush(d.elevBrush,d.cols,d.rows);
    const rect=terrainBrushBounds(hover.c,hover.r,b.width,b.depth,d.cols,d.rows);
    const level=terrainAt(frame.elev,hover.c+.5,hover.r+.5);
    g.lineWidth=2;g.strokeStyle='#baffd0';g.fillStyle='rgba(118,255,169,.18)';
    cellPath(g,frame,rect.x,rect.y,level,rect.w,rect.d);g.fill();g.stroke();
    if(d.tool==='height'&&b.level!==level){
      g.save();g.setLineDash([5,3]);g.strokeStyle='#ffe6a8';g.fillStyle='rgba(255,227,153,.07)';
      cellPath(g,frame,rect.x,rect.y,b.level,rect.w,rect.d);g.fill();g.stroke();g.restore();
    }
    const p=terrainScreenPoint(frame,(hover.c+.5)*frame.cellW,(hover.r+.5)*frame.cellH,level*frame.terrainLiftStep);
    label(g,p.x,p.y-23,`${b.width}×${b.depth}${d.tool==='height'?` · высота ${b.level}`:''}`,'#baffd0');
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
