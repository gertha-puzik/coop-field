// @ts-nocheck
// Вид Элизии: один перевод px мира в сцену и ортокамера, совпадающая с
// screenToWorld. Настоящая камера Babylon в NullEngine проверяет проекцию
// и frustum, браузер отдельно проверяет WebGL и ориентацию текстур.
// Запуск — через npm run test:unit.
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Camera } from '@babylonjs/core/Cameras/camera.js';
import { Frustum } from '@babylonjs/core/Maths/math.frustum.js';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import {
  elisionLeapClearance,
  elisionScreenX, elisionDayTint, elisionRotatedSize,
  elisionSpritePose,
  elisionActorFoot, elisionSpriteVertices, elisionDepthBias, elisionObstacleAlpha,
  elisionCameraDown,
  elisionCameraPose,
  elisionTerrainGeometry,
  elisionCameraRight,
  elisionCameraUp,
  elisionOrtho,
  selfWorldPx,
  spriteSizePx,
  worldPxToScene,
} from '../src/lib/sim/elision-scene.ts';

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/** Копия screenToWorld из geometry.ts — тот файл тянет test-field, юнит-раннер так не грузит. */
function screenToWorld(sx, sy, vw, vh, camX, camY, z, yaw) {
  const dx = (sx - vw / 2) / Math.max(0.05, z);
  const dy = (sy - vh / 2) / Math.max(0.05, z);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: dx * c + dy * s + camX, y: -dx * s + dy * c + camY };
}

const scene = worldPxToScene(10, 20, 26);
assert(scene.x === 10 && scene.y === 26 && scene.z === 20, 'мир (x, y вниз, подъём) → (x, подъём, z=y)');
assert(worldPxToScene(0, 0, 0).x === 0 && worldPxToScene(0, 0, 0).z === 0, 'нулевая клетка без сдвига +1');

const body = { fx: 1.5, fy: 2, col: 4, row: 1, liftV: 26, leapZ: 0, leap: null };
const peace = selfWorldPx(body, 100, 150, true, 0);
assert(peace.x === 150 && peace.y === 300 && peace.lift === 26, 'мирный кот стоит в fx/fy, левый верх');
const battle = selfWorldPx(body, 100, 150, false, 0);
assert(battle.x === 400 && battle.y === 150 && battle.lift === 26, 'боевой кот стоит в клетке col/row');
const leaping = selfWorldPx(
  {
    ...body,
    leapZ: 10,
    leap: { battle: true, t0: 0, dur: 100, x0: 0, y0: 0, x1: 200, y1: 100, l0: 0, l1: 26 },
  },
  100,
  150,
  false,
  50,
);
assert(leaping.x === 100 && leaping.y === 50 && leaping.lift === 23, 'боевой прыжок — середина дуги в px');
const size = spriteSizePx(150, 100, 0.5);
assert(size.h === 140 && size.w === 70, 'рост модельки как у spriteBoxOf');

const yaw = Math.PI / 2;
const right = elisionCameraRight(yaw);
const down = elisionCameraDown(yaw);
assert(Math.abs(right.x) < 1e-9 && Math.abs(right.z + 1) < 1e-9, 'yaw 90°: экран вправо = −z');
assert(Math.abs(down.x - 1) < 1e-9 && Math.abs(down.z) < 1e-9, 'yaw 90°: экран вниз = +x');
const up = elisionCameraUp(0);
assert(up.x === 0 && up.y === 0 && up.z === -1, 'yaw 0: верх экрана = −z');

const ortho = elisionOrtho(200, 100, 2);
assert(ortho.left === -50 && ortho.right === 50 && Math.abs(ortho.top - 25 * Math.SQRT1_2) < 1e-9 && ortho.bottom === -ortho.top, 'грани орто: ширина вида / zoom, без отражения X');

const engine = new NullEngine();
const world = new Scene(engine);
world.useRightHandedSystem = true;
const camera = new FreeCamera('regression-camera', new Vector3(0, 800, 0), world);
camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
camera.minZ = 0.1;
camera.maxZ = 4000;
camera.updateUpVectorFromRotation = true;
const prop = CreatePlane('visible-tree', { width: 30, height: 60 }, world);
prop.rotation.x = -Math.PI / 2;

function project(wx, wy, camX, camY, yawRad, zoom, vw, vh, lift = 0) {
  const eye = elisionCameraPose(camX, camY, yawRad, 800);
  camera.position.set(eye.x, eye.y, eye.z);
  camera.rotation.set(eye.pitch, eye.yaw, 0);
  const box = elisionOrtho(vw, vh, zoom);
  camera.orthoLeft = box.left;
  camera.orthoRight = box.right;
  camera.orthoBottom = box.bottom;
  camera.orthoTop = box.top;
  const transform = camera.getViewMatrix(true).multiply(camera.getProjectionMatrix(true));
  // До исправления left > right отсекает даже объект в центре кадра.
  prop.position.set(camX, 2, camY);
  prop.computeWorldMatrix(true);
  assert(prop.isInFrustum(Frustum.GetPlanes(transform)), 'объект в центре виден frustum');
  const p = Vector3.TransformCoordinates(new Vector3(wx, lift, wy), transform);
  return { sx: (p.x * 0.5 + 0.5) * vw, sy: (1 - (p.y * 0.5 + 0.5)) * vh };
}

const samples = [
  [10, 20, 0, 0, 0, 1, 200, 100],
  [10, 20, 0, 0, 0, 2, 200, 100],
  [50, 80, 40, 70, Math.PI / 2, 1, 300, 200],
  [12, -4, 3, 5, Math.PI / 4, 1.5, 400, 300],
  [100, 40, 10, -20, -Math.PI / 3, 0.8, 640, 480],
];
for (const [wx, wy, camX, camY, yawRad, zoom, vw, vh] of samples) {
  const got = project(wx, wy, camX, camY, yawRad, zoom, vw, vh);
  const back = screenToWorld(got.sx, got.sy, vw, vh, camX, camY, zoom, yawRad);
  assert(Math.abs(back.x - wx) < 1e-3 && Math.abs(back.y - wy) < 1e-3, `проекция не совпала с screenToWorld (${wx}, ${wy})`);
  const raised = project(wx, wy, camX, camY, yawRad, zoom, vw, vh, 52);
  assert(Math.abs(raised.sx - got.sx) < 1e-3, 'подъём не сдвигает кота вбок');
  assert(Math.abs(raised.sy - got.sy + 52 * zoom) < 1e-3, 'подъём 2 уровня виден на 52px выше земли');
}

const terrain = elisionTerrainGeometry(4, 3, 100, 150, { '1,1': 2, '2,1': 2 }, 26);
assert(terrain.tops.positions.length === 2 * 4 * 3, 'две поднятые поверхности');
assert(terrain.walls.positions.length === 6 * 4 * 3, 'шесть внешних стен, общей стены нет');
assert(terrain.tops.positions.filter((_, i) => i % 3 === 1).every(y => y === 52), 'верх соответствует высоте карты');
assert(terrain.tops.uvs[0] === 1/4 && terrain.tops.uvs[1] === 1/3, 'UV верха берёт свою клетку из атласа');
const stepped = elisionTerrainGeometry(4, 3, 100, 150, { '1,1': 2, '2,1': 1 }, 26);
assert(stepped.walls.positions.length === 7 * 4 * 3, 'перепад высот добавляет одну стену');
const empty = elisionTerrainGeometry(4, 3, 100, 150, {}, 26);
assert(empty.tops.positions.length === 0 && empty.walls.positions.length === 0, 'плоская карта без стен');

world.dispose();
engine.dispose();
console.log('elision scene ok');

const self = {id:'main',x:100,y:100,w:60,h:100,lift:0,rot:0,url:'cat',mirror:false};
const obstacle = {...self,id:'tree',isProp:true,x:90,y:70,w:120,h:160};
assert(elisionObstacleAlpha(obstacle,self,0) < 0.5, 'foreground obstacle does not hide player');
assert(elisionObstacleAlpha({...obstacle,y:0},self,0) === 1, 'background obstacle stays opaque');
assert(elisionObstacleAlpha({...obstacle,x:1000},self,0) === 1, 'unrelated obstacle stays opaque');
assert(elisionObstacleAlpha(self,self,0) === 1, 'player stays opaque');
const foot = elisionActorFoot(self);
assert(foot.x === 130 && foot.z === 200 && Math.abs(foot.y-.2) < 1e-9, 'billboard is anchored at feet above ground');
assert(elisionDepthBias('tree') === elisionDepthBias('tree'), 'no frame-dependent sort jitter');
assert(elisionDepthBias('tree') !== elisionDepthBias('main'), 'coplanar ties have stable offsets');
assert(elisionDepthBias('tree') > -1 && elisionDepthBias('tree') < 0, 'bias stays small');
for (const angle of [0, 45, 90, 180, 270]) {
  const vertices = elisionSpriteVertices(60,100,angle,false);
  assert(vertices.every(Number.isFinite), 'finite rotated billboard');
  assert(vertices.filter((_,i)=>i%3===1).every(y=>y>=0), 'no billboard vertex below terrain');
  const radians = angle*Math.PI/180;
  const expected = [[-30,0],[30,0],[30,100],[-30,100]].map(([x,y])=>x*Math.sin(radians)-y*Math.cos(radians));
  for(let i=0;i<4;i++) assert(Math.abs(vertices[i*3+2]-vertices[i*3+1]-expected[i])<1e-8,'old 2D rotation preserved above ground');
}
console.log('sprite depth, occlusion and rotated ground clearance ok');

const crouch = elisionSpritePose(4100,0,140,{holding:true,since:100,releaseAt:0,charge:0});
assert(Math.abs(crouch.scaleY - 0.58) < 1e-9 && crouch.scaleX === 1.2, 'полный присед виден в WebGL');
const release = elisionSpritePose(4100,0,140,{holding:false,since:100,releaseAt:4100,charge:1});
assert(release.scaleY > 1 && release.lift > 0, 'отпускание пробела растягивает и подбрасывает спрайт');
const wobble = elisionSpritePose(115,0.5,140);
assert(wobble.scaleX !== 1 && wobble.scaleY !== 1 && wobble.rot !== 0, 'поворот даёт желе');
assert(wobble.scaleX > 0.8 && wobble.scaleY > 0.8, 'поворот не схлопывает спрайт в ноль');

for(const yaw of [0,Math.PI/2,Math.PI,Math.PI*1.5]) {
  // Правая клавиша преобразована из экрана в мир; обратная проекция всегда вправо.
  assert(Math.abs(elisionScreenX(Math.cos(yaw),-Math.sin(yaw),yaw)-1)<1e-9,'разворот вправо одинаков во всех квадрантах');
  assert(Math.abs(elisionScreenX(Math.sin(yaw),Math.cos(yaw),yaw))<1e-9,'вертикальная ходьба не переворачивает кота');
}
for(const boundary of [0,1,2,3,4]) {
  const a=elisionDayTint(boundary-1e-5),b=elisionDayTint(boundary+1e-5);
  assert(a.every((v,i)=>Math.abs(v-b[i])<1e-4),'цвет суток непрерывен на границе фазы');
}
assert(elisionDayTint(NaN).every(Number.isFinite),'нет NaN до сетевого якоря суток');
const rotated=elisionRotatedSize(1200,600,Math.PI/2);
assert(Math.abs(rotated.w-600)<1e-8&&Math.abs(rotated.h-1200)<1e-8,'редактор вписывает повёрнутую карту');

const leapFloor=(c:number,r:number)=>c===4&&r>=3&&r<=4?2:0;
for(const [y0,y1,l0,l1] of [[5.19,3.5,0,52],[3.5,5.19,52,0]]) {
  const z=elisionLeapClearance(4.5,y0,4.5,y1,l0,l1,70,26,leapFloor);
  for(let t=.001;t<1;t+=.001) {
    const floor=leapFloor(4,Math.floor(y0+(y1-y0)*t))*26;
    const lift=l0+(l1-l0)*t+Math.sin(Math.PI*t)*z;
    assert(lift>=floor-1e-4,'дуга на подъёме/спуске не проходит внутри верхней поверхности');
  }
}
assert(elisionLeapClearance(0,0,2,0,0,0,60,26,()=>0)===60,'прыжок по ровной земле не меняется');

const rock = { id: 'rock', isProp: true, x: 0, y: 0, w: 100, h: 100, lift: 0, url: '/tex/rock-1.png', mirror: false, rot: 0 };
assert(elisionObstacleAlpha(rock, {...rock, id: 'self', isProp: false}, 0) === 1, 'камень остаётся непрозрачным при пересечении с котом');
