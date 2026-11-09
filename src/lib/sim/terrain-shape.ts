import type { EditorTool } from './editor-model';
import { TERRAIN_MAX_LEVEL } from './test-map.ts';
import type { ElisionFrame } from './elision-scene';
export type TerrainHit = { x: number; y: number; c: number; r: number; level: number };
/** Geometry and persistence use cell units; height uses a tenth of a level.
 * Exact rectangular terrain, layered over the legacy whole-cell height map.
 * Keys x,y,width,depth describe a rectangle in cell units; values are levels.
 * Zero rectangles explicitly erase old terrain. Whole-cell c,r keys stay valid.
 * Coordinates are bounded, canonical and independent of sprite/paint pixels.
 */
export type TerrainRect = { x: number; y: number; w: number; d: number; level: number };
export const TERRAIN_RECT_LIMIT = 10000;
const eps = 1e-7;
const round = (n: number) => Math.round(n * 10000) / 10000;
export const terrainRectKey = (b: TerrainRect) => [b.x,b.y,b.w,b.d].map(round).join(',');
export function decodeTerrainRect(key: string, level: number): TerrainRect | null {
  const a = key.split(',').map(Number);
  if ((a.length !== 2 && a.length !== 4) || a.some(n => !Number.isFinite(n))) return null;
  const [x,y,w=1,d=1] = a;
  return {x,y,w,d,level};
}
export function sanitizeTerrainElev(raw: unknown, cols: number, rows: number, max: number): Record<string,number> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if(Object.keys(raw).length>TERRAIN_RECT_LIMIT)return null;
  const clean: Record<string,number> = {};
  let count=0;
  for (const [key,value] of Object.entries(raw)) {
    if (count++ >= TERRAIN_RECT_LIMIT) break;
    if (!/^\d+(?:\.\d+)?,\d+(?:\.\d+)?(?:,\d+(?:\.\d+)?,\d+(?:\.\d+)?)?$/.test(key)) continue;
    const level = Math.min(max,Math.max(0,Math.round(Number(value)*10)/10));
    const b = decodeTerrainRect(key,level);
    if (!b || !Number.isFinite(level) || b.x < 0 || b.y < 0 || b.x >= cols || b.y >= rows || b.w <= 0 || b.d <= 0) continue;
    if (key.split(',').length === 2) {
      if (!Number.isInteger(b.x) || !Number.isInteger(b.y) || !level) continue;
      clean[`${b.x},${b.y}`] = level;
    } else {
      b.w=round(Math.min(b.w,cols-b.x)); b.d=round(Math.min(b.d,rows-b.y));
      if (b.w < .0001 || b.d < .0001) continue;
      clean[terrainRectKey(b)] = level;
    }
  }
  return clean;
}
export function intersects(a: TerrainRect,b: TerrainRect): boolean {
  return a.x < b.x+b.w-eps && a.x+a.w > b.x+eps && a.y < b.y+b.d-eps && a.y+a.d > b.y+eps;
}
/** At most four disjoint pieces; no implicit rounding to a whole cell. */
export function subtractTerrainRect(a: TerrainRect,b: TerrainRect): TerrainRect[] {
  if (!intersects(a,b)) return [a];
  const x0=Math.max(a.x,b.x),x1=Math.min(a.x+a.w,b.x+b.w);
  const y0=Math.max(a.y,b.y),y1=Math.min(a.y+a.d,b.y+b.d);
  return [
    {...a,w:x0-a.x}, {...a,x:x1,w:a.x+a.w-x1},
    {...a,x:x0,w:x1-x0,d:y0-a.y}, {...a,x:x0,y:y1,w:x1-x0,d:a.y+a.d-y1},
  ].filter(r=>r.w>eps&&r.d>eps).map(r=>({...r,x:round(r.x),y:round(r.y),w:round(r.w),d:round(r.d)}));
}
type TerrainIndex = { cells: Map<string,TerrainRect[]>; rects: TerrainRect[] };
const indices = new WeakMap<Record<string,number>,TerrainIndex>();
function makeIndex(elev: Record<string,number>): TerrainIndex {
  const cells=new Map<string,TerrainRect[]>(),rects:TerrainRect[]=[];
  // Legacy cells are the base; rectangle overrides always win, even after JSON roundtrips.
  for(const [key,level] of Object.entries(elev)) {
    if(key.split(',').length!==4)continue;
    const b=decodeTerrainRect(key,level);if(!b)continue;rects.push(b);
    for(let r=Math.floor(b.y);r<Math.ceil(b.y+b.d-eps);r++)for(let c=Math.floor(b.x);c<Math.ceil(b.x+b.w-eps);c++){
      const k=`${c},${r}`;const list=cells.get(k)??[];list.push(b);cells.set(k,list);
    }
  }
  return {cells,rects};
}
export function terrainIndex(elev: Record<string,number>): TerrainIndex {
  let index=indices.get(elev);if(!index){index=makeIndex(elev);indices.set(elev,index);}return index;
}
export function invalidateTerrain(elev: Record<string,number>) { indices.delete(elev); tileCaches.delete(elev); }
export function terrainAt(elev: Record<string,number>|undefined,x:number,y:number):number {
  if(!elev)return 0;
  const c=Math.floor(x),r=Math.floor(y),list=terrainIndex(elev).cells.get(`${c},${r}`)??[];
  for(let i=list.length-1;i>=0;i--){const b=list[i];if(x>=b.x&&x<b.x+b.w&&y>=b.y&&y<b.y+b.d)return b.level;}
  return elev[`${c},${r}`]??0;
}
/** Geometry partition: each tile and its neighboring edge segments have a constant level.
 * Only nearby rectangle boundaries subdivide a cell; a 0.1-wide block does not
 * force the whole world onto a ten-times denser grid.
 */
export function terrainTiles(elev:Record<string,number>,cols:number,rows:number):TerrainRect[] {
  const out:TerrainRect[]=[],index=terrainIndex(elev);
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const xs=new Set([c,c+1]),ys=new Set([r,r+1]);
    for(let nr=r-1;nr<=r+1;nr++)for(let nc=c-1;nc<=c+1;nc++){
      for(const b of index.cells.get(`${nc},${nr}`)??[]){
        for(const v of [b.x,b.x+b.w])if(v>c+eps&&v<c+1-eps)xs.add(v);
        for(const v of [b.y,b.y+b.d])if(v>r+eps&&v<r+1-eps)ys.add(v);
      }
    }
    const xx=[...xs].sort((a,b)=>a-b),yy=[...ys].sort((a,b)=>a-b);
    for(let j=0;j<yy.length-1;j++)for(let i=0;i<xx.length-1;i++){
      const x=xx[i],y=yy[j],w=xx[i+1]-x,d=yy[j+1]-y;
      out.push({x,y,w,d,level:terrainAt(elev,x+w/2,y+d/2)});
    }
  }
  return out;
}
export function terrainBrushBounds(c:number,r:number,width:number,depth:number,cols:number,rows:number):TerrainRect {
  const x=width<1?c+.5-width/2:c-Math.floor((width-1)/2);
  const y=depth<1?r+.5-depth/2:r-Math.floor((depth-1)/2);
  const x0=Math.max(0,x),y0=Math.max(0,y);
  return {x:round(x0),y:round(y0),w:round(Math.min(cols,x+width)-x0),d:round(Math.min(rows,y+depth)-y0),level:0};
}
/** Stroke union lives in touched; overlapping rectangular stamps never add twice. */
export function stampTerrainRect(elev:Record<string,number>,target:TerrainRect,mode:string,level:number,touched:Set<string>,flat:number,max:number):boolean {
  let pending=[target];
  for(const key of touched){const old=decodeTerrainRect(key,0);if(old)pending=pending.flatMap(b=>subtractTerrainRect(b,old));}
  if(!pending.length)return false;
  const original={...elev};let changed=false;
  for(const area of pending){
    const pieces:TerrainRect[]=[];
    if(mode==='height'||mode==='flat')pieces.push({...area,level:mode==='height'?level:flat});
    else {
      const xs=new Set([area.x,area.x+area.w]),ys=new Set([area.y,area.y+area.d]);
      for(let c=Math.ceil(area.x);c<area.x+area.w;c++)xs.add(c);
      for(let r=Math.ceil(area.y);r<area.y+area.d;r++)ys.add(r);
      for(const b of terrainIndex(original).rects)if(intersects(area,b)){
        for(const x of [b.x,b.x+b.w])if(x>area.x&&x<area.x+area.w)xs.add(x);
        for(const y of [b.y,b.y+b.d])if(y>area.y&&y<area.y+area.d)ys.add(y);
      }
      const xx=[...xs].sort((a,b)=>a-b),yy=[...ys].sort((a,b)=>a-b);
      for(let j=0;j<yy.length-1;j++)for(let i=0;i<xx.length-1;i++){
        const x=xx[i],y=yy[j],w=xx[i+1]-x,d=yy[j+1]-y;
        pieces.push({x,y,w,d,level:Math.min(max,Math.max(0,Math.round((terrainAt(original,x+w/2,y+d/2)+(mode==='raise'?1:-1))*10)/10))});
      }
    }
    // Preserve the part of every existing override outside the new rectangle.
    for(const [key,old] of Object.entries(elev)){
      if(key.split(',').length!==4)continue;
      const b=decodeTerrainRect(key,old);if(!b||!intersects(b,area))continue;
      delete elev[key];for(const part of subtractTerrainRect(b,area))elev[terrainRectKey(part)]=part.level;
    }
    for(const b of pieces){elev[terrainRectKey(b)]=b.level;changed=true;}
    touched.add(terrainRectKey(area));invalidateTerrain(elev);
  }
  if(Object.keys(elev).length>TERRAIN_RECT_LIMIT){
    for(const key of Object.keys(elev))delete elev[key];
    Object.assign(elev,original);invalidateTerrain(elev);return false;
  }
  return changed;
}

/** Exact body contact against rectangular cliffs, including subcell ledges. */
const tileCaches = new WeakMap<Record<string,number>,{cols:number;rows:number;tiles:TerrainRect[]}>();
export function cachedTerrainTiles(elev:Record<string,number>,cols:number,rows:number):TerrainRect[] {
  const cached=tileCaches.get(elev);
  if(cached&&cached.cols===cols&&cached.rows===rows)return cached.tiles;
  const tiles=terrainTiles(elev,cols,rows);tileCaches.set(elev,{cols,rows,tiles});return tiles;
}
export function terrainBodyContact(elev:Record<string,number>,cols:number,rows:number,x:number,y:number,rx:number,ry:number,level:number):number {
  if(!(rx>0&&ry>0))return 0;
  let overlap=0;
  for(const b of cachedTerrainTiles(elev,cols,rows)){
    if(b.x>x+rx||b.x+b.w<x-rx||b.y>y+ry||b.y+b.d<y-ry||Math.abs(b.level-level)<=1+eps)continue;
    const dx=(x-Math.max(b.x,Math.min(b.x+b.w,x)))/rx;
    const dy=(y-Math.max(b.y,Math.min(b.y+b.d,y)))/ry;
    overlap=Math.max(overlap,1-Math.hypot(dx,dy));
  }
  return overlap;
}

export function pickTerrainTop(
  x: number, y: number, cellW: number, cellH: number, cols: number, rows: number,
  levelAt: (c: number, r: number) => number, lift: number, yaw: number, elev?: Record<string,number>,
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
  if (elev) {
    cuts.push(...Object.values(elev));
    for (const b of terrainIndex(elev).rects) {
      for (const [edges,origin,direction] of [ [[b.x*cellW,(b.x+b.w)*cellW],x,sin*lift], [[b.y*cellH,(b.y+b.d)*cellH],y,cos*lift] ] as const) {
        if (Math.abs(direction)<1e-9) continue;
        for(const edge of edges){const t=(edge-origin)/direction;if(t>0&&t<TERRAIN_MAX_LEVEL)cuts.push(t);}
      }
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
    const level = elev ? terrainAt(elev,(x+sin*midpoint*lift)/cellW,(y+cos*midpoint*lift)/cellH) : levelAt(c, r);
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


export type ElevationTool = 'raise' | 'lower' | 'flat' | 'height';
export type ElevationBrush = { width: number; depth: number; level: number };
export type CellRect = { c0: number; r0: number; c1: number; r1: number };

export const DEFAULT_ELEVATION_BRUSH: ElevationBrush = { width: 1, depth: 1, level: 1 };

export function isElevationTool(tool: EditorTool): tool is ElevationTool {
  return tool === 'raise' || tool === 'lower' || tool === 'flat' || tool === 'height';
}

export function clampBrush(brush: ElevationBrush | undefined, cols: number, rows: number): ElevationBrush {
  const integer = (value: number | undefined, fallback: number, max: number) =>
    Math.min(max, Math.max(.1, Math.round((Number.isFinite(value) ? value! : fallback) * 10) / 10));
  return {
    width: integer(brush?.width, 1, cols),
    depth: integer(brush?.depth, 1, rows),
    level: Math.min(TERRAIN_MAX_LEVEL, Math.max(0, Math.round((Number.isFinite(brush?.level) ? brush!.level : 1) * 10) / 10)),
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
  const precise=clampBrush(brush,cols,rows);
  // Keep the legacy pure helper useful for decimal brushes as well.
  // Integer stamps retain their compact c,r representation for old maps.
  if(!Number.isInteger(precise.width)||!Number.isInteger(precise.depth)) {
    return stampTerrainRect(elev,terrainBrushBounds(c,r,precise.width,precise.depth,cols,rows),mode,precise.level,touched,flat,TERRAIN_MAX_LEVEL);
  }
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
/** Is this top's center actually visible, rather than hidden by another top? */
export function terrainTopVisible(frame: ElisionFrame, c: number, r: number): boolean {
  const level = terrainAt(frame.elev,c+.5,r+.5);
  const lift = level * frame.terrainLiftStep;
  const x = (c + .5) * frame.cellW - Math.sin(frame.yaw) * lift;
  const y = (r + .5) * frame.cellH - Math.cos(frame.yaw) * lift;
  const hit = pickTerrainTop(x, y, frame.cellW, frame.cellH, frame.cols, frame.rows,
    (cx, ry) => terrainAt(frame.elev,cx+.5,ry+.5), frame.terrainLiftStep, frame.yaw, frame.elev);
  return hit.c === c && hit.r === r;
}


/** Canvas fallback retains the exact rectangle extents when WebGL is unavailable.
 * The caller already applies the world/camera transform, so elevation is shifted
 * along the camera's world-space up direction just like the old cell painter.
 */
export function drawRectTerrain(
  g:CanvasRenderingContext2D,elev:Record<string,number>,cols:number,rows:number,
  cw:number,ch:number,lift:number,yaw:number,grass:CanvasPattern|null,stone:CanvasPattern|null,
  paint:HTMLCanvasElement|null,
):void {
  const sin=Math.sin(yaw),cos=Math.cos(yaw);
  const tiles=cachedTerrainTiles(elev,cols,rows).filter(b=>b.level>0).slice();
  tiles.sort((a,b)=>(a.x+a.w/2)*cw*sin+(a.y+a.d/2)*ch*cos-(b.x+b.w/2)*cw*sin-(b.y+b.d/2)*ch*cos);
  const face=((Math.round(yaw/(Math.PI/2))%4)+4)%4;
  for(const b of tiles){
    const dx=-sin*b.level*lift,dy=-cos*b.level*lift;
    const x=b.x*cw+dx,y=b.y*ch+dy,w=b.w*cw,h=b.d*ch;
    const nx=face===1?b.x+b.w+1e-6:face===3?b.x-1e-6:b.x+b.w/2;
    const ny=face===0?b.y+b.d+1e-6:face===2?b.y-1e-6:b.y+b.d/2;
    const neighbor=nx<0||ny<0||nx>=cols||ny>=rows?0:terrainAt(elev,nx,ny);
    const drop=Math.max(0,b.level-neighbor)*lift;
    g.fillStyle=stone??'#878a80';
    if(face===0)g.fillRect(x,y+h,w,drop);
    else if(face===2)g.fillRect(x,y-drop,w,drop);
    else if(face===1)g.fillRect(x+w,y,drop,h);
    else g.fillRect(x-drop,y,drop,h);
    if(paint){
      const sx=paint.width/cols,sy=paint.height/rows;
      g.drawImage(paint,b.x*sx,b.y*sy,b.w*sx,b.d*sy,x,y,w+.1,h+.1);
    }else{g.fillStyle=grass??'#526b35';g.fillRect(x,y,w+.1,h+.1);}
    g.fillStyle=`rgba(255,245,200,${Math.min(.5,b.level*.025)})`;
    g.fillRect(x,y,w+.1,h+.1);
  }
}

/** Free placement uses the cursor as the block center. Magnet modes affect
 * only nearby terrain rectangles, never the global editing grid or props.
 * 'level' joins equal-height surfaces; 'all' also aligns stepped terraces.
 */
export function freeTerrainPlacement(
  elev:Record<string,number>,x:number,y:number,width:number,depth:number,level:number,
  cols:number,rows:number,mode:'off'|'level'|'all'='level',distance=.12,
):TerrainRect & {snapped:boolean} {
  const clampX=(v:number)=>Math.max(0,Math.min(cols-width,v));
  const clampY=(v:number)=>Math.max(0,Math.min(rows-depth,v));
  let bx=clampX(x-width/2),by=clampY(y-depth/2),snapped=false;
  if(mode!=='off'){
    const candidates=Object.entries(elev).map(([k,v])=>decodeTerrainRect(k,v)).filter((b):b is TerrainRect=>
      !!b&&b.level>0&&(mode==='all'||Math.abs(b.level-level)<eps)&&
      b.x+b.w>=bx-distance&&b.x<=bx+width+distance&&b.y+b.d>=by-distance&&b.y<=by+depth+distance);
    const closest=(origin:number,values:number[])=>{
      let best=origin,gap=distance+eps;
      for(const value of values){const d=Math.abs(value-origin);if(d<gap){best=value;gap=d;}}
      return {value:best,snapped:gap<=distance};
    };
    const xx:number[]=[];
    for(const b of candidates)if(b.y+b.d>=by-distance&&b.y<=by+depth+distance)
      xx.push(b.x,b.x+b.w,b.x-width,b.x+b.w-width);
    const px=closest(bx,xx);bx=clampX(px.value);snapped=px.snapped;
    const yy:number[]=[];
    for(const b of candidates)if(b.x+b.w>=bx-eps&&b.x<=bx+width+eps)
      yy.push(b.y,b.y+b.d,b.y-depth,b.y+b.d-depth);
    const py=closest(by,yy);by=clampY(py.value);snapped ||= py.snapped;
  }
  return {x:round(bx),y:round(by),w:width,d:depth,level,snapped};
}
