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
  elisionCameraDown,
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
assert(ortho.left === -50 && ortho.right === 50 && ortho.top === 25 && ortho.bottom === -25, 'грани орто: ширина вида / zoom, без отражения X');

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

function project(wx, wy, camX, camY, yawRad, zoom, vw, vh) {
  camera.position.set(camX, 800, camY);
  camera.rotation.set(-Math.PI / 2, yawRad, 0);
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
  const p = Vector3.TransformCoordinates(new Vector3(wx, 0, wy), transform);
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
}

world.dispose();
engine.dispose();
console.log('elision scene ok');
