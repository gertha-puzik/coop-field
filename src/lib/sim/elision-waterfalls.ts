import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';
import type { ElisionFrame } from './elision-scene';
import { cachedWaterfallGeometry, waterfallFrame, WATERFALL_FRAMES, WATERFALL_PARTS } from './waterfall-view';

export function createElisionWaterfalls(scene: Scene) {
  const parts = new Map<typeof WATERFALL_PARTS[number], {mesh: Mesh; material: StandardMaterial; texture: Texture}>();
  let current: ReturnType<typeof cachedWaterfallGeometry> | undefined;
  const clear = () => {
    for (const {mesh,material,texture} of parts.values()) {
      mesh.dispose();
      material.dispose();
      texture.dispose();
    }
    parts.clear();
    current = undefined;
  };

  return {
    sync(frame: ElisionFrame, now: number, tint: [number, number, number]) {
      if (!frame.waterfalls?.length) {
        if (parts.size) clear();
        return;
      }
      const quads = cachedWaterfallGeometry(frame,frame.waterfalls);
      if (current !== quads) {
        clear();
        for (const name of WATERFALL_PARTS) {
          const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
          for (const quad of quads) {
            if (quad.part !== name) continue;
            const {a,b,c,fraction} = quad;
            const offset=positions.length/3;
            positions.push(a.x,a.y,a.z,b.x,b.y,b.z,b.x+c.x-a.x,b.y+c.y-a.y,b.z+c.z-a.z,c.x,c.y,c.z);
            indices.push(offset,offset+1,offset+2,offset,offset+2,offset+3);
            const u=1/WATERFALL_FRAMES;
            const inset=.5/(WATERFALL_FRAMES*(name==='lip'?64:48));
            uvs.push(inset,1,u-inset,1,u-inset,1-fraction,inset,1-fraction);
          }
          if (!positions.length) continue;
          const mesh = new Mesh(`waterfall-${name}`,scene);
          const data = new VertexData();
          data.positions=positions;data.indices=indices;data.uvs=uvs;
          const normals:number[]=[];
          VertexData.ComputeNormals(positions,indices,normals);
          data.normals=normals;data.applyToMesh(mesh);
          const texture=new Texture(`/tex/waterfall/${name}-frames.png`,scene,true,true,Texture.NEAREST_SAMPLINGMODE);
          texture.hasAlpha=true;
          texture.wrapU=texture.wrapV=Texture.CLAMP_ADDRESSMODE;
          const material=new StandardMaterial(`waterfall-${name}`,scene);
          material.diffuseTexture=texture;
          material.useAlphaFromDiffuseTexture=true;
          material.disableLighting=true;
          material.backFaceCulling=false;
          material.transparencyMode=Material.MATERIAL_ALPHATEST;
          material.alphaCutOff=.15;
          mesh.material=material;mesh.isPickable=false;
          parts.set(name,{mesh,material,texture});
        }
        current=quads;
      }
      for (const {material,texture} of parts.values()) {
        texture.uOffset=waterfallFrame(now)/WATERFALL_FRAMES;
        material.emissiveColor.set(...tint);
      }
    },
    destroy: clear,
  };
}
