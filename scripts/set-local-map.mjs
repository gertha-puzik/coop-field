/**
 * Установка карты из JSON-файла в комнату «тест» ЛОКАЛЬНОГО сервера
 * (по умолчанию ws://127.0.0.1:3780). Карта комнаты держится в памяти сервера
 * (дубль на диске — data/test-map.json), так что после перезапуска сервера её
 * возвращают на место этим скриптом. Флоу: join гостем mapprobe2 → ждём «you» →
 * шлём ['setmap', { map }] → выходим по широковещательному «map» (успех)
 * или «info» (отказ сервера).
 *
 * Использование: node scripts/set-local-map.mjs [файл.json] [wsUrl]
 *   по умолчанию файл — backups/prod-elysia-map-2026-11-06.json (бэкап прод-карты
 *   «Элизия» комнаты «тест», снята dump-vps-map.mjs 2026-11-06), сервер ws://127.0.0.1:3780;
 *   прод по этому скрипту недоступен в принципе — для прод-восстановления есть
 *   scripts/set-vps-map.mjs (отдельное намеренное действие);
 *   чужой локальный адрес — env WS_URL (явный override, например WS_URL=ws://127.0.0.1:3700).
 *
 * Примеры:
 *   node scripts/set-local-map.mjs                       # бэкап 2026-11-06 → локальный сервер
 *   node scripts/set-local-map.mjs data/fresh-map.json   # карта, снятая dump-vps-map.mjs
 *   npm run map:restore                                  # то же, что первый пример
 *
 * Пароля редактора нет: setmap пароль не читает, карту сохраняет только
 * сессия с ролью admin (server/testmap.js).
 *
 * Ограничения сервера (server/config.js, server/testmap.js): setmap не чаще раза
 * в 10 с на сокет («Редактор: слишком часто.»); крупный кадр легален только для
 * setmap — карта с paint PNG весит ≈ 0,5 МиБ при потолке кадра 4 МиБ. Один запуск — один кадр.
 *
 * Кадры — сырые JSON-фреймы в стиле scripts/test-ws.mjs: ['join', …], ['setmap', …].
 * Коды выхода: 0 — сервер принял карту (получен broadcast 'map', геометрия сошлась);
 * 1 — файл не читается / не карта / прод-адрес в аргументах; 2 — таймаут или сетевая
 * ошибка; 3 — noplace (нет мест в комнате); 4 — сервер отказал ('info' после setmap);
 * 5 — принятая сервером карта расходится с файлом (геометрия не совпала).
 */
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

const LOCAL_URL = 'ws://127.0.0.1:3780';
const PROD_URL = 'wss://coop.89-232-184-77.sslip.io';
const FILE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'backups/prod-elysia-map-2026-11-06.json';
if (process.argv[3] === PROD_URL) {
  console.error('прод-эндпоинт недоступен из этого скрипта — используйте scripts/set-vps-map.mjs');
  process.exit(1);
}
const URL_ = process.env.WS_URL || process.argv[3] || LOCAL_URL;

let map;
try {
  map = JSON.parse(readFileSync(FILE, 'utf8'));
} catch (e) {
  console.error(`не читается ${FILE}: ${e.message}`);
  process.exit(1);
}
// Проверка файла в стиле test-ws: до отправки убеждаемся, что это полноценная карта.
if (!Number.isFinite(map.cols) || !Number.isFinite(map.rows) || !Array.isArray(map.zones) || map.zones.length === 0) {
  console.error(`${FILE} — не похоже на карту (нужны cols/rows/заполненные zones)`);
  process.exit(1);
}

const ws = new WebSocket(URL_, { handshakeTimeout: 12000 });
const timer = setTimeout(() => { console.error('таймаут'); process.exit(2); }, 15000);

ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(2); });
ws.on('open', () => ws.send(JSON.stringify(['join', { room: 'test', login: 'mapprobe2' }])));

let sent = false;
ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const [event, payload] = msg;
  if (event === 'noplace') { console.error('noplace — в комнате нет свободных клеток, попробуйте позже'); process.exit(3); }
  if (event === 'you' && !sent) {
    sent = true;
    ws.send(JSON.stringify(['setmap', { map }]));
    return;
  }
  if (event === 'info' && sent) {
    console.error('ОТКАЗ:', JSON.stringify(payload));
    process.exit(4);
  }
  if (event === 'map' && sent) {
    clearTimeout(timer);
    // Сверка широковещательного 'map' с отправленным (в стиле test-ws):
    // сервер обязан вернуть принятую геометрию — cols/rows/число зон те же.
    const okCols = Number(payload?.cols) === Number(map.cols);
    const okRows = Number(payload?.rows) === Number(map.rows);
    const okZones = Array.isArray(payload?.zones) && payload.zones.length === map.zones.length;
    console.log(`ПРИНЯТО map-event: ${payload.cols}x${payload.rows} zones=${payload.zones.length} objects=${(payload.objects || []).length} paint=${payload.paint ? payload.paint.length : 0}`);
    if (!okCols || !okRows || !okZones) {
      console.error(`РАСХОЖДЕНИЕ с файлом: в файле cols=${map.cols} rows=${map.rows} zones=${map.zones.length}`);
      ws.close();
      process.exit(5);
    }
    ws.close();
    process.exit(0);
  }
});
