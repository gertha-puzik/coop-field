// Regression: saving elevation must finish even when the editor closes during PNG encoding.
import assert from 'node:assert/strict';
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
  new Function('require','exports',js)(id => id.startsWith('.') ? loadTs(new URL(id+'.ts',url)) : require(id),out);
  return out;
}
let finish;
const field = { ensurePaintDecoded: async () => true };
const mapLib = { TERRAIN_MAX_LEVEL: 10, TEST_MAP_LIMITS: {objectsMax: 1000}, testMapConnectivityError: () => null };
const mocks = {
  '@/lib/sim/editor-model': { SETMAP_MIN_GAP_MS: 10000 },
  '@/lib/sim/paint': { encodeDraftPaint: () => '', encodeDraftPaintAsync: () => new Promise(r => {finish=r;}) },
  '@/lib/sim/test-field': field,
  '@/lib/sim/test-map': mapLib,
  '@/lib/sim/geometry': {},
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
assert.deepEqual(editorRef.current.elev,{'1,1':2,'2,2':1});
ops.saveEditorMap();
ops.closeEditor();
finish('');
await new Promise(r=>setImmediate(r));
assert.equal(sent.length,1,'closing editor must not silently cancel saving');
assert.equal(sent[0][0],'setmap');
assert(!('pass' in sent[0][1]),'client sends no editor password');
assert.deepEqual(sent[0][1].map.elev,{'1,1':2,'2,2':1},'old and new elevations both survive');
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
assert.deepEqual(roundtrip.elev,{'1,1':2,'2,2':1},'received map preserves both heights for reopening');
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
serverMap.setMap(ws,{map:{...previousMap,elev:{'2,2':1}}});
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
 for(const level of [1,5,10]) {
  const x=550-Math.sin(yaw)*26*level,y=825-Math.cos(yaw)*26*level;
  const hit=terrain.pickTerrainTop(x,y,100,150,12,12,(c,r)=>c===5&&r===5?level:0,26,yaw);
  assert.equal(hit.c,5);assert.equal(hit.r,5);assert.equal(hit.level,level);
 }
}
assert.deepEqual(terrain.clampBrush({width:99,depth:99,level:99},6,4),{width:6,depth:4,level:10});
console.log('rectangular exact-height brush and terrain picking at five camera angles: OK');
