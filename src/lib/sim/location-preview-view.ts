import { CAM_YAW_TAU_MS } from './engine-consts';
import { drawWaterSurface, waterTextureRevision } from './water-render';
import { buildPathLoops, pathCellsOf, pathLoopsToPath2D } from './path-field';
import { cachedTerrainTiles, drawRectTerrain, terrainHeightTint } from './terrain-shape';
import { drawWaterfalls } from './waterfall-view';
import { TERRAIN_LIFT_PX } from './test-field';
import type { ElisionFrame, ElisionView } from './elision-scene';
import type { TestMap } from './test-map';

export const PREVIEW_YAW = 0;
const CELL_W = 100;
const CELL_H = 150;
type PreviewData = Pick<TestMap,'cols'|'rows'|'elev'|'water'|'objects'|'seed'> & {painted:boolean};

async function loadPaint(source: string, signal: AbortSignal) {
  const response=await fetch(source+'&layer=paint',{credentials:'include',signal});
  if (!response.ok) return null;
  return createImageBitmap(await response.blob());
}

function drawPreviewFallback(canvas: HTMLCanvasElement, frame: ElisionFrame, now: number) {
  const pixelRatio=Math.min(2,window.devicePixelRatio||1);
  const width=Math.round(frame.viewW*pixelRatio), height=Math.round(frame.viewH*pixelRatio);
  if (canvas.width!==width || canvas.height!==height) {
    canvas.width=width;
    canvas.height=height;
  }
  const g=canvas.getContext('2d');
  if (!g || !frame.paint) return;
  g.setTransform(1,0,0,1,0,0);
  g.clearRect(0,0,width,height);
  g.translate(width/2,height/2);
  g.scale(frame.zoom*pixelRatio,frame.zoom*pixelRatio);
  g.rotate(frame.yaw);
  g.translate(-frame.camX,-frame.camY);
  const worldW=frame.cols*frame.cellW, worldH=frame.rows*frame.cellH;
  g.drawImage(frame.paint,0,0,worldW,worldH);
  drawRectTerrain(g,frame.elev,frame.cols,frame.rows,frame.cellW,frame.cellH,
    frame.terrainLiftStep,frame.yaw,null,null,frame.paint,null,true);
  if (frame.waterfalls?.length) drawWaterfalls(canvas,frame,frame.waterfalls,now);
}

export function startLocationPreview(
  target: HTMLDivElement, source: string, yaw: {current:number}, controller: AbortController,
  status: (value:'ready'|'error')=>void,
) {
  const {signal}=controller;
  let request=0;
  let view: ElisionView | undefined;
  const canvas=document.createElement('canvas');
  target.append(canvas);

  async function init() {
    const response=await fetch(source,{credentials:'include',signal});
    if (!response.ok) throw new Error('Preview unavailable');
    const data:PreviewData=await response.json();
    const map:TestMap={...data,v:2,margin:0,zones:[]};
    const paint=data.painted ? await loadPaint(source,signal).catch(()=>null) : null;
    if (signal.aborted) {paint?.close();return;}

    const worldW=map.cols*CELL_W, worldH=map.rows*CELL_H;
    const atlas=document.createElement('canvas');
    const atlasScale=Math.min(1,2048/Math.max(worldW,worldH));
    atlas.width=Math.ceil(worldW*atlasScale);
    atlas.height=Math.ceil(worldH*atlasScale);
    const g=atlas.getContext('2d');
    if (!g) {paint?.close();throw new Error('Canvas unavailable');}
    g.scale(atlas.width/worldW,atlas.height/worldH);
    const path=pathLoopsToPath2D(buildPathLoops(pathCellsOf(map.objects),map.cols,map.rows,map.seed??'preview'),CELL_W,CELL_H);
    const elev=map.elev??{};
    const raisedTiles=cachedTerrainTiles(elev,map.cols,map.rows).filter(tile=>tile.level>0);
    const compose=()=>{
      g.clearRect(0,0,worldW,worldH);
      if (paint) g.drawImage(paint,0,0,worldW,worldH);
      else {
        g.fillStyle='#75814c';
        g.fillRect(0,0,worldW,worldH);
      }
      g.fillStyle='#886a47';
      g.fill(path,'evenodd');
      g.save();
      g.globalCompositeOperation='source-atop';
      for (const {x,y,w,d,level} of raisedTiles) {
        g.fillStyle=terrainHeightTint(level);
        g.fillRect(x*CELL_W,y*CELL_H,w*CELL_W,d*CELL_H);
      }
      g.restore();
      drawWaterSurface(g,map,CELL_W,CELL_H);
    };

    signal.addEventListener('abort',()=>paint?.close(),{once:true});
    try {
      if (window.WebGLRenderingContext) {
        const {createElisionView}=await import('./elision-babylon');
        if (!signal.aborted) view=createElisionView(canvas);
      }
    } catch {
      // The same ground and terrain can be projected by Canvas without WebGL.
    }
    if (signal.aborted) return;
    const fallback=view ? canvas : document.createElement('canvas');
    if (!view) canvas.replaceWith(fallback);

    const peak=Math.max(0,...Object.values(elev))*TERRAIN_LIFT_PX;
    const diagonal=Math.hypot(worldW,worldH);
    const waterfalls=map.objects?.filter(object=>object.kind==='waterfall');
    let drawn='', textureRevision=-1, paintRev=0;
    let angle=yaw.current, lastFrame=performance.now();
    status('ready');
    const render=(now:number)=>{
      const revision=waterTextureRevision();
      if (revision!==textureRevision) {
        compose();
        textureRevision=revision;
        paintRev++;
      }
      const dt=now-lastFrame;
      lastFrame=now;
      angle+=(yaw.current-angle)*(1-Math.exp(-dt/CAM_YAW_TAU_MS));
      if (Math.abs(yaw.current-angle)<.004) angle=yaw.current;
      const viewW=target.clientWidth,viewH=target.clientHeight;
      const key=`${viewW}/${viewH}/${angle}/${paintRev}/${waterfalls?.length ? Math.floor(now/85) : 0}`;
      if (viewW>1 && viewH>1 && key!==drawn) {
        drawn=key;
        const frame:ElisionFrame={
          camX:worldW/2-Math.sin(angle)*peak/2,camY:worldH/2-Math.cos(angle)*peak/2,
          zoom:.9*Math.min(viewW/diagonal,viewH/(diagonal+peak)),
          yaw:angle,viewW,viewH,cols:map.cols,rows:map.rows,cellW:CELL_W,cellH:CELL_H,
          editor:true,elev,terrainLiftStep:TERRAIN_LIFT_PX,day:'day',dayProgress:.5,
          jumpTarget:null,decals:[],waterfalls,controlledId:'',paint:atlas,paintRev,
        };
        if (view) view.frame(frame);
        else drawPreviewFallback(fallback,frame,now);
      }
      request=requestAnimationFrame(render);
    };
    request=requestAnimationFrame(render);
  }

  void init().catch(()=>{if (!signal.aborted) status('error');});
  return ()=>{
    controller.abort();
    cancelAnimationFrame(request);
    view?.destroy();
    target.replaceChildren();
  };
}
