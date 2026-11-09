import type { ElisionFrame } from './elision-scene.ts';
import { terrainAt, terrainScreenPoint } from './terrain-shape.ts';
import { testPointInIsland } from './test-field';
/**
 * Sprint dust particles: a com-of-earth/grass mote thrown from under the paws
 * while the cat sprints in peace mode — type, spawn cadence and palettes only.
 * Carved verbatim from the simulator.tsx module belt (W5a stage 1,
 * behavior-preserving).
 *
 * Consumers: simulator.tsx keeps the particle references (sprintPartsRef,
 * sprintAccRef). Shared physics and the visible HUD pass are kept here so
 * the WebGL and legacy worlds show the same particles.
 */

/** Темп появления частиц спринта: один комочек каждые столько мс бега. */
export const SPRINT_SPAWN_MS = 26;
/** Гравитация частиц спринта, px мира / с²: взлетев — падают обратно в траву. */
export const SPRINT_GRAVITY = 520;
/** Палитры частиц спринта: комочки земли и клочки травы. */
export const SPRINT_DIRT = ['#5b4632', '#6d5740', '#7e684b', '#4e3d2b'];
export const SPRINT_GRASS = ['#3f6d2a', '#4d7f33', '#5b913d', '#356023'];

/** Частица спринта: комочек земли/травы, вылетающий из-под лап. x/y — точка
 *  на грунте (px мира), z — высота над землёй; vz тянется вниз гравитацией,
 *  приземлившаяся или отжившая частица убирается. */
export type SprintPart = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  ttl: number;
  size: number;
  col: string;
  lift?:number;
  kind?:'dust';
};

/** Новый комочек из-под лап: летит против направления бега веером вверх. */
export function spawnSprintPart(arr: SprintPart[], fxPx: number, fyPx: number, bx: number, by: number,lift=0) {
  const dirt = Math.random() < 0.55;
  const pal = dirt ? SPRINT_DIRT : SPRINT_GRASS;
  const back = 36 + Math.random() * 84;
  const side = (Math.random() - 0.5) * 64;
  arr.push({
    lift,
    x: fxPx + (Math.random() - 0.5) * 10,
    y: fyPx + (Math.random() - 0.5) * 6,
    z: 2 + Math.random() * 4,
    vx: -bx * back + side * -by,
    vy: -by * back + side * bx,
    vz: 95 + Math.random() * 150,
    life: 0,
    ttl: 300 + Math.random() * 320,
    size: 2 + Math.random() * 2.5,
    col: pal[(Math.random() * pal.length) | 0],
  });
  if (arr.length > 90) arr.splice(0, arr.length - 90); // страховка от переполнения
}

/** A short radial burst at the actual landing foot point, once per jump. */
export function spawnLandingDust(parts:SprintPart[],x:number,y:number,lift:number){
  const palette=['#b59d72','#c8b186','#a28b64'];
  for(let i=0;i<12;i++){
    const angle=i*Math.PI/6+(Math.random()-.5)*.4,speed=24+Math.random()*55;
    parts.push({x:x+(Math.random()-.5)*8,y:y+(Math.random()-.5)*5,lift,z:1,vx:Math.cos(angle)*speed,
      vy:Math.sin(angle)*speed*.55,vz:18+Math.random()*30,life:0,ttl:330+Math.random()*220,
      size:3+Math.random()*4,col:palette[i%3],kind:'dust'});
  }
  if(parts.length>90)parts.splice(0,parts.length-90);
}

/** Shared bounded physics for sprint chips and softer landing dust. */
export function advanceGroundParticles(parts:SprintPart[],dt:number){
  const seconds=Math.min(50,Math.max(0,dt))/1000;let alive=0;
  for(const p of parts){
    p.life+=seconds*1000;if(p.life>=p.ttl)continue;
    p.x+=p.vx*seconds;p.y+=p.vy*seconds;p.z+=p.vz*seconds;
    p.vz-=(p.kind==='dust'?180:SPRINT_GRAVITY)*seconds;
    if(p.kind==='dust'){
      p.z=Math.max(0,p.z);const drag=Math.exp(-seconds*3);p.vx*=drag;p.vy*=drag;
    }else if(p.z<=0)continue;
    parts[alive++]=p;
  }
  parts.length=alive;
}

type RainSplash={x:number;y:number;lift:number;life:number;ttl:number;seed:number};
export type GroundEffectsState={rain:RainSplash[];rainBudget:number};
export const createGroundEffects=():GroundEffectsState=>({rain:[],rainBudget:0});

/** Rain hits are sampled on actual painted ground, not in empty screen space.
 * Positions stay in world coordinates while the camera pans/rotates/zooms.
 * Pools are bounded independently of map size; no map-sized canvas or texture.
 */
export function drawGroundEffects(
  canvas:HTMLCanvasElement|null,frame:ElisionFrame,parts:SprintPart[],state:GroundEffectsState,
  dt:number,raining:boolean,
){
  if(frame.editor){state.rain.length=0;state.rainBudget=0;parts.length=0;return;}
  const elapsed=Math.min(50,Math.max(0,dt));
  if(!raining){state.rain.length=0;state.rainBudget=0;}
  else{
    state.rain=state.rain.filter(p=>(p.life+=elapsed)<p.ttl);
    state.rainBudget+=elapsed/1000*Math.min(42,frame.viewW*frame.viewH/38000);
    while(state.rainBudget>=1){
      state.rainBudget--;
      const dx=(Math.random()-.5)*frame.viewW/frame.zoom,dy=(Math.random()-.5)*frame.viewH/frame.zoom;
      const x=frame.camX+dx*Math.cos(frame.yaw)+dy*Math.sin(frame.yaw);
      const y=frame.camY-dx*Math.sin(frame.yaw)+dy*Math.cos(frame.yaw);
      const cx=x/frame.cellW,cy=y/frame.cellH;
      if(cx<0||cy<0||cx>=frame.cols||cy>=frame.rows||!testPointInIsland(cx,cy))continue;
      state.rain.push({x,y,lift:terrainAt(frame.elev,cx,cy)*frame.terrainLiftStep,life:0,ttl:220+Math.random()*200,seed:Math.random()});
    }
    if(state.rain.length>64)state.rain.splice(0,state.rain.length-64);
  }
  const g=canvas?.getContext('2d');if(!g)return;
  const visible=(p:{x:number;y:number})=>p.x>=-20&&p.y>=-20&&p.x<=frame.viewW+20&&p.y<=frame.viewH+20&&!(p.x>frame.viewW-150&&p.y<130);
  const dpr=Math.min(2,window.devicePixelRatio||1);
  g.save();g.setTransform(dpr,0,0,dpr,0,0);
  for(const part of parts){
    const p=terrainScreenPoint(frame,part.x,part.y,(part.lift??0)+part.z);if(!visible(p))continue;
    const t=part.life/part.ttl,size=Math.max(.6,part.size*frame.zoom);
    g.fillStyle=part.col;
    if(part.kind==='dust'){
      g.globalAlpha=(1-t)*.4;g.beginPath();g.ellipse(p.x,p.y,size*(1+t),size*.5,0,0,Math.PI*2);g.fill();
    }else{
      g.globalAlpha=Math.min(1,(1-t)*1.6);g.fillRect(p.x-size/2,p.y-size/2,size,size);
    }
  }
  for(const splash of state.rain){
    const p=terrainScreenPoint(frame,splash.x,splash.y,splash.lift);if(!visible(p))continue;
    const t=splash.life/splash.ttl,spread=(2+6*t)*Math.max(.55,frame.zoom);
    g.globalAlpha=(1-t)*.42;g.strokeStyle='#c5e4f4';g.lineWidth=.65;g.beginPath();
    g.ellipse(p.x,p.y,spread,spread*.28,0,0,Math.PI*2);g.stroke();
    g.fillStyle='#d6ecf7';
    for(let i=0;i<3;i++){
      const angle=splash.seed*Math.PI*2+i*Math.PI*2/3;
      const x=p.x+Math.cos(angle)*spread,y=p.y+Math.sin(angle)*spread*.4-Math.sin(t*Math.PI)*5;
      g.beginPath();g.ellipse(x,y,.65,1,angle,0,Math.PI*2);g.fill();
    }
  }
  g.restore();
}
