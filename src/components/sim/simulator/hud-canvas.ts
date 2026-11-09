/** Canvas HUD above WebGL: rotating four-season-of-day dial, weather satellite and jump overlays. */
import { elisionActorFoot, type ElisionFrame, type ElisionSpace } from '@/lib/sim/elision-scene';
import { jumpFillOf } from '@/lib/sim/test-map';
import { type WeatherKind } from '@/lib/sim/settings';

const TAU = Math.PI*2;
const WEATHER_LABEL: Record<WeatherKind,string> = {sun:'Солнечно',cloud:'Облачно',rain:'Дождь'};

function circle(g: CanvasRenderingContext2D,x:number,y:number,r:number) {
  g.beginPath();g.arc(x,y,r,0,TAU);
}
function cloud(g:CanvasRenderingContext2D,x:number,y:number,r:number) {
  const color=g.createLinearGradient(0,y-r,0,y+r);color.addColorStop(0,'#fff');color.addColorStop(1,'#aebcde');
  g.fillStyle=color;g.beginPath();
  g.arc(x-r*.46,y+r*.12,r*.48,Math.PI*.7,Math.PI*1.6);
  g.arc(x,y-r*.22,r*.64,Math.PI,TAU);
  g.arc(x+r*.5,y+r*.1,r*.47,Math.PI*1.5,Math.PI*.5);
  g.lineTo(x-r*.45,y+r*.58);g.closePath();g.fill();
}
function sun(g:CanvasRenderingContext2D,x:number,y:number,r:number) {
  g.save();g.strokeStyle='#ffe585';g.lineWidth=Math.max(1,r*.18);g.lineCap='round';
  for(let i=0;i<8;i++) {const a=i*TAU/8;g.beginPath();g.moveTo(x+Math.cos(a)*r*1.3,y+Math.sin(a)*r*1.3);g.lineTo(x+Math.cos(a)*r*1.65,y+Math.sin(a)*r*1.65);g.stroke();}
  const fill=g.createLinearGradient(x,y-r,x,y+r);fill.addColorStop(0,'#fff3ac');fill.addColorStop(1,'#ffb82f');
  circle(g,x,y,r);g.fillStyle=fill;g.fill();g.restore();
}
function spark(g:CanvasRenderingContext2D,x:number,y:number,r:number) {
  g.beginPath();g.moveTo(x,y-r);g.lineTo(x+r*.3,y-r*.25);g.lineTo(x+r,y);g.lineTo(x+r*.25,y+r*.3);
  g.lineTo(x,y+r);g.lineTo(x-r*.3,y+r*.25);g.lineTo(x-r,y);g.lineTo(x-r*.25,y-r*.3);g.closePath();
  const fill=g.createLinearGradient(x-r,y-r,x+r,y+r);fill.addColorStop(0,'#fff8ca');fill.addColorStop(.5,'#ffdc83');fill.addColorStop(1,'#b46c26');g.fillStyle=fill;g.fill();
}
function goldRing(g:CanvasRenderingContext2D,x:number,y:number,r:number) {
  const gold=g.createLinearGradient(x-r,y-r,x+r,y+r);gold.addColorStop(0,'#fff6b5');gold.addColorStop(.3,'#e6a74d');gold.addColorStop(.6,'#ffde91');gold.addColorStop(1,'#ad6429');
  circle(g,x,y,r);g.strokeStyle='#36264e';g.lineWidth=7;g.stroke();
  g.strokeStyle=gold;g.lineWidth=4;g.stroke();circle(g,x,y,r-3);g.strokeStyle='#fff0bd';g.lineWidth=.8;g.stroke();
}
function weatherIcon(g:CanvasRenderingContext2D,x:number,y:number,kind:WeatherKind) {
  if(kind==='sun') {sun(g,x,y,7);return;}
  if(kind==='cloud') {sun(g,x-5,y-4,4);cloud(g,x+2,y+2,9);return;}
  cloud(g,x,y-4,10);g.strokeStyle='#8ed7ff';g.lineWidth=2;g.lineCap='round';
  for(let i=-1;i<=1;i++) {g.beginPath();g.moveTo(x+i*6+1,y+5);g.lineTo(x+i*6-2,y+11);g.stroke();}
}

/** Every HUD frame uses the current work viewport, including hidden editor HUDs.
 * Clearing without resizing leaves CSS stretching the old gameplay backing store.
 */
export function clearFieldHud(cv:HTMLCanvasElement,vw:number,vh:number){
  const dpr=Math.min(2,window.devicePixelRatio||1),bw=Math.round(vw*dpr),bh=Math.round(vh*dpr);
  if(cv.width!==bw||cv.height!==bh){cv.width=bw;cv.height=bh;}
  const g=cv.getContext('2d');if(!g)return null;
  g.setTransform(dpr,0,0,dpr,0,0);g.clearRect(0,0,vw,vh);return g;
}

/** Fixed left needle reads the continuously rotating day disc. No rotation of the whole HUD. */
export function drawFieldHud(cv:HTMLCanvasElement,vw:number,vh:number,p4:number,weather:WeatherKind,weatherPrev:WeatherKind,weatherAt:number) {
  const g=clearFieldHud(cv,vw,vh);if(!g)return;
  const r=43,cx=vw-80,cy=64,satX=cx+r-2;
  g.save();g.shadowColor='rgba(0,0,0,.42)';g.shadowBlur=9;g.shadowOffsetY=3;
  circle(g,cx,cy,r+2);g.fillStyle='#132343';g.fill();g.restore();
  g.save();circle(g,cx,cy,r-2);g.clip();g.translate(cx,cy);g.rotate(-p4*Math.PI/2);
  const skies=[['#ffd3b2','#ef8768'],['#abdfff','#4f9ee9'],['#ffba88','#d65c44'],['#243a69','#101d3e']];
  for(let i=0;i<4;i++) {
    const a=Math.PI+i*Math.PI/2;
    g.save();g.beginPath();g.moveTo(0,0);g.arc(0,0,r,a,a+Math.PI/2);g.closePath();g.clip();
    const fill=g.createLinearGradient(0,-r,0,r);fill.addColorStop(0,skies[i][0]);fill.addColorStop(1,skies[i][1]);g.fillStyle=fill;g.fillRect(-r,-r,r*2,r*2);
    const x=Math.cos(a+Math.PI/4)*r*.56,y=Math.sin(a+Math.PI/4)*r*.56;
    if(i===3) {
      circle(g,x,y,9);g.fillStyle='#ffe49c';g.fill();circle(g,x+4,y-3,8);g.fillStyle='#192c54';g.fill();
      spark(g,x-11,y-10,2);spark(g,x+12,y+10,2);spark(g,x-9,y+12,1.5);
    } else if(i===1) sun(g,x,y,6);
    else {
      circle(g,x,y+3,8);g.fillStyle='#ffe397';g.fill();
      g.fillStyle=i===0?'#ed9275':'#db6b51';g.beginPath();g.moveTo(x-22,y+8);g.quadraticCurveTo(x-8,y+2,x+2,y+7);g.quadraticCurveTo(x+12,y+3,x+24,y+9);g.lineTo(x+24,y+25);g.lineTo(x-22,y+25);g.closePath();g.fill();
    }
    g.restore();
  }
  g.restore();goldRing(g,cx,cy,r);
  spark(g,cx,cy-r,8);spark(g,cx,cy+r,7);
  // The pointer is stationary; its tip reads the current quadrant at the left edge.
  g.beginPath();g.moveTo(cx-r-13,cy-8);g.lineTo(cx-r+7,cy);g.lineTo(cx-r-13,cy+8);g.closePath();g.fillStyle='#162846';g.fill();g.strokeStyle='#ffe6a2';g.lineWidth=3;g.lineJoin='round';g.stroke();
  circle(g,satX,cy,19);g.fillStyle='#16294f';g.fill();goldRing(g,satX,cy,19);
  const wt=weather===weatherPrev?1:Math.min(1,Math.max(0,(performance.now()-weatherAt)/900));
  g.save();circle(g,satX,cy,16);g.clip();
  if(wt<1){g.globalAlpha=1-wt;weatherIcon(g,satX,cy,weatherPrev);}
  g.globalAlpha=wt;weatherIcon(g,satX,cy,weather);g.restore();
  g.beginPath();g.roundRect(cx-49,cy+r+12,114,23,12);g.fillStyle='rgba(15,28,52,.88)';g.fill();g.strokeStyle='rgba(235,209,149,.6)';g.lineWidth=1;g.stroke();
  g.font='600 11px ui-sans-serif,system-ui,sans-serif';g.textAlign='center';g.textBaseline='middle';g.fillStyle='#fff0ca';g.fillText(WEATHER_LABEL[weather],cx+8,cy+r+23.5);
}

/** Ground marker is projected from the same landing calculation as the jump, above WebGL. */
export function drawElisionJumpTarget(cv:HTMLCanvasElement|null,frame:ElisionFrame,now:number) {
  const target=frame.jumpTarget;if(!cv||frame.editor||!target)return;
  const g=cv.getContext('2d');if(!g)return;
  const dx=target.x-frame.camX,dy=target.y-frame.camY;
  const x=frame.viewW/2+(dx*Math.cos(frame.yaw)-dy*Math.sin(frame.yaw))*frame.zoom;
  const y=frame.viewH/2+(dx*Math.sin(frame.yaw)+dy*Math.cos(frame.yaw)-target.lift)*frame.zoom;
  const r=(8+Math.sin(now*.012)*1.5)*frame.zoom;
  g.save();const dpr=Math.min(2,window.devicePixelRatio||1);g.setTransform(dpr,0,0,dpr,0,0);
  circle(g,x,y,r);g.fillStyle=target.ok?'rgba(126,247,156,.22)':'rgba(255,178,126,.22)';g.fill();
  g.strokeStyle=target.ok?'#a9ffbf':'#ffb27e';g.lineWidth=1.8;g.stroke();g.restore();
}

/** Заряд прыжка поверх WebGL и погоды; координаты из того же кадра, что спрайт. */
export function drawElisionJumpHud(cv: HTMLCanvasElement | null, frame: ElisionFrame, sp: ElisionSpace, now: number) {
  if (!cv || frame.editor || (!sp.holding && !(sp.releaseAt > 0 && now-sp.releaseAt < 420))) return;
  const actor = frame.decals.find(a => a.id === frame.controlledId);
  if (!actor) return;
  const g = cv.getContext('2d');
  if (!g) return;
  const f = elisionActorFoot(actor), dx = f.x-frame.camX, dy = f.z-frame.camY;
  const x = frame.viewW/2+(dx*Math.cos(frame.yaw)-dy*Math.sin(frame.yaw))*frame.zoom;
  const y = frame.viewH/2+(dx*Math.sin(frame.yaw)+dy*Math.cos(frame.yaw)-f.y)*frame.zoom;
  const h = Math.max(36,actor.h*0.55)*frame.zoom, w = Math.max(5,actor.h*0.045)*frame.zoom;
  const bx = x+(actor.w/2+Math.max(8,actor.h*0.07))*frame.zoom;
  const by = y-actor.h*frame.zoom+(actor.h*frame.zoom-h)*0.35;
  const fill = sp.holding ? Math.min(1,(now-sp.since)/4000) : jumpFillOf(sp.charge);
  g.save();
  const dpr = Math.min(2,window.devicePixelRatio||1);
  g.setTransform(dpr,0,0,dpr,0,0);
  g.fillStyle='rgba(0,0,0,0.55)';g.fillRect(bx-1,by-1,w+2,h+2);
  g.fillStyle=fill>=1?'#f6e7a1':fill>=0.5?'#8ef0b0':'#e7c48a';g.fillRect(bx,by+h*(1-fill),w,h*fill);
  g.strokeStyle='rgba(255,255,255,0.9)';g.lineWidth=1;
  g.strokeRect(bx-1,by-1,w+2,h+2);g.beginPath();g.moveTo(bx-2,by+h/2);g.lineTo(bx+w+2,by+h/2);g.stroke();
  g.restore();
}
