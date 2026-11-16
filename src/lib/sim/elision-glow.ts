/** Cosmetic world-space lights: bounded shader work, smooth dusk/dawn and firefly flights. */
import { MaterialPluginBase } from "@babylonjs/core/Materials/materialPluginBase";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import { Effect } from "@babylonjs/core/Materials/effect";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { CreatePlane } from "@babylonjs/core/Meshes/Builders/planeBuilder";
import type { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import type { Scene } from "@babylonjs/core/scene";
import type { SubMesh } from "@babylonjs/core/Meshes/subMesh";
import type { UniformBuffer } from "@babylonjs/core/Materials/uniformBuffer";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import type { ElisionActor, ElisionFrame } from "./elision-scene";
import {
  currentTestMap,
  testPointInIsland,
  supportLevelAt,
  TERRAIN_LIFT_PX,
} from "./test-field";
import { MAX_GLOW_LIGHTS, createNightLightModel } from "./night-lights";
export { itemGlowAmount, fireflyAmount } from "./night-lights";
class WorldGlowPlugin extends MaterialPluginBase {
  constructor(
    material: StandardMaterial,
    private lights: number[],
  ) {
    super(material, "WorldGlow", 210, {}, true, true);
    this._enable(true);
  }
  getClassName() {
    return "WorldGlowPlugin";
  }
  getUniforms() {
    return {
      externalUniforms: ["worldGlowLights"],
    };
  }
  getCustomCode(shaderType: string) {
    return shaderType === "fragment"
      ? {
          CUSTOM_FRAGMENT_DEFINITIONS: `uniform vec4 worldGlowLights[${MAX_GLOW_LIGHTS}];`,
          CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `
    vec3 worldGlow = vec3(0.0);
    for (int glowIndex=0;glowIndex<${MAX_GLOW_LIGHTS};glowIndex++) {
      if(worldGlowLights[glowIndex].w<=0.0)continue;
      vec3 glowDelta=vPositionW-worldGlowLights[glowIndex].xyz;
      float glowFalloff=max(0.0,1.0-dot(glowDelta,glowDelta)/14400.0);
      worldGlow+=vec3(1.0,0.84,0.37)*glowFalloff*glowFalloff*worldGlowLights[glowIndex].w;
    }
    color.rgb+=min(worldGlow,vec3(0.5))*color.a;
  `,
        }
      : null;
  }
  bindForSubMesh(
    _buffer: UniformBuffer,
    _scene: Scene,
    _engine: AbstractEngine,
    subMesh: SubMesh,
  ) {
    subMesh.effect?.setArray4("worldGlowLights", this.lights);
  }
}
export function createWorldGlow(scene: Scene) {
  const lights = Array(MAX_GLOW_LIGHTS * 4).fill(0) as number[];
  const pluginMaterials = new WeakSet<StandardMaterial>();
  const attach = (material: StandardMaterial) => {
    if (!pluginMaterials.has(material)) {
      new WorldGlowPlugin(material, lights);

      pluginMaterials.add(material);
    }
  };
  Effect.ShadersStore.worldGlowHaloVertexShader = `precision highp float;
    attribute vec3 position;attribute vec2 uv;uniform mat4 worldViewProjection;
    varying vec2 vUV;void main(){vUV=uv;gl_Position=worldViewProjection*vec4(position,1.0);}`;
  Effect.ShadersStore.worldGlowHaloFragmentShader = `precision highp float;
    varying vec2 vUV;uniform float glowTime;uniform float glowEnergy;uniform float glowCore;
    void main(){vec2 p=vUV-vec2(0.5);float d=dot(p,p);
      float halo=exp(-d*25.0)*0.35;float core=exp(-d*950.0)*glowCore;
      float alpha=(halo+core)*glowEnergy;if(alpha<0.002)discard;
      gl_FragColor=vec4(vec3(1.0,0.88,0.39)+vec3(core*0.7),alpha);}`;
  const haloMaterial = new ShaderMaterial(
    "world-glow-halo",
    scene,
    { vertex: "worldGlowHalo", fragment: "worldGlowHalo" },
    {
      attributes: ["position", "uv"],
      uniforms: ["worldViewProjection", "glowTime", "glowEnergy", "glowCore"],
      needAlphaBlending: true,
    },
  );
  haloMaterial.backFaceCulling = false;
  haloMaterial.disableDepthWrite = true;
  haloMaterial.alphaMode = Material.MATERIAL_ALPHABLEND;
  haloMaterial.onBindObservable.add((mesh) => {
    const meta = mesh.metadata || {};
    haloMaterial.setFloat("glowEnergy", meta.energy || 0);
    haloMaterial.setFloat("glowCore", meta.core || 0);
  });
  function halo(id: string, size: number) {
    const mesh = CreatePlane(id, { size: 1 }, scene);
    mesh.material = haloMaterial;
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.scaling.set(size, size, size);
    mesh.isPickable = false;
    mesh.setEnabled(false);
    return mesh;
  }
  const model = createNightLightModel(),
    halos = new Map<string, Mesh>();
  function update(frame: ElisionFrame, now: number) {
    const sources = model.update(
      frame,
      now,
      currentTestMap(),
      (x, z) => testPointInIsland(x / frame.cellW, z / frame.cellH),
      (x, z) =>
        supportLevelAt(x / frame.cellW, z / frame.cellH) * TERRAIN_LIFT_PX,
    );
    const seen = new Set<string>();
    for (const source of sources) {
      seen.add(source.id);
      let mesh = halos.get(source.id);
      if (!mesh) {
        mesh = halo(source.id, source.kind === "firefly" ? 19 : 105);
        halos.set(source.id, mesh);
      }
      mesh.position.set(source.x, source.y, source.z);
      mesh.metadata = {
        energy: source.energy * (source.kind === "firefly" ? 1 : 0.85),
        core: source.kind === "firefly" ? 1 : 0,
      };
      mesh.setEnabled(true);
    }
    for (const [id, mesh] of halos)
      if (!seen.has(id)) {
        mesh.dispose();
        halos.delete(id);
      }
    sources.sort(
      (a, b) =>
        (a.x - frame.camX) ** 2 +
        (a.z - frame.camY) ** 2 -
        ((b.x - frame.camX) ** 2 + (b.z - frame.camY) ** 2),
    );
    lights.fill(0);
    sources.slice(0, MAX_GLOW_LIGHTS).forEach((s, i) => {
      lights[i * 4] = s.x;
      lights[i * 4 + 1] = s.y;
      lights[i * 4 + 2] = s.z;
      lights[i * 4 + 3] = s.energy * (s.kind === "firefly" ? 0.13 : 0.38);
    });
    haloMaterial.setFloat("glowTime", now * 0.001);
  }
  function destroy() {
    for (const mesh of halos.values()) mesh.dispose();
    halos.clear();
    haloMaterial.dispose();
  }
  return { attach, update, destroy };
}
