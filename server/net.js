/**
 * Transport (W4 carve, behavior-preserving): the `[event, payload]` inbound
 * dispatcher, the health/static HTTP server, the WebSocket accept path
 * (Origin check, 30 s heartbeat, connection wiring), and the periodic
 * timers — cat position flush (2 s) and the atmosphere anchor ticker (5 s).
 * The >64 KiB non-setmap frame drop is the guard in onMessage; wire names
 * come from ./protocol.js only (W3 canon). startServer() is called once by
 * the thin server.js entry and does everything the old tail of server.js did
 * at import time — module import itself has no side effects.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import { EV, MAX_PLAYERS, ATMO_PHASE_LIST } from "./protocol.js";
import {
  PUBLIC, HOST, PORT, MAX_PAYLOAD, FRAME_LIMIT, HEARTBEAT_MS, isAllowedOrigin, isPublicHost,
} from "./config.js";
import { rooms, leave, join, setSprite, block, space, roomsInfo } from "./room.js";
import { move, freeMove, cellsync, jump } from "./movement.js";
import { aim, strike, armor } from "./combat.js";
import { chat } from "./sanitize.js";
import { dummyToggle, dummyMove, dummyGrab, dummyDrop, rabToggle, rabHit } from "./dummy-rab.js";
import { atmo, atmoset, atmoState, atmoBroadcast, atmoPhaseIdx } from "./atmo.js";
import { setMap, testMap, MAP_FILE, saveTestMap } from "./testmap.js";
import { flushCatBook } from "./persist.js";
import { handleAuthHttp, handleAuthFrame, handshake, flushAuth } from "./auth.js";
import { handleCfgHttp } from "./runtime-config.js";
import { handleProfilesHttp } from "./profiles.js";

function onMessage(ws, raw) {
  // Длина кадра в байтах: ws отдаёт Buffer (length уже октеты), byteLength —
  // запасной путь на случай строки.
  const bytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw));
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }
  const event = Array.isArray(msg) ? msg[0] : msg && msg.event;
  // Размерный лимит на НЕ-setmap кадры: имя события известно только после
  // парса (мягкая реализация), зато после проверки кадр до обработчиков не
  // доходит — как если бы его отбросили до JSON.parse. setmap — единственное
  // исключение: ради рисунка локации (PNG base64 до 3,5 МБ) ему оставлен
  // высокий транспортный потолок MAX_PAYLOAD.
  if (bytes > FRAME_LIMIT && event !== EV.SETMAP) return;
  const payload = Array.isArray(msg) ? msg[1] : msg;
  if (event === EV.JOIN) join(ws, payload || {});
  else if (event === EV.MOVE) move(ws, payload || {});
  else if (event === EV.AIM) aim(ws, payload || {});
  else if (event === EV.STRIKE) strike(ws, payload || {});
  else if (event === EV.CHAT) chat(ws, payload ?? {});
  else if (event === EV.SPRITE) setSprite(ws, payload || {});
  else if (event === EV.DUMMY) dummyToggle(ws, payload || {});
  else if (event === EV.DUMMY_MOVE) dummyMove(ws, payload || {});
  else if (event === EV.DUMMY_GRAB) dummyGrab(ws);
  else if (event === EV.DUMMY_DROP) dummyDrop(ws);
  else if (event === EV.RAB) rabToggle(ws, payload || {});
  else if (event === EV.RAB_HIT) rabHit(ws, payload || {});
  else if (event === EV.BLOCK) block(ws, payload || {});
  else if (event === EV.SPACE) space(ws, payload || {});
  else if (event === EV.ATMO) atmo(ws, payload || {});
  else if (event === EV.ATMOSET) atmoset(ws, payload || {});
  else if (event === EV.ARMOR) armor(ws, payload || {});
  else if (event === EV.FREEMOVE) freeMove(ws, payload || {});
  else if (event === EV.CELLSYNC) cellsync(ws, payload || {});
  else if (event === EV.JUMP) jump(ws, payload || {});
  else if (event === EV.SETMAP) setMap(ws, payload || {});
  else if (event === EV.ROOMS) roomsInfo(ws, payload || {});
  else if (event === EV.AUTH) {
    Promise.resolve(handleAuthFrame(ws, payload || {}, ws.clientIp || "0")).catch((e) => {
      console.warn("auth frame failed:", e?.message || e);
    });
  }
}
export function startServer() {
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

  function serveStatic(req, res, url) {
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
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
  }

  /** 404 «зоны не существует» (P1): единый ответ host-гейта и скрытых маршрутов. */
  function notFoundJson(res) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, reason: "not_found" }));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, maxPlayers: MAX_PLAYERS }));
      return;
    }
    // Хост-гейт P1 (класс — config.hostClassOf по req.headers.host): public-фронт
    // (пивные гроты) не должен знать про зоны Элизии — auth, profiles и admin
    // отвечают «не существует», конфиг на нём читается, но не пишется (спек §11).
    // P2: скрыты и admin-маршруты /cfg (дашборд/экспорт) — на public их нет.
    const p = url.pathname;
    if (isPublicHost(req)) {
      const hidden =
        p === "/auth" ||
        p.startsWith("/auth/") ||
        p === "/profiles" ||
        p.startsWith("/profiles/") ||
        p === "/admin" ||
        p.startsWith("/admin/") ||
        p === "/cfg/admin" ||
        p.startsWith("/cfg/admin/") ||
        p === "/cfg/export" ||
        (req.method === "POST" && (p === "/cfg" || p.startsWith("/cfg/")));
      if (hidden) {
        notFoundJson(res);
        return;
      }
    }
    // CSRF Origin для пишущего /cfg-POST (cookie-аутентификация админа): чужой
    // браузерный Origin → 403. Пустой/отсутствующий Origin не блокируем.
    // Пишущие auth-POST проверяются тем же правилом в server/auth.js.
    if (req.method === "POST" && (p === "/cfg" || p.startsWith("/cfg/"))) {
      const origin = String(req.headers.origin || "");
      if (origin && !isAllowedOrigin(origin)) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, reason: "csrf" }));
        return;
      }
    }
    Promise.resolve(handleAuthHttp(req, res)).then((hit) => {
      if (hit) return;
      return Promise.resolve(handleCfgHttp(req, res)).then((cfgHit) => {
        if (cfgHit) return;
        return Promise.resolve(handleProfilesHttp(req, res)).then((profHit) => {
          if (profHit) return;
          serveStatic(req, res, url);
        });
      });
    }).catch(() => {
      res.writeHead(500);
      res.end();
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
    handshake(ws, req);
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

  /** Периодический слив книги позиций: рестарт по kill не теряет последние шаги. */
  const catFlushTimer = setInterval(() => flushCatBook(), 2000);
  catFlushTimer.unref();

  /**
   * Тикер атмосферы: доезжающая по интервалу смена погоды (лениво посчитанная в
   * atmoState) уходит всем рассылкой якоря; заодно — смена части суток (клиенты
   * едут сами, но якорь держит их синхронно с серверными часами). Раз в 5 секунд —
   * с запасом к точности 7-минутных частей, нагрузка нулевая.
   */
  const atmoTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (room.sockets.size === 0) continue;
      // Снимаем «до» по значению: atmoState двигает погоду на месте, в том же объекте.
      const a = room.atmo;
      const dpBefore = a ? ATMO_PHASE_LIST[atmoPhaseIdx(a, now)] : null;
      const wBefore = a ? a.w : null;
      const st = atmoState(room, now); // лениво двигает погоду, если срок истёк
      if (dpBefore !== ATMO_PHASE_LIST[atmoPhaseIdx(st, now)] || wBefore !== st.w) {
        atmoBroadcast(room, now);
      }
    }
  }, 5000);
  atmoTimer.unref();

  /** Остановка: дожимаем книгу позиций и карту (если расходится с диском) в файлы. */
  function flushOnShutdown() {
    flushAuth();
    flushCatBook(true);
    try {
      const onDisk = fs.readFileSync(MAP_FILE, "utf8");
      if (onDisk !== JSON.stringify(testMap, null, 2)) saveTestMap();
    } catch {}
  }
  process.on("SIGTERM", () => {
    flushOnShutdown();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    flushOnShutdown();
    process.exit(0);
  });
}
