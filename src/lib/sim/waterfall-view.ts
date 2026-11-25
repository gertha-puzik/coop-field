import type { ElisionFrame } from './elision-scene';
import type { TestMapObject } from './test-map';
import { terrainAt, terrainScreenPoint } from './terrain-shape';
import type { EdgePoint } from './terrain-forms';

const textures = new Map<string, HTMLImageElement>();

function fillTexture(g: CanvasRenderingContext2D, name: string, from: EdgePoint, right: EdgePoint, down: EdgePoint) {
  let image = textures.get(name);
  if (!image) {
    image = new Image();
    image.src = `/tex/waterfall/${name}.png`;
    textures.set(name,image);
  }
  g.save();
  g.transform(right.x-from.x,right.y-from.y,down.x-from.x,down.y-from.y,from.x,from.y);
  g.imageSmoothingEnabled = false;
  if (image.complete && image.naturalWidth) g.drawImage(image,0,0,1,1);
  else {
    g.fillStyle = name==='curtain'?'#397c9e':'#62aecd';
    g.fillRect(0,0,1,1);
  }
  g.restore();
}

export function drawWaterfalls(canvas: HTMLCanvasElement | null, frame: ElisionFrame, objects: TestMapObject[]) {
  if (!canvas) return;
  const context = canvas.getContext('2d');
  if (!context) return;
  const dpr = Math.min(2,window.devicePixelRatio||1);
  context.save();
  context.setTransform(dpr,0,0,dpr,0,0);
  for (const object of objects) {
    if (object.kind !== 'waterfall' || object.x == null || object.y == null) continue;
    const verticalEdge = object.dir==='left'||object.dir==='right';
    const direction = object.dir==='left'||object.dir==='up'?-1:1;
    const dx = verticalEdge?direction:0, dy = verticalEdge?0:direction;
    const x = object.x, y = object.y;
    const high = terrainAt(frame.elev,x-dx*.004,y-dy*.004)*frame.terrainLiftStep;
    const low = terrainAt(frame.elev,x+dx*.004,y+dy*.004)*frame.terrainLiftStep;
    if (high <= low) continue;
    const len = (object.s ?? 1)/2;
    const point = (along: number, across: number, lift: number) => terrainScreenPoint(frame,
      (x+(verticalEdge?0:along)+dx*across)*frame.cellW,
      (y+(verticalEdge?along:0)+dy*across)*frame.cellH, lift);
    fillTexture(context,'lip',point(-len,-.17,high),point(len,-.17,high),point(-len,0,high));
    fillTexture(context,'curtain',point(-len,0,high),point(len,0,high),point(-len,0,low));
    fillTexture(context,'pool',point(-len,0,low),point(len,0,low),point(-len,.24,low));
  }
  context.restore();
}
