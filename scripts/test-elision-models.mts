// @ts-nocheck
// Model assets, client/server persistence, and sprite depth regression contracts.
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MODEL_CATALOG, TREE_MODELS } from '../src/lib/sim/model-catalog.ts';
import { SPRITES as CLIENT_SPRITES } from '../src/lib/sim/settings.ts';
import { objectSprite, sanitizeTestMap as sanitizeClient } from '../src/lib/sim/test-map.ts';
import { SPRITES as SERVER_SPRITES, TREE_SPRITE_IDS } from '../server/config.js';
import { defaultTestMap, sanitizeTestMap as sanitizeServer } from '../server/testmap.js';
import { elisionActorFoot, elisionDepthBias, elisionObstacleAlpha } from '../src/lib/sim/elision-scene.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
const manifest = JSON.parse(readFileSync(new URL('../public/models/catalog.json', import.meta.url)));
for (const source of new Set(manifest.map(model => model.source))) {
  const bytes = readFileSync(new URL(`../assets/models/source/${source}`, import.meta.url));
  const hash = createHash('sha256').update(bytes).digest('hex');
  assert(manifest.filter(model => model.source === source).every(model => model.sourceSha256 === hash), 'source provenance retained');
}
const clientIds = CLIENT_SPRITES.map(sprite => sprite.id).sort();
assert(JSON.stringify(clientIds) === JSON.stringify([...SERVER_SPRITES].sort()), 'player whitelist mirrored');
assert(clientIds.includes('origami-cat'), '3D player can join and change skin');
assert(TREE_MODELS.length === 200 && MODEL_CATALOG.length === 201, 'all uploaded objects present');
assert(new Set(MODEL_CATALOG.map(model => model.id)).size === 201, 'stable model IDs are unique');

for (const model of MODEL_CATALOG) {
  const bytes = readFileSync(new URL(`../public${model.url}`, import.meta.url));
  assert(bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2, `GLB2 ${model.id}`);
  assert(bytes.readUInt32LE(8) === bytes.length, `complete GLB ${model.id}`);
  const length = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + length).toString());
  assert(gltf.buffers.length === 1 && !gltf.buffers[0].uri, `embedded buffer ${model.id}`);
  assert(!gltf.images?.length, `no missing MTL texture dependencies ${model.id}`);
  const primitive = gltf.meshes[0].primitives[0];
  for (const attribute of ['POSITION', 'NORMAL', 'COLOR_0']) {
    const accessor = gltf.accessors[primitive.attributes[attribute]];
    const view = gltf.bufferViews[accessor.bufferView];
    const components = attribute === 'COLOR_0' ? 4 : 3;
    assert(view.byteLength === accessor.count * components * 4, `attribute complete ${model.id}:${attribute}`);
    assert(view.byteOffset + view.byteLength <= gltf.buffers[0].byteLength, `attribute in bounds ${model.id}`);
    const start = 20 + length + 8 + view.byteOffset;
    for (let i = 0; i < view.byteLength; i += 4)
      assert(Number.isFinite(bytes.readFloatLE(start+i)), `finite geometry ${model.id}`);
  }
  const position = gltf.accessors[primitive.attributes.POSITION];
  assert(Math.abs(position.min[1]) < 1e-5 && Math.abs(position.max[1]-1) < 1e-5, `grounded normalized height ${model.id}`);
  assert(existsSync(new URL(`../public${model.preview}`, import.meta.url)), `2D fallback ${model.id}`);
  if (model.kind === 'tree') {
    assert(TREE_SPRITE_IDS.has(model.id), `server accepts ${model.id}`);
    assert(objectSprite({kind:'tree',spr:model.id}) === model.id, `client accepts ${model.id}`);
  }
}
for (const id of ['tree3d-001', 'tree3d-100', 'tree3d-200', 'tree-1']) {
  const raw = defaultTestMap();
  raw.objects = [{id:'tree-test',kind:'tree',c:2,r:2,x:2.5,y:3,s:1.2,rot:37,spr:id,mir:1}];
  for (const sanitize of [sanitizeClient, sanitizeServer]) {
    const result = sanitize(raw);
    assert(result.map?.objects?.[0]?.spr === id, `save/reload preserves ${id}: ${result.error}`);
  }
}
const self = {id:'main',x:100,y:100,w:60,h:100,lift:0,rot:0,url:'cat',mirror:false};
const prop = {...self,id:'tree',isProp:true,x:90,y:70,w:120,h:160};
assert(elisionObstacleAlpha(prop,self,0) < 0.5, 'foreground obstacle does not hide player');
assert(elisionObstacleAlpha({...prop,y:0},self,0) === 1, 'background obstacle stays opaque');
assert(elisionObstacleAlpha({...prop,x:1000},self,0) === 1, 'unrelated obstacle stays opaque');
assert(elisionObstacleAlpha(self,self,0) === 1, 'player stays opaque');
const foot = elisionActorFoot(self);
assert(foot.x === 130 && foot.z === 200 && Math.abs(foot.y-.2) < 1e-9, 'billboard is anchored at feet above ground');
assert(elisionDepthBias('tree') === elisionDepthBias('tree'), 'no frame-dependent sort jitter');
assert(elisionDepthBias('tree') !== elisionDepthBias('main'), 'coplanar ties have stable offsets');
assert(elisionDepthBias('tree') > -1 && elisionDepthBias('tree') < 0, 'bias stays small');
console.log('elision models: 201 GLBs, whitelists, map round trips, stable sprite depth and occlusion ok');
