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
  new Function('require','exports',js)(id => id.startsWith('.') ? loadTs(new URL(id+(id.endsWith('.ts')?'':'.ts'),url)) : require(id),out);
  return out;
}
let finish;
const field = { ensurePaintDecoded: async () => true };
const mapLib = { TERRAIN_MAX_LEVEL: 20, TEST_MAP_LIMITS: {objectsMax: 1000}, testMapConnectivityError: () => null };
const mocks = {
  '@/lib/sim/editor-model': loadTs(new URL('../src/lib/sim/editor-model.ts',import.meta.url)),
  '@/lib/sim/paint': { encodeDraftPaint: () => '', encodeDraftPaintAsync: () => new Promise(r => {finish=r;}) },
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
const original = {cols:6,rows:6,margin:.5,seed:'regression',zones:[{kind:'cells',c0:0,r0:0,c1:5,r1:5}],objects:[],spawns:[],elev:{'1,1':2}};
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
console.log('editor elevation save after close: OK');

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
const ws={readyState:1,lastSetmap:0,send:data=>replies.push(JSON.parse(data))};
ws.room={code:'test',sockets:new Map([[ws,{}]])};
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
const okWs={readyState:1,lastSetmap:0,send:data=>okReplies.push(JSON.parse(data))};
okWs.room={code:'test',sockets:new Map([[okWs,{}]])};
const oldIsland=serverMap.TEST_ISLAND,oldCells=serverMap.TEST_CELLS;
serverMap.setMap(okWs,{map:{...previousMap,elev:{'2,2,1,1':6.7}}});
assert.equal(serverMap.TEST_ISLAND,oldIsland,'height-only saves reuse the ground contour');
assert.equal(serverMap.TEST_CELLS,oldCells,'height-only saves reuse the battle mask');
assert(okReplies.some(([event,text])=>event==='info'&&text==='Редактор: сохранено.'));
assert(!replies.some(([event,text])=>event==='info'&&text==='Редактор: сохранено.'),'disk failure never acknowledges success');
console.log('explicit save acknowledgement follows durable write: OK');

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
