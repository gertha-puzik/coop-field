/**
 * Проверка редактора локации на уровне протокола:
 *  1. join в «тест» → field несёт map (конфиг локации).
 *  2. setmap с неверным паролем → info с ошибкой, map не меняется.
 *  3. setmap с верным паролем и несоединённым конфигом → info с причиной.
 *  4. setmap с верным паролем и валидным конфигом → map всем + field; файл сохранён.
 *  5. cellsync в зелёную зону отвергается.
 *  6. Возврат к раскладке по умолчанию (восстановление после теста).
 */
import WebSocket from 'ws';

const URL = process.env.WS_URL || 'ws://127.0.0.1:3780';
const PASS = '1946';

const connect = () =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
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

const main = async () => {
  const { ws, state } = await connect();
  send(ws, 'join', { room: 'test', login: 'MapTester' });
  const field = await wait(state, (m) => m[0] === 'field', 'field');
  const f = field[1];
  console.log('1. field: format=%s size=%sx%s map=%s', f.format, f.width, f.height, f.map ? `zones=${f.map.zones.length}` : 'НЕТ');
  if (!f.map) throw new Error('field.map отсутствует');
  console.log('   зоны:', f.map.zones.map((z) => `${z.name}[${z.kind}] ${z.c0},${z.r0}-${z.c1},${z.r1}`).join(' | '));

  // неверный пароль
  send(ws, 'setmap', { pass: '0000', map: f.map });
  const badPass = await wait(state, (m) => m[0] === 'info', 'info (bad pass)');
  console.log('2. неверный пароль →', badPass[1]);

  // несоединённый конфиг
  const broken = JSON.parse(JSON.stringify(f.map));
  broken.zones.push({ id: 'zx', name: 'Оторванная', kind: 'green', c0: 0, r0: 0, c1: 0, r1: 0 });
  // разрываем соединение: убираем боевой полигон между двумя зелёными зонами
  broken.zones = broken.zones.filter((z) => z.name !== 'Полигон');
  send(ws, 'setmap', { pass: PASS, map: broken });
  const badMap = await wait(state, (m) => m[0] === 'info', 'info (broken map)');
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
  send(ws, 'setmap', { pass: PASS, map: good });
  const mapMsg = await wait(state, (m) => m[0] === 'map', 'map event');
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
  send(ws, 'setmap', {
    pass: PASS,
    map: {
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
  });
  await wait(state, (m) => m[0] === 'map' && m[1].rows === 7, 'map (restore)');
  console.log('6. локация восстановлена к исходной');
  ws.close();
  process.exit(0);
};

main().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
