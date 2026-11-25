import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';
import type { ElisionFrame } from './elision-scene';
import { cachedWaterfallGeometry, waterfallFrame, waterfallVisible, WATERFALL_FRAMES } from './waterfall-view';

export function createElisionWaterfalls(scene: Scene) {
  type Geometry = ReturnType<typeof cachedWaterfallGeometry>;
  type WaterfallMesh = {mesh: Mesh; material: StandardMaterial; texture: Texture; flow: Geometry[number]['flow']};
  const parts: WaterfallMesh[] = [];
  let current: Geometry | undefined;
  const clear = () => {
    for (const {mesh,material,texture} of parts) {
      mesh.dispose();
      material.dispose();
      texture.dispose();
    }
    parts.length=0;
    current = undefined;
  };

  return {
    sync(frame: ElisionFrame, now: number, tint: [number, number, number]) {
      if (!frame.waterfalls?.length) {
        if (parts.length) clear();
        return;
      }
      const quads = cachedWaterfallGeometry(frame,frame.waterfalls);
      if (current !== quads) {
        clear();
        const batches = new Map<string,Geometry>();
        for (const quad of quads) {
          const key = `${quad.part}-${quad.flow}`;
          const batch = batches.get(key);
          if (batch) batch.push(quad);
          else batches.set(key,[quad]);
        }
        for (const [key,batch] of batches) {
          const {part:name,flow} = batch[0];
          const positions: number[] = [], indices: number[] = [], uvs: number[] = [];
          for (const {a,b,c,fraction,u0,u1} of batch) {
            const offset=positions.length/3;
            positions.push(a.x,a.y,a.z,b.x,b.y,b.z,b.x+c.x-a.x,b.y+c.y-a.y,b.z+c.z-a.z,c.x,c.y,c.z);
            indices.push(offset,offset+1,offset+2,offset,offset+2,offset+3);
            const frameWidth=1/WATERFALL_FRAMES;
            const inset=.5/(WATERFALL_FRAMES*(name==='lip'?64:48));
            const span=frameWidth-2*inset;
            const start=inset+u0*span, end=inset+u1*span;
            uvs.push(start,1,end,1,end,1-fraction,start,1-fraction);
          }
          if (!positions.length) continue;
          const mesh = new Mesh(`waterfall-${key}`,scene);
          const data = new VertexData();
          data.positions=positions;data.indices=indices;data.uvs=uvs;
          const normals:number[]=[];
          VertexData.ComputeNormals(positions,indices,normals);
          data.normals=normals;data.applyToMesh(mesh);
          const texture=new Texture(`/tex/waterfall/${name}-frames.png`,scene,true,true,Texture.NEAREST_SAMPLINGMODE);
          texture.hasAlpha=true;
          texture.wrapU=texture.wrapV=Texture.CLAMP_ADDRESSMODE;
          const material=new StandardMaterial(`waterfall-${key}`,scene);
          material.diffuseTexture=texture;
          material.useAlphaFromDiffuseTexture=true;
          material.disableLighting=true;
          material.backFaceCulling=false;
          material.transparencyMode=Material.MATERIAL_ALPHATEST;
          material.alphaCutOff=.15;
          mesh.material=material;mesh.isPickable=false;
          parts.push({mesh,material,texture,flow});
        }
        current=quads;
      }
      for (const {mesh,material,texture,flow} of parts) {
        mesh.isVisible=waterfallVisible(flow,frame.yaw);
        texture.uOffset=waterfallFrame(now)/WATERFALL_FRAMES;
        material.emissiveColor.set(...tint);
      }
    },
    destroy: clear,
  };
}
