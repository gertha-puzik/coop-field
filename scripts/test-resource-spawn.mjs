import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const data = mkdtempSync(join(tmpdir(), 'coop-resource-spawn-'));
process.env.DATA_DIR = data;
const { changeSpawnSettings, nextSpawnAt, tickResourceSpawn, spawnOverview } = await import('../server/resource-spawn.js');
const { spawnGround, worldItemAction, saveItem, grantItems } = await import('../server/inventory-store.js');
try {
  const now = Date.parse('2026-11-20T05:00:00Z');
  assert.equal(nextSpawnAt({ mode:'daily', times:['09:00','18:00'] }, now), Date.parse('2026-11-20T06:00:00Z'));
  assert.equal(nextSpawnAt({ mode:'daily', times:['09:00','18:00'] }, Date.parse('2026-11-20T15:00:00Z')), Date.parse('2026-11-21T06:00:00Z'));
  const random = nextSpawnAt({ mode:'random', min:2, max:4 }, now);
  assert.ok(random >= now + 120000 && random <= now + 240000);

  assert.ok(saveItem({ id:'zero-weight', name:'Тест', weight:1, sprite:'/items/nugget.png' }).item);
  const rule = { name:'Сбор', enabled:true, schedule:{ mode:'interval', minutes:2 },
    min:3, max:10, locations:[1,2], items:[{ itemId:'nugget', weight:1 },{ itemId:'zero-weight', weight:0 }] };
  assert.equal(changeSpawnSettings({ action:'save', rule:{ ...rule, max:2 } }, now).error, 'invalid_spawn');
  assert.ok(changeSpawnSettings({ action:'save', rule }, now).ok);
  assert.ok(changeSpawnSettings({ action:'limit', locationId:1, limit:2 }, now).ok);
  assert.ok(changeSpawnSettings({ action:'limit', locationId:2, limit:10 }, now).ok);

  grantItems('admin', 'owner', 'cat', { operationId:'spawn-test-grant', itemId:'nugget', quantity:1 });
  assert.ok(worldItemAction('owner','cat','test',{ action:'drop', version:1, from:{area:'bag',index:0}, x:1.5,y:1.5 }).inventory);
  let saved = spawnOverview().rules[0];
  assert.ok(changeSpawnSettings({ action:'force', id:saved.id }, now).ok);
  assert.equal(spawnOverview().rules[0].next, saved.next);
  assert.equal(spawnGround('test').length, 3, 'player drop occupies none of the two spawn slots');
  const forest = spawnGround('test-loc-2');
  assert.ok(forest.length >= 3 && forest.length <= 10);
  assert.ok(forest.every(row => row.itemId === 'nugget'));
  const valley = spawnGround('test').find(row => row.spawned);
  assert.ok(worldItemAction('owner','cat','test',{ action:'take', version:2, id:valley.id }).inventory);
  tickResourceSpawn(saved.next);
  assert.equal(spawnGround('test').filter(item => item.spawned).length, 2);
  assert.ok(spawnOverview().log.some(row => row.source === 'manual'));
  assert.ok(spawnOverview().log.some(row => row.source === 'scheduled' && row.locationId === 1 && row.items[0]?.count === 1));

  saved = spawnOverview().rules[0];
  const before = spawnOverview().log.length;
  const restart = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { tickResourceSpawn } from './server/resource-spawn.js'; tickResourceSpawn(${saved.next + 120000}, true);`],
    { env:process.env, encoding:'utf8' });
  assert.equal(restart.status, 0, restart.stderr);
  const disk = JSON.parse(readFileSync(join(data,'inventories.json')));
  assert.equal(disk.resourceSpawn.log.length, before);
  assert.ok(disk.resourceSpawn.rules[0].next > saved.next + 120000);
  assert.equal(Object.values(disk.ground).filter(row => row.room === 'test').length, 3);
  console.log('resource spawn: PASS — Moscow schedules, weighted pool, location caps, pickup, journal and restart');
} finally {
  rmSync(data, { recursive:true, force:true });
}
