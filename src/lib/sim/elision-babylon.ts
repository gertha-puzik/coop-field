/**
 * WebGL-вид Элизии на Babylon.js. Грузится только динамическим import()
 * из use-elision-view, когда на поле открыта Элизия: в бандл пивных гротов
 * и в первый чанк статического экспорта движок не входит. Нет WebGL —
 * createElisionView бросает, хук убирает канвас, остаётся прежний 2D.
 *
 * Engine, не WebGPUEngine. Камера ортографическая и совпадает с
 * screenToWorld (формулы — elision-scene.ts), поэтому клики не переезжают.
 */
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera';
import { Camera } from '@babylonjs/core/Cameras/camera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { CreatePlane } from '@babylonjs/core/Meshes/Builders/planeBuilder';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Constants } from '@babylonjs/core/Engines/constants';
import {
  elisionCameraUp,
  elisionOrtho,
  worldPxToScene,
  type ElisionActor,
  type ElisionDay,
  type ElisionFrame,
  type ElisionView,
} from './elision-scene';

const DAY_TINT: Record<ElisionDay, [number, number, number]> = {
  morning: [1, 0.94, 0.82],
  day: [1, 1, 1],
  evening: [1, 0.8, 0.66],
  night: [0.42, 0.5, 0.72],
};

const GRASS = new Color3(0.11, 0.24, 0.1);

type DecalNode = { mesh: Mesh; mat: StandardMaterial; sig: string };

export function createElisionView(canvas: HTMLCanvasElement): ElisionView {
  const engine = new Engine(
    canvas,
    false,
    {
      // Явно WebGL: disableWebGL2Support выключен, WebGPUEngine не создаётся.
      disableWebGL2Support: false,
      stencil: false,
      alpha: true,
      premultipliedAlpha: false,
      antialias: false,
      failIfMajorPerformanceCaveat: false,
    },
    true,
  );
  const version = engine.webGLVersion;
  if (version < 1) {
    engine.dispose();
    throw new Error('WebGL недоступен');
  }
  const webgl: ElisionView['webgl'] = version >= 2 ? 'webgl2' : 'webgl1';

  const scene = new Scene(engine);
  scene.clearColor = new Color4(9 / 255, 9 / 255, 11 / 255, 1);
  scene.autoClear = true;

  const camera = new FreeCamera('elision-cam', new Vector3(0, 800, 0), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.1;
  camera.maxZ = 5000;
  // Смотрим ровно вниз. yaw живёт в upVector, не в крене: setTarget его
  // затирает (там Vector3.Up и rotation.z = 0), поэтому цель не лочим.
  camera.rotation.x = Math.PI / 2;
  camera.rotation.y = 0;
  camera.rotation.z = 0;
  scene.activeCamera = camera;

  const groundMat = new StandardMaterial('elision-ground', scene);
  groundMat.disableLighting = true;
  groundMat.specularColor = new Color3(0, 0, 0);
  groundMat.emissiveColor = GRASS.clone();
  groundMat.backFaceCulling = false;

  let ground: ReturnType<typeof CreateGround> | null = null;
  let groundTex: RawTexture | null = null;
  let paintKey = '';
  let groundMode: ElisionView['ground'] = 'boot';
  let wasEditor = false;
  let lastCssW = 0;
  let lastCssH = 0;
  const textures = new Map<string, Texture>();
  const decals = new Map<string, DecalNode>();

  const fitCanvas = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === lastCssW && h === lastCssH) return;
    lastCssW = w;
    lastCssH = h;
    engine.resize();
    canvas.style.width = '100%';
    canvas.style.height = '100%';
  };

  const applyTint = (day: ElisionDay, textured: boolean) => {
    const [r, g, b] = DAY_TINT[day];
    if (textured) groundMat.emissiveColor.set(r, g, b);
    else groundMat.emissiveColor.set(GRASS.r * r, GRASS.g * g, GRASS.b * b);
  };

  const placeGround = (worldW: number, worldH: number) => {
    ground?.dispose(false, false);
    ground = CreateGround('elision-ground', { width: worldW, height: worldH, subdivisions: 1 }, scene);
    const origin = worldPxToScene(worldW / 2, worldH / 2, 0);
    ground.position.set(origin.x, origin.y, origin.z);
    ground.material = groundMat;
    ground.isPickable = false;
  };

  const syncGround = (frame: ElisionFrame) => {
    const worldW = Math.max(1, frame.cols * frame.cellW);
    const worldH = Math.max(1, frame.rows * frame.cellH);
    const src = frame.paint;
    const key = `${worldW}x${worldH}:${src ? `${src.width}x${src.height}` : 'flat'}:${frame.paintRev}`;
    if (key === paintKey && ground) {
      applyTint(frame.day, groundMat.emissiveTexture != null);
      return;
    }
    paintKey = key;
    placeGround(worldW, worldH);
    groundTex?.dispose();
    groundTex = null;
    groundMat.emissiveTexture = null;
    groundMat.diffuseTexture = null;
    groundMat.opacityTexture = null;
    let pixels: Uint8ClampedArray | null = null;
    if (src && src.width >= 2 && src.height >= 2) {
      try {
        const copy = document.createElement('canvas');
        copy.width = src.width;
        copy.height = src.height;
        const g = copy.getContext('2d', { willReadFrequently: true });
        if (!g) throw new Error('no 2d');
        g.imageSmoothingEnabled = false;
        g.drawImage(src, 0, 0);
        pixels = g.getImageData(0, 0, copy.width, copy.height).data;
      } catch {
        pixels = null;
        groundMode = 'unread';
      }
    }
    if (!pixels || !src) {
      if (groundMode !== 'unread') groundMode = 'flat';
      groundMat.transparencyMode = Material.MATERIAL_OPAQUE;
      applyTint(frame.day, false);
      return;
    }
    groundMode = 'paint';
    // ImageData идёт сверху вниз, GL — снизу вверх. invertY кладёт верх рисунка на z = 0.
    groundTex = RawTexture.CreateRGBATexture(
      new Uint8Array(pixels),
      src.width,
      src.height,
      scene,
      false,
      true,
      Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    );
    groundTex.hasAlpha = true;
    groundMat.emissiveTexture = groundTex;
    groundMat.diffuseTexture = groundTex;
    groundMat.opacityTexture = groundTex;
    groundMat.transparencyMode = Material.MATERIAL_ALPHATEST;
    groundMat.alphaCutOff = 0.15;
    applyTint(frame.day, true);
  };

  const textureFor = (url: string): Texture => {
    const cached = textures.get(url);
    if (cached) return cached;
    const tex = new Texture(
      url,
      scene,
      false,
      true,
      Constants.TEXTURE_NEAREST_SAMPLINGMODE,
    );
    tex.hasAlpha = true;
    textures.set(url, tex);
    return tex;
  };

  const syncDecals = (list: ElisionActor[]) => {
    const seen = new Set<string>();
    for (const actor of list) {
      if (!actor.url || actor.w < 1 || actor.h < 1) continue;
      seen.add(actor.id);
      const sig = `${actor.url}|${actor.w.toFixed(2)}|${actor.h.toFixed(2)}|${actor.mirror ? 1 : 0}|${actor.rot}`;
      let node = decals.get(actor.id);
      if (!node || node.sig !== sig) {
        if (node) {
          node.mat.emissiveTexture = null;
          node.mat.dispose(false, false);
          node.mesh.dispose(false, false);
        }
        const mat = new StandardMaterial(`decal-${actor.id}`, scene);
        mat.disableLighting = true;
        mat.specularColor = new Color3(0, 0, 0);
        const tex = textureFor(actor.url);
        mat.emissiveColor = Color3.White();
        mat.emissiveTexture = tex;
        mat.diffuseTexture = tex;
        mat.opacityTexture = tex;
        mat.useAlphaFromDiffuseTexture = true;
        mat.transparencyMode = Material.MATERIAL_ALPHATEST;
        mat.alphaCutOff = 0.35;
        mat.backFaceCulling = false;
        const mesh = CreatePlane(
          `decal-${actor.id}`,
          { width: actor.w, height: actor.h, sideOrientation: Mesh.DOUBLESIDE },
          scene,
        );
        mesh.material = mat;
        mesh.isPickable = false;
        mesh.rotation.x = Math.PI / 2;
        mesh.rotation.y = (actor.rot * Math.PI) / 180;
        mesh.rotation.z = 0;
        mesh.scaling.x = actor.mirror ? -1 : 1;
        node = { mesh, mat, sig };
        decals.set(actor.id, node);
      }
      const place = worldPxToScene(actor.x + actor.w / 2, actor.y + actor.h / 2, actor.lift + 2);
      node.mesh.position.set(place.x, place.y, place.z);
    }
    for (const [id, node] of decals) {
      if (seen.has(id)) continue;
      node.mat.emissiveTexture = null;
      node.mat.dispose(false, false);
      node.mesh.dispose(false, false);
      decals.delete(id);
    }
  };

  const placeCamera = (frame: ElisionFrame) => {
    const eye = worldPxToScene(frame.camX, frame.camY, 800);
    camera.position.set(eye.x, eye.y, eye.z);
    camera.rotation.x = Math.PI / 2;
    camera.rotation.y = 0;
    camera.rotation.z = 0;
    // getViewMatrix один раз подменяет upVector, если крен «ещё не кэширован».
    (camera as unknown as { _cachedRotationZ: number })._cachedRotationZ = 0;
    const up = elisionCameraUp(frame.yaw);
    camera.upVector.set(up.x, up.y, up.z);
    const ortho = elisionOrtho(frame.viewW, frame.viewH, frame.zoom);
    camera.orthoLeft = ortho.left;
    camera.orthoRight = ortho.right;
    camera.orthoBottom = ortho.bottom;
    camera.orthoTop = ortho.top;
  };

  let dead = false;
  const view: ElisionView = {
    webgl,
    get ground() {
      return groundMode;
    },
    frame(frame) {
      if (dead) return;
      if (frame.editor || frame.viewW < 2 || frame.viewH < 2) {
        canvas.style.visibility = 'hidden';
        wasEditor = frame.editor;
        return;
      }
      canvas.style.visibility = 'visible';
      if (wasEditor) {
        paintKey = '';
        wasEditor = false;
      }
      fitCanvas();
      placeCamera(frame);
      syncGround(frame);
      syncDecals(frame.decals);
      scene.render();
    },
    destroy() {
      if (dead) return;
      dead = true;
      for (const node of decals.values()) {
        node.mat.emissiveTexture = null;
        node.mat.dispose(false, false);
        node.mesh.dispose(false, false);
      }
      decals.clear();
      for (const tex of textures.values()) tex.dispose();
      textures.clear();
      groundTex?.dispose();
      ground?.dispose(false, false);
      scene.dispose();
      engine.dispose();
    },
  };
  return view;
}
