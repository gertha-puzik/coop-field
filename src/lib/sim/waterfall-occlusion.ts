import { elisionTerrainGeometry, type ElisionFrame } from './elision-scene';

type WorldPoint = { x: number; y: number; z: number };
type ScreenPoint = { x: number; y: number; depth: number };
type Corners = [WorldPoint, WorldPoint, WorldPoint, WorldPoint];
type Bounds = { left: number; top: number; right: number; bottom: number };

const bounds = (points: ScreenPoint[]): Bounds => ({
  left:Math.min(...points.map(p=>p.x)),top:Math.min(...points.map(p=>p.y)),
  right:Math.max(...points.map(p=>p.x)),bottom:Math.max(...points.map(p=>p.y)),
});
const overlaps = (a: Bounds,b: Bounds) => a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;

function depthPlane([a,b,c]: ScreenPoint[]) {
  const dx=b.x-a.x,dy=b.y-a.y,ex=c.x-a.x,ey=c.y-a.y;
  const determinant=dx*ey-dy*ex;
  if(Math.abs(determinant)<1e-5)return null;
  const bx=b.depth-a.depth, cx=c.depth-a.depth;
  const sx=(bx*ey-cx*dy)/determinant,sy=(cx*dx-bx*ex)/determinant;
  return (point:ScreenPoint)=>a.depth+(point.x-a.x)*sx+(point.y-a.y)*sy;
}

let source: ElisionFrame | undefined;
let terrain: Corners[] = [];
function terrainFaces(frame: ElisionFrame) {
  if (source?.elev===frame.elev && source.cols===frame.cols && source.rows===frame.rows &&
      source.cellW===frame.cellW && source.cellH===frame.cellH && source.terrainLiftStep===frame.terrainLiftStep) return terrain;
  const {tops,walls}=elisionTerrainGeometry(frame.cols,frame.rows,frame.cellW,frame.cellH,frame.elev,frame.terrainLiftStep);
  terrain=[];
  for(const {positions} of [tops,walls]){
    for(let i=0;i<positions.length;i+=12){
      const point=(k:number)=>({x:positions[i+k],y:positions[i+k+1],z:positions[i+k+2]});
      terrain.push([point(0),point(3),point(6),point(9)]);
    }
  }
  source=frame;
  return terrain;
}

/** In orthographic view both depths are affine in screen space. Subtract only
 * the part of each terrain face that is in front of the water plane. */
export function waterfallOcclusion(frame: ElisionFrame) {
  const sin=Math.sin(frame.yaw),cos=Math.cos(frame.yaw);
  const project = (point: WorldPoint): ScreenPoint => {
    const dx=point.x-frame.camX,dz=point.z-frame.camY;
    const down=dx*sin+dz*cos;
    return {x:frame.viewW/2+(dx*cos-dz*sin)*frame.zoom,
      y:frame.viewH/2+(down-point.y)*frame.zoom,depth:down+point.y};
  };
  const viewport={left:0,top:0,right:frame.viewW,bottom:frame.viewH};
  const faces=terrainFaces(frame).map(face=>face.map(project))
    .map(points=>({points,box:bounds(points)}))
    .filter(face=>overlaps(viewport,face.box));
  return {
    project,
    clip(context: CanvasRenderingContext2D, quad: ScreenPoint[]) {
      const plane=depthPlane(quad);
      if(!plane)return false;
      const box=bounds(quad);
      if(!overlaps(viewport,box))return false;
      for(const {points,box: faceBox} of faces){
        if(!overlaps(box,faceBox))continue;
        const front: ScreenPoint[]=[];
        for(let i=0;i<points.length;i++){
          const a=points[i],b=points[(i+1)%points.length];
          const da=a.depth-plane(a)-.025,db=b.depth-plane(b)-.025;
          if(da>0)front.push(a);
          if((da>0)===(db>0))continue;
          const t=da/(da-db);
          front.push({x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t,depth:0});
        }
        if(front.length<3)continue;
        const path=new Path2D();
        path.rect(0,0,frame.viewW,frame.viewH);
        path.moveTo(front[0].x,front[0].y);
        for(const point of front.slice(1))path.lineTo(point.x,point.y);
        path.closePath();
        context.clip(path,'evenodd');
      }
      return true;
    },
  };
}
