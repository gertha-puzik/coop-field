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
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Constants } from '@babylonjs/core/Engines/constants';
import {
  elisionOrtho,
  elisionActorFoot,
  elisionSpriteVertices,
  elisionObstacleAlpha,
  elisionDepthBias,
  elisionCameraPose,
  elisionTerrainGeometry,
  worldPxToScene,
  type ElisionActor,
  elisionDayTint,
  type ElisionFrame,
  type ElisionView,
} from './elision-scene';

const GRASS = new Color3(0.11, 0.24, 0.1);

type DecalNode = { root: TransformNode; mesh: Mesh; mat: StandardMaterial; sig: string; poseSig?: string };

export function createElisionView(canvas: HTMLCanvasElement): ElisionView {
  const engine = new Engine(
    canvas,
    true,
    {
      // Явно WebGL: disableWebGL2Support выключен, WebGPUEngine не создаётся.
      disableWebGL2Support: false,
      stencil: false,
      alpha: true,
      premultipliedAlpha: false,
      antialias: true,
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
  // RH даёт экранный +X вправо без отражённой ортопроекции.
  scene.useRightHandedSystem = true;
  scene.clearColor = new Color4(9 / 255, 9 / 255, 11 / 255, 1);
  scene.autoClear = true;

  const camera = new FreeCamera('elision-cam', new Vector3(0, 800, 0), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.minZ = 0.1;
  camera.maxZ = 5000;
  // Публичный механизм Babylon обновляет upVector из того же поворота.
  camera.updateUpVectorFromRotation = true;
  camera.rotation.set(-Math.PI / 4, 0, 0);
  scene.activeCamera = camera;

  const groundMat = new StandardMaterial('elision-ground', scene);
  groundMat.disableLighting = true;
  groundMat.specularColor = new Color3(0, 0, 0);
  groundMat.emissiveColor = GRASS.clone();
  groundMat.backFaceCulling = false;

  let ground: ReturnType<typeof CreateGround> | null = null;
  let groundTex: RawTexture | null = null;
  let terrainTop: Mesh | null = null;
  let terrainWalls: Mesh | null = null;
  let terrainFringe: Mesh | null = null;
  const wallMat = new StandardMaterial('elision-cliff', scene);
  wallMat.disableLighting = true;
  wallMat.specularColor = Color3.Black();
  wallMat.backFaceCulling = false;
  wallMat.transparencyMode = Material.MATERIAL_ALPHATEST;
  // CC0 Cainos stone tiles already shipped with the game: a repeating rock
  // surface instead of the old vertically stretched dirt gradient/dark band.
  const wallTex = new Texture('/tex/stone-floor.png', scene, false, false, Constants.TEXTURE_NEAREST_SAMPLINGMODE);
  wallTex.coordinatesIndex = 1;
  wallTex.wrapU = wallTex.wrapV = Texture.WRAP_ADDRESSMODE;
  wallMat.diffuseTexture = wallTex;
  wallMat.emissiveColor = Color3.White();
  let paintKey = '';
  let groundMode: ElisionView['ground'] = 'boot';
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

  let tint: [number,number,number] = [1,1,1];
  let tintAt = performance.now();
  const applyTint = (textured: boolean) => {
    const [r, g, b] = tint;
    wallMat.emissiveColor.set(r, g, b);
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

  const syncTerrain = (frame: ElisionFrame) => {
    terrainTop?.dispose(false, false);
    terrainWalls?.dispose(false, false);
    terrainFringe?.dispose(false, false);
    terrainTop = null;
    terrainWalls = null;
    const geo = elisionTerrainGeometry(frame.cols, frame.rows, frame.cellW, frame.cellH, frame.elev, frame.terrainLiftStep);
    const make = (name: string, part: typeof geo.tops, material: StandardMaterial) => {
      if (!part.positions.length) return null;
      const mesh = new Mesh(name, scene);
      const data = new VertexData();
      data.positions = part.positions;
      data.indices = part.indices;
      data.uvs = part.uvs;
      data.uvs2 = part.uvs2;
      const normals: number[] = [];
      VertexData.ComputeNormals(part.positions, part.indices, normals);
      data.normals = normals;
      data.applyToMesh(mesh);
      mesh.material = material;
      mesh.isPickable = false;
      return mesh;
    };
    terrainTop = make('elision-plateau-tops', geo.tops, groundMat);
    terrainWalls = make('elision-cliff-walls', geo.walls, wallMat);
    terrainFringe = make('elision-grass-fringe', geo.fringe, groundMat);
    wallMat.opacityTexture = groundTex;
  };

  const syncGround = (frame: ElisionFrame) => {
    const worldW = Math.max(1, frame.cols * frame.cellW);
    const worldH = Math.max(1, frame.rows * frame.cellH);
    const src = frame.paint;
    const key = `${worldW}x${worldH}:${src ? `${src.width}x${src.height}` : 'flat'}:${frame.paintRev}`;
    if (key === paintKey && ground) {
      applyTint(groundMat.diffuseTexture != null);
      return;
    }
    paintKey = key;
    placeGround(worldW, worldH);
    wallMat.opacityTexture = null;
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
      applyTint(false);
      syncTerrain(frame);
      return;
    }
    groundMode = 'paint';
    // У CreateGround v=0 на z=0: ImageData загружаем без invertY,
    // иначе рисунок зеркалится по вертикали относительно объектов и коллизий.
    groundTex = RawTexture.CreateRGBATexture(
      new Uint8Array(pixels),
      src.width,
      src.height,
      scene,
      version >= 2,
      false,
      version >= 2 ? Constants.TEXTURE_TRILINEAR_SAMPLINGMODE : Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
    );
    groundTex.hasAlpha = true;
    groundTex.anisotropicFilteringLevel = 8;
    groundTex.wrapU = groundTex.wrapV = Texture.CLAMP_ADDRESSMODE;
    groundMat.diffuseTexture = groundTex;
    groundMat.opacityTexture = groundTex;
    groundMat.transparencyMode = Material.MATERIAL_ALPHATEST;
    groundMat.alphaCutOff = 0.15;
    applyTint(true);
    syncTerrain(frame);
  };

  const textureFor = (url: string): Texture => {
    const cached = textures.get(url);
    if (cached) return cached;
    const tex = new Texture(
      url,
      scene,
      false,
      true,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    );
    tex.hasAlpha = true;
    tex.anisotropicFilteringLevel = 8;
    tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    textures.set(url, tex);
    return tex;
  };

  const syncDecals = (frame: ElisionFrame) => {
    const list = frame.decals;
    const self = list.find((actor) => actor.id === frame.controlledId);
    const seen = new Set<string>();
    for (const actor of list) {
      if (!actor.url || actor.w < 1 || actor.h < 1) continue;
      seen.add(actor.id);
      const sig = `${actor.url}|${actor.w.toFixed(2)}|${actor.h.toFixed(2)}|${actor.mirror ? 1 : 0}|${actor.rot}`;
      let node = decals.get(actor.id);
      if (!node || node.sig.split('|')[0] !== actor.url) {
        if (node) {
          node.mat.emissiveTexture = null;
          node.mat.dispose(false, false);
          node.root.dispose();
        }
        const mat = new StandardMaterial(`decal-${actor.id}`, scene);
        mat.disableLighting = true;
        mat.specularColor = new Color3(0, 0, 0);
        const tex = textureFor(actor.url);
        mat.emissiveColor = Color3.White();
        mat.diffuseTexture = tex;
        // Берём альфу один раз: повторная opacityTexture темнила и обрезала края.
        mat.useAlphaFromDiffuseTexture = true;
        mat.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
        mat.alphaCutOff = 0.01;
        mat.backFaceCulling = false;
        mat.zOffset = elisionDepthBias(actor.id);
        const mesh = new Mesh(`decal-${actor.id}`, scene);
        const vertices = new VertexData();
        vertices.positions = elisionSpriteVertices(actor.w, actor.h, actor.rot, actor.mirror);
        vertices.indices = [0,1,2, 0,2,3];
        vertices.normals = [0,0,-1, 0,0,-1, 0,0,-1, 0,0,-1];
        vertices.uvs = [0,0, 1,0, 1,1, 0,1];
        vertices.applyToMesh(mesh, true);
        mesh.material = mat;
        mesh.isPickable = false;
        const root = new TransformNode(`sprite-foot-${actor.id}`, scene);
        mesh.parent = root;
        node = { root, mesh, mat, sig };
        decals.set(actor.id, node);
      }
      // Обновляем только вершины: разворот не удаляет материал и не ждёт компиляции шейдера.
      const pose = actor.pose;
      const poseSig = `${sig}|${pose?.scaleX}|${pose?.scaleY}|${pose?.rot}`;
      if (node.poseSig !== poseSig) {
        node.mesh.updateVerticesData('position', elisionSpriteVertices(
          actor.w * (pose?.scaleX ?? 1), actor.h * (pose?.scaleY ?? 1),
          actor.rot + (pose?.rot ?? 0) * 180/Math.PI, actor.mirror), true);
        node.poseSig = poseSig;
      }
      node.sig = sig;
      node.mat.emissiveColor.set(...tint);
      const targetAlpha = actor.opacity ?? elisionObstacleAlpha(actor, self, frame.yaw);
      const alpha = Math.abs(node.mat.alpha - targetAlpha) < 0.001 ? targetAlpha
        : node.mat.alpha + (targetAlpha - node.mat.alpha) * 0.18;
      node.mat.alpha = alpha;
      node.mat.alphaCutOff = 0.01;
      node.mat.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
      const foot = elisionActorFoot(actor);
      node.root.position.set(foot.x + (pose?.sway ?? 0)*Math.cos(frame.yaw),
        foot.y + (pose?.lift ?? 0), foot.z - (pose?.sway ?? 0)*Math.sin(frame.yaw));
      // Вертикальные билборды имеют глубину по точке опоры, а не общей плоскости земли.
      node.root.rotation.set(0, frame.yaw, 0);
    }
    for (const [id, node] of decals) {
      if (seen.has(id)) continue;
      node.mat.emissiveTexture = null;
      node.mat.dispose(false, false);
      node.root.dispose();
      decals.delete(id);
    }
  };

  const placeCamera = (frame: ElisionFrame) => {
    const distance = Math.max(800, frame.cols * frame.cellW + frame.rows * frame.cellH);
    const eye = elisionCameraPose(frame.camX, frame.camY, frame.yaw, distance);
    camera.position.set(eye.x, eye.y, eye.z);
    camera.rotation.set(eye.pitch, eye.yaw, 0);
    camera.maxZ = distance * 4;
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
      if (frame.viewW < 2 || frame.viewH < 2) {
        canvas.style.visibility = 'hidden';
        return;
      }
      canvas.style.visibility = 'visible';
      const now = performance.now(), target = elisionDayTint(frame.dayProgress);
      const k = 1-Math.exp(-Math.min(100,Math.max(0,now-tintAt))/1200);
      tint = frame.editor ? target : tint.map((v,i)=>v+(target[i]-v)*k) as [number,number,number];
      tintAt = now;
      fitCanvas();
      placeCamera(frame);
      syncGround(frame);
      syncDecals(frame);
      scene.render();
    },
    destroy() {
      if (dead) return;
      dead = true;
      for (const node of decals.values()) {
        node.mat.emissiveTexture = null;
        node.mat.dispose(false, false);
        node.root.dispose();
      }
      decals.clear();
      for (const tex of textures.values()) tex.dispose();
      textures.clear();
      groundTex?.dispose();
      ground?.dispose(false, false);
      terrainTop?.dispose(false, false);
      terrainWalls?.dispose(false, false);
      terrainFringe?.dispose(false, false);
      wallTex.dispose();
      wallMat.dispose(false, false);
      scene.dispose();
      engine.dispose();
    },
  };
  return view;
}
