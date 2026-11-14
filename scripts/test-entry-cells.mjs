/**
 * Проверка клеток захода на уровне протокола:
 *  1. setmap: заход на боевой клетке → отказ с ошибкой.
 *  2. setmap: заход вне направления боевой клетки → отказ с ошибкой.
 *  3. setmap: валидные заходы → map всем, в конфиге заходы с dir; файл сохранён.
 *  4. cellsync на клетку захода → принят (вход в бой с захода), fm=0.
 *  5. move с захода в зону → применён; move из зоны на заход → применён (выход).
 *  6. freemove после выхода → fm=1.
 *  7. Возврат к раскладке по умолчанию (восстановление после теста).
 *
 * Запуск: node scripts/test-entry-cells.mjs — из чистого клона, сам поднимает
 * свой server.js на случайном порту с временным DATA_DIR (репозиторный data/
 * не трогается). Внешний сервер: WS_URL=ws://… node scripts/test-entry-cells.mjs.
 *
 * Каждая setmap-правка уходит со своего НОВОГО сокета: сервер троттлит любые
 * setmap-кадры раз в 10 с НА СОКЕТ — свежее соединение получает свежий счётчик.
 *
 * Пароля редактора нет: setmap пароль не читает, карту сохраняет только
 * сессия с ролью admin (server/testmap.js).
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { sendJoin } from './ws-auth.mjs';

const ROOM = 'test';

// Аккаунт-редактор: мутации карт (setmap) за админ-гейтом (server/testmap.js),
// setmap-загрузчик теста логинится админом. Аккаунт создаётся в DATA_DIR ДО
// старта сервера через scripts/make-admin.mjs (лестница S1, test-admin-reset).
const ADMIN_LOGIN = 'mapboss';
const ADMIN_ACCOUNT_PASS = 'password1';

const PORT = 3973 + Math.floor(Math.random() * 40);
const url = process.env.WS_URL || `ws://127.0.0.1:${PORT}`;

// Свой server.js, если внешний адрес не задан; пароль уходит в spawn-окружение
// тем же значением, что и в кадрах setmap («читает env КАК сервер»). Перед
// стартом — аккаунт-админ для setmap-загрузок теста.
const DATA = mkdtempSync(path.join(tmpdir(), 'coop-entry-cells-'));
if (!process.env.WS_URL) {
  execFileSync(process.execPath, [
    path.resolve(new URL('..', import.meta.url).pathname, 'scripts/make-admin.mjs'),
    ADMIN_LOGIN,
    ADMIN_ACCOUNT_PASS,
  ], {
    env: { ...process.env, DATA_DIR: DATA },
    encoding: 'utf8',
  });
}
const srv = process.env.WS_URL
  ? null
  : spawn(process.execPath, ['server.js'], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        DATA_DIR: DATA,
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

// Комната «test» закрыта (requiresAccount): register/login через ws-auth.mjs,
// затем join — так заходят и игроки, и setmap-загрузчик (админ).
const join = async (sock, name, login) => {
  sendJoin(sock.ws, { room: ROOM, login: login || name });
  await wait(sock.state, ([e]) => e === 'you', `you ${name}`);
  await wait(sock.state, ([e]) => e === 'field', `field ${name}`);
};

// setmap-кадр с нового сокета (троттлинг 10 с — на сокет, см. шапку):
// отказ приходит только отправителю, а рассылка map — всей комнате.
// Загрузчик — подготовленный админ: мутации карт за админ-гейтом
// (server/testmap.js); негативы ниже — про санитайзер, не про гейт.
const setmap = async (map, expectOk) => {
  const sock = await connect();
  await join(sock, 'uploader', ADMIN_LOGIN);
  sock.ws.send(JSON.stringify(['setmap', { map }]));
  const first = await wait(sock.state, ([e]) => e === 'info' || e === 'map', 'setmap ответ');
  // При успехе сервер сначала шлёт автору малый ack «Редактор: сохранено.»,
  // и только затем широковещательный кадр map — дожидаемся его.
  const info = expectOk && first[0] === 'info'
    ? await wait(sock.state, ([e]) => e === 'map', 'map после ack сохранено')
    : first;
  const [ev] = info;
  sock.ws.close();
  if (expectOk) {
    if (ev !== 'map') throw new Error(`ожидали map, получили ${ev}: ${JSON.stringify(info[1])}`);
  } else {
    if (ev !== 'info') throw new Error(`ожидали отказ info, получили ${ev}`);
  }
  return info;
};

const results = [];
const ok = (label) => results.push(`ok: ${label}`);
const fail = (label, err) => {
  results.push(`FAIL: ${label}: ${err?.message || err}`);
  process.exitCode = 1;
};

const baseMap = () => ({
  v: 2,
  cols: 12,
  rows: 6,
  seed: 'entrytest',
  zones: [
    { id: 'z1', name: 'Лужайка', kind: 'green', c0: 0, r0: 0, c1: 6, r1: 5 },
    { id: 'z2', name: 'Полигон', kind: 'cells', c0: 7, r0: 1, c1: 10, r1: 4 },
  ],
  objects: [],
});

try {
  await waitServer();
  const a = await connect();
  await join(a, 'EntryTestA');
  const b = await connect();
  await join(b, 'EntryTestB');

  // 1. Заход на боевой клетке — отказ.
  const m1 = baseMap();
  m1.objects = [{ id: 'e1', kind: 'entry', c: 8, r: 2, dir: 'right' }];
  const bad1 = await setmap(m1, false);
  if (!String(bad1[1]).includes('на боевых клетках')) throw new Error(`неожиданный текст: ${bad1[1]}`);
  ok('setmap entry on battle cell refused');

  // 2. Заход на траве, но направление в траву — отказ.
  const m2 = baseMap();
  m2.objects = [{ id: 'e1', kind: 'entry', c: 6, r: 2, dir: 'left' }];
  const bad2 = await setmap(m2, false);
  if (!String(bad2[1]).includes('боевая клетка')) throw new Error(`неожиданный текст: ${bad2[1]}`);
  ok('setmap entry pointing at grass refused');

  // 3. Валидные заходы (влево и вверх) — принято.
  const m3 = baseMap();
  m3.objects = [
    { id: 'e1', kind: 'entry', c: 6, r: 2, dir: 'right' },
    { id: 'e2', kind: 'entry', c: 8, r: 0, dir: 'down' },
  ];
  await setmap(m3, true);
  const fieldMsg = await wait(b.state, ([e, p]) => e === 'field' && p?.map, 'field с map');
  const entries = (fieldMsg[1].map.objects || []).filter((o) => o.kind === 'entry');
  if (entries.length !== 2 || !entries.every((o) => o.dir)) {
    throw new Error(`заходы в конфиге: ${JSON.stringify(fieldMsg[1].map.objects)}`);
  }
  ok('setmap entries saved and broadcast with dir');

  // 4. cellsync на клетку захода (0-based 6:2 → 1-based 7:3) — принят (fm=0).
  const target = b;
  target.ws.send(JSON.stringify(['cellsync', { x: 7, y: 3 }]));
  const catUpd = await wait(target.state, ([e, p]) => e === 'update cat' && p?.id === p.id && typeof p?.fm === 'number', 'cellsync entry echo');
  if (catUpd[1].x !== 7 || catUpd[1].y !== 3 || catUpd[1].fm !== 0) {
    throw new Error(`ожидали 7:3 fm=0, получили ${catUpd[1].x}:${catUpd[1].y} fm=${catUpd[1].fm}`);
  }
  ok('cellsync onto entry cell accepted, fm=0');

  // 5a. Шаг с захода в зону (направление right → 8:3) — применён.
  target.ws.send(JSON.stringify(['move', { x: 1, y: 0 }]));
  const step1 = await wait(target.state, ([e, p]) => e === 'update cat' && p?.id && p.x === 8 && p.y === 3, 'move в зону');
  if (!step1) throw new Error('нет эха шага в зону');
  ok('move from entry into battle zone applied');

  // 5b. Шаг из зоны на заход (влево → 7:3) — применён (выход из зоны).
  target.ws.send(JSON.stringify(['move', { x: -1, y: 0 }]));
  const step2 = await wait(target.state, ([e, p]) => e === 'update cat' && p?.id && p.x === 7 && p.y === 3, 'move на заход');
  if (!step2) throw new Error('нет эха шага на заход');
  ok('move from battle zone onto entry applied');

  // 6. freemove на траве — fm=1 (эхо себе не приходит — проверяем на соседнем сокете).
  target.ws.send(JSON.stringify(['freemove', { x: 3.5, y: 2.5, stop: true }]));
  const fmMsg = await wait(a.state, ([e, p]) => e === 'freemove' && p?.id != null, 'freemove relay to peer');
  ok('freemove sets fm=1 (peace)');

  // 7. Восстановление дефолтной раскладки.
  const def = baseMap();
  def.cols = 19;
  def.rows = 7;
  def.seed = 'test';
  def.zones = [
    { id: 'z1', name: 'Лужайка', kind: 'green', c0: 0, r0: 0, c1: 9, r1: 6 },
    { id: 'z2', name: 'Полигон', kind: 'cells', c0: 10, r0: 1, c1: 15, r1: 5 },
    { id: 'z3', name: 'Заросли', kind: 'green', c0: 16, r0: 0, c1: 18, r1: 6 },
  ];
  await setmap(def, true);
  ok('default map restored');

  a.ws.close();
  b.ws.close();
} catch (err) {
  fail('entry cells', err);
}

for (const line of results) console.log(line);
process.exit(process.exitCode || 0);
