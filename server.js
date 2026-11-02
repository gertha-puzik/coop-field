import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 3780;
// На VPS порт задаёт systemd-юнит: Environment=PORT=8787 (образец — deploy/vps/coop-field.service).
// Локальный запуск без переменных слушает 3780 — на него настроен клиент разработки.
/** 1 = требовать заголовок Origin (не-браузерные клиенты без Origin не пускаются).
 *  По умолчанию 0: скрипты тестов (scripts/test-ws.mjs) подключаются без Origin. */
const REQUIRE_ORIGIN = process.env.REQUIRE_ORIGIN === "1";
const WS_HOSTNAME = "coop.89-232-184-77.sslip.io";
const FRONT_HOSTNAME = "abnocw.89-232-184-77.sslip.io";
const DEFAULT_ORIGINS = [
  "http://localhost:3780",
  "http://127.0.0.1:3780",
  `https://${WS_HOSTNAME}`,
  `https://${FRONT_HOSTNAME}`,
];

function allowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function isAllowedOrigin(origin) {
  if (!origin) return !REQUIRE_ORIGIN;
  if (allowedOrigins().has(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
    return protocol === "https:" && /^coop-field(-[a-z0-9-]+)?\.vercel\.app$/.test(hostname);
  } catch {
    return false;
  }
}
const WIDTH = 10;
const HEIGHT = 6;
/** Потолок комнаты. Клеток на поле 60, но в одну комнату пускаем не больше этого числа. */
const MAX_PLAYERS = 30;
/** Кулдаун шага на сервере. Ходы, пришедшие раньше, не теряются — встают
 *  в очередь MOVE_QUEUE_MAX и применяются ровно в момент снятия кулдауна. */
const MOVE_COOLDOWN_MS = 80;
/** Глубина очереди шагов: залипшая клавиша не должна превращаться в длинный буфер. */
const MOVE_QUEUE_MAX = 3;
/** Кулдаун на повторный join: самое дорогое событие (снимок field всей комнате). */
const JOIN_COOLDOWN_MS = 1000;
/** Пауза между ping-ами. Браузер отвечает pong сам, клиентский код не нужен. */
const HEARTBEAT_MS = 30_000;
/** Потолок входящего кадра: протокол состоит из коротких JSON-строк,
 *  дефолтные 100 МиБ библиотеки ws здесь только помогали расходу памяти. */
const MAX_PAYLOAD = 4 * 1024;
/**
 * Короткий предохранитель от пачки aim подряд. Угол в cat.deg пишется сразу.
 * Если с прошлой рассылки прошло больше этого — пакет уходит сразу.
 * Более плотный залп не копится в очереди: остаётся последний угол и уходит
 * по короткому таймеру, так что свежий угол не застревает.
 * 20 мс — не сглаживание картинки (его делает клиент), а только отсечка всплеска.
 */
const AIM_MIN_GAP_MS = 20;
/** Нижняя граница отклика удара в симе — 30 мс. Кулдаун чуть ниже, чтобы легитимный удар не отбрасывался. */
const STRIKE_COOLDOWN_MS = 25;
/** Одно сообщение комнате. Длиннее обрезается, чаще этого интервала — отказ. */
const CHAT_MAX_LEN = 200;
const CHAT_COOLDOWN_MS = 450;
const CHAT_HISTORY = 40;
/**
 * Зоны abnocw (id → подпись и урон при пресете 0,0). Совпадает с DEFAULT_SETTINGS.combat.zones.
 * Когтей и зубов нет: weapon в логе пустой.
 */
const STRIKE_ZONES = {
  tail: { part: "Хвост", damage: 2 },
  paws: { part: "Лапы", damage: 6 },
  back: { part: "Спина", damage: 12 },
  muzzle: { part: "Морда", damage: 18 },
  belly: { part: "Живот", damage: 25 },
  neck: { part: "Шея", damage: 30 },
  throat: { part: "Горло", damage: 42 },
};
const SPAWNS = [
  [4, 3],
  [5, 3],
  [3, 4],
  [6, 3],
  [4, 4],
  [5, 4],
  [2, 3],
  [7, 3],
];
const PALETTE = ["#d85e90", "#4b8fd0", "#e6b84d", "#73a13a", "#bf5af2", "#2dd4bf", "#ff9f0a", "#64d2ff"];
const NAMES = ["Сырь", "Пухляшик", "Травожуй"];
const SPRITES = ["blestyashka", "puhlyashik", "puzatik", "razdora", "pohititel", "syrstyashka", "ryzhiy", "trehcvetny", "serebristyy", "evr", "drel", "maslina", "buran", "sumrak"];
/**
 * Манекен «ПОЧУХАТЬ»: общий предмет комнаты, не персонаж. Не в боевом режиме,
 * но клетка под ним непроходима. Позиция в клеточных долях (x — по ширине,
 * y — по высоте, 0 — левый верх спрайта). Тащить может любой игрок; когда кто-то
 * держит манекен, комната видит курсор с его именем.
 */
const DUMMY_DEFAULT = { x: 7, y: 2, sprite: "puhlyashik" };
/**
 * Боевая мишень «РАБ»: общий предмет комнаты в боевом режиме — по ней проходят
 * удары, её клетка непроходима. Спрайт один у всех мишеней, позиция фиксирована.
 */
const RAB_CELL = { x: 4, y: 2 };

const rooms = new Map();
let nextId = 1001;

function send(ws, event, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify([event, payload]));
}

function roomOf(code) {
  const key = String(code || "demo")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24) || "demo";
  if (!rooms.has(key)) {
    rooms.set(key, { code: key, cats: new Map(), sockets: new Map(), chat: [], chatSeq: 0, dummy: null, dummyLast: null, dummyGrab: null, rab: null });
  }
  return rooms.get(key);
}

/** Клетка предмета (0-based) по его клеточным долям: центр округляется в пределы поля. */
function objCell(pos) {
  return {
    cx: Math.min(WIDTH - 1, Math.max(0, Math.round(pos.x))),
    cy: Math.min(HEIGHT - 1, Math.max(0, Math.round(pos.y))),
  };
}

function occupied(room, x, y, exceptId) {
  for (const cat of room.cats.values()) {
    if (cat.id !== exceptId && cat.x === x && cat.y === y) return true;
  }
  // Предметы комнаты — физические препятствия: на их клетки нельзя ступать и там нельзя спавниться.
  if (room.dummy) {
    const c = objCell(room.dummy);
    if (c.cx === x - 1 && c.cy === y - 1) return true;
  }
  if (room.rab && RAB_CELL.x === x - 1 && RAB_CELL.y === y - 1) return true;
  return false;
}

function spawnCell(room) {
  for (const [x, y] of SPAWNS) {
    if (!occupied(room, x, y)) return [x, y];
  }
  for (let y = 1; y <= HEIGHT; y++) {
    for (let x = 1; x <= WIDTH; x++) {
      if (!occupied(room, x, y)) return [x, y];
    }
  }
  return null;
}

function pickSprite(payload, slot) {
  const raw = String(payload.sprite || "").trim();
  if (SPRITES.includes(raw)) return raw;
  return SPRITES[slot % SPRITES.length];
}

function publicCat(cat) {
  return {
    id: cat.id,
    login: cat.login,
    color: cat.color,
    sprite: cat.sprite,
    x: cat.x,
    y: cat.y,
    deg: cat.deg,
    size: cat.size,
    blocking: !!cat.blocking,
  };
}

function fieldPayload(room) {
  const users = {};
  for (const cat of room.cats.values()) {
    if (!users[cat.x]) users[cat.x] = Array(HEIGHT + 1).fill(null);
    users[cat.x][cat.y] = publicCat(cat);
  }
  return {
    huntMode: false,
    width: WIDTH,
    height: HEIGHT,
    room: room.code,
    users,
    cats: [...room.cats.values()].map(publicCat),
    location: { name: "Расщелина меж скал", bg: 71085 },
    dummy: room.dummy
      ? { on: true, x: room.dummy.x, y: room.dummy.y, sprite: room.dummy.sprite, grab: room.dummyGrab || null }
      : null,
    rab: room.rab ? { on: true } : null,
  };
}

function broadcast(room, event, payload, exceptWs) {
  for (const ws of room.sockets.keys()) {
    if (ws !== exceptWs) send(ws, event, payload);
  }
}

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  const cat = room.sockets.get(ws);
  room.sockets.delete(ws);
  // Ушедший тащил манекен — комната больше не видит курсор с его именем.
  if (room.dummyGrab && cat && room.dummyGrab === cat.login) {
    room.dummyGrab = null;
    broadcast(room, "dummyDrop", {});
  }
  if (cat) {
    clearAimTimer(cat);
    clearMoveTimer(cat);
    cat.moveQueue = [];
    room.cats.delete(cat.id);
    broadcast(room, "move", { id: cat.id, x: 0, y: 0 });
    console.log(`ws leave room=${room.code} cat=${cat.login}#${cat.id}`);
  }
  ws.room = null;
  if (room.sockets.size === 0) rooms.delete(room.code);
}

function refuseJoin(ws, room, reason) {
  send(ws, "info", reason);
  send(ws, "noplace", { room: room.code, reason });
}

function join(ws, payload = {}) {
  const now = Date.now();
  if (now - (ws.lastJoin || 0) < JOIN_COOLDOWN_MS) {
    send(ws, "info", "Слишком часто. Подождите секунду.");
    return;
  }
  ws.lastJoin = now;
  if (ws.room) leave(ws);
  const room = roomOf(payload.room);
  if (room.cats.size >= MAX_PLAYERS) {
    refuseJoin(ws, room, `В комнате уже ${MAX_PLAYERS} котов — мест нет. Смените ?room=.`);
    return;
  }
  const cell = spawnCell(room);
  if (!cell) {
    // Двух котов в одну клетку не ставим: нет свободной клетки — отказ, не очередь.
    refuseJoin(ws, room, "На поле нет свободных клеток.");
    return;
  }
  const slot = room.cats.size;
  const login = uniqueLogin(room, sanitizeLogin(payload.login, NAMES[slot] || `Кот ${slot + 1}`));
  const cat = {
    id: nextId++,
    login,
    color: PALETTE[slot % PALETTE.length],
    sprite: pickSprite(payload, slot),
    x: cell[0],
    y: cell[1],
    deg: 0,
    size: 3.2,
    lastMove: 0,
    lastStrike: 0,
    lastAim: 0,
    lastChat: 0,
    // Блок (удержание К): любые удары по этому коту проводятся в «Лапы» (см. strike).
    blocking: false,
    // Шаги, ждущие снятия кулдауна (см. queueMove), и их таймер.
    moveQueue: [],
    moveTimer: null,
  };
  room.cats.set(cat.id, cat);
  room.sockets.set(ws, cat);
  ws.room = room;
  send(ws, "you", publicCat(cat));
  send(ws, "field", fieldPayload(room));
  if (room.chat?.length) send(ws, "chatlog", room.chat);
  broadcast(room, "move", publicCat(cat), ws);
}

function move(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
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
  if (nx < 1 || nx > WIDTH || ny < 1 || ny > HEIGHT) {
    send(ws, "info", "Край поля.");
    // refuse — тот же отказ, но с кодом: клиент откатывает предикт по коду,
    // а не по подстроке русского текста (текст менять можно свободно).
    send(ws, "refuse", { code: "edge", text: "Край поля." });
    return;
  }
  if (occupied(room, nx, ny, cat.id)) {
    send(ws, "info", "Клетка занята.");
    send(ws, "refuse", { code: "cell_busy", text: "Клетка занята." });
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
  const patch = { id: cat.id, x: cat.x, y: cat.y, deg: cat.deg, sprite: cat.sprite };
  // Шагнувшему — одно эхо. Второй экземпляр той же клетки (broadcast без except)
  // клиент читал как отказ предикта: спрайт шагал назад и следующим кадром
  // перепрыгивал клетку.
  send(ws, "update cat", patch);
  broadcast(room, "update cat", patch, ws);
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
    send(ws, "info", "Слишком быстро.");
    send(ws, "refuse", { code: "cooldown", text: "Слишком быстро." });
    return;
  }
  cat.moveQueue.push(payload);
  pumpMoveQueue(ws, cat);
}

/**
 * Смена скина. Клиент → ["sprite", { sprite }].
 * Остальным в комнате сразу → ["update cat", { id, x, y, deg, sprite, login }].
 * Клетка не меняется. Неизвестный id спрайта молча отбрасывается.
 */
function setSprite(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const sprite = String(payload.sprite || "").trim();
  if (!SPRITES.includes(sprite) || sprite === cat.sprite) return;
  cat.sprite = sprite;
  broadcast(
    room,
    "update cat",
    { id: cat.id, x: cat.x, y: cat.y, deg: cat.deg, sprite: cat.sprite, login: cat.login },
    ws,
  );
}

function clearAimTimer(cat) {
  if (!cat?.aimTimer) return;
  clearTimeout(cat.aimTimer);
  cat.aimTimer = null;
}

function normalizeDeg(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(wrap360(n) * 10) / 10;
}

/** Запомнить угол сразу. Рассылаем его сразу, а залп теснее AIM_MIN_GAP_MS схлопываем до последнего. */
function setDeg(ws, deg) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat || deg == null) return;
  if (deg === cat.deg && !cat.aimDirty) return;
  cat.deg = deg;
  const elapsed = Date.now() - (cat.lastAim || 0);
  if (elapsed >= AIM_MIN_GAP_MS) {
    clearAimTimer(cat);
    broadcastDeg(room, cat, ws);
    return;
  }
  cat.aimDirty = true;
  if (cat.aimTimer) return;
  cat.aimTimer = setTimeout(() => {
    cat.aimTimer = null;
    if (!cat.aimDirty || ws.room !== room) return;
    broadcastDeg(room, cat, ws);
  }, AIM_MIN_GAP_MS - elapsed);
}

function broadcastDeg(room, cat, exceptWs) {
  cat.aimDirty = false;
  cat.lastAim = Date.now();
  broadcast(room, "update cat", { id: cat.id, x: cat.x, y: cat.y, deg: cat.deg, sprite: cat.sprite }, exceptWs);
}

function aim(ws, payload = {}) {
  const cat = ws.room && ws.room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const deg = normalizeDeg(payload.deg ?? payload.angle);
  if (deg == null) return;
  setDeg(ws, deg);
}

function wrap360(a) {
  return ((a % 360) + 360) % 360;
}

function wrap180(a) {
  const x = wrap360(a);
  return x > 180 ? x - 360 : x;
}

/** Сосед, на которого точнее указывает стрела. То же правило, что pickStrikeTarget в симе. */
function aimedNeighbor(room, cat, angle) {
  if (!Number.isFinite(angle)) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const other of room.cats.values()) {
    if (other.id === cat.id) continue;
    const dx = other.x - cat.x;
    const dy = other.y - cat.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== 1) continue;
    const phi = wrap360((Math.atan2(dy, dx) * 180) / Math.PI);
    const diff = Math.abs(wrap180(phi - wrap360(angle)));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = other;
    }
  }
  return best;
}

/**
 * С диагонали зона не берётся из полос тела: морда / хвост / лапы, как в landStrike.
 * dx, dy — шаг от бьющего к цели, каждый -1 или 1.
 */
function diagonalZone(dx, dy) {
  if (Math.abs(dx) !== 1 || Math.abs(dy) !== 1) return null;
  if (dy === 1) return "muzzle";
  if (dx === -1 && dy === -1) return "tail";
  return "paws";
}

function resolveZone(raw) {
  const key = String(raw || "").trim();
  if (STRIKE_ZONES[key]) return [key, STRIKE_ZONES[key]];
  const lower = key.toLowerCase();
  for (const [id, zone] of Object.entries(STRIKE_ZONES)) {
    if (zone.part.toLowerCase() === lower) return [id, zone];
  }
  return null;
}

/**
 * Удар. Клиент → ["strike", { target, zone, angle, damage }].
 * Комнате → ["fight", { attackerId, attacker, targetId, name, part, zone, weapon, damage, isAttacking }].
 * name / part / weapon / isAttacking — поля боевого лога. isAttacking свой у каждого сокета.
 * damage — урон бьющего (его пресет «Урон игрока»); сервер нормализует число 0..100,
 * а без числа берёт урон зоны из серверной таблицы. Оружие пустое: когти и зубы
 * в этот обмен не входят, нокаута нет.
 */
function strike(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const now = Date.now();
  if (now - cat.lastStrike < STRIKE_COOLDOWN_MS) return;

  const targetId = Number(payload.target ?? payload.id);
  const angle = Number(payload.angle);
  const resolved = resolveZone(payload.zone ?? payload.part);
  if (!Number.isInteger(targetId) || !resolved || !Number.isFinite(angle)) {
    cat.lastStrike = now;
    send(ws, "info", "Удар не разобран.");
    return;
  }
  const [zoneId0, zone0] = resolved;
  let zoneId = zoneId0;
  let zone = zone0;
  const target = room.cats.get(targetId);
  if (!target || target.id === cat.id) {
    cat.lastStrike = now;
    send(ws, "info", "Цель не в комнате.");
    return;
  }
  const aimed = aimedNeighbor(room, cat, angle);
  if (!aimed) {
    cat.lastStrike = now;
    send(ws, "info", "Рядом никого.");
    return;
  }
  if (aimed.id !== target.id) {
    cat.lastStrike = now;
    send(ws, "info", "Стрела смотрит не на эту цель.");
    return;
  }
  cat.lastStrike = now;
  // Блок цели: любой удар — в «Лапы», стойка бьющего (прямая/диагональ) не важна.
  if (target.blocking) {
    zoneId = "paws";
    zone = STRIKE_ZONES.paws;
  } else {
    const forced = diagonalZone(target.x - cat.x, target.y - cat.y);
    if (forced && zoneId !== forced) {
      cat.lastStrike = now;
      send(ws, "info", "С этой диагонали бьётся другая часть.");
      return;
    }
  }
  // Урон присылает бьющий (его пресет «Урон игрока», проценты энергии 0..100).
  // Число округляем и зажимаем; нет числа — фолбэк на серверную таблицу зон.
  const dmgRaw = Number(payload.damage);
  const damage = Number.isFinite(dmgRaw) ? Math.min(100, Math.max(0, Math.round(dmgRaw))) : zone.damage;
  const entry = {
    attackerId: cat.id,
    attacker: cat.login,
    targetId: target.id,
    name: target.login,
    part: zone.part,
    zone: zoneId,
    weapon: "",
    damage,
  };
  for (const sock of room.sockets.keys()) {
    send(sock, "fight", {
      ...entry,
      isAttacking: room.sockets.get(sock)?.id === cat.id,
    });
  }
}

/**
 * Невидимые и bidi-символы: нулевая ширина даёт подмену имён («Сы\u200Bрь» выглядит
 * как «Сырь»), bidi-управляющие переворачивают строку чата. Вырезаем и из логина,
 * и из текста сообщений. Составные эмодзи (ZWJ) тоже распадаются — осознанная цена.
 */
const INVISIBLE_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function clipChars(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("");
}

function sanitizeChat(raw) {
  const text = String(raw ?? "")
    .replace(INVISIBLE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clipChars(text, CHAT_MAX_LEN);
}

/** Логин: только видимые символы, одинарные пробелы, не длиннее 24 код-поинтов. */
function sanitizeLogin(raw, fallback) {
  const text = clipChars(
    String(raw ?? "")
      .replace(INVISIBLE_RE, "")
      .replace(/\s+/g, " ")
      .trim(),
    24,
  );
  return text || fallback;
}

/** Имя, не совпадающее с уже сидящими в комнате (без учёта регистра):
 *  «Альфа» и «альфа» в одном чате — это одна и та же персона для читающего. */
function uniqueLogin(room, base) {
  const taken = new Set();
  for (const cat of room.cats.values()) taken.add(cat.login.toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  const stem = clipChars(base, 21);
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Чат комнаты. Клиент → ["chat", { text }].
 * Всем в комнате, включая отправителя → ["chat", { seq, id, login, color, text, ts }].
 * Новичку после field приходит ["chatlog", те же объекты], не больше CHAT_HISTORY.
 */
function chat(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const source = typeof payload === "string" ? payload : payload?.text ?? payload?.message ?? "";
  // Предрез по код-поинтам, а не по UTF-16: slice(0, 2000) мог разрезать суррогатную пару.
  const text = sanitizeChat(clipChars(String(source), 2000));
  if (!text) return;
  const now = Date.now();
  if (now - (cat.lastChat || 0) < CHAT_COOLDOWN_MS) {
    send(ws, "info", "Сообщения слишком частые.");
    return;
  }
  cat.lastChat = now;
  if (!room.chat) room.chat = [];
  room.chatSeq = (room.chatSeq || 0) + 1;
  const entry = {
    seq: room.chatSeq,
    id: cat.id,
    login: cat.login,
    color: cat.color,
    text,
    ts: now,
  };
  room.chat.push(entry);
  if (room.chat.length > CHAT_HISTORY) room.chat.splice(0, room.chat.length - CHAT_HISTORY);
  broadcast(room, "chat", entry);
}

/**
 * Манекен «ПОЧУХАТЬ». Клиент → ["dummy", { on, sprite? }].
 * Включение ставит манекен туда, где его выключили (или в дефолт), sprite обновляет
 * скин из списка персонажей. Комнате (и включившему тоже) → один пакет dummyState.
 */
function dummyToggle(ws, payload = {}) {
  const room = ws.room;
  if (!room) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const on = !!payload.on;
  if (on) {
    if (!room.dummy) room.dummy = room.dummyLast ? { ...room.dummyLast } : { ...DUMMY_DEFAULT };
    const sprite = String(payload.sprite || "").trim();
    if (SPRITES.includes(sprite)) room.dummy.sprite = sprite;
  } else {
    if (room.dummy) room.dummyLast = { ...room.dummy };
    room.dummy = null;
    room.dummyGrab = null;
  }
  broadcast(room, "dummyState", {
    on,
    x: room.dummy?.x ?? DUMMY_DEFAULT.x,
    y: room.dummy?.y ?? DUMMY_DEFAULT.y,
    sprite: room.dummy?.sprite ?? DUMMY_DEFAULT.sprite,
    grab: room.dummyGrab || null,
  });
}

/** Округление координат манекена до сотых: точности перетаскивания хватает, пакет короче. */
function normDummyCoord(value, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(Math.min(max, Math.max(0, n)) * 100) / 100;
}

/**
 * Перетаскивание манекена. Клиент → ["dummyMove", { x, y }] — координаты в клеточных
 * долях, уже зажатые клиентом; сервер перепроверяет и рассылает остальным
 * ["dummyMove", { x, y }]. Отправителю эхо не нужно: он уже нарисовал позицию.
 */
function dummyMove(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat || !room.dummy) return;
  const x = normDummyCoord(payload.x, WIDTH - 1);
  const y = normDummyCoord(payload.y, HEIGHT - 1);
  if (x == null || y == null) return;
  room.dummy.x = x;
  room.dummy.y = y;
  broadcast(room, "dummyMove", { x, y }, ws);
}

/**
 * Кто-то взял манекен: комната (включая взявшего) видит курсор с именем тащщего.
 * Клиент → ["dummyGrab"]. Комнате → ["dummyGrab", { login }].
 */
function dummyGrab(ws) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat || !room.dummy) return;
  room.dummyGrab = cat.login;
  broadcast(room, "dummyGrab", { login: room.dummyGrab });
}

/** Манекен отпущен. Клиент → ["dummyDrop"]. Комнате → ["dummyDrop"]. */
function dummyDrop(ws) {
  const room = ws.room;
  if (!room || !room.dummyGrab) return;
  const cat = room.sockets.get(ws);
  if (cat && room.dummyGrab !== cat.login) return;
  room.dummyGrab = null;
  broadcast(room, "dummyDrop", {});
}

/**
 * Боевая мишень «РАБ». Клиент → ["rab", { on }]. Включение/выключение уходит всей
 * комнате (и включившему тоже) пакетом rabState. Позиция фиксирована (RAB_CELL).
 */
function rabToggle(ws, payload = {}) {
  const room = ws.room;
  if (!room) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const on = !!payload.on;
  room.rab = on ? { on: true } : null;
  broadcast(room, "rabState", { on });
}

/**
 * Удар по мишени РАБ. Клиент → ["rabHit", { zone, part, damage }].
 * Остальным в комнате → ["rabHit", { zone, part, damage }]: качание «желе» и
 * всплывающий урон над мишенью. Бьющему эхо не уходит — он уже анимировал удар
 * локально в момент попадания. Урон зажимаем 0..100, строки режем.
 */
function rabHit(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) return;
  const zone = String(payload.zone || "").trim().slice(0, 32);
  const part = String(payload.part || "").trim().slice(0, 32);
  if (!zone && !part) return;
  const dmgRaw = Number(payload.damage);
  const damage = Number.isFinite(dmgRaw) ? Math.min(100, Math.max(0, Math.round(dmgRaw))) : 0;
  for (const sock of room.sockets.keys()) {
    if (sock === ws) continue;
    send(sock, "rabHit", { zone, part, damage });
  }
}

/**
 * Блок (удержание К). Клиент → ["block", { on }]. Комнате (кроме отправителя) →
 * ["block", { id, on }]. Пока блок держится, strike проводит любые удары по этому
 * коту в зону «Лапы». Состояние также входит в publicCat — новички видят его в field.
 */
function block(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat) return;
  cat.blocking = !!payload.on;
  broadcast(room, "block", { id: cat.id, on: cat.blocking }, ws);
}

function onMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  const event = Array.isArray(msg) ? msg[0] : msg && msg.event;
  const payload = Array.isArray(msg) ? msg[1] : msg;
  if (event === "join" || event === "first") join(ws, payload || {});
  else if (event === "move") move(ws, payload || {});
  else if (event === "aim") aim(ws, payload || {});
  else if (event === "strike") strike(ws, payload || {});
  else if (event === "chat") chat(ws, payload ?? {});
  else if (event === "sprite") setSprite(ws, payload || {});
  else if (event === "dummy") dummyToggle(ws, payload || {});
  else if (event === "dummyMove") dummyMove(ws, payload || {});
  else if (event === "dummyGrab") dummyGrab(ws);
  else if (event === "dummyDrop") dummyDrop(ws);
  else if (event === "rab") rabToggle(ws, payload || {});
  else if (event === "rabHit") rabHit(ws, payload || {});
  else if (event === "block") block(ws, payload || {});
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, maxPlayers: MAX_PLAYERS }));
    return;
  }
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_PAYLOAD,
  verifyClient(info) {
    const origin = info.origin || "";
    const ok = isAllowedOrigin(origin);
    if (!ok) console.warn("ws origin rejected:", origin || "(нет Origin)");
    return ok;
  },
});

/**
 * Heartbeat: обрыв без FIN (мобильная сеть, уход вкладки в сон) иначе держал бы
 * клетку и слот комнаты до таймаута nginx. Пинг раз в 30 с; если pong не пришёл
 * с прошлого пинга — terminate(), его close-обработчик вызовет leave() и освободит клетку.
 */
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
hb.unref();

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  console.log(`ws open ${req.socket.remoteAddress || "?"} origin=${req.headers.origin || "-"}`);
  ws.on("message", (raw) => onMessage(ws, raw));
  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`coop-field http://${HOST}:${PORT}/?room=demo`);
});
