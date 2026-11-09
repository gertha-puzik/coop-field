/**
 * Movement domain (W4 carve, behavior-preserving): cell steps with the
 * 80 ms × 3 queue, refuse codes (edge/cell_busy/cliff) for the client
 * predictor, and the «test»-room free movement: freemove (peace walk, point-in
 * -polygon clamp, ≤1/50 ms), cellsync (battle entry, ≤6-cell ring search)
 * and the 8-direction 1–3-cell jump over cliffs (≥450 ms cooldown).
 * Step allows elevation delta ≤1; jump charge (payload.charge, 0..1)
 * clears +2 at half, +3 and drops of 4+ at full, and never climbs 4+.
 * Every step still gets exactly one response — echo or refuse (see AGENTS.md
 * invariants). Cooldowns and geometry constants come from ./protocol.js (W3).
 */
import {
  EV, MOVE_COOLDOWN_MS, MOVE_QUEUE_MAX, JUMP_COOLDOWN_MS, JUMP_MAX_CELLS, ELEV_STEP_MAX,
} from "./protocol.js";
import { WIDTH, HEIGHT } from "./config.js";
import { send, broadcast, occupied, publicCat } from "./room.js";
import { normalizeDeg, clearAimTimer } from "./combat.js";
import { rememberCat } from "./persist.js";
import { TEST_WIDTH, TEST_HEIGHT } from "./testmap.js";
import { testWalkable, testEntryCell, cliffBetween, terrainLevelAt, terrainPointLevelAt, terrainBodyOverlap, elevJumpOk, testElev, nearestTestCell, testPointInIsland } from "./world.js";

function move(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, EV.INFO, "Сначала зайдите в комнату.");
    return;
  }
  const step = parseMove(payload);
  if (!step) return;
  const now = Date.now();
  if (now - cat.lastMove < MOVE_COOLDOWN_MS) {
    // Раньше такой шаг глотался молча: клиент уже нарисовал его, эха нет —
    // предикт расходился с сервером и следующий эхо откатывал кота на клетку
    // назад (телепорт). Теперь шаг встаёт в короткую очередь и обязательно
    // выполняется или честно отказывается.
    queueMove(ws, cat, payload);
    return;
  }
  applyMove(ws, cat, payload);
}

/** Нормализация хода: {-1..1, -1..1}, не (0,0), числа конечны. */
function parseMove(payload = {}) {
  let dx = Number(payload.x);
  let dy = Number(payload.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  dx = Math.max(-1, Math.min(1, Math.trunc(dx)));
  dy = Math.max(-1, Math.min(1, Math.trunc(dy)));
  if (dx === 0 && dy === 0) return null;
  return { dx, dy };
}

function applyMove(ws, cat, payload) {
  const room = ws.room;
  if (!room || room.sockets.get(ws) !== cat) return;
  const step = parseMove(payload);
  if (!step) return;
  const now = Date.now();
  const nx = cat.x + step.dx;
  const ny = cat.y + step.dy;
  const inBounds =
    room.fmt === 'test'
      ? testWalkable(nx, ny) || !!testEntryCell(nx - 1, ny - 1)
      : nx >= 1 && nx <= WIDTH && ny >= 1 && ny <= HEIGHT;
  if (!inBounds) {
    send(ws, EV.INFO, room.fmt === 'test' ? "Край локации." : "Край поля.");
    // refuse — тот же отказ, но с кодом: клиент откатывает предикт по коду,
    // а не по подстроке русского текста (текст менять можно свободно).
    send(ws, EV.REFUSE, { code: "edge", text: "Край поля." });
    return;
  }
  if (occupied(room, nx, ny, cat.id)) {
    send(ws, EV.INFO, "Клетка занята.");
    send(ws, EV.REFUSE, { code: "cell_busy", text: "Клетка занята." });
    return;
  }
  // Обрыв: в «тесте» перепад больше одного уровня шагом не проходится — нужен прыжок.
  if (room.fmt === 'test' && cliffBetween(cat.x, cat.y, nx, ny)) {
    send(ws, EV.INFO, "Обрыв — удержите Пробел и допрыгните.");
    send(ws, EV.REFUSE, { code: "cliff", text: "Обрыв — удержите Пробел и допрыгните." });
    return;
  }

  cat.x = nx;
  cat.y = ny;
  // Стрела живёт отдельно от шага: без deg в пакете оставляем последний угол,
  // а не разворачиваем её по направлению клетки.
  const sentDeg = normalizeDeg(payload.deg ?? payload.angle);
  if (sentDeg != null) cat.deg = sentDeg;
  clearAimTimer(cat);
  cat.aimDirty = false;
  cat.lastAim = now;
  cat.lastMove = now;
  const patch = publicCat(cat, room);
  // Шагнувшему — одно эхо. Второй экземпляр той же клетки (broadcast без except)
  // клиент читал как отказ предикта: спрайт шагал назад и следующим кадром
  // перепрыгивал клетку.
  send(ws, EV.UPDATE_CAT, patch);
  broadcast(room, EV.UPDATE_CAT, patch, ws);
}

function clearMoveTimer(cat) {
  if (!cat?.moveTimer) return;
  clearTimeout(cat.moveTimer);
  cat.moveTimer = null;
}

/** Разогнать очередь шагов: каждый — в момент снятия кулдауна. */
function pumpMoveQueue(ws, cat) {
  if (cat.moveTimer) return;
  const wait = MOVE_COOLDOWN_MS - (Date.now() - cat.lastMove);
  cat.moveTimer = setTimeout(() => {
    cat.moveTimer = null;
    const room = ws.room;
    if (!room || room.sockets.get(ws) !== cat) return;
    const next = cat.moveQueue.shift();
    if (next === undefined) return;
    applyMove(ws, cat, next);
    if (cat.moveQueue.length > 0) pumpMoveQueue(ws, cat);
  }, Math.max(0, wait));
}

/** Шаг раньше кулдауна: в очередь, а не в мусорку. */
function queueMove(ws, cat, payload) {
  if (cat.moveQueue.length >= MOVE_QUEUE_MAX) {
    // Залп длиннее очереди — честный отказ, клиент откатит предикт.
    send(ws, EV.INFO, "Слишком быстро.");
    send(ws, EV.REFUSE, { code: "cooldown", text: "Слишком быстро." });
    return;
  }
  cat.moveQueue.push(payload);
  pumpMoveQueue(ws, cat);
}

/** Темп рассылки свободных позиций: чаще — спам, реже — рваное движение у соседей. */
const FREE_MOVE_GAP_MS = 50;

/**
 * Свободная ходьба в мирном режиме комнаты «тест». Клиент → ["freemove", { x, y, stop?, sp? }]
 * — позиция в клеточных долях мира (уже зажатая кромкой локации). Сервер перепроверяет
 * (конечные числа, запас за кромку), обновляет логическую клетку кота (ближайшая
 * проходимая — для ударов и препятствий) и раз в FREE_MOVE_GAP_MS рассылает остальным
 * ["freemove", { id, x, y, cx, cy, sp }]. stop=true — финальная позиция остановки, уходит без темпа.
 * sp=1 — кот спринтит (Shift): чужие клиенты рисуют комочки земли/травы из-под лап.
 */
function freeMove(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat || room.fmt !== 'test') return;
  const x = Number(payload.x);
  const y = Number(payload.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  const nx = Math.min(TEST_WIDTH + 1.2, Math.max(-1.2, x));
  const ny = Math.min(TEST_HEIGHT + 1.2, Math.max(-1.2, y));
  // Точка обязана лежать на локации: клиент зажимает ходьбу нарисованной кромкой
  // по лапам. Угол спрайта (то, что приходит в пакете) у кромки и у малышей
  // торчит за полигон, хотя лапы стоят на траве — достаточно, чтобы внутри
  // была хотя бы одна из трёх точек (угол, середина, лапы).
  const onIsland = testPointInIsland;
  if (!onIsland(nx, ny) && !onIsland(nx + 0.45, ny + 0.45) && !onIsland(nx + 0.45, ny + 0.95)) return;
  // Обрыв в свободной ходьбе: перепад больше одного уровня пешком не
  // проходится (зеркало клиентского elevWalkBlocked). Пакет прыжка (jp=1 во
  // время дуги) открывает окно — дуга несёт кота через обрыв, и финальные
  // пакеты посадки идут сразу за ним: они проходят, пока окно не закрылось.
  // Новый клиент передаёт смещение лап от верхнего левого угла спрайта.
  // Старые клиенты без foot сохраняют прежнюю нулевую опору. Это не экранный lift.
  const rawFoot = payload.foot;
  const foot = rawFoot && Number.isFinite(rawFoot.dx) && Number.isFinite(rawFoot.dy)
    && rawFoot.dx >= 0 && rawFoot.dx <= 4 && rawFoot.dy >= 0 && rawFoot.dy <= 2
    ? rawFoot : (cat.freeFoot || {dx:0,dy:0});
  const rx = Number.isFinite(foot.rx) ? Math.min(1,Math.max(0,foot.rx)) : 0;
  const ry = Number.isFinite(foot.ry) ? Math.min(1,Math.max(0,foot.ry)) : 0;
  const previousFoot = cat.freeFoot || foot;
  const nowGuard = Date.now();
  const jumping = payload.jp === 1 || payload.jp === true;
  if (jumping) {
    cat.freeJumpUntil = nowGuard + 2000;
  } else if (nowGuard >= (cat.freeJumpUntil || 0)) {
    const fromX = Number.isFinite(cat.fx) ? cat.fx : cat.x - 1;
    const fromY = Number.isFinite(cat.fy) ? cat.fy : cat.y - 1;
    const x0 = fromX+previousFoot.dx, y0 = fromY+previousFoot.dy;
    const x1 = nx+foot.dx, y1 = ny+foot.dy;
    const levelAt = terrainLevelAt;
    const level = terrainPointLevelAt(x0,y0);
    if (Math.abs(terrainPointLevelAt(x1,y1)-level) > ELEV_STEP_MAX) return;
    const before = terrainBodyOverlap(x0,y0,rx,ry,level,levelAt);
    const after = terrainBodyOverlap(x1,y1,rx,ry,level,levelAt);
    if (after > Math.max(1e-7,before+1e-7)) return;
  }
  cat.freeFoot = {dx:foot.dx,dy:foot.dy,rx,ry};
  cat.fm = 1;
  cat.fx = nx; // Не округляем угол спрайта: округление могло перенести лапы через край.
  cat.fy = ny;
  cat.fsp = payload.stop ? 0 : payload.sp === 1 || payload.sp === true ? 1 : 0;
  cat.jp = payload.jp === 1 || payload.jp === true ? 1 : 0;
  const cell = nearestTestCell(cat.fx, cat.fy);
  if (cell) {
    cat.x = cell.x;
    cat.y = cell.y;
  }
  const now = Date.now();
  rememberCat(cat); // позиция в книге (на диск — общим сливом, не чаще 3 с)
  if (!payload.stop && now - (cat.lastFree || 0) < FREE_MOVE_GAP_MS) return;
  cat.lastFree = now;
  broadcast(room, EV.FREEMOVE, { id: cat.id, x: cat.fx, y: cat.fy, cx: cat.x, cy: cat.y, sp: cat.fsp ? 1 : 0, jp: cat.jp ? 1 : 0 }, ws);
}

/**
 * Возврат в клеточный бой комнаты «тест»: клиент щёлкает на ближайшую проходимую
 * клетку и шлёт ["cellsync", { x, y }] (1-based). Сервер проверяет зону, при занятой
 * клетке ищет свободную рядом, запоминает режим fm=0 и рассылает publicCat всей
 * комнате (и самому отправителю — его onCat синхронизирует клетку).
 */
function cellsync(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat || room.fmt !== 'test') return;
  const x = Math.round(Number(payload.x));
  const y = Math.round(Number(payload.y));
  // Проходимая боевая клетка или клетка захода: в бой входят с захода (кнопкой),
  // и сервер обязан принять его клетку — иначе чужие не увидят смену режима (fm).
  if (!Number.isInteger(x) || !Number.isInteger(y) || (!testWalkable(x, y) && !testEntryCell(x - 1, y - 1))) return;
  if (occupied(room, x, y, cat.id)) {
    outer: for (let rad = 1; rad <= 6; rad++) {
      for (let dr = -rad; dr <= rad; dr++) {
        for (let dc = -rad; dc <= rad; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          const nx = x + dc;
          const ny = y + dr;
          if (testWalkable(nx, ny) && !occupied(room, nx, ny, cat.id)) {
            cat.x = nx;
            cat.y = ny;
            break outer;
          }
        }
      }
    }
  } else {
    cat.x = x;
    cat.y = y;
  }
  cat.fm = 0;
  rememberCat(cat);
  broadcast(room, EV.UPDATE_CAT, publicCat(cat, room));
}


/**
 * Прыжок через обрыв (боевой режим «теста»). Клиент → ["jump", { x, y, charge? }]
 * (1-based клетка назначения — по прямой вдоль 8 направлений на 1..3 клетки).
 * charge — доля шкалы прыжка 0..1 (удержание Пробела / 4 с). Сервер проверяет:
 * дальность и прямизну, проходимость, занятость, перепад (elevJumpOk) и кулдаун.
 * Промежуточные клетки могут быть непроходимы или выше — в этом смысл прыжка.
 * Успех: cat.lastJump/lastMove обновляются, publicCat уходит ВСЕМ
 * (и самому прыгнувшему — его onCat подтвердит предикт).
 */
/** Доля шкалы прыжка 0..1 из кадра jump. Нет числа — тап (0). */
function jumpFill(payload) {
  const n = Number(payload && payload.charge);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function jump(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat || room.fmt !== 'test') return;
  const x = Math.round(Number(payload.x));
  const y = Math.round(Number(payload.y));
  if (!Number.isInteger(x) || !Number.isInteger(y)) return;
  const now = Date.now();
  if (now - (cat.lastJump || 0) < JUMP_COOLDOWN_MS) return;
  const dx = x - cat.x;
  const dy = y - cat.y;
  // Прямая вдоль одного из 8 направлений: одна из осей 0, длины равны либо одна 0.
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const dist = Math.max(ax, ay);
  const straight = (dx === 0 || dy === 0 || ax === ay) && (ax === 0 || ay === 0 || ax === ay);
  if (!straight || dist < 1 || dist > JUMP_MAX_CELLS) return;
  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  // Все клетки прямой обязаны быть в границах мира (промежуточные могут быть
  // заняты/непроходимы — через них перелетаем, но за мир не выходим).
  for (let i = 1; i <= dist; i++) {
    const cx = cat.x + sx * i;
    const cy = cat.y + sy * i;
    if (cx < 1 || cy < 1 || cx > TEST_WIDTH || cy > TEST_HEIGHT) return;
  }
  if (!testWalkable(x, y) && !testEntryCell(x - 1, y - 1)) return;
  if (occupied(room, x, y, cat.id)) return;
  // Клетка захода перепадом не считается — как cliffBetween и клиентский прыжок.
  const entryHop = testEntryCell(cat.x - 1, cat.y - 1) || testEntryCell(x - 1, y - 1);
  if (!entryHop && !elevJumpOk(testElev(cat.x, cat.y), testElev(x, y), jumpFill(payload))) return;
  cat.lastJump = now;
  cat.lastMove = now; // шаг сразу после приземления не должен уходить в очередь
  cat.x = x;
  cat.y = y;
  const sentDeg = normalizeDeg(payload.deg ?? payload.angle);
  if (sentDeg != null) cat.deg = sentDeg;
  clearAimTimer(cat);
  cat.aimDirty = false;
  cat.lastAim = now;
  rememberCat(cat);
  const patch = publicCat(cat, room);
  send(ws, EV.UPDATE_CAT, patch);
  broadcast(room, EV.UPDATE_CAT, patch, ws);
}

export { move, parseMove, clearMoveTimer, freeMove, cellsync, jump };
