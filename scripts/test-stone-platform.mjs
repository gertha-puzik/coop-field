/**
 * Регрессионный тест «камень — платформа уровня 1» (серверный контракт).
 *
 * Проверяет зеркальное правило сервера (server/world.js testElev + buildCells):
 *  1. Клетка камня в боевой зоне ПРОХОДИМА: cellsync на неё ставит кота,
 *     шаг на неё и шаг с неё — обычные update cat (не refuse).
 *  2. Эффективный уровень клетки камня = 1: сосед с elev 2 — шагом (перепад 1),
 *     сосед с elev 3 — обрыв (перепад 2, нужен прыжок).
 *  3. Клетка ДЕРЕВА по-прежнему непроходима: cellsync на неё молчит.
 *  4. Мирный freemove на клетку камня принимается (тело камня не стена).
 *
 * Запуск: node scripts/test-stone-platform.mjs — сам поднимает server.js на
 * случайном порту с временным DATA_DIR. Внешний сервер: WS_URL=ws://…
 * Коды выхода: 0 — зелёный; 1 — отказ.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

// Мутации карт (кадр setmap) — за админ-гейтом (server/testmap.js, гейт как у
// adminGate в sprites.js): сохранение локации доступно только админам, пароля
// редактора больше не существует. setmap-загрузчики теста логинятся админом;
// аккаунт создаётся в DATA_DIR ДО старта сервера через scripts/make-admin.mjs
// (лестница S1, см. test-admin-reset). Негатив-гейт (не-админ) — outsider ниже.
const ADMIN_LOGIN = 'mapboss';
const ADMIN_PASS = 'password1';

const PORT = 3981 + Math.floor(Math.random() * 20);
const url = process.env.WS_URL || `ws://127.0.0.1:${PORT}`;

const DATA = mkdtempSync(path.join(tmpdir(), 'coop-stone-platform-'));
if (!process.env.WS_URL) {
  execFileSync(process.execPath, [
    path.resolve(new URL('..', import.meta.url).pathname, 'scripts/make-admin.mjs'),
    ADMIN_LOGIN,
    ADMIN_PASS,
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
        ADMIN_PASS: process.env.OPEN_EDITOR_TEST_PASS || '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
if (srv) {
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write(d));
  process.on('exit', () => srv.kill('SIGTERM'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSock() {
  const ws = new WebSocket(url);
  const state = { inbox: [], waiters: [], readIdx: 0 };
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    state.inbox.push(msg);
    while (state.waiters.length) state.waiters.shift()();
  });
  const next = () => state.inbox[state.readIdx++];
  const wait = (timeoutMs = 5000) =>
    state.readIdx < state.inbox.length ? Promise.resolve(next()) : new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting frame')), timeoutMs);
      const check = () => {
        if (state.readIdx < state.inbox.length) { clearTimeout(t); resolve(next()); }
      };
      state.waiters.push(check);
    });
  const send = (event, payload) => ws.send(JSON.stringify([event, payload]));
  const open = () => new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return { ws, next, wait, send, open, state };
}

/** Сокет в «тест»: register/login + join. asAdmin=true — вход подготовленным
 *  админом (setmap-загрузчики: мутации карт за админ-гейтом), иначе свежий
 *  зарегистрированный аккаунт. */
async function joinTest(prefix, asAdmin = false) {
  const s = makeSock();
  await s.open();
  await s.wait(); // handshake whoami
  s.send('auth', asAdmin
    ? { action: 'login', login: ADMIN_LOGIN, pass: ADMIN_PASS }
    : { action: 'register', login: `${prefix}${Math.random().toString(36).slice(2, 8)}`, pass: 'parol12345' });
  const reg = await s.wait();
  if (!reg[1]?.ok) throw new Error(`auth: ${JSON.stringify(reg)}`);
  s.send('join', { room: 'test' });
  let field = null;
  for (let i = 0; i < 8 && !field; i++) {
    const f = await s.wait();
    if (f[0] === 'field') field = f;
    if (f[0] === 'noplace') throw new Error(`join: ${JSON.stringify(f)}`);
  }
  if (!field) throw new Error('field не пришёл');
  return { s, field, role: reg[1].role };
}

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

await sleep(800);

// --- карта: боевой полигон по умолчанию + камень (12,3) 0-based, дерево (13,2), elev-соседи ---
const outsider = makeSock();
await outsider.open();
await outsider.wait();
outsider.send('setmap', {map:{}});
check('не-админ не может менять карту (админ-гейт)', (await outsider.wait())[1]?.includes('доступно только администраторам'));
outsider.ws.close();
const first = await joinTest('a', true);
check('карту правит только админ (роль аккаунта-редактора)', first.role === 'admin');
const map0 = first.field[1].map;
const edited = {
  ...map0,
  objects: [
    { id: 'o1', kind: 'stone', c: 12, r: 3, x: 12.5, y: 4, s: 1, spr: 'rock-6', pos: 'center' },
    { id: 'o2', kind: 'tree', c: 13, r: 2, x: 13.5, y: 3, s: 1, spr: 'tree-1', pos: 'center' },
  ],
  elev: { '11,3': 2, '12,2': 3 },
};
first.s.send('setmap', { map: edited });
let mapBack = null;
for (let i = 0; i < 6 && !mapBack; i++) {
  const f = await first.s.wait();
  if (f[0] === 'map') mapBack = f[1];
  if (f[0] === 'info') console.log('  [info]', f[1]);
}
check('setmap принял карту с камнем/деревом/высотами', !!mapBack);
check('сервер сохранил elev', JSON.stringify(mapBack?.elev ?? null) === JSON.stringify({ '11,3': 2, '12,2': 3 }));
first.s.send('setmap', {map:edited});
let limited;
do { limited=await first.s.wait(); } while(limited[0]!=='info');
check('повторное сохранение ограничено троттлингом', limited[1].includes('слишком часто'));
const invalid=await joinTest('b', true);
invalid.s.send('setmap',{map:{v:2}});
const invalidReply=await invalid.s.wait();
check('невалидная карта по-прежнему отвергается',invalidReply[0]==='info'&&invalidReply[1].startsWith('Редактор:'));
invalid.s.ws.close();
if (srv) check('высоты записаны в файл для следующего запуска', JSON.stringify(JSON.parse(readFileSync(path.join(DATA, 'test-map.json'), 'utf8')).elev) === JSON.stringify(edited.elev));

// --- 1. cellsync на клетку камня (1-based 13,4) ---
const A = first.s;
A.send('cellsync', { x: 13, y: 4 });
let cat = null;
for (let i = 0; i < 6 && !cat; i++) {
  const f = await A.wait();
  if (f[0] === 'update cat') cat = f[1];
}
check('cellsync на клетку камня принят (клетка проходима)', cat?.x === 13 && cat?.y === 4, `x=${cat?.x} y=${cat?.y}`);

// --- 2. шаг с камня на elev-2 соседа (1-based 12,4): перепад 1 → шаг ---
await sleep(120);
A.send('move', { x: -1, y: 0 });
let stepFrame = null;
for (let i = 0; i < 6 && !stepFrame; i++) {
  const f = await A.wait();
  if (f[0] === 'update cat' || f[0] === 'refuse') stepFrame = f;
}
check('шаг с камня на плато elev-2 (перепад 1) принят', stepFrame?.[0] === 'update cat' && stepFrame?.[1]?.x === 12, JSON.stringify(stepFrame?.[1] ?? stepFrame?.[0]));

// --- 3. шаг обратно на камень: перепад 1 вниз → шаг ---
await sleep(120);
A.send('move', { x: 1, y: 0 });
stepFrame = null;
for (let i = 0; i < 6 && !stepFrame; i++) {
  const f = await A.wait();
  if (f[0] === 'update cat' || f[0] === 'refuse') stepFrame = f;
}
check('шаг обратно на камень (перепад 1 вниз) принят', stepFrame?.[0] === 'update cat' && stepFrame?.[1]?.x === 13, JSON.stringify(stepFrame?.[1] ?? stepFrame?.[0]));

// --- 4. шаг на elev-3 соседа (1-based 13,3): перепад 2 → refuse cliff ---
await sleep(120);
A.send('move', { x: 0, y: -1 });
stepFrame = null;
for (let i = 0; i < 6 && !stepFrame; i++) {
  const f = await A.wait();
  if (f[0] === 'update cat' || f[0] === 'refuse') stepFrame = f;
}
check('шаг на плато elev-3 (перепад 2) — refuse cliff', stepFrame?.[0] === 'refuse' && stepFrame?.[1]?.code === 'cliff', JSON.stringify(stepFrame?.[1] ?? stepFrame?.[0]));

// --- 5. дерево по-прежнему стена: cellsync на его клетку (1-based 14,3) молчит ---
A.send('cellsync', { x: 14, y: 3 });
let treeBlocked = true;
try {
  for (let i = 0; i < 6 && treeBlocked; i++) {
    const f = await A.wait(900);
    if (f[0] === 'update cat' && f[1]?.x === 14 && f[1]?.y === 3) treeBlocked = false;
  }
} catch {
  /* таймаут = кадра нет = молчание */
}
check('cellsync на клетку дерева молчит (дерево — стена)', treeBlocked);

// --- 6. мирный freemove на клетку камня принимается (наблюдатель видит кадр) ---
const B = (await joinTest('b')).s;
await sleep(100);
A.send('freemove', { x: 12.5, y: 3.9, stop: true });
let fm = null;
for (let i = 0; i < 8 && !fm; i++) {
  const f = await B.wait(1500);
  if (f[0] === 'freemove') fm = f[1];
}
check('freemove на клетку камня принят и разослан', !!fm && fm.x === 12.5 && fm.y === 3.9, JSON.stringify(fm ?? null));

console.log(failures === 0 ? '\nstone-platform: все проверки зелёные.' : `\nstone-platform: ПРОВАЛОВ — ${failures}`);
process.exit(failures === 0 ? 0 : 1);
