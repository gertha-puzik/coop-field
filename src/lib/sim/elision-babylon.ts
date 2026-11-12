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
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
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
import { rememberSpriteAspect } from './sprite-aspect';

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
  /** DynamicTexture: mid-stroke upload с canvas без getImageData (RawTexture
   *  каждый paintRev создавал новую GPU-текстуру и рвал росчерк). */
  let groundDyn: DynamicTexture | null = null;
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
  const textures = new Map<string|HTMLCanvasElement, Texture>();
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
    wallMat.opacityTexture = groundDyn;
  };

  const syncGround = (frame: ElisionFrame) => {
    const worldW = Math.max(1, frame.cols * frame.cellW);
    const worldH = Math.max(1, frame.rows * frame.cellH);
    const src = frame.paint;
    const sizeKey = `${worldW}x${worldH}:${src ? `${src.width}x${src.height}` : 'flat'}`;
    const key = `${sizeKey}:${frame.paintRev}`;
    if (key === paintKey && ground) {
      applyTint(groundMat.diffuseTexture != null);
      return;
    }
    const sizeChanged = !paintKey.startsWith(sizeKey + ':') || !ground;
    paintKey = key;
    if (sizeChanged) placeGround(worldW, worldH);
    if (!src || src.width < 2 || src.height < 2) {
      wallMat.opacityTexture = null;
      groundMat.emissiveTexture = null;
      groundMat.diffuseTexture = null;
      groundMat.opacityTexture = null;
      groundDyn?.dispose();
      groundDyn = null;
      if (groundMode !== 'unread') groundMode = 'flat';
      groundMat.transparencyMode = Material.MATERIAL_OPAQUE;
      applyTint(false);
      syncTerrain(frame);
      return;
    }
    try {
      const tw = src.width;
      const th = src.height;
      const needNew = !groundDyn || groundDyn.getSize().width !== tw || groundDyn.getSize().height !== th;
      if (needNew) {
        groundDyn?.dispose();
        // invertY=false — как у прежнего RawTexture: CreateGround v=0 на z=0.
        groundDyn = new DynamicTexture(
          'elision-ground',
          { width: tw, height: th },
          scene,
          version >= 2,
          version >= 2 ? Constants.TEXTURE_TRILINEAR_SAMPLINGMODE : Constants.TEXTURE_BILINEAR_SAMPLINGMODE,
          Constants.TEXTUREFORMAT_RGBA,
          false,
        );
        groundDyn.hasAlpha = true;
        groundDyn.anisotropicFilteringLevel = 8;
        groundDyn.wrapU = groundDyn.wrapV = Texture.CLAMP_ADDRESSMODE;
        groundMat.diffuseTexture = groundDyn;
        groundMat.opacityTexture = groundDyn;
        groundMat.transparencyMode = Material.MATERIAL_ALPHATEST;
        groundMat.alphaCutOff = 0.15;
      }
      const dyn = groundDyn;
      if (!dyn) throw new Error('no groundDyn');
      const g = dyn.getContext() as CanvasRenderingContext2D;
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, tw, th);
      g.drawImage(src, 0, 0);
      dyn.update(false);
      wallMat.opacityTexture = dyn;
      groundMode = 'paint';
      applyTint(true);
      // Рельеф/стены — только при смене размера мира; mid-stroke их не трогаем.
      if (sizeChanged) syncTerrain(frame);
    } catch {
      groundMode = 'unread';
      groundMat.transparencyMode = Material.MATERIAL_OPAQUE;
      applyTint(false);
      if (sizeChanged) syncTerrain(frame);
    }
  };

  const noteTextureAspect = (tex: Texture, url: string, image?: HTMLCanvasElement) => {
    // Размеры текстуры → кэш aspect: билборд перестаёт тянуться, даже если
    // HTMLImage ещё не лежит в spritesRef (типичный чужой/личный окрас).
    if (image && image.width > 0 && image.height > 0) {
      rememberSpriteAspect(url, image.width, image.height);
      return;
    }
    const mark = () => {
      const size = tex.getSize();
      if (size.width > 1 && size.height > 1) rememberSpriteAspect(url, size.width, size.height);
    };
    if (tex.isReady()) mark();
    else tex.onLoadObservable.addOnce(mark);
  };

  const textureFor = (url: string,image?:HTMLCanvasElement): Texture => {
    const key=image??url;
    const cached = textures.get(key);
    if (cached) {
      noteTextureAspect(cached, url, image);
      return cached;
    }
    const tex = image ? RawTexture.CreateRGBATexture(
      new Uint8Array(image.getContext('2d')!.getImageData(0,0,image.width,image.height).data),
      image.width,image.height,scene,true,true,Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    ) : new Texture(
      url,
      scene,
      false,
      true,
      Constants.TEXTURE_TRILINEAR_SAMPLINGMODE,
    );
    tex.hasAlpha = true;
    tex.anisotropicFilteringLevel = 8;
    tex.wrapU = tex.wrapV = Texture.CLAMP_ADDRESSMODE;
    textures.set(key, tex);
    noteTextureAspect(tex, url, image);
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
        const tex = textureFor(actor.url,actor.image);
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
      // Switching GIF frames reuses the mesh/material and each uploaded texture.
      const texture=textureFor(actor.url,actor.image);
      if(node.mat.diffuseTexture!==texture)node.mat.diffuseTexture=texture;
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
      groundDyn?.dispose();
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
