/** World-location regression: isolated disk maps/geometry/rooms and trusted
 * passage travel over real authenticated WebSockets. Only mkdtemp data is used.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import ts from 'typescript';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-locations-'));
const getPort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const port = await getPort(), origin = `http://127.0.0.1:${port}`, sleep = ms => new Promise(r => setTimeout(r, ms));
const fixture = { v: 2, cols: 12, rows: 11, margin: .5, seed: 'valley-fixture', place: { id: 1, name: 'Долина', zoneId: 1, zoneName: 'Средиземье' }, zones: [{ id: 'grass', kind: 'green', name: 'Трава', c0: 0, r0: 0, c1: 11, r1: 10 }, { id: 'battle', kind: 'cells', name: 'Бой', c0: 0, r0: 0, c1: 1, r1: 1 }], objects: [], spawns: [{ c: 2, r: 5 }], elev: { '8,8': 2 }, passages: [{ id: 'forest', x: 2, y: 4, w: 3, h: 3, targetId: 2, link: 'trail', direction: 'right' }] };
fs.writeFileSync(path.join(dir, 'test-map.json'), JSON.stringify(fixture));
const admin = spawnSync(process.execPath, ['scripts/make-admin.mjs', 'worldadmin', 'local-test-pass'], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
assert.equal(admin.status, 0, admin.stderr);
let server;
const clients = [];
let logs = '';
async function start() {
    server = spawn(process.execPath, ['server.js'], { env: { ...process.env, DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', x => logs += x);
    server.stderr.on('data', x => logs += x);
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(origin + '/health')).ok)
                return;
        }
        catch { }
        await sleep(50);
    }
    throw Error(logs);
}
async function login() { const r = await fetch(origin + '/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'worldadmin', pass: 'local-test-pass' }) }); assert.equal(r.status, 200); return r.headers.getSetCookie().map(s => s.split(';')[0]).join('; '); }
async function client(cookie = '') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}) } }), frames = [];
    clients.push(ws);
    ws.on('message', raw => frames.push(JSON.parse(String(raw))));
    await once(ws, 'open');
    const wait = async (predicate, from = 0) => { for (let n = 0; n < 160; n++) {
        const f = frames.slice(from).find(predicate);
        if (f)
            return f[1];
        await sleep(25);
    } throw Error('Missing frame: ' + frames.slice(-8).map(f => f[0] + ':' + (typeof f[1] === 'string' ? f[1] : JSON.stringify(f[1]).slice(0, 140))).join('\n') + '\n' + logs.slice(-1800)); };
    return { ws, frames, send: (event, body) => ws.send(JSON.stringify([event, body])), wait };
}
try {
    await start();
    const cookie = await login();
    const appearance = await fetch(origin + '/profiles/me', { method: 'PATCH', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ scale: 67 }) });
    assert.equal(appearance.status, 200);
    const a = await client(cookie), b = await client(cookie), guest = await client();
    a.send('join', { room: 'test', login: 'World A' });
    const first = await a.wait(f => f[0] === 'field');
    assert.equal(first.width, 12);
    assert.equal(first.cats[0].size, 67, 'saved profile size survives joins without an override');
    assert.equal(first.map.place.id, 1);
    assert.equal(first.locations.length, 2);
    b.send('join', { room: 'test-loc-2', login: 'World B' });
    const second = await b.wait(f => f[0] === 'field');
    assert.equal(second.width, 10);
    assert.equal(second.height, 10);
    assert.equal(second.map.place.name, 'Редколесье');
    assert(second.map.paint);
    guest.send('join', { room: 'test-loc-2' });
    await guest.wait(f => f[0] === 'noplace' && f[1].reason === 'auth_required');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'test-map.json'), 'utf8')).elev, { '8,8': 2 }, 'opening another world never overwrites Valley');
    // Client/server schema mirror, including malicious coordinates and identities.
    const js = ts.transpileModule(fs.readFileSync('src/lib/sim/location-map.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const clientModel = {};
    new Function('exports', 'require', js)(clientModel, () => ({}));
    const env = { ...process.env, DATA_DIR: dir };
    const schemaCode = `import {sanitizeLocationFields} from './server/location-world.js';console.log(JSON.stringify(JSON.parse(process.env.LOCATION_CASES).map(x=>sanitizeLocationFields(x,12,11))));`;
    const cases = [fixture, { place: fixture.place, passages: [{ ...fixture.passages[0], w: -1 }] }, { place: fixture.place, passages: [fixture.passages[0], fixture.passages[0]] }, { place: { ...fixture.place, id: 1.5 } }, { place: fixture.place, passages: [{ ...fixture.passages[0], link: '../escape' }] }, { place: fixture.place, passages: [{ ...fixture.passages[0], targetId: 1 }] }];
    const mirror = spawnSync(process.execPath, ['--input-type=module', '-e', schemaCode], { env: { ...env, LOCATION_CASES: JSON.stringify(cases) }, encoding: 'utf8' });
    assert.equal(mirror.status, 0, mirror.stderr);
    assert.deepEqual(JSON.parse(mirror.stdout.trim()), cases.map(x => clientModel.sanitizeLocationFields(x, 12, 11)));
    // A failed/forged request must leave the source room and cat intact.
    let n = a.frames.length;
    a.send('join', { passageId: 'missing', targetId: 2, x: 1, y: 1 });
    await a.wait(f => f[0] === 'info' && String(f[1]).startsWith('Переход:'), n);
    await sleep(1100);
    a.send('freemove', { x: 7, y: 7, foot: { dx: .45, dy: .95 }, stop: true });
    await sleep(60);
    n = a.frames.length;
    a.send('join', { passageId: 'forest' });
    await a.wait(f => f[0] === 'info' && String(f[1]).includes('область'), n);
    await sleep(1100);
    a.send('cellsync', { x: 1, y: 1 });
    await sleep(80);
    n = a.frames.length;
    a.send('join', { passageId: 'forest' });
    await a.wait(f => f[0] === 'info' && String(f[1]).includes('мирном'), n);
    a.send('freemove', { x: 2, y: 5, foot: { dx: .45, dy: .95 }, stop: true });
    await sleep(1100);
    n = a.frames.length;
    a.send('join', { passageId: 'forest' });
    const arrived = await a.wait(f => f[0] === 'field' && f[1].room === 'test-loc-2', n);
    const me = arrived.cats.find(c => c.id === a.frames.slice(n).find(f => f[0] === 'you')[1].id);
    assert.equal(me.fm, 1);
    assert.equal(me.size, 67, 'passage retains saved height');
    assert(me.fx + .45 >= 0 && me.fx + .45 < 10 && me.fy + .95 >= 0 && me.fy + .95 < 10, 'fallback arrival is on destination map');
    // Rename and passage edits affect only the destination file/room.
    const observer=await client(cookie);observer.send('join',{room:'test'});await observer.wait(f=>f[0]==='field');
    const changed = { ...second.map, place: { ...second.map.place, name: 'Редколесье тест' }, elev: { '6,6': 3 }, passages: [{ id: 'back', x: 1, y: 3, w: 2, h: 2, targetId: 1, link: 'trail', direction: 'left' }] };
    n = b.frames.length;
    b.send('setmap', { map: changed });
    await b.wait(f => f[0] === 'info' && f[1] === 'Редактор: сохранено.', n);
    const catalogue=await observer.wait(f=>f[0]==='locations');assert.equal(catalogue.find(p=>p.id===2).name,'Редколесье тест','rename updates catalogue in other rooms without replacing their map');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'location-2.json'), 'utf8')).place.name, 'Редколесье тест');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'test-map.json'), 'utf8')), fixture, 'destination edit cannot mutate source disk map');
    // Go back through the real reverse passage, then arrive outside it on return.
    a.send('freemove', { x: 1.2, y: 3.2, foot: { dx: .45, dy: .95 }, stop: true });
    await sleep(2100);
    n = a.frames.length;
    a.send('join', { passageId: 'back' });
    await a.wait(f => f[0] === 'field' && f[1].room === 'test', n);
    a.send('freemove', { x: 2, y: 5, foot: { dx: .45, dy: .95 }, stop: true });
    await sleep(2100);
    n = a.frames.length;
    a.send('join', { passageId: 'forest' });
    const back = await a.wait(f => f[0] === 'field' && f[1].room === 'test-loc-2', n);
    const ownId = a.frames.slice(n).find(f => f[0] === 'you')[1].id;
    const own = back.cats.find(c => c.id === ownId);
    assert(!clientModel.passageContains(changed.passages[0], own.fx + .45, own.fy + .95, .1), 'arrival is near, not inside, reverse trigger');
    assert(Math.hypot(own.fx + .45 - 2, own.fy + .95 - 4) < 4, 'arrival stays near reverse exit');
    const position = { fx: own.fx, fy: own.fy };
    a.ws.close();
    await sleep(100);
    const reconnect = await client(cookie);
    reconnect.send('join', { room: 'test-loc-2' });
    const restored = await reconnect.wait(f => f[0] === 'you');
    assert.equal(restored.size, 67, 'reconnect retains saved height');
    assert(Math.abs(restored.fx - position.fx) < .02 && Math.abs(restored.fy - position.fy) < .02, 'reconnect restores this location position');
    const resume=await client(cookie);resume.send('join',{room:'test',resume:true});const resumed=await resume.wait(f=>f[0]==='field');assert.equal(resumed.room,'test-loc-2','fresh world entry resumes the latest location');
    const explicit=await client(cookie);explicit.send('join',{room:'test'});assert.equal((await explicit.wait(f=>f[0]==='field')).room,'test','explicit Valley room still opens Valley');
    // Cached world scopes must restore after nesting and after exceptions.
    const scopeCode = `import {withTestLocation,testMap,TEST_WIDTH} from './server/testmap.js';import{testElev}from'./server/world.js';import{roomOf}from'./server/room.js';if(roomOf('test-loc-02')!==roomOf('test-loc-2'))throw Error('aliases split the world');const a=TEST_WIDTH;if(a!==12)throw Error('base');withTestLocation(2,()=>{if(TEST_WIDTH!==10||testElev(7,7)!==3)throw Error('forest geometry');withTestLocation(1,()=>{if(TEST_WIDTH!==12||testElev(9,9)!==2)throw Error('nested valley');});if(TEST_WIDTH!==10)throw Error('nested restore');});try{withTestLocation(2,()=>{throw Error('expected')});}catch{}if(TEST_WIDTH!==12)throw Error('exception restore');console.log('scopes OK');`;
    const scoped = spawnSync(process.execPath, ['--input-type=module', '-e', scopeCode], { env, encoding: 'utf8' });
    assert.equal(scoped.status, 0, scoped.stderr);
    const bad=fs.mkdtempSync(path.join(os.tmpdir(),'coop-location-corrupt-'));
    try{
      fs.writeFileSync(path.join(bad,'test-map.json'),JSON.stringify(fixture));fs.writeFileSync(path.join(bad,'location-2.json'),'{broken');
      assert.equal(spawnSync(process.execPath,['scripts/make-admin.mjs','brokenactor','local-test-pass'],{env:{...process.env,DATA_DIR:bad},encoding:'utf8'}).status,0);
      const corruptCode=`import fs from 'node:fs';import {withTestLocation,TEST_WIDTH} from './server/testmap.js';import {locationCatalogue} from './server/location-world.js';import{join}from'./server/room.js';import{findByLogin,activeCharacter}from'./server/accounts.js';import{rememberCat}from'./server/persist.js';const list=locationCatalogue();if(list[0].name!=='Долина'||TEST_WIDTH!==12)throw Error('corrupt neighbor blocked Valley');for(let i=0;i<2;i++){let failed=false;try{withTestLocation(2,()=>{})}catch{failed=true}if(!failed||TEST_WIDTH!==12)throw Error('failed scope poisoned cache');}const account=findByLogin('brokenactor');rememberCat({login:activeCharacter(account).name,locationId:2,fm:1,fx:2,fy:5,x:3,y:6});const replies=[],ws={account,readyState:1,send:text=>replies.push(JSON.parse(text))};join(ws,{room:'test',resume:true});if(!replies.some(f=>f[0]==='field'&&f[1].room==='test'))throw Error('resume must recover in Valley');if(fs.readFileSync(process.env.DATA_DIR+'/location-2.json','utf8')!=='{broken')throw Error('corrupt map overwritten');`;
      const corrupt=spawnSync(process.execPath,['--input-type=module','-e',corruptCode],{env:{...process.env,DATA_DIR:bad},encoding:'utf8'});assert.equal(corrupt.status,0,corrupt.stderr);
    }finally{fs.rmSync(bad,{recursive:true,force:true});}
    // Admin create: next free ID, blank 10×10, catalogue broadcast, join works.
    const createDenied = await fetch(origin + '/admin/locations', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(createDenied.status, 401);
    const created = await fetch(origin + '/admin/locations', { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Новый луг' }) });
    const createdText = await created.text();
    assert.equal(created.status, 200, createdText);
    const createdBody = JSON.parse(createdText);
    assert.equal(createdBody.place.id, 3);
    assert.equal(createdBody.place.name, 'Новый луг');
    assert.equal(createdBody.room, 'test-loc-3');
    assert.equal(createdBody.locations.length, 3);
    const disk3 = JSON.parse(fs.readFileSync(path.join(dir, 'location-3.json'), 'utf8'));
    assert.equal(disk3.cols, 10);
    assert.equal(disk3.rows, 10);
    assert.equal(disk3.place.id, 3);
    assert(disk3.paint && disk3.paint.startsWith('iVBORw0KGgo'), 'new location has grass paint');
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'locations-index.json'), 'utf8'));
    assert.deepEqual(index.ids, [1, 2, 3]);
    const catalogueHttp = await fetch(origin + '/locations');
    assert.equal(catalogueHttp.status, 200);
    const catalogueBody = await catalogueHttp.json();
    assert.equal(catalogueBody.locations.length, 3);
    assert.deepEqual(catalogueBody.rooms, ['test', 'test-loc-2', 'test-loc-3']);
    const c = await client(cookie);
    c.send('join', { room: 'test-loc-3', login: 'World C' });
    const third = await c.wait(f => f[0] === 'field');
    assert.equal(third.width, 10);
    assert.equal(third.height, 10);
    assert.equal(third.map.place.name, 'Новый луг');
    assert.equal(third.locations.length, 3);
    console.log('PASS: location schema parity; distinct 12×11/10×10 maps, rooms, files and geometry; guest/forged/outside/battle denial; real passage travel, reverse arrival, reconnect/resume, nested scope restoration, corrupt-neighbor isolation and admin create ID 3');
}
finally {
    for (const ws of clients)
        ws.terminate();
    if (server) {
        server.kill('SIGTERM');
        await once(server, 'exit').catch(() => { });
    }
    fs.rmSync(dir, { recursive: true, force: true });
}
