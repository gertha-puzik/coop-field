/**
 * Одноразовая установка демо-карты для E2E-скриншотов:
 * перекрывающиеся боевые зоны (проверка единого цвета) + три клетки захода.
 * Запуск: node scripts/install-demo-map.mjs  (восстановление: node scripts/install-demo-map.mjs --restore)
 */
import WebSocket from 'ws';

const URL = process.env.WS_URL || 'ws://127.0.0.1:3780';
const PASS = '1946';
const restore = process.argv.includes('--restore');

const demoMap = {
  v: 2,
  cols: 19,
  rows: 7,
  seed: 'test',
  zones: [
    { id: 'z1', name: 'Лужайка', kind: 'green', c0: 0, r0: 0, c1: 9, r1: 6 },
    { id: 'z2', name: 'Полигон', kind: 'cells', c0: 10, r0: 1, c1: 15, r1: 5 },
    { id: 'z4', name: 'Полигон-юг', kind: 'cells', c0: 12, r0: 4, c1: 17, r1: 6 },
  ],
  objects: [
    { id: 'e1', kind: 'entry', c: 9, r: 3, dir: 'right' },
    { id: 'e2', kind: 'entry', c: 11, r: 6, dir: 'right' },
    { id: 'e3', kind: 'entry', c: 16, r: 3, dir: 'left' },
  ],
};

const defaultMap = {
  v: 2,
  cols: 19,
  rows: 7,
  seed: 'test',
  zones: [
    { id: 'z1', name: 'Лужайка', kind: 'green', c0: 0, r0: 0, c1: 9, r1: 6 },
    { id: 'z2', name: 'Полигон', kind: 'cells', c0: 10, r0: 1, c1: 15, r1: 5 },
    { id: 'z3', name: 'Заросли', kind: 'green', c0: 16, r0: 0, c1: 18, r1: 6 },
  ],
  objects: [],
};

const map = restore ? defaultMap : demoMap;
const ws = new WebSocket(URL);
ws.on('open', () => {
  ws.send(JSON.stringify(['join', { room: 'test', login: 'MapSetter' }]));
});
let done = false;
ws.on('message', (raw) => {
  const [ev, p] = JSON.parse(String(raw));
  if (ev === 'you') {
    ws.send(JSON.stringify(['setmap', { pass: PASS, map }]));
  } else if (ev === 'map') {
    console.log(restore ? 'default map restored' : `demo map installed: objects=${(p.objects || []).length}`);
    done = true;
    ws.close();
  } else if (ev === 'info') {
    console.log('info:', p);
    ws.close();
  }
});
ws.on('close', () => process.exit(done ? 0 : 1));
setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 5000);
