/**
 * Восстановление карты на VPS: читает JSON из файла и шлёт setmap в комнату
 * «тест». Файл с картой — первый аргумент (по умолчанию data/test-map.json).
 * Запуск: node scripts/set-vps-map.mjs [файл-карты.json] [ws-url]
 * Сервер сам проверит конфиг; ответ info — причина отказа, map — успех.
 * Пароль редактора по умолчанию — 1946 (совпадает с серверным legacy-дефолтом);
 * переопределение — env MAP_PASS: MAP_PASS=… node scripts/set-vps-map.mjs файл.json
 */
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

const FILE = process.argv[2] || 'data/test-map.json';
const URL = process.argv[3] || 'wss://coop.89-232-184-77.sslip.io';
// пароль редактора по умолчанию (совпадает с серверным legacy-дефолтом; переопределение — env MAP_PASS)
const PASS = process.env.MAP_PASS || '1946';

let map;
try {
  map = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`не читаю ${FILE}: ${e.message}`);
  process.exit(1);
}

const ws = new WebSocket(URL, { handshakeTimeout: 12000 });
const timer = setTimeout(() => {
  console.error('таймаут');
  process.exit(2);
}, 15000);

ws.on('error', (e) => {
  console.error('ws error:', e.message);
  process.exit(2);
});
ws.on('open', () => {
  ws.send(JSON.stringify(['join', { room: 'test', login: 'maprestore' }]));
});
ws.on('message', (raw) => {
  const [event, payload] = JSON.parse(String(raw));
  if (event !== 'field' && event !== 'info' && event !== 'you' && event !== 'noplace') return;
  if (event === 'you' || event === 'noplace') {
    if (event === 'noplace') {
      console.error('noplace:', JSON.stringify(payload));
      process.exit(3);
    }
    ws.send(JSON.stringify(['setmap', { pass: PASS, map }]));
    return;
  }
  clearTimeout(timer);
  if (event === 'info') {
    console.error('ОТКАЗ:', payload);
    process.exit(4);
  }
  const m = payload.map;
  console.log(
    `ПРИНЯТО: ${m.cols}x${m.rows} seed=${JSON.stringify(m.seed)} zones=${m.zones.length} objects=${(m.objects || []).length}`,
  );
  ws.close();
  process.exit(0);
});
