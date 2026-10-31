import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 3780;
const WS_HOSTNAME = "coop.89-232-184-77.sslip.io";
const DEFAULT_ORIGINS = [
  "http://localhost:3780",
  "http://127.0.0.1:3780",
  `https://${WS_HOSTNAME}`,
];

function allowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
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
const MOVE_COOLDOWN_MS = 80;
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
/**
 * Зоны abnocw (id → подпись и урон при пресете 0,0). Совпадает с DEFAULT_SETTINGS.combat.zones.
 * Когтей и зубов нет: weapon в логе пустой.
 */
const STRIKE_ZONES = {
  tail: { part: "Хвост", damage: 2 },
  paws: { part: "Лапы", damage: 5 },
  back: { part: "Спина", damage: 12 },
  muzzle: { part: "Морда", damage: 20 },
  belly: { part: "Живот", damage: 25 },
  neck: { part: "Шея", damage: 30 },
  throat: { part: "Горло", damage: 38 },
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
const SPRITES = ["blestyashka", "puhlyashik", "puzatik", "razdora", "pohititel", "syrstyashka"];

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
    rooms.set(key, { code: key, cats: new Map(), sockets: new Map() });
  }
  return rooms.get(key);
}

function occupied(room, x, y, exceptId) {
  for (const cat of room.cats.values()) {
    if (cat.id !== exceptId && cat.x === x && cat.y === y) return true;
  }
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
  if (cat) {
    clearAimTimer(cat);
    room.cats.delete(cat.id);
    broadcast(room, "move", { id: cat.id, x: 0, y: 0 });
  }
  ws.room = null;
  if (room.sockets.size === 0) rooms.delete(room.code);
}

function refuseJoin(ws, room, reason) {
  send(ws, "info", reason);
  send(ws, "noplace", { room: room.code, reason });
}

function join(ws, payload = {}) {
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
  const login = String(payload.login || NAMES[slot] || `Кот ${slot + 1}`).slice(0, 24);
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
  };
  room.cats.set(cat.id, cat);
  room.sockets.set(ws, cat);
  ws.room = room;
  send(ws, "you", publicCat(cat));
  send(ws, "field", fieldPayload(room));
  broadcast(room, "move", publicCat(cat), ws);
}

function move(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, "info", "Сначала зайдите в комнату.");
    return;
  }
  const now = Date.now();
  if (now - cat.lastMove < MOVE_COOLDOWN_MS) return;

  let dx = Number(payload.x);
  let dy = Number(payload.y);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
  dx = Math.max(-1, Math.min(1, Math.trunc(dx)));
  dy = Math.max(-1, Math.min(1, Math.trunc(dy)));
  if (dx === 0 && dy === 0) return;

  const nx = cat.x + dx;
  const ny = cat.y + dy;
  if (nx < 1 || nx > WIDTH || ny < 1 || ny > HEIGHT) {
    send(ws, "info", "Край поля.");
    return;
  }
  if (occupied(room, nx, ny, cat.id)) {
    send(ws, "info", "Клетка занята.");
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
  const patch = { id: cat.id, x: cat.x, y: cat.y, deg: cat.deg };
  send(ws, "update cat", patch);
  broadcast(room, "update cat", patch);
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
  broadcast(room, "update cat", { id: cat.id, x: cat.x, y: cat.y, deg: cat.deg }, exceptWs);
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
 * Удар. Клиент → ["strike", { target, zone, angle }].
 * Комнате → ["fight", { attackerId, attacker, targetId, name, part, zone, weapon, damage, isAttacking }].
 * name / part / weapon / isAttacking — поля боевого лога. isAttacking свой у каждого сокета.
 * Оружие пустое: когти и зубы в этот обмен не входят, нокаута нет.
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
  const [zoneId, zone] = resolved;
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
  const forced = diagonalZone(target.x - cat.x, target.y - cat.y);
  if (forced && zoneId !== forced) {
    cat.lastStrike = now;
    send(ws, "info", "С этой диагонали бьётся другая часть.");
    return;
  }

  cat.lastStrike = now;
  const entry = {
    attackerId: cat.id,
    attacker: cat.login,
    targetId: target.id,
    name: target.login,
    part: zone.part,
    zone: zoneId,
    weapon: "",
    damage: zone.damage,
  };
  for (const sock of room.sockets.keys()) {
    send(sock, "fight", {
      ...entry,
      isAttacking: room.sockets.get(sock)?.id === cat.id,
    });
  }
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
  verifyClient(info) {
    const origin = info.origin || "";
    const ok = isAllowedOrigin(origin);
    if (!ok) console.warn("ws origin rejected:", origin);
    return ok;
  },
});
wss.on("connection", (ws) => {
  ws.on("message", (raw) => onMessage(ws, raw));
  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`coop-field http://${HOST}:${PORT}/?room=demo`);
});
