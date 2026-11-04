/** Прогон серверной карты через клиентский sanitizeTestMap (HEAD). */
import { sanitizeTestMap } from '/tmp/test-map.mjs';
import { readFileSync } from 'node:fs';

// Карта, которую прямо сейчас отдаёт VPS (снята probe-vps-map.mjs)
const vps = {
  v: 2,
  cols: 19,
  rows: 7,
  margin: 0.5,
  seed: 'test',
  zones: [
    { id: 'z1', name: 'Лужайка', kind: 'green', c0: 0, r0: 0, c1: 9, r1: 6 },
    { id: 'z2', name: 'Полигон', kind: 'cells', c0: 10, r0: 1, c1: 15, r1: 5 },
    { id: 'z3', name: 'Заросли', kind: 'green', c0: 16, r0: 0, c1: 18, r1: 6 },
  ],
  objects: [
    { id: 'o1', kind: 'entry', c: 9, r: 4, pos: 'center', dir: 'right' },
    { id: 'o2', kind: 'entry', c: 9, r: 2, pos: 'center', dir: 'right' },
  ],
};

const cases = [
  ['VPS-карта (снапшот поля)', vps],
  ['файл data/test-map.json песочницы', JSON.parse(readFileSync('/home/z/my-project/coop-field/data/test-map.json', 'utf8'))],
  ['встроенный дефолт клиента', { v: 2, cols: 19, rows: 7, margin: 0.5, seed: 'test', zones: [
    { id: 'z1', name: 'Лужайка', kind: 'green', c0: 0, r0: 0, c1: 9, r1: 6 },
    { id: 'z2', name: 'Полигон', kind: 'cells', c0: 10, r0: 1, c1: 15, r1: 5 },
    { id: 'z3', name: 'Заросли', kind: 'green', c0: 16, r0: 0, c1: 18, r1: 6 },
  ], objects: [] }],
];

for (const [name, raw] of cases) {
  const r = sanitizeTestMap(raw);
  if (!r.map) {
    console.log(`ОТКЛОНЕНА: ${name} → ${r.error}`);
  } else {
    const o = (r.map.objects || []).map((x) => `${x.kind}${x.c != null ? `@${x.c},${x.r}` : `@${x.x},${x.y}`}${x.dir ? `:${x.dir}` : ''}`);
    console.log(`ok: ${name} → zones=${r.map.zones.length}, objects=[${o.join('; ')}]`);
  }
}
