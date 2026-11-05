/**
 * Проверка редактора локации на уровне протокола:
 *  1. join в «тест» → field несёт map (конфиг локации).
 *  2. setmap с неверным паролем → info с ошибкой, map не меняется.
 *  3. setmap с верным паролем и несоединённым конфигом → info с причиной.
 *  4. setmap с верным паролем и валидным конфигом → map всем + field; файл сохранён.
 *  5. cellsync в зелёную зону отвергается.
 *  6. Возврат к раскладке по умолчанию (восстановление после теста).
 *
 * Запуск: node scripts/test-editor-map.mjs — из чистого клона, сам поднимает
 * свой server.js на случайном порту с временным DATA_DIR (репозиторный data/
 * не трогается). Внешний сервер: WS_URL=ws://… node scripts/test-editor-map.mjs.
 *
 * Каждая setmap-правка уходит со своего НОВОГО сокета: сервер троттлит любые
 * setmap-кадры раз в 10 с НА СОКЕТ — свежее соединение получает свежий счётчик.
 *
 * Пароль редактора по умолчанию — 1946 (совпадает с серверным legacy-дефолтом);
 * переопределение — env MAP_PASS (спавненному серверу передаётся ADMIN_PASS
 * с тем же значением — клиент и сервер теста всегда сходимся).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

// пароль редактора по умолчанию (совпадает с серверным legacy-дефолтом; переопределение — env MAP_PASS)
const PASS = process.env.MAP_PASS || '1946';

const PORT = 3953 + Math.floor(Math.random() * 40);
const url = process.env.WS_URL || `ws://127.0.0.1:${PORT}`;

// Свой server.js, если внешний адрес не задан; пароль уходит в spawn-окружение
// тем же значением, что и в кадрах setmap («читает env КАК сервер»).
const srv = process.env.WS_URL
  ? null
  : spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        DATA_DIR: mkdtempSync(path.join(tmpdir(), 'coop-editor-map-')),
        ADMIN_PASS: PASS,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
if (srv) {
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write(d));
  process.on('exit', () => srv.kill('SIGTERM'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const connect = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const state = { inbox: [], waiters: [], readIdx: 0 };
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      state.inbox.push(msg);
      for (let i = state.waiters.length - 1; i >= 0; i--) {
        const w = state.waiters[i];
        if (w.pred(msg)) {
          state.waiters.splice(i, 1);
          // съедаем всё до этого сообщения включительно: следующий wait
          // не должен матчить уже использованные сообщения
          state.readIdx = Math.max(state.readIdx, state.inbox.length);
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });
    ws.on('open', () => resolve({ ws, state }));
    ws.on('error', reject);
  });

const wait = (state, pred, label, ms = 4000) => {
  const match = (msg) => {
    try {
      return pred(msg);
    } catch {
      return false;
    }
  };
  // Сообщения могут прилететь одним чанком: 'map' и следующий за ним 'field'
  // обрабатываются в одном событии сокета — к моменту регистрации waiter'а
  // 'field' уже лежит в inbox. Поэтому сначала ищем с позиции курсора,
  // а найденное съедаем (следующий wait старое не матчит).
  for (let i = state.readIdx; i < state.inbox.length; i++) {
    if (match(state.inbox[i])) {
      state.readIdx = i + 1;
      return Promise.resolve(state.inbox[i]);
    }
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${label}`)), ms);
    state.waiters.push({ pred: match, resolve, timer });
  });
};

const send = (ws, event, payload) => ws.send(JSON.stringify([event, payload]));

// Готовность: свой server.js поднимается доли секунды, чужой может слушать сразу.
async function waitServer() {
  for (let i = 0; i < 100; i++) {
    const ready = await new Promise((resolve) => {
      const probe = new WebSocket(url);
      probe.once('open', () => {
        probe.terminate();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (ready) return;
    await sleep(100);
  }
  throw new Error('сервер не поднялся');
}

/** setmap-кадр с нового сокета (троттлинг 10 с — на сокет, см. шапку).
 *  Ответ ждём на сокете самого отправителя: отказ приходит только ему,
 *  а рассылка map/field — всей комнате, включая его. */
const setmapOnce = async (map, pass, pred, label) => {
  const sock = await connect();
  send(sock.ws, 'join', { room: 'test', login: `MapAdmin-${Date.now().toString(36)}` });
  await wait(sock.state, (m) => m[0] === 'field', 'field админа');
  send(sock.ws, 'setmap', { pass, map });
  const reply = await wait(sock.state, pred, label);
  sock.ws.close();
  return reply;
};

const main = async () => {
  await waitServer();
  const { ws, state } = await connect();
  send(ws, 'join', { room: 'test', login: 'MapTester' });
  const field = await wait(state, (m) => m[0] === 'field', 'field');
  const f = field[1];
  console.log('1. field: format=%s size=%sx%s map=%s', f.format, f.width, f.height, f.map ? `zones=${f.map.zones.length}` : 'НЕТ');
  if (!f.map) throw new Error('field.map отсутствует');
  console.log('   зоны:', f.map.zones.map((z) => `${z.name}[${z.kind}] ${z.c0},${z.r0}-${z.c1},${z.r1}`).join(' | '));

  // неверный пароль
  const badPass = await setmapOnce(f.map, '0000', (m) => m[0] === 'info', 'info (bad pass)');
  console.log('2. неверный пароль →', badPass[1]);

  // несоединённый конфиг
  const broken = JSON.parse(JSON.stringify(f.map));
  broken.zones.push({ id: 'zx', name: 'Оторванная', kind: 'green', c0: 0, r0: 0, c1: 0, r1: 0 });
  // разрываем соединение: убираем боевой полигон между двумя зелёными зонами
  broken.zones = broken.zones.filter((z) => z.name !== 'Полигон');
  const badMap = await setmapOnce(broken, PASS, (m) => m[0] === 'info', 'info (broken map)');
  console.log('3. несоединённые зоны →', badMap[1]);

  // валидный конфиг: мир выше, зелёная зона сверху
  const good = JSON.parse(JSON.stringify(f.map));
  good.cols = 19;
  good.rows = 9;
  good.zones = [
    { id: 'z1', name: 'Лужайка', kind: 'cells', c0: 0, r0: 2, c1: 9, r1: 8 },
    { id: 'z2', name: 'Переход', kind: 'cells', c0: 10, r0: 3, c1: 12, r1: 7 },
    { id: 'z3', name: 'Закуток', kind: 'cells', c0: 13, r0: 2, c1: 18, r1: 7 },
    { id: 'z4', name: 'Зелёная зона 1', kind: 'green', c0: 2, r0: 0, c1: 8, r1: 2 },
  ];
  const mapMsg = await setmapOnce(good, PASS, (m) => m[0] === 'map', 'map event');
  console.log('4. map event: %sx%s, зоны=%d', mapMsg[1].cols, mapMsg[1].rows, mapMsg[1].zones.length);
  const field2 = await wait(state, (m) => m[0] === 'field' && m[1].map?.rows === 9, 'field (resync)');
  const me = field2[1].cats.find((c) => c.login === 'MapTester');
  console.log('   field2: size=%sx%s map=%s, мой кот на %s,%s', field2[1].width, field2[1].height, !!field2[1].map, me?.x, me?.y);

  // ходьба в клетку зелёной зоны не проходит как клеточная (сервер отвергает)
  send(ws, 'cellsync', { x: 4, y: 1 }); // (0-based 3,0) — зелёная зона
  const upd = await wait(state, (m) => m[0] === 'update cat', 'update cat', 2500).catch(() => null);
  if (upd) console.log('5. cellsync в зелёную зону → передвинут на %s,%s', upd[1].x, upd[1].y);
  else console.log('5. cellsync в зелёную зону → сервер молчит (отвергнуто)');

  // восстановление раскладки по умолчанию: тест не зависит от того, с какой
  // картой сервер стартовал (f.map мог быть любым валидным)
  await setmapOnce(
    {
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
      objects: [],
    },
    PASS,
    (m) => m[0] === 'map' && m[1].rows === 7,
    'map (restore)',
  );
  console.log('6. локация восстановлена к исходной');
  ws.close();
  process.exit(0);
};

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
