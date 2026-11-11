// Exercise the actual React network handlers without a browser/socket.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
let handlers;
const registered = new Set(), noop = () => {};
const client = { connect: noop, emit: noop };
const mocks = {
  react: { useEffect: fn => fn() },
  '@/lib/net/coop': {
    createCoopClient: h => { handlers = h; return client; }, nameFromUrl: () => '', roomTitle: x => x,
    catToDummy: c => ({ id: `p${c.id}`, sprite: c.sprite, scale: c.size ?? 100, col: c.x - 1, row: c.y - 1 }),
  },
  '@/lib/sim/sprite-catalog': { ensureFieldSprite: id => registered.add(id) },
  // Зеркало catScaleOf из sprite-aspect.ts — onYou тянет его после merge с #136.
  '@/lib/sim/sprite-aspect': {
    catScaleOf: (size) => {
      const raw = Math.round(Number(size));
      return Number.isFinite(raw) && raw >= 60 && raw <= 100 ? raw : 100;
    },
  },
  '@/lib/net/move-book': { seedRemoteDraw: x => x },
  '@/lib/sim/remote-aim': { createRemoteAim: noop },
  '@/lib/sim/settings': { SPRITES: [] },
  '../sim-model': { rememberRemoteCell: noop },
};
const source = fs.readFileSync(new URL('../src/components/sim/simulator/hooks/use-network.ts', import.meta.url), 'utf8');
const out = {};
new Function('require', 'exports', ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText)(id => mocks[id] ?? {}, out);
const settingsRef = { current: { character: { sprite: 'old', spriteScale: 100 }, combat: { armorLevel: 0 }, arrow: { battleMode: false } } };
const liveRemotesRef = { current: [] };
const refs = { settingsRef, liveRemotesRef, pendingJoinRef: { current: null }, engineRef: { current: {} },
  netMovesRef: { current: { pending: [] } }, fieldFormatRef: { current: 'test' } };
const deps = new Proxy({ loaded: true, netStarted: true, ...refs,
  setSettings: fn => settingsRef.current = fn(settingsRef.current),
}, { get: (o,k) => k in o ? o[k] : String(k).endsWith('Ref') ? (o[k] = { current: new Map() }) : noop });
out.useSimNet(deps);
handlers.onYou({ id: 1, sprite: 'my-upload', size: 67, x: 2, y: 2 });
assert.equal(settingsRef.current.character.spriteScale, 67, 'YOU applies the server size to self');
assert(registered.has('my-upload'));
registered.clear();
handlers.onField({ format: 'test', cats: [{ id: 2, sprite: 'peer-existing', size: 67, x: 3, y: 3 }] });
assert(registered.has('peer-existing'), 'existing peers must preload original image dimensions');
assert.equal(liveRemotesRef.current[0].scale, 67);
registered.clear();
handlers.onCat({ id: 3, sprite: 'peer-new', size: 67, x: 4, y: 4, fm: 1, fx: 3, fy: 3 });
assert(registered.has('peer-new'), 'new peers must preload original image dimensions');
handlers.onCat({ id: 3, sprite: 'peer-changed', size: 67, x: 4, y: 4, fm: 1, fx: 3, fy: 3 });
assert(registered.has('peer-changed'), 'appearance changes also preload original dimensions');
assert.equal(liveRemotesRef.current.find(c => c.id === 'p3').scale, 67);
console.log('PASS: actual YOU/FIELD/move handlers preserve 67% size and preload peer sprite dimensions');
