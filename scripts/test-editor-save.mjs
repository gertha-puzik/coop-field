// Regression: saving elevation must finish even when the editor closes during PNG encoding.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import ts from 'typescript';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cache = new Map();
function loadTs(url) {
  const key = url.href;
  if (cache.has(key)) return cache.get(key);
  const out = {};
  cache.set(key,out);
  const js = ts.transpileModule(fs.readFileSync(url,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','exports',js)(id => id.endsWith('.json') ? {default:JSON.parse(fs.readFileSync(new URL(id,url),'utf8'))} : id.startsWith('.') ? loadTs(new URL(id+(id.endsWith('.ts')?'':'.ts'),url)) : require(id),out);
  return out;
}
let finish;
const field = { ensurePaintDecoded: async () => true };
const mapLib = { TERRAIN_MAX_LEVEL: 20, TEST_MAP_LIMITS: {objectsMax: 1000}, testMapConnectivityError: () => null };
const mocks = {
  '@/lib/sim/editor-model': loadTs(new URL('../src/lib/sim/editor-model.ts',import.meta.url)),
  '@/lib/sim/paint': { ...loadTs(new URL('../src/lib/sim/paint.ts',import.meta.url)), encodeDraftPaint: () => '', encodeDraftPaintAsync: () => new Promise(r => {finish=r;}) },
  '@/lib/sim/test-field': field,
  '@/lib/sim/test-map': mapLib,
  '@/lib/sim/geometry': {},
  '@/lib/sim/terrain-shape': loadTs(new URL('../src/lib/sim/terrain-shape.ts',import.meta.url)),
  '@/lib/sim/terrain-editor': loadTs(new URL('../src/lib/sim/terrain-editor.ts',import.meta.url)),
  './editor-select': {buildEditorSelect: () => ({})},
  './editor-cells': {buildEditorCells: () => ({})},
};
const source = fs.readFileSync(new URL('../src/components/sim/simulator/editor-ops.ts',import.meta.url),'utf8');
const compiled = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports = {};
new Function('require','exports',compiled)(id => mocks[id] ?? require(id),exports);
const original = {place:{id:1,name:'Долина',zoneId:1,zoneName:'Средиземье'},passages:[{id:'forest',x:1,y:1,w:1,h:1,targetId:2,link:'trail',direction:'right'}],cols:6,rows:6,margin:.5,seed:'regression',zones:[{kind:'cells',c0:0,r0:0,c1:5,r1:5}],objects:[],spawns:[],elev:{'1,1':2}};
const editorRef={current:{...structuredClone(original),undo:[],elev:{'1,1':2},dirty:false,pcv:null}};
const sent=[];
const params = { editorRef, elevStrokeRef:{current:null}, savedMapRef:{current:original}, netRef:{current:{ready:true,emit:(...args)=>sent.push(args)}}, camRef:{current:{}}, setTestMap:()=>{} };
for(const name of ['setEditorView','setEditorOpen','setEditorMsg','setEditorSave','setEditorPlace']) params[name]=()=>{};
const ops=exports.buildEditorOps(params);
ops.beginElevStroke('raise',2,2);
ops.endElevStroke();
assert.deepEqual(editorRef.current.elev,{'1,1':2,'2,2,1,1':1});
ops.saveEditorMap();
ops.closeEditor();
finish('');
await new Promise(r=>setImmediate(r));
assert.equal(sent.length,1,'closing editor must not silently cancel saving');
assert.equal(sent[0][0],'setmap');
assert(!('pass' in sent[0][1]),'client sends no editor password');
assert.deepEqual(sent[0][1].map.elev,{'1,1':2,'2,2,1,1':1},'old and new elevations both survive');
assert.deepEqual(original.elev,{'1,1':2},'preview does not mutate saved map');
assert.deepEqual(sent[0][1].map.place,original.place,'location identity survives save-after-close');
assert.deepEqual(sent[0][1].map.passages,original.passages,'passages survive save-after-close');
console.log('editor elevation, location and passage save after close: OK');

// Load the real field helpers; DOM is not needed for terrain/support queries.
const actualField=loadTs(new URL('../src/lib/sim/test-field.ts',import.meta.url));
const actualMap=loadTs(new URL('../src/lib/sim/test-map.ts',import.meta.url));
const stoneMap={...structuredClone(actualMap.TEST_MAP_DEFAULT),elev:{'2,2':2},objects:[{id:'stone',kind:'stone',c:2,r:2,x:2.5,y:2.5,s:1,spr:'rock-1',rot:45}]};
actualField.setTestMap(stoneMap);
assert.equal(actualField.supportLevelAt(2.5,2.5),3,'stone adds one level at its body');
assert.equal(actualField.supportLevelAt(2.05,2.05),2,'same cell outside stone keeps ground level');
assert.equal(actualField.elevLiftAtPoint(2.5,2.5),52,'stone itself stays on ground, not on its own support');
assert.deepEqual(actualField.effectiveElevRecord(stoneMap),{'2,2':2},'no generated terrain under stone');
actualField.setTestMap({...stoneMap,elev:{}});
assert.equal(actualField.elevAny(),false,'stone on flat map does not render a plateau');
const roundtrip=actualMap.sanitizeTestMap(sent[0][1].map).map;
assert.deepEqual(roundtrip.elev,{'1,1':2,'2,2,1,1':1},'received map preserves both heights for reopening');
console.log('stone support, terrain separation and elevation roundtrip: OK');

// A disk failure cannot be acknowledged as a saved map or replace the live map.
process.env.DATA_DIR=fs.mkdtempSync('/tmp/coop-editor-write-fail-');
delete process.env.ADMIN_PASS;
const serverMap=await import('../server/testmap.js');
const previousMap=serverMap.testMap;
fs.mkdirSync(process.env.DATA_DIR+'/test-map.json'); // force atomic rename to fail
const replies=[];
const ws={readyState:1,lastSetmap:0,account:{role:'admin'},send:data=>replies.push(JSON.parse(data))};
ws.room={code:'test',fmt:'test',sockets:new Map([[ws,{}]])};
serverMap.setMap(ws,{map:{...previousMap,elev:{'2,2,1,1':1}}});
assert.equal(serverMap.testMap,previousMap,'failed save restores previous live map');
assert(replies.some(([event,text])=>event==='info'&&text.includes('сохранить локацию на диск не удалось')));
assert(!replies.some(([event])=>event==='map'||event==='field'),'failed save never broadcasts success');
fs.rmSync(process.env.DATA_DIR,{recursive:true,force:true});
console.log('editor disk failure rollback: OK');

// Elevation stamps and inverse projection share the same pure implementation.
const terrain = loadTs(new URL('../src/lib/sim/terrain-editor.ts',import.meta.url));
const levels = {'1,1':2};
const touched = new Set();
assert(terrain.stampElevation(levels,'height',4,3,{width:3,depth:2,level:7},10,10,touched,0));
for (const r of [3,4]) for (const c of [3,4,5]) assert.equal(levels[`${c},${r}`],7);
assert.equal(levels['1,1'],2,'unrelated heights survive a rectangular stamp');
assert(!terrain.stampElevation(levels,'raise',4,3,{width:3,depth:2,level:7},10,10,touched,0),'same stroke never stacks cells twice');
terrain.stampElevation(levels,'height',4,3,{width:3,depth:2,level:0},10,10,new Set(),0);
assert.deepEqual(levels,{'1,1':2},'level zero removes the entire rectangular stamp');
for (const yaw of [0,.31,Math.PI/2,Math.PI,Math.PI*1.5]) {
 for(const level of [1,5,10,20]) {
  const x=550-Math.sin(yaw)*26*level,y=825-Math.cos(yaw)*26*level;
  const hit=terrain.pickTerrainTop(x,y,100,150,12,12,(c,r)=>c===5&&r===5?level:0,26,yaw);
  assert.equal(hit.c,5);assert.equal(hit.r,5);assert.equal(hit.level,level);
 }
}
assert.deepEqual(terrain.clampBrush({width:99,depth:99,level:99},6,4),{width:6,depth:4,level:20});
console.log('rectangular exact-height brush and terrain picking at five camera angles: OK');

// Exact dimensions must survive rendering, server sanitization and JSON storage.
const shape=loadTs(new URL('../src/lib/sim/terrain-shape.ts',import.meta.url));
const precise={'1,1':2};
const bounds=shape.terrainBrushBounds(2,2,.2,3.2,12,12);
assert.equal(bounds.w,.2);assert.equal(bounds.d,3.2);
const stroke=new Set();
assert(shape.stampTerrainRect(precise,bounds,'height',6.7,stroke,0,20));
assert.equal(shape.terrainAt(precise,bounds.x+.1,bounds.y+.1),6.7);
assert.equal(shape.terrainAt(precise,bounds.x-.001,bounds.y+.1),0);
assert.equal(shape.terrainAt(precise,bounds.x+bounds.w+.001,bounds.y+.1),0);
assert(!shape.stampTerrainRect(precise,bounds,'raise',6.7,stroke,0,20),'same stroke does not stack rectangles');
const persisted=serverMap.sanitizeTestMap({...structuredClone(actualMap.TEST_MAP_DEFAULT),cols:12,rows:12,zones:[{id:'all',kind:'cells',c0:0,r0:0,c1:11,r1:11}],elev:precise});
assert(!persisted.error,persisted.error);
assert.deepEqual(persisted.map.elev,shape.sanitizeTerrainElev(precise,12,12,20));
assert.equal(serverMap.terrainAt(JSON.parse(JSON.stringify(persisted.map.elev)),bounds.x+.1,bounds.y+.1),6.7);
assert(shape.terrainBodyContact(precise,12,12,bounds.x-.05,bounds.y+.2,.1,.1,0)>0,'fractional cliff blocks a body at its exact boundary');
for(const yaw of [0,Math.PI/2,Math.PI,Math.PI*1.5,.37]){
 const wx=(bounds.x+.1)*100,wy=(bounds.y+.2)*150,lv=6.7;
 const hit=shape.pickTerrainTop(wx-Math.sin(yaw)*lv*26,wy-Math.cos(yaw)*lv*26,100,150,12,12,()=>0,26,yaw,precise);
 assert.equal(hit.level,6.7,'fractional top ray intersection at every angle');
}
shape.stampTerrainRect(precise,bounds,'height',0,new Set(),0,20);
assert.equal(shape.terrainAt(precise,bounds.x+.1,bounds.y+.1),0,'zero explicitly erases a fractional block');
assert.equal(shape.terrainAt(precise,1.5,1.5),2,'legacy terrain survives');
assert.deepEqual(shape.clampBrush({width:.1,depth:3.2,level:6.7},12,12),{width:.1,depth:3.2,level:6.7});
console.log('exact decimal geometry, picking, collision, server persistence and erase: OK');

const bootDir=fs.mkdtempSync('/tmp/coop-decimal-map-boot-');
fs.writeFileSync(bootDir+'/test-map.json',JSON.stringify(persisted.map));
const boot=spawnSync(process.execPath,['--input-type=module','-e',
  `import {testMap} from './server/testmap.js'; if(JSON.stringify(testMap.elev)!==process.env.EXPECT_ELEV)throw new Error('persisted decimal terrain lost at startup');`],
  {cwd:new URL('..',import.meta.url),env:{...process.env,DATA_DIR:bootDir,EXPECT_ELEV:JSON.stringify(persisted.map.elev)},encoding:'utf8',timeout:10000});
assert.equal(boot.status,0,boot.stderr);
console.log('persisted rectangular terrain survives a fresh server process: OK');

const neighboring={'2,2,1,1':6.7,'7,2,1,1':4};
const free=shape.freeTerrainPlacement(neighboring,3.58,2.52,1,1,6.7,12,12,'level',.12);
assert.equal(free.x,3);assert.equal(free.y,2);assert(free.snapped,'matching block aligns edges exactly');
const off=shape.freeTerrainPlacement(neighboring,3.58,2.52,1,1,6.7,12,12,'off',.12);
assert.equal(off.x,3.08);assert.equal(off.y,2.02);assert(!off.snapped,'free placement never snaps to global cells');
const other=shape.freeTerrainPlacement(neighboring,8.58,2.52,1,1,6.7,12,12,'level',.12);
assert.equal(other.x,8.08,'same-height magnet excludes different-height neighbors');
assert.equal(shape.freeTerrainPlacement(neighboring,8.58,2.52,1,1,6.7,12,12,'all',.12).x,8);
assert(!shape.freeTerrainPlacement(neighboring,5.5,5.5,1,1,6.7,12,12,'all',.12).snapped,'distant blocks do not attract');
console.log('free terrain placement, optional snapping and height filter: OK');

// A successful disk write has a small direct acknowledgement even without a broadcast room.
const okReplies=[];
const okWs={readyState:1,lastSetmap:0,account:{role:'admin'},send:data=>okReplies.push(JSON.parse(data))};
okWs.room={code:'test',fmt:'test',sockets:new Map([[okWs,{}]])};
const oldIsland=serverMap.TEST_ISLAND,oldCells=serverMap.TEST_CELLS;
serverMap.setMap(okWs,{map:{...previousMap,elev:{'2,2,1,1':6.7}}});
assert.equal(serverMap.TEST_ISLAND,oldIsland,'height-only saves reuse the ground contour');
assert.equal(serverMap.TEST_CELLS,oldCells,'height-only saves reuse the battle mask');
assert(okReplies.some(([event,text])=>event==='info'&&text==='Редактор: сохранено.'));
assert(!replies.some(([event,text])=>event==='info'&&text==='Редактор: сохранено.'),'disk failure never acknowledges success');
console.log('explicit save acknowledgement follows durable write: OK');

// Admin gate (ux/admin-gate, server/testmap.js): a non-admin socket — even a
// registered player inside the room — must NOT mutate the map: refusal info,
// live map unchanged, no broadcast.
const gatedReplies=[];
const gatedWs={readyState:1,lastSetmap:0,account:{role:'registered'},send:data=>gatedReplies.push(JSON.parse(data))};
gatedWs.room={code:'test',fmt:'test',sockets:new Map([[gatedWs,{}]])};
const liveBeforeGate=serverMap.testMap;
serverMap.setMap(gatedWs,{map:{...previousMap,elev:{'4,4,1,1':5}}});
assert(gatedReplies.some(([event,text])=>event==='info'&&String(text).includes('доступно только администраторам')),'non-admin setmap is refused by the admin gate');
assert.equal(serverMap.testMap,liveBeforeGate,'refused setmap never replaces the live map');
assert(!gatedReplies.some(([event])=>event==='map'||event==='field'),'refused setmap never broadcasts');
console.log('admin gate: non-admin setmap refused, live map intact: OK');

const historyRef={current:{...structuredClone(original),tool:'height',undo:[],redo:[],dirty:false,pcv:null,sel:[]}};
const historyOps=exports.buildEditorOps({...params,editorRef:historyRef,editorSelRef:{current:null},patchField:()=>{},setPaintOverride:()=>{}});
historyOps.pushEditorUndo();historyRef.current.elev['3,3']=6.7;historyRef.current.dirty=true;
historyOps.undoEditor();assert.deepEqual(historyRef.current.elev,original.elev);assert.equal(historyRef.current.dirty,false,'undo to the saved baseline is clean');
historyOps.redoEditor();assert.equal(historyRef.current.elev['3,3'],6.7);assert.equal(historyRef.current.dirty,true);
historyOps.undoEditor();historyOps.pushEditorUndo();historyRef.current.elev['4,4']=20;
assert.equal(historyRef.current.redo.length,0,'a new edit after undo discards the redo branch');
console.log('unified editor history, redo branching and unsaved baseline status: OK');

// The editor must resize the HUD even when the gameplay weather dial is hidden.
const hudModule={};
const hudJs=ts.transpileModule(fs.readFileSync(new URL('../src/components/sim/simulator/hud-canvas.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('require','exports',hudJs)(()=>({}),hudModule);
const oldWindow=globalThis.window;
try{
 for(const dpr of [1,2]){
  globalThis.window={devicePixelRatio:dpr};
  let transform;
  const context={setTransform:(...args)=>{transform=args;},clearRect:()=>{}};
  const canvas={width:1900,height:1050,getContext:()=>context};
  for(const [w,h] of [[1400,900],[1048,716],[1328,716],[700,900]]){
   hudModule.clearFieldHud(canvas,w,h);
   assert.equal(canvas.width,w*dpr);assert.equal(canvas.height,h*dpr);
   assert.deepEqual(transform,[dpr,0,0,dpr,0,0]);
  }
 }
}finally{if(oldWindow===undefined)delete globalThis.window;else globalThis.window=oldWindow;}
console.log('HUD backing store tracks editor layout at DPR 1 and 2: OK');

const archive=loadTs(new URL('../src/lib/sim/paint.ts',import.meta.url));
const archiveMap={v:2,cols:12,rows:9,margin:.5,seed:'portable-map',zones:[],objects:[{id:'oak',kind:'tree',c:3,r:3,spr:'tree-1'}],spawns:[],elev:{'5.1,2.3,1.2,0.4':6.7}};
const archiveBytes=archive.encodeMapArchive(archiveMap),archiveRestored=archive.decodeMapArchive(archiveBytes);
assert.equal(archiveRestored.seed,'portable-map');assert.deepEqual(archiveRestored.elev,archiveMap.elev);assert.equal(archiveRestored.objects[0].spr,'tree-1');
const corrupt=archiveBytes.slice();corrupt[45]^=1;assert.throws(()=>archive.decodeMapArchive(corrupt),/повреждён/);
assert.throws(()=>archive.decodeMapArchive(new Uint8Array(32)),/ZIP/);
assert(serverMap.sanitizeTestMap(archiveRestored).map,'peace-only map passes both validators');
const cleanRef={current:{...structuredClone(original),tool:'height',undo:[],redo:[],dirty:false,pcv:null,sel:[]}};
const cleanOps=exports.buildEditorOps({...params,editorRef:cleanRef,editorPlaceRef:{current:null},editorSelRef:{current:null},patchField:()=>{},setPaintOverride:()=>{}});
cleanOps.clearEditorMap();assert.deepEqual(cleanRef.current.zones,[]);assert.deepEqual(cleanRef.current.elev,{});assert(cleanRef.current.dirty);
cleanOps.undoEditor();assert.deepEqual(cleanRef.current.elev,original.elev);assert.deepEqual(cleanRef.current.zones,original.zones);
cleanOps.redoEditor();assert.deepEqual(cleanRef.current.zones,[]);
console.log('portable ZIP roundtrip, corruption rejection, peace-only server validation and reversible full clear: OK');

const collisionShape=loadTs(new URL('../src/lib/sim/terrain-shape.ts',import.meta.url));
let scans=0;const flat=new Proxy({},{ownKeys:()=>{scans++;return [];}});
const benchStart=performance.now();
for(let i=0;i<10000;i++)assert.equal(collisionShape.terrainBodyContact(flat,60,40,25+i%20/10,20,.1,.1,0),0);
assert.equal(scans,1,'flat ground never allocates a world-sized partition for each movement probe');
console.log(`10000 flat collision probes: ${Math.round(performance.now()-benchStart)} ms, one index scan`);
const cliffs={'3,3':5,'3.4,3.2,0.3,0.6':0,'4.1,3.2,0.6,0.6':6.7};
for(let y=2.9;y<4.1;y+=.09)for(let x=2.9;x<5;x+=.09)for(const level of [0,5,6.7]){
 const actual=collisionShape.terrainBodyContact(cliffs,12,9,x,y,.2,.15,level);
 let expected=0;
 for(const b of collisionShape.cachedTerrainTiles(cliffs,12,9)){
  if(Math.abs(b.level-level)<=1+1e-7)continue;
  expected=Math.max(expected,1-Math.hypot((x-Math.max(b.x,Math.min(b.x+b.w,x)))/.2,(y-Math.max(b.y,Math.min(b.y+b.d,y)))/.15));
 }
 assert(Math.abs(actual-expected)<1e-7);assert.equal(serverMap.terrainBodyContact(cliffs,12,9,x,y,.2,.15,level),actual);
}
console.log('local collision queries match full geometry and server for fractional cliffs/erased cuts: OK');

const liveField=loadTs(new URL('../src/lib/sim/test-field.ts',import.meta.url));
const oldImage=globalThis.Image,oldDocument=globalThis.document;
const images=[];
try{
 globalThis.Image=class{constructor(){images.push(this);}set src(value){this.source=value;}};
 globalThis.document={createElement:()=>({width:0,height:0,getContext(){return {drawImage(){},getImageData:()=>({data:new Uint8ClampedArray(this.width*this.height*4).fill(255)})};}})};
 const fakePng='iVBORw0KGgo'+'A'.repeat(40);
 liveField.setTestMap({...archiveMap,paint:fakePng});const first=liveField.ensurePaintDecoded();
 assert.equal(liveField.ensurePaintDecoded(),first,'same decode request is deduplicated');
 liveField.setTestMap({...archiveMap,zones:[{id:'old',name:'old',kind:'green',c0:3,r0:3,c1:6,r1:6}],cols:13,paint:fakePng+'B'});const second=liveField.ensurePaintDecoded();
 images[1].naturalWidth=1300;images[1].naturalHeight=1350;images[1].onload();assert(await second);
 const loaded=liveField.paintCanvas();images[0].onerror();assert.equal(await first,false);assert.equal(liveField.paintCanvas(),loaded,'late old decode cannot erase current ground');
 assert(liveField.testPeacePointFree(12.5,5),'expanded painted area is walkable outside old zones');
 assert(!liveField.testPeacePointFree(13.1,5),'outside painted map stays blocked');
 liveField.setTestMap({...archiveMap,paint:fakePng});const third=liveField.ensurePaintDecoded();
 const canvas=globalThis.document.createElement('canvas');canvas.width=1200;canvas.height=1350;
 liveField.setPaintOverride(canvas,true);images[2].naturalWidth=1200;images[2].naturalHeight=1350;images[2].onload();assert.equal(await third,false);assert.equal(liveField.paintCanvas(),canvas,'live editor override wins over pending PNG');
}finally{globalThis.Image=oldImage;globalThis.document=oldDocument;}
console.log('paint decode races, deduplication, expanded ground and editor override: OK');

// Dense terrain must not create a label/ray test for every block each frame.
const overlay=loadTs(new URL('../src/lib/sim/terrain-editor.ts',import.meta.url));
let terrainScans=0;
const dense=new Proxy(Object.fromEntries(Array.from({length:2400},(_,i)=>[`${i%60},${Math.floor(i/60)}`,2])),{ownKeys(target){terrainScans++;return Reflect.ownKeys(target);}});
collisionShape.terrainAt(dense,10.5,8.5);terrainScans=0;
const texts=[];
const guideContext=new Proxy({measureText:()=>({width:80}),fillText:text=>texts.push(text)},{get:(target,key)=>key in target?target[key]:()=>{},set:(target,key,value)=>{target[key]=value;return true;}});
const guideCanvas={getContext:()=>guideContext};
const guideDraft={cols:60,rows:40,tool:'cursor',showGrid:true,zones:[],objects:[],spawns:[],sel:[],terrainCursor:{x:10.5,y:8.5}};
const guideFrame={editor:true,elev:dense,cols:60,rows:40,cellW:100,cellH:150,terrainLiftStep:26,camX:1050,camY:1275,yaw:0,zoom:1,viewW:1200,viewH:800};
const previousGuideWindow=globalThis.window;
try{
 globalThis.window={devicePixelRatio:1};
 overlay.drawTerrainEditorOverlay(guideCanvas,guideFrame,{draft:guideDraft,hover:null,placement:null});assert.equal(texts.length,0,'no hovered block means no height labels');
 overlay.drawTerrainEditorOverlay(guideCanvas,guideFrame,{draft:guideDraft,hover:{c:10,r:8},placement:null});assert.deepEqual(texts,['Высота: 2'],'only the hovered block is labeled, even with the grid enabled');
 assert.equal(terrainScans,0,'annotation pass does not enumerate all 2400 terrain blocks');
}finally{globalThis.window=previousGuideWindow;}
console.log('dense terrain overlay: one hovered height, none on leave, no per-frame terrain scan: OK');

// Plants are free decorative objects: preserve all catalog variants and transforms,
// allow overlaps, and never add terrain support, battle walls or entry interference.
const plantCatalog=actualMap.PLANT_SPRITE_OPTS;
assert.equal(plantCatalog.length,75);
assert.deepEqual(JSON.parse(fs.readFileSync(new URL('../server/plant-sprites.json',import.meta.url))),plantCatalog);
const plantMap=actualMap.sanitizeTestMap({...original,v:2,elev:{},objects:plantCatalog.map(p=>({id:p.id,kind:'plant',spr:p.id,c:2,r:2,x:2.5,y:2.8,s:2.5,rot:90,mir:1}))});
assert(plantMap.map,plantMap.error);
const plantServer=serverMap.sanitizeTestMap(plantMap.map);assert(plantServer.map,plantServer.error);
assert.equal(plantServer.map.objects.length,75,'decorative plants do not collapse to one object per cell');
assert.deepEqual(plantServer.map.objects.map(({dir,...o})=>o),plantMap.map.objects.map(({dir,...o})=>o),'client and server preserve all free plant transforms');
actualField.setTestMap(plantMap.map);
assert.equal(actualField.testObstacleAt(2,2),null);assert.equal(actualField.supportLevelAt(2.5,2.8),0);assert.equal(actualField.testPeaceObjectDepth(2.5,2.8,100,150,5),0);
assert(actualField.testWalkableCell(2,2),'plants leave battle cells walkable');
const plantWorld=await import('../server/world.js');assert.equal(plantWorld.obstacleBodiesOf(plantServer.map).length,0);
for(const p of plantCatalog){
 const bytes=fs.readFileSync(new URL(`../public/tex/${p.id}.png`,import.meta.url));
 assert.deepEqual([bytes.readUInt32BE(16),bytes.readUInt32BE(20)],[p.width,p.height]);
 assert.deepEqual(actualMap.OBJECT_DIMS[p.id],[p.width,p.height]);
 assert.equal(plantWorld.objectSprite({kind:'plant',spr:p.id}),p.id);
}
const plantArchive=archive.decodeMapArchive(archive.encodeMapArchive(plantMap.map));assert.deepEqual(plantArchive.objects,plantMap.map.objects,'plants survive ZIP location archive roundtrip');
console.log('75 plant catalog assets, client/server transforms, overlap, non-collision and archive persistence: OK');

actualField.setTestMap({...plantMap.map,objects:[plantMap.map.objects[0],{id:'entry-overlap',kind:'entry',c:2,r:2,dir:'right'}]});
assert.equal(actualField.testEntryAt(2,2)?.id,'entry-overlap','a decorative plant never hides an entry in the cell index');

// Weather off must hide/clear the retained Pixi frame, even when the main loop
// keeps calling setVisible(true). Re-enabling respects editor/master visibility.
const atmosphereModule={};
const atmosphereJs=ts.transpileModule(fs.readFileSync(new URL('../src/lib/sim/atmosphere.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
new Function('require','exports',atmosphereJs)(()=>({}),atmosphereModule);
const weatherView={style:{}},weather=new atmosphereModule.Atmosphere(weatherView,{});
let weatherClears=0;weather.app={render:()=>weatherClears++};weather.cloudC={visible:true};weather.rainC={visible:true};
weather.setWeatherFx(false);weather.setVisible(true);
assert.equal(weatherView.style.display,'none');assert.equal(weather.cloudC.visible,false);assert.equal(weather.rainC.visible,false);assert.equal(weatherClears,1);
weather.setVisible(false);weather.setWeatherFx(true);assert.equal(weatherView.style.display,'none');
weather.setVisible(true);assert.equal(weatherView.style.display,'');
console.log('weather toggle clears retained frame and respects master/editor visibility: OK');

const groundFx=loadTs(new URL('../src/lib/sim/particles.ts',import.meta.url));
const dust=[];groundFx.spawnLandingDust(dust,100,150,78);assert.equal(dust.length,12);assert(dust.every(p=>p.kind==='dust'&&p.lift===78));
for(let i=0;i<20;i++)groundFx.spawnLandingDust(dust,100,150,78);assert(dust.length<=90,'landing bursts are bounded');
for(let i=0;i<20;i++)groundFx.advanceGroundParticles(dust,50);assert.equal(dust.length,0,'landing dust expires');
const chips=[];groundFx.spawnSprintPart(chips,100,150,1,0,52);assert.equal(chips[0].lift,52);groundFx.advanceGroundParticles(chips,50);assert(chips[0].x<110,'sprint chips travel away from the paws');
const rainState=groundFx.createGroundEffects();rainState.rain.push({x:100,y:150,lift:0,life:0,ttl:300,seed:0});
groundFx.drawGroundEffects(null,{editor:false},[],rainState,16,false);assert.equal(rainState.rain.length,0,'weather off clears ground splashes immediately');
console.log('landing dust cap/lifetime, sprint lift/physics and immediate splash clear: OK');

// A late paint decode from a departed location must not populate the new draft.
const receiverSource=fs.readFileSync(new URL('../src/components/sim/simulator/map-receive.ts',import.meta.url),'utf8');
const receiverJs=ts.transpileModule(receiverSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const receiver={},deferred=new Map();let decodingMap,decodedCanvas=null;const paintOverrides=[];
const receiverMocks={
  '@/lib/sim/test-map':{mapHasPaint:map=>!!map.paint},
  '@/lib/sim/test-field':{
    setTestMap:map=>{decodingMap=map;decodedCanvas=null;},
    ensurePaintDecoded:()=>{const id=decodingMap.place.id;if(!deferred.has(id)){let resolve;const promise=new Promise(done=>{resolve=done;});deferred.set(id,{promise,resolve});}return deferred.get(id).promise;},
    setPaintOverride:cv=>paintOverrides.push(cv),
  },
  '@/lib/sim/paint':{copyPaintCanvas:()=>decodedCanvas},
};
new Function('require','exports',receiverJs)(id=>receiverMocks[id]??require(id),receiver);
const firstMap={...structuredClone(original),v:2,paint:'first-paint'},secondMap={...firstMap,place:{...firstMap.place,id:2,name:'Редколесье'},passages:[],paint:'second-paint'};
const firstDraft={...structuredClone(editorRef.current),place:firstMap.place,pcv:null,ppaint:null,pdirty:false,dirty:false};
const receiveDeps={savedMapRef:{current:firstMap},editorRef:{current:firstDraft},setEditorView:()=>{},setEditorMsg:()=>{}};
receiver.receiveEditorMap(receiveDeps,firstMap);
const secondDraft={...structuredClone(firstDraft),place:secondMap.place,pcv:null,ppaint:null,pdirty:false};receiveDeps.editorRef.current=secondDraft;
receiver.receiveEditorMap(receiveDeps,secondMap);
decodedCanvas={location:1};deferred.get(1).resolve(true);await new Promise(r=>setImmediate(r));
assert.equal(secondDraft.pcv,null,'stale source decode cannot enter destination draft');assert.equal(paintOverrides.length,0);
decodedCanvas={location:2};deferred.get(2).resolve(true);await new Promise(r=>setImmediate(r));
assert.equal(secondDraft.pcv.location,2);assert.equal(paintOverrides.at(-1).location,2);
console.log('async paint isolation between location drafts: OK');
