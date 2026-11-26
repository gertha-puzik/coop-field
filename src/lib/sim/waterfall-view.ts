import type { ElisionFrame } from './elision-scene';
import type { TestMapObject } from './test-map';
import { waterfallOcclusion } from './waterfall-occlusion';
import { cachedTerrainTiles, terrainAt } from './terrain-shape';

export const WATERFALL_PARTS = ['lip','curtain','pool'] as const;
import { waterfallFrame, WATERFALL_FRAMES } from './waterfall-texture';
export { waterfallFrame, WATERFALL_FRAMES };
type Part = typeof WATERFALL_PARTS[number];
type Point = { x: number; y: number; z: number };
type FlowDirection = NonNullable<TestMapObject['dir']>;
type Quad = {
  part: Part; a: Point; b: Point; c: Point; fraction: number;
  u0: number; u1: number; flow: FlowDirection; width: number;
};

/** The three waterfall strips depict one downstream face. Conceal the whole
 * effect upstream or edge-on, where repeated crests on stepped banks look like shards. */
export function waterfallVisible(flow: FlowDirection, yaw: number, width = Infinity, zoom = 1) {
  const facing = flow === 'left' || flow === 'right' ? Math.sin(yaw) : Math.cos(yaw);
  const downstream = facing * (flow === 'left' || flow === 'up' ? -1 : 1);
  // Keep ordinary waterfalls visible in a zoomed-out overview. Only narrow
  // cliff fragments need enough projected width to show the sprite detail.
  return downstream > .1 && (width >= 20 || width * zoom * downstream >= 8);
}
type TerrainFrame = Pick<ElisionFrame,'cols'|'rows'|'cellW'|'cellH'|'terrainLiftStep'|'elev'>;

export function waterfallGeometry(frame: TerrainFrame, objects: TestMapObject[]) {
  const quads: Quad[] = [];
  const {cols,rows,cellW,cellH,elev,terrainLiftStep} = frame;
  const height = (x: number,y: number) => terrainAt(elev,x,y);
  for (const object of objects) {
    if (object.kind!=='waterfall' || object.x==null || object.y==null) continue;
    const {x,y} = object;
    const flow = object.dir ?? 'down';
    const vertical = flow==='left'||flow==='right';
    const normal = flow==='left'||flow==='up'?-1:1;
    const nx = vertical?normal:0, nz = vertical?0:normal;
    const along = vertical?y:x, length = Math.min(object.s??1,1);
    const limit = vertical?rows:cols;
    const cell = Math.max(0,Math.min(limit-1,Math.floor(along)));
    const start = Math.max(cell,along-length/2), end = Math.min(cell+1,along+length/2);
    if (end<=start) continue;

    const cuts = new Set([start,end]);
    const cross = vertical?x:y;
    const tiles = cachedTerrainTiles(elev,cols,rows);
    for (const tile of tiles) {
      const crossStart=vertical?tile.x:tile.y, crossEnd=crossStart+(vertical?tile.w:tile.d);
      if (cross<crossStart-.0001 || cross>crossEnd+.0001) continue;
      const from=vertical?tile.y:tile.x, to=from+(vertical?tile.d:tile.w);
      if (from>start&&from<end) cuts.add(from);
      if (to>start&&to<end) cuts.add(to);
    }
    const edges=[...cuts].sort((a,b)=>a-b);
    const position=(a: number, d: number, h: number): Point => ({
      x: ((vertical?x:a)+nx*d)*cellW, y: h, z: ((vertical?a:y)+nz*d)*cellH,
    });
    const runs: { from: number; to: number; first: number }[] = [];
    for(let i=0;i<edges.length-1;i++) {
      const from=edges[i], to=edges[i+1], mid=(from+to)/2;
      if (to-from<.00001) continue;
      // Terrain subdivision must not restart the full texture in every sliver.
      const u0=(from-start)/(end-start), u1=(to-start)/(end-start);
      const point=position(mid,0,0);
      const tx=point.x/cellW, ty=point.z/cellH;
      const hi=height(tx-nx*.0001,ty-nz*.0001), lo=height(tx+nx*.0001,ty+nz*.0001);
      if (hi<=lo) continue;
      const last = runs.at(-1);
      if (last && last.to === from) last.to = to;
      else runs.push({from,to,first:quads.length});
      const top=hi*terrainLiftStep, bottom=lo*terrainLiftStep;
      // Bound both flat strips to their cells and to their actual terrain tier.
      const span=(side: number, level: number, maximum: number) => {
        const at=cross+side*.0001*normal;
        const cellBoundary=normal*side===1?Math.floor(at)+1:Math.floor(at);
        let width=Math.min(maximum,Math.abs(cellBoundary-cross));
        for (const tile of tiles) {
          const a=vertical?tile.y:tile.x, b=a+(vertical?tile.d:tile.w);
          if(mid<a||mid>=b||tile.level===level) continue;
          const c=vertical?tile.x:tile.y, d=c+(vertical?tile.w:tile.d);
          const gap=normal*side===1?c-cross:cross-d;
          if(gap>=0)width=Math.min(width,gap);
        }
        const bound=vertical?cols:rows;
        return at<0||at>=bound?0:width;
      };
      const lip=span(-1,hi,.17), pool=span(1,lo,.24);
      // Extend the crest past the grass fringe and use the very same seam for the flow.
      const seam=span(1,lo,.6/(vertical?cellW:cellH)), crest=top+.2;
      if(lip>0)quads.push({part:'lip',a:position(from,-lip,crest),b:position(to,-lip,crest),c:position(from,seam,crest),fraction:1,u0,u1,flow,width:0});
      for(let y=crest;y>bottom;y-=48) {
        const next=Math.max(bottom,y-48);
        quads.push({part:'curtain',a:position(from,seam,y),b:position(to,seam,y),c:position(from,seam,next),fraction:(y-next)/48,u0,u1,flow,width:0});
      }
      if(pool>0)quads.push({part:'pool',a:position(from,0,bottom+.15),b:position(to,0,bottom+.15),c:position(from,pool,bottom+.15),fraction:1,u0,u1,flow,width:0});
    }
    for (const [i,run] of runs.entries()) {
      const end = runs[i+1]?.first ?? quads.length;
      const width = (run.to-run.from) * (vertical ? cellH : cellW);
      for (let j=run.first;j<end;j++) quads[j].width=width;
    }
  }
  return quads;
}

let saved: { frame: TerrainFrame; objects: TestMapObject[]; quads: Quad[] } | undefined;
export function cachedWaterfallGeometry(frame: TerrainFrame, objects: TestMapObject[]) {
  if (saved?.objects===objects && saved.frame.elev===frame.elev && saved.frame.cellW===frame.cellW &&
      saved.frame.cellH===frame.cellH && saved.frame.cols===frame.cols && saved.frame.rows===frame.rows &&
      saved.frame.terrainLiftStep===frame.terrainLiftStep) return saved.quads;
  const quads = waterfallGeometry(frame,objects);
  saved={frame,objects,quads};
  return quads;
}

const images = new Map<Part, HTMLImageElement>();
export function drawWaterfalls(canvas: HTMLCanvasElement | null, frame: ElisionFrame, objects: TestMapObject[], now: number) {
  const context = canvas?.getContext('2d');
  if (!context) return;
  const dpr = Math.min(2,window.devicePixelRatio||1);
  const quads = cachedWaterfallGeometry(frame,objects).filter(quad=>waterfallVisible(quad.flow,frame.yaw,quad.width,frame.zoom));
  if (!quads.length) return;
  const {project,clip} = waterfallOcclusion(frame);
  for (const quad of quads) {
    let image=images.get(quad.part);
    if(!image) {
      image=new Image();
      image.src=`/tex/waterfall/${quad.part}-frames.png`;
      images.set(quad.part,image);
    }
    if(!image.complete||!image.naturalWidth)continue;
    const a=project(quad.a),b=project(quad.b),c=project(quad.c);
    const width=image.naturalWidth/WATERFALL_FRAMES;
    context.save();
    context.setTransform(dpr,0,0,dpr,0,0);
    const d=project({x:quad.b.x+quad.c.x-quad.a.x,y:quad.b.y+quad.c.y-quad.a.y,z:quad.b.z+quad.c.z-quad.a.z});
    if (!clip(context,[a,b,c,d])) {context.restore();continue;}
    context.transform(b.x-a.x,b.y-a.y,c.x-a.x,c.y-a.y,a.x,a.y);
    context.imageSmoothingEnabled=false;
    context.drawImage(image,(waterfallFrame(now)+quad.u0)*width,0,(quad.u1-quad.u0)*width,
      image.naturalHeight*quad.fraction,0,0,1,1);
    context.restore();
  }
}
