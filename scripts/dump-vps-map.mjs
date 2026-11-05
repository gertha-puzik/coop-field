/**
 * Слив полной карты комнаты «тест» (zones + objects + paint PNG) в JSON-файл.
 * Только чтение: входим гостем mapprobe, ждём широковещательный field, забираем
 * из снапшота field.map, сохраняем в файл и выходим — сервер не меняем.
 *
 * Использование: node scripts/dump-vps-map.mjs [файл.json] [wsUrl] [--prod]
 *   по умолчанию — ЛОКАЛЬНЫЙ сервер ws://127.0.0.1:3780, файл — data/fresh-map.json
 *   (каталог data/ гитигнорится, туда удобно сливать свежие экспериментальные дампы);
 *   прод — ТОЛЬКО явным флагом --prod (endpoint wss://coop.89-232-184-77.sslip.io,
 *   перед стартом печатается предупреждение «–– ПРАВКА ПРОДА») — так снимают текущую
 *   карту с прода для нового бэкапа;
 *   другой адрес — env WS_URL (явный override, например WS_URL=ws://127.0.0.1:3700).
 *
 * Примеры:
 *   node scripts/dump-vps-map.mjs                              # локальный сервер → data/fresh-map.json
 *   node scripts/dump-vps-map.mjs backups/fresh-backup.json --prod  # слить текущую карту с прода
 *   WS_URL=ws://127.0.0.1:3700 node scripts/dump-vps-map.mjs data/x.json
 *   npm run map:dump                                          # алиас дефолтного локального слива
 *
 * Кадры — те же сырые JSON-фреймы, что и в scripts/test-ws.mjs:
 * ['join', …] → ['field', …]. Join занимает свободную клетку комнаты: если мест
 * нет, сервер ответит «noplace» (код выхода 3) — повторите, когда комната освободится.
 *
 * Коды выхода: 0 — карта сохранена; 1 — прод-адрес без --prod / в field не оказалось
 * полноценной карты; 2 — таймаут или сетевая ошибка; 3 — noplace (нет мест в комнате).
 */
import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const LOCAL_URL = 'ws://127.0.0.1:3780';
const PROD_URL = 'wss://coop.89-232-184-77.sslip.io';
const ROOM = 'test';
const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'data/fresh-map.json';

const wantProd = process.argv.includes('--prod');
if (wantProd) console.log('–– ПРАВКА ПРОДА:', PROD_URL);
if (!wantProd && process.argv[3] === PROD_URL) {
  console.error('прод-эндпоинт доступен только с явным флагом --prod');
  process.exit(1);
}
const URL = process.env.WS_URL || (wantProd ? PROD_URL : process.argv[3]) || LOCAL_URL;

const ws = new WebSocket(URL, { handshakeTimeout: 12000 });
const timer = setTimeout(() => { console.error('таймаут'); process.exit(2); }, 15000);

ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(2); });
ws.on('open', () => ws.send(JSON.stringify(['join', { room: ROOM, login: 'mapprobe' }])));

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const [event, payload] = msg;
  if (event === 'noplace') { console.error('noplace — в комнате нет свободных клеток, попробуйте позже'); process.exit(3); }
  if (event !== 'field') return;
  clearTimeout(timer);
  const map = payload?.map;
  // Проверки снапшота в стиле test-ws: сохраняем только полноценную карту.
  if (!map || !Number.isFinite(map.cols) || !Number.isFinite(map.rows) || !Array.isArray(map.zones)) {
    console.error('в field нет полноценной карты:',
      map ? `cols=${map.cols} rows=${map.rows} zones=${Array.isArray(map.zones) ? map.zones.length : typeof map.zones}` : 'payload.map отсутствует');
    ws.close();
    process.exit(1);
  }
  const paintLen = map.paint ? map.paint.length : 0;
  console.log('meta:', JSON.stringify({ cols: map.cols, rows: map.rows, zones: map.zones.length, objects: (map.objects || []).length, seed: map.seed, v: map.v, paintLen }));
  // Каталог назначения создаём сами: в свежем чекауте data/ ещё нет.
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(map));
  console.log('saved →', OUT);
  ws.close();
  process.exit(0);
});
