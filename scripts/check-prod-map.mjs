/** Прод-проверка редактора локации: join в «тест» → field.map должен прийти. Только чтение. */
import WebSocket from 'ws';

const URL = 'wss://coop.89-232-184-77.sslip.io';
const ws = new WebSocket(URL);
const timer = setTimeout(() => { console.error('FAIL: timeout'); process.exit(1); }, 8000);
ws.on('open', () => ws.send(JSON.stringify(['join', { room: 'test', login: 'ProdCheck' }])));
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg[0] === 'field') {
    const f = msg[1];
    console.log('format:', f.format, '| size:', f.width + 'x' + f.height, '| map:', f.map ? `${f.map.cols}x${f.map.rows} zones=${f.map.zones.map((z) => z.name + ':' + z.kind).join(', ')}` : 'НЕТ');
    clearTimeout(timer);
    ws.close();
    process.exit(f.map ? 0 : 1);
  }
});
ws.on('error', (e) => { console.error('FAIL:', e.message); process.exit(1); });
