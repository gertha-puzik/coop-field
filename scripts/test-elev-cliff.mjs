/**
 * Регрессионный тест рельефа комнаты «тест» (локальный сервер).
 *
 * Проверяет правило возвышенностей: перепад больше 1 уровня между соседними
 * клетками — стенка для пешей ходьбы, с любой стороны (спереди, сзади, сбоку).
 * Плато здесь уровня 3, поэтому шаг на него не проходит, а прыжок (freemove
 * jp=1 в мирном режиме, событие jump с charge 1 в боевом) проходит.
 * Сервер и клиент считают перепады по одному конфигу (cliffBetween ↔
 * elevWalkBlocked, elevJumpOk), тест бьёт по серверу.
 *
 * Нюанс сервера: пакет прыжка (jp=1) открывает 2-секундное окно, внутри
 * которого freemove проходит свободно (дуга несёт кота через обрыв) — поэтому
 * стенки проверяются ДО прыжков и после выдержанной паузы.
 *
 * Флоу: join «test» → setmap с плато 2×2 (уровень 3, 0-based (11,12)..(12,13),
 * внутри боевой зоны карты) → мирная ходьба (freemove): шаг на плато спереди/
 * сзади/сбоку молча отклоняется, прыжок (jp=1) пропускает, ходьба по плато
 * и спуск прыжком работают → боевой шаг на плато получает REFUSE «cliff»,
 * боевой jump проходит. В конце карта возвращается к исходной (без elev).
 *
 * Использование: node scripts/test-elev-cliff.mjs [wsUrl]
 *   по умолчанию ws://127.0.0.1:3780 (локальный сервер; прод не трогаем).
 * Коды выхода: 0 — все проверки зелёные; 1 — отказ.
 */
import { WebSocket } from 'ws';
import { readFileSync } from 'node:fs';

const url = process.argv[2] || process.env.WS_URL || 'ws://127.0.0.1:3780';

/** Клиент с копилкой сообщений: события складываются, тесты их фильтруют. */
function client(login, room = 'test') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on('message', (raw) => {
      try {
        inbox.push(JSON.parse(String(raw)));
      } catch {
        /* мусорный кадр — не наш случай */
      }
    });
    ws.on('error', reject);
    ws.once('open', () => {
      ws.send(JSON.stringify(['join', { room, login }]));
      ws.inbox = inbox;
      resolve(ws);
    });
  });
}

function waitFor(ws, event, ms = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const hit = ws.inbox.find((m) => m[0] === event);
      if (hit) return resolve(hit);
      if (Date.now() - t0 > ms) return reject(new Error(`timeout: ${event}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Свежие сообщения с события event после отметки from (индекс в инбоксе). */
function fresh(ws, event, from) {
  return ws.inbox.slice(from).filter((m) => m[0] === event);
}

/** Ходьба с ожиданием и сбором результата: дошёл ли кот до (x, y). */
async function walk(observer, mover, moverId, from, x, y, jump = false) {
  const mark = observer.inbox.length;
  mover.send(JSON.stringify(['freemove', jump ? { x, y, jp: 1 } : { x, y }]));
  await sleep(jump ? 300 : 400);
  return fresh(observer, 'freemove', mark).some(
    (m) => m[1].id === moverId && Math.abs(m[1].x - x) < 0.01 && Math.abs(m[1].y - y) < 0.01,
  );
}

/** Самодостаточная карта: лужайка и полигон накрывают точки обхода,
 *  плато 2×2 уровня 3 в 0-based (11,12)..(12,13) лежит внутри полигона.
 *  Не читает data/test-map.json — тот файл локальный и может быть другой формы. */
function mapWithPlateau() {
  return {
    v: 2,
    cols: 20,
    rows: 18,
    margin: 0.5,
    seed: 'elev-cliff',
    zones: [
      { id: 'z1', name: 'Лужайка', kind: 'green', c0: 0, r0: 0, c1: 19, r1: 17 },
      { id: 'z2', name: 'Полигон', kind: 'cells', c0: 8, r0: 8, c1: 16, r1: 16 },
    ],
    objects: [{ id: 'o1', kind: 'entry', c: 7, r: 8, pos: 'center', dir: 'right' }],
    spawns: [{ c: 2, r: 2 }],
    elev: { '11,12': 3, '12,12': 3, '11,13': 3, '12,13': 3 },
  };
}

/** setmap от отдельного сокета (лимит — раз в 10 с НА сокет). */
async function uploadMap(map) {
  const admin = await client(`mapprobe${Date.now() % 10000}`);
  await waitFor(admin, 'you');
  admin.send(JSON.stringify(['setmap', { pass: process.env.MAP_PASS || '1946', map }]));
  await waitFor(admin, 'map');
  admin.close();
}

let failed = 0;
const ok = (name) => console.log(`ok: ${name}`);
const bad = (name) => {
  console.error(`ПРОВАЛ: ${name}`);
  failed++;
};

const original = JSON.parse(readFileSync('data/test-map.json', 'utf8'));
try {
  // 1. Карта с плато (свежий сокет — свой лимит setmap).
  await uploadMap(mapWithPlateau());

  // 2. Двое в комнате: mover ходит, observer смотрит широковещательные freemove.
  const mover = await client(`climber${Date.now() % 10000}`);
  const observer = await client(`watcher${Date.now() % 10000}`);
  await waitFor(mover, 'you');
  await waitFor(observer, 'you');
  const moverId = mover.inbox.find((m) => m[0] === 'you')[1].id;

  // 3. Легальная точка к югу от плато (0-based доли клетки), без прыжков.
  if (await walk(observer, mover, moverId, null, 11.5, 14.5)) ok('ходьба по земле дошла до плато');
  else bad('ходьба по земле до юга плато не дошла');

  // 4. Шаг СПЕРЕДИ на плато (южная стена, перепад 0→3) — молчаливый отказ.
  if (!(await walk(observer, mover, moverId, null, 11.5, 13.5))) ok('шаг спереди на плато остановлен (южная стенка)');
  else bad('игрок ПРОШЁЛ сквозь переднюю стену плато');

  // 5. Обход к восточной стороне и шаг СБОКУ — тоже стенка.
  if (!(await walk(observer, mover, moverId, null, 13.5, 14.5))) bad('ходьба восточнее плато заблокирована (не должна)');
  if (!(await walk(observer, mover, moverId, null, 13.5, 13.5))) bad('ходьба к восточной стене заблокирована (не должна)');
  if (!(await walk(observer, mover, moverId, null, 12.5, 13.5))) ok('шаг сбоку на плато остановлен');
  else bad('игрок ПРОШЁЛ сквозь боковую стену плато');

  // 6. Обход к северной стороне. Нарисованный верх уровня 3 начинается на y=11.48,
  // поэтому 11.3 — ещё трава, а 11.6 — уже спина плато (пешком нельзя).
  if (!(await walk(observer, mover, moverId, null, 13.5, 11.5))) bad('ходьба севернее плато заблокирована (не должна)');
  if (!(await walk(observer, mover, moverId, null, 11.5, 11.3))) bad('ходьба к задней стене заблокирована (не должна)');
  if (!(await walk(observer, mover, moverId, null, 11.5, 11.6))) ok('шаг сзади на плато остановлен');
  else bad('игрок ПРОШЁЛ сквозь заднюю стену плато');

  // 7. Прыжок (jp=1) на плато — проходит, ходьба ПО плато свободна,
  //    прыжок вниз — проходит.
  if (await walk(observer, mover, moverId, null, 11.5, 12.5, true)) ok('прыжок на плато прошёл');
  else bad('прыжок на плато не прошёл');
  if (await walk(observer, mover, moverId, null, 12.5, 12.5)) ok('ходьба по плато свободна');
  else bad('ходьба ПО плато заблокирована (не должна)');
  if (await walk(observer, mover, moverId, null, 12.5, 14.5, true)) ok('прыжок с плато вниз прошёл');
  else bad('прыжок с плато вниз не прошёл');

  // 8. Боевой режим: клеточный шаг на плато — REFUSE cliff; jump — проходит.
  //    move — ДЕЛЬТА {-1..1}: с (12,15) шаг на север это {x:0, y:-1} → (12,14).
  mover.send(JSON.stringify(['cellsync', { x: 12, y: 15 }]));
  await sleep(300);
  mover.send(JSON.stringify(['move', { x: 0, y: -1 }]));
  await sleep(300);
  const refused = mover.inbox.some((m) => m[0] === 'refuse' && m[1]?.code === 'cliff');
  if (refused) ok('боевой шаг на плато — отказ «cliff»');
  else bad('боевой шаг на плато не получил отказ cliff');
  mover.send(JSON.stringify(['jump', { x: 12, y: 14, charge: 1 }]));
  await sleep(300);
  const jumped = mover.inbox.some((m) => m[0] === 'update cat' && m[1]?.x === 12 && m[1]?.y === 14);
  if (jumped) ok('боевой jump на плато прошёл');
  else bad('боевой jump на плато не прошёл');

  mover.close();
  observer.close();
} finally {
  // 9. Возврат карты комнаты к исходной (свежий сокет — свой лимит).
  await uploadMap(original);
}

if (failed > 0) {
  console.error(`тест рельефа: ${failed} провал(ов)`);
  process.exit(1);
}
console.log('тест рельефа: зелёный — перепад больше 1 стенка, прыжок с полным зарядом проходит.');
