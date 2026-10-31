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
const MAX_PLAYERS = 3;
const MOVE_COOLDOWN_MS = 80;
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
const PALETTE = ["#d85e90", "#4b8fd0", "#e6b84d"];
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

function degFromDelta(dx, dy) {
  if (dx === 0 && dy === 0) return 0;
  // Official 0° faces right; 90° down (screen +y).
  return (Math.atan2(dy, dx) * 180) / Math.PI;
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
    room.cats.delete(cat.id);
    broadcast(room, "move", { id: cat.id, x: 0, y: 0 });
  }
  ws.room = null;
  if (room.sockets.size === 0) rooms.delete(room.code);
}

function join(ws, payload = {}) {
  if (ws.room) leave(ws);
  const room = roomOf(payload.room);
  if (room.cats.size >= MAX_PLAYERS) {
    send(ws, "info", "В комнате уже 3 кота — клетка не свободна.");
    send(ws, "noplace", { room: room.code });
    return;
  }
  const cell = spawnCell(room);
  if (!cell) {
    send(ws, "info", "На поле нет свободных клеток.");
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
  cat.deg = Math.round(degFromDelta(dx, dy) * 100) / 100;
  cat.lastMove = now;
  const patch = { id: cat.id, x: cat.x, y: cat.y, deg: cat.deg };
  send(ws, "update cat", patch);
  broadcast(room, "update cat", patch);
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
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
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
