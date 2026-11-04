/**
 * Разведка карты на VPS: подключаемся как гость в комнату «тест», снимаем
 * присланную сервером карту (zones + objects) и позиции котов из снапшота.
 * Ничего не меняем: только читаем field и выходим.
 * Запуск: node scripts/probe-vps-map.mjs [ws-url]
 */
import WebSocket from 'ws';

const URL = process.argv[2] || 'wss://coop.89-232-184-77.sslip.io';
const ROOM = 'test';

const ws = new WebSocket(URL, { handshakeTimeout: 12000 });

const timer = setTimeout(() => {
  console.error('таймаут: сервер не ответил за 15 с');
  process.exit(2);
}, 15000);

ws.on('error', (e) => {
  console.error('ws error:', e.message);
  process.exit(2);
});

ws.on('open', () => {
  ws.send(JSON.stringify(['join', { room: ROOM, login: 'mapprobe' }]));
});

ws.on('message', (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const [event, payload] = msg;
  if (event === 'noplace') {
    console.error('noplace:', JSON.stringify(payload));
    process.exit(3);
  }
  if (event !== 'field') return;
  clearTimeout(timer);

  const map = payload.map;
  console.log('room:', payload.room, '| format:', payload.format);
  console.log('width x height:', payload.width, 'x', payload.height);
  if (!map) {
    console.log('карты в снапшоте нет');
    process.exit(0);
  }
  console.log('map: v', map.v, '| cols', map.cols, '| rows', map.rows, '| seed', JSON.stringify(map.seed));
  console.log('zones:');
  for (const z of map.zones) {
    console.log(`  ${z.id} «${z.name}» ${z.kind} [${z.c0},${z.r0}..${z.c1},${z.r1}]`);
  }
  const objs = map.objects || [];
  console.log(`objects: ${objs.length}`);
  for (const o of objs.slice(0, 40)) {
    console.log('  ', JSON.stringify(o));
  }
  if (objs.length > 40) console.log(`  … и ещё ${objs.length - 40}`);
  const cats = payload.cats || [];
  console.log(`cats on field: ${cats.length}`);
  for (const c of cats) {
    console.log(`  #${c.id} ${c.login || '(без имени)'} fm=${c.fm} x=${c.x} y=${c.y} fx=${c.fx} fy=${c.fy} spr=${c.spr}`);
  }
  ws.close();
  process.exit(0);
});
