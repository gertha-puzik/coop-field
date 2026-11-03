#!/usr/bin/env node
/** Проверки правок 11.2025: гонка за клетку, блок-перевод урона, размер при спавне.
 *  События каждого сокета копятся одной «лентой» — пакеты, пришедшие в одном тике,
 *  не теряются (классическая ловушка с навешиванием listener'а после await). */
const WebSocket = require('ws');

const URL = 'ws://127.0.0.1:3780';
const room = `fixtest-${Date.now()}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HANG = setTimeout(() => { console.error('HANG'); process.exit(3); }, 20000);

function tape(ws) {
  const box = [];
  const waiters = [];
  ws.on('message', (raw) => {
    let m;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    const item = { ev: m[0], p: m[1] };
    box.push(item);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].ev === item.ev) {
        const w = waiters.splice(i, 1)[0];
        w.res(item.p);
      }
    }
  });
  return {
    box,
    /** Ждёт событие: пришедшее раньше — отдаёт сразу, будущее — по прибытии. */
    once(ev) {
      const hit = box.find((x) => x.ev === ev);
      if (hit) return Promise.resolve(hit.p);
      return new Promise((res) => waiters.push({ ev, res }));
    },
    all(ev) {
      return box.filter((x) => x.ev === ev);
    },
  };
}

async function joinCat(login, roomCode, extra = {}) {
  const ws = new WebSocket(URL);
  await new Promise((res) => ws.on('open', res));
  const t = tape(ws);
  ws.send(JSON.stringify(['join', { room: roomCode, login, sprite: 'izya', ...extra }]));
  const you = await t.once('you');
  await t.once('field');
  return { ws, t, you };
}

(async () => {
  // ---- 1. Размер при спавне: join с size=75 ----
  const a1 = await joinCat('Размерный', room, { size: 75 });
  if (a1.you.size !== 75) throw new Error(`you.size не 75: ${JSON.stringify(a1.you)}`);
  a1.ws.send(JSON.stringify(['move', { x: 1, y: 0 }]));
  await wait(300);
  const upd = a1.t.all('update cat').find((m) => m.p.id === a1.you.id);
  if (!upd || upd.p.size !== 75) throw new Error(`update cat без size: ${JSON.stringify(a1.t.all('update cat'))}`);
  console.log('ok: size 75 в you и update cat');
  a1.ws.close();

  // ---- 2. Гонка за клетку: оба идут в общую соседнюю ----
  const room2 = `${room}-race`;
  const g1 = await joinCat('Гонка1', room2);
  const g2 = await joinCat('Гонка2', room2);
  await wait(200);
  const c1 = { x: g1.you.x, y: g1.you.y };
  const c2 = { x: g2.you.x, y: g2.you.y };
  let target = null;
  for (let dx1 = -1; dx1 <= 1 && !target; dx1++) {
    for (let dy1 = -1; dy1 <= 1 && !target; dy1++) {
      if (!dx1 && !dy1) continue;
      const cand = { x: c1.x + dx1, y: c1.y + dy1 };
      if (cand.x < 1 || cand.x > 10 || cand.y < 1 || cand.y > 6) continue;
      if (cand.x === c2.x && cand.y === c2.y) continue;
      if (Math.abs(cand.x - c2.x) <= 1 && Math.abs(cand.y - c2.y) <= 1) target = cand;
    }
  }
  if (!target) throw new Error('нет общей соседней клетки');
  g1.ws.send(JSON.stringify(['move', { x: Math.sign(target.x - c1.x), y: Math.sign(target.y - c1.y) }]));
  g2.ws.send(JSON.stringify(['move', { x: Math.sign(target.x - c2.x), y: Math.sign(target.y - c2.y) }]));
  await wait(500);
  const pos = new Map();
  for (const m of [...g1.t.all('update cat'), ...g2.t.all('update cat')]) pos.set(m.p.id, { x: m.p.x, y: m.p.y });
  // Проигравший гонку отказа получает (refuse), а не update cat — он остаётся на своей клетке.
  const p1 = pos.get(g1.you.id) ?? c1;
  const p2 = pos.get(g2.you.id) ?? c2;
  if (!p1 || !p2) throw new Error(`нет позиций: ${JSON.stringify([...pos])}`);
  if (p1.x === p2.x && p1.y === p2.y) throw new Error('оба кота в одной клетке!');
  const won1 = p1.x === target.x && p1.y === target.y;
  const won2 = p2.x === target.x && p2.y === target.y;
  if (won1 === won2) throw new Error(`гонка не разрешилась однозначно: ${JSON.stringify({ p1, p2, target })}`);
  const loserPos = won1 ? p2 : p1;
  const loserCell = won1 ? c2 : c1;
  if (loserPos.x !== loserCell.x || loserPos.y !== loserCell.y) {
    throw new Error(`проигравший не на своей клетке: ${JSON.stringify(loserPos)} ≠ ${JSON.stringify(loserCell)}`);
  }
  console.log(`ok: гонка за клетку — победил один, второй остался на ${JSON.stringify(loserCell)}`);
  g1.ws.close();
  g2.ws.close();

  // ---- 3. Блок: strike с pawsDamage=2 по блокирующему ----
  const room3 = `${room}-block`;
  const s1 = await joinCat('Бьющий', room3);
  const s2 = await joinCat('Блокер', room3);
  await wait(200);
  const fights = s1.t.all('fight');
  for (let i = 0; i < 10; i++) {
    const dx = s1.you.x - s2.you.x;
    const dy = s1.you.y - s2.you.y;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) break;
    s2.ws.send(JSON.stringify(['move', { x: Math.sign(dx), y: Math.sign(dy) }]));
    await wait(140);
  }
  const dx = s1.you.x - s2.you.x;
  const dy = s1.you.y - s2.you.y;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) throw new Error('блокер не подтянулся');
  const angle = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
  s2.ws.send(JSON.stringify(['block', { on: true }]));
  await wait(120);
  s1.ws.send(JSON.stringify(['strike', { target: s2.you.id, zone: 'back', angle, damage: 10, pawsDamage: 2, flightMs: 100 }]));
  await wait(500);
  const f = s1.t.all('fight').find((m) => m.p.targetId === s2.you.id);
  if (!f) throw new Error(`fight не пришёл: лента=${JSON.stringify(s1.t.box.map((x) => x.ev))} / ${JSON.stringify(s1.t.box.filter((x) => x.ev !== 'update cat').map((x) => x.p))}`);
  if (f.p.zone !== 'paws') throw new Error(`зона не paws: ${JSON.stringify(f.p)}`);
  if (f.p.damage !== 2) throw new Error(`урон не 2 (ждём лаповый урон бьющего): ${JSON.stringify(f.p)}`);
  console.log('ok: блок переводит удар в Лапы с лаповым уроном 2 (не 10)');
  s1.ws.close();
  s2.ws.close();

  clearTimeout(HANG);
  console.log('ALL OK');
  process.exit(0);
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
