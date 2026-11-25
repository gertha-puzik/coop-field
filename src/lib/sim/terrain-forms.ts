import { decodeTerrainRect, terrainAt, terrainRectKey, invalidateTerrain, type TerrainRect } from './terrain-shape';

export type EdgePoint = { x: number; y: number };
export type TriangleControl = { t: number; offset: number };
export type TerrainEdge = EdgePoint & { axis: 'x' | 'y'; normal: 1 | -1; width: number };

export function closestTerrainEdge(elev: Record<string,number>, x: number, y: number, distance: number, waterfall = false): TerrainEdge | null {
  let nearest = distance;
  let result: TerrainEdge | null = null;
  for (const [key,level] of Object.entries(elev)) {
    const block = decodeTerrainRect(key,level);
    if (!block || !level) continue;
    for (const [axis,position,start,length] of [
      ['x',block.y,block.x,block.w], ['x',block.y+block.d,block.x,block.w],
      ['y',block.x,block.y,block.d], ['y',block.x+block.w,block.y,block.d],
    ] as const) {
      const width = Math.min(length,1.5);
      const inset = waterfall ? width/2 : 0;
      const along = Math.max(start+inset, Math.min(start+length-inset, axis==='x'?x:y));
      const edgeX = axis==='x'?along:position, edgeY = axis==='x'?position:along;
      const gap = Math.hypot(edgeX-x,edgeY-y);
      if (gap >= nearest) continue;
      const dx = axis==='y'?.0001:0, dy = axis==='x'?.0001:0;
      const before = terrainAt(elev,edgeX-dx,edgeY-dy), after = terrainAt(elev,edgeX+dx,edgeY+dy);
      if (before===after) continue;
      nearest = gap;
      result = {x:edgeX,y:edgeY,axis,normal:before>after?1:-1,width};
    }
  }
  return result;
}

export function triangleProfile(controls: TriangleControl[]) {
  return [{x:0,y:0},{x:1,y:0}, ...controls.slice().sort((a,b)=>b.t-a.t)
    .map(({t,offset})=>({x:t,y:1-t+offset})),{x:0,y:1}];
}

export function triangleAt(elev: Record<string,number>, x: number, y: number, w: number, h: number,
  controls: TriangleControl[], degrees: number, magnet: boolean) {
  const edge = magnet ? closestTerrainEdge(elev,x,y,.55) : null;
  const automatic = edge?.axis === 'x' ? (edge.normal===1?0:180) : edge ? (edge.normal===1?270:90) : 0;
  const angle = (degrees+automatic)*Math.PI/180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return triangleProfile(controls).map(point=>{
    const px = (point.x-.5)*w, py = (point.y-(edge?0:.5))*h;
    return {x:(edge?.x??x)+px*cos-py*sin,y:(edge?.y??y)+px*sin+py*cos};
  });
}

/** Store a polygon as narrow elevation strips so existing collision, map saves
 * and both terrain renderers use exactly the same occupied geometry. */
export function stampTriangle(elev: Record<string,number>, points: EdgePoint[], level: number, cols: number, rows: number) {
  const top = Math.max(0,Math.min(...points.map(p=>p.y)));
  const bottom = Math.min(rows,Math.max(...points.map(p=>p.y)));
  const count = Math.ceil((bottom-top)*12);
  const strips: TerrainRect[] = [];
  for (let row=0; row<count; row++) {
    const y = Math.round((top+row/12)*10000)/10000;
    const end = Math.round(Math.min(bottom,top+(row+1)/12)*10000)/10000;
    const d = end-y;
    if(d<=0) continue;
    const center = y+d/2;
    const cuts: number[] = [];
    for (let i=0;i<points.length;i++) {
      const a=points[i], b=points[(i+1)%points.length];
      if ((a.y>center)===(b.y>center)) continue;
      cuts.push(a.x+(b.x-a.x)*(center-a.y)/(b.y-a.y));
    }
    cuts.sort((a,b)=>a-b);
    for(let i=0;i+1<cuts.length;i+=2){
      const x=Math.max(0,cuts[i]), right=Math.min(cols,cuts[i+1]);
      if(right-x>.001) strips.push({x,y,w:right-x,d,level});
    }
  }
  if (!strips.length || Object.keys(elev).length+strips.length>10000) return false;
  for(const strip of strips){
    const key = terrainRectKey(strip);
    delete elev[key]; // retain last-write order over other terrain shapes
    elev[key]=strip.level;
  }
  invalidateTerrain(elev);
  return true;
}
