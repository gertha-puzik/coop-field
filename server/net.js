import { withTestLocation } from "./testmap.js";
import { locationFromRoom, travel, handleLocationsHttp } from "./location-world.js";
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
import { WebSocketServer, WebSocket } from "ws";
import { EV, MAX_PLAYERS, ATMO_PHASE_LIST } from "./protocol.js";
import { allowBroadcastFrame, isFrameLimited } from "./frame-limit.js";
import {
  PUBLIC, HOST, PORT, MAX_PAYLOAD, FRAME_LIMIT, HEARTBEAT_MS,
  REQUIRE_ORIGIN, originAllowedHere, csrfDecision, siteClassOfRequest, WS_MAX_PER_IP,
  assertStartupSecurity,
} from "./config.js";
import { rooms, leave, join, setSprite, block, space, roomsInfo } from "./room.js";
import { move, freeMove, cellsync, jump } from "./movement.js";
import { aim, strike, armor } from "./combat.js";
import { chat } from "./sanitize.js";
import { dummyToggle, dummyMove, dummyGrab, dummyDrop, rabToggle, rabHit } from "./dummy-rab.js";
import { atmo, atmoset, atmoState, atmoBroadcast, atmoPhaseIdx } from "./atmo.js";
import { setMap, testMap, MAP_FILE, saveTestMap } from "./testmap.js";
import { flushCatBook } from "./persist.js";
import { handleAuthHttp, handleAuthFrame, handshake, flushAuth, COOKIE } from "./auth.js";
import { handleCfgHttp } from "./runtime-config.js";
// F2: per-room admin-роуты (те же гейты /cfg-зоны: роль admin на сервере,
// host-гейт public ниже прячет /cfg/rooms* целиком, CSRF-щит — общий apiZone).
import { handleRoomCfgHttp } from "./room-config.js";
// Админ-операции «Игроки на поле» (GET/POST /admin/players*): гейт session
// + role=admin + общий apiZone-CSRF — сам домен в room.js (W4-граница).
import { handleAdminOpsHttp } from "./admin-ops.js";
// Одноразовые инвайт-коды регистрации (server/invites.js): админ-роуты
// GET/POST /admin/invites* (гейты — в самом домене, как admin-ops.js;
// host-гейт ниже прячет /admin ЦЕЛИКОМ на public, apiZone — CSRF-щит).
import { handleInvitesHttp } from "./invites.js";
// Статусы игроков на поле (/admin/statuses*): каталог + назначения аккаунтам
// (гейты — в самом домене, как invites/admin-ops; host-гейт прячет /admin
// на public, apiZone — CSRF-щит).
import { handleStatusesHttp, bootStatuses } from "./statuses.js";
// Новости главной доски: GET /cfg/news|/news (public), POST /cfg/news|/admin/news (admin).
import { handleHomeNewsHttp } from "./home-news.js";
// Менеджер спрайтов (server/sprites.js): публичный каталог + файлы загруженных
// (/sprites/*, ДО статики — иначе /sprites/file/… ушёл бы в файловый 404) и
// админские CRUD /admin/sprites* (гейты — в самом домене, как в admin-ops.js).
import { handleSpritesHttp } from "./sprites.js";
// Личные окрасы игроков (#83): сессионные POST/GET/DELETE /sprites/mine* —
// единый стек с профилями (host-гейт ниже прячет зону на публичном классе,
// apiZone ниже держит CORS-надзор и unsafe-cookie Origin-щит; сессия и
// перепроверка CSRF — в самом домене, как у profiles.js).
import { handleMineSpritesHttp } from "./my-sprites.js";
// Аватарки профилей (server/avatars.js): сессионные POST/DELETE /avatars/mine
// (host-гейт ниже прячет зону на публичном классе, apiZone ниже держит
// CORS-надзор и unsafe-cookie Origin-щит; сессия и перепроверка CSRF — в
// самом домене, как у profiles/my-sprites) и публичный GET /avatars/file/*
// (префикс, как /sprites/file: не спрятан и в apiZone не числится —
// безопасный метод без сессии, читается обоим сайтам).
import { handleAvatarsHttp } from "./avatars.js";
import { handleProfilesHttp } from "./profiles.js";
import { handleTexturesHttp } from "./textures.js";

function onMessage(ws,raw){
  try{return withTestLocation(locationFromRoom(ws.room?.code??""),()=>dispatchMessage(ws,raw));}
  catch(error){console.warn("world frame failed:",error.message);send(ws,EV.INFO,"Локация недоступна. Попробуйте позже.");}
}
function dispatchMessage(ws, raw) {
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
  // Общий потолок block/space/atmo/atmoset/dummy/rab: молча, без нового события.
  if (isFrameLimited(event) && !allowBroadcastFrame(ws)) return;
  const payload = Array.isArray(msg) ? msg[1] : msg;
  if (event === EV.JOIN){if(payload?.passageId)travel(ws,payload);else join(ws,payload||{});}
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
  // Статусы на поле: сид Тестер/Глав. Админ после полной загрузки accounts.
  bootStatuses();
  // §5 fail-closed: первым делом — инстанс-класс и запрет выключенного CSRF
  // на production/preview. До любого listen и регистрации колбэков.
  assertStartupSecurity();
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

  /* S4 (аудит Z.AI 2026-11-08): экспозиция режима клиентского IP в /health и
   * троттленное предупреждение о «голом» loopback-трафике на прод-классах.
   * Логика зеркалит auth.js clientIp(): loopback-сокет + XFF → 'xff' (наш
   * nginx, лимиты считают реальные адреса), loopback без XFF → 'loopback'
   * (лимиты отключены), не-loopback → 'direct' (адрес сокета). */
  function clientIpMode(req) {
    const fwd = String(req.headers["x-forwarded-for"] || "");
    const remote = String(req.socket.remoteAddress || "");
    const loop = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    return fwd && loop ? "xff" : loop ? "loopback" : "direct";
  }
  /**
   * S5a (аудит Z.AI 2026-11-08): счётчик ОДНОВРЕМЕННЫХ WS-сокетов на клиентский
   * IP (ключ — clientIp из auth.js handshake: loopback+XFF → реальный адрес,
   * иначе адрес сокета). Сверх WS_MAX_PER_IP — info 'too_many_sockets' и close.
   * Карта ip → число живых сокетов; чистится на close/error (once-флаг, чтобы
   * двойное срабатывание не съело чужой слот).
   */
  const socketsPerIp = new Map();
  const LOOPBACK_PROD_WARN_EVERY_MS = 5 * 60_000;
  let loopbackProdWarnAt = 0;

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
    const p = url.pathname;
    if (p === "/health") {
      // S4 (аудит Z.AI 2026-11-08): режим IP виден владелице без выхода в
      // сеть. 'loopback' на прод-классе хоста = «голый» прокси без XFF (или
      // локальная разработка): rate-лимиты auth для такого трафика отключены
      // — предупреждаем в лог не чаще раза в 5 минут (не на каждый кадр).
      const ipMode = clientIpMode(req);
      const healthClass = siteClassOfRequest(req);
      if (ipMode === "loopback" && healthClass !== "local") {
        const now = Date.now();
        if (now - loopbackProdWarnAt > LOOPBACK_PROD_WARN_EVERY_MS) {
          loopbackProdWarnAt = now;
          console.warn(
            `[health] клиент пришёл loopback без X-Forwarded-For на хост-классе «${healthClass}»: ` +
              `темп-лимиты auth не работают (см. deploy/vps — nginx-фрагмент x-forwarded-for), clientIpMode=${ipMode}`,
          );
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        rooms: rooms.size,
        maxPlayers: MAX_PLAYERS,
        clientIpMode: ipMode, // S4: 'loopback' | 'xff' | 'direct'
      }));
      return;
    }
    // B1: класс САЙТА destination (siteClassOfRequest: Host-классификация +
    // доверенная loopback-метка прокси AUTH_TRUST_PROXY_HEADER) решает и
    // host-гейт, и пары (Origin, destination) в CORS/CSRF ниже.
    const destClass = siteClassOfRequest(req);
    // Хост-гейт P1: public-фронт (пивные гроты) не должен знать про зоны
    // Элизии — auth, profiles и admin отвечают «не существует», конфиг на
    // нём читается, но не пишется (спек §11). P2: скрыты и admin-маршруты
    // /cfg (дашборд/экспорт) — на public их нет.
    if (destClass === "public") {
      const hidden =
        p === "/auth" ||
        p.startsWith("/auth/") ||
        p === "/profiles" ||
        p.startsWith("/profiles/") ||
        p === "/admin" ||
        p.startsWith("/admin/") ||
        // #83: личные окрасы — сессионная зона Элизии, на гроттах её нет.
        p === "/sprites/mine" ||
        p.startsWith("/sprites/mine/") ||
        // Аватарка профиля: та же сессионная зона Элизии (файл /avatars/file
        // ниже НЕ прячем — он публичен обоим классам, как /sprites/file).
        p === "/avatars/mine" ||
        p.startsWith("/avatars/mine/") ||
        p === "/cfg/admin" ||
        p.startsWith("/cfg/admin/") ||
        p === "/cfg/export" ||
        // F2: per-room конфиг — admin-маршрут, на public-фронте его нет
        // (как /cfg/admin): и чтение, и запись отвечают «не существует».
        p === "/cfg/rooms" ||
        p.startsWith("/cfg/rooms/") ||
        // Создание локаций: GET /locations публичен, POST — только Элизия/local.
        (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && p === "/locations") ||
        (req.method === "POST" && (p === "/cfg" || p.startsWith("/cfg/")));
      if (hidden) {
        notFoundJson(res);
        return;
      }
    }
    // B1: CORS-надзор на ВСЕХ API-зонах. Обработчики (auth/cfg/profiles)
    // отражают Origin по ГЛОБАЛЬНОМУ списку — над ними (крюк на res.setHeader)
    // стоит per-destination политика: чужой Origin ответа не прочитает
    // (Access-Control-* не выдаётся браузеру), свой получает ТОЧНЫЙ origin
    // (никогда wildcard) + Allow-Credentials + Vary: Origin. Префлайты
    // OPTIONS проходят ту же пару (Origin, класс destination).
    const originHeader = String(req.headers.origin || "");
    const originAllowed = originHeader && originAllowedHere(originHeader, destClass);
    const apiZone =
      p === "/auth" || p.startsWith("/auth/") ||
      p === "/profiles" || p.startsWith("/profiles/") ||
      p === "/cfg" || p.startsWith("/cfg/") ||
      // Админ-операции «Игроки на поле» (/admin/players*): тот же CSRF-щит
      // (unsafe + cookie ⇒ Origin) и CORS-надзор; страница /admin — статика,
      // в зону попадают API-пути (list/reset/promote), не HTML дашборда.
      p === "/admin/players" || p.startsWith("/admin/players/") ||
      // Инвайт-коды регистрации (/admin/invites*): тот же CSRF-щит
      // (unsafe + cookie ⇒ Origin) и CORS-надзор, что у «Игроков на поле».
      p === "/admin/invites" || p.startsWith("/admin/invites/") ||
      // Статусы на поле (/admin/statuses* и обходной /cfg/statuses*): CSRF.
      p === "/admin/statuses" || p.startsWith("/admin/statuses/") ||
      p === "/cfg/statuses" || p.startsWith("/cfg/statuses/") ||
      // Новости доски главной: GET /cfg/news|/news публичны; POST /cfg/news
      // (и /admin/news) — cookie+CSRF (unsafe). Запись через /cfg — обход
      // nginx (location /admin без точного префикса → статика 405).
      p === "/news" || p === "/cfg/news" ||
      p === "/admin/news" || p.startsWith("/admin/news/") ||
      // Создание локаций мира (POST /locations|/cfg/locations и алиас /admin/locations).
      p === "/locations" || p === "/cfg/locations" ||
      p === "/admin/locations" || p.startsWith("/admin/locations/") ||
      // Менеджер спрайтов: админские POST/PATCH/DELETE /admin/sprites* —
      // unsafe-cookie ⇒ тот же Origin-щит (GET-каталог /sprites/* публичный
      // и в зоне не нуждается: безопасный метод, сессию не несёт).
      p === "/admin/sprites" || p.startsWith("/admin/sprites/") ||
      // Текстуры редактора: /admin/tex* и обходной /cfg/tex* (прод /cfg уже в Node).
      p === "/admin/tex" || p.startsWith("/admin/tex/") ||
      p === "/cfg/tex" || p.startsWith("/cfg/tex/") ||
      p === "/cfg/tex-catalog" || p === "/cfg/tex-file" || p.startsWith("/cfg/tex-file/") ||
      // Личные окрасы (#83): POST/DELETE несут cookie-сессию — тот же
      // unsafe-cookie Origin-щит и CORS-надзор (GET /sprites/mine безопасен,
      // но пусть зона вся живёт под одной политикой, как /profiles).
      p === "/sprites/mine" || p.startsWith("/sprites/mine/") ||
      // Аватарки: POST/DELETE /avatars/mine несут cookie-сессию — тот же
      // unsafe-cookie Origin-щит и CORS-надзор (GET /avatars/file —
      // безопасный метод, в зоне не нуждается, как /sprites/file).
      p === "/avatars/mine" || p.startsWith("/avatars/mine/");
    if (apiZone) {
      if (originHeader) res.setHeader("Vary", "Origin");
      if (originAllowed) {
        res.setHeader("Access-Control-Allow-Origin", originHeader);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
    }
    {
      const rawSetHeader = res.setHeader.bind(res);
      res.setHeader = (name, value) => {
        const key = String(name).toLowerCase();
        if (key.startsWith("access-control-")) {
          if (!originAllowed) return res; // произвольный Origin не отражается
          if (key === "access-control-allow-origin" || key === "access-control-allow-credentials") {
            return res; // уже выставлены точно и только «своему» origin
          }
        }
        return rawSetHeader(name, value);
      };
    }
    // CSRF fail-closed (B1): unsafe-методы с cookie-аутентификацией на
    // public/elyria обязаны нести Origin, точный для destination-класса
    // (пустой Origin → 403 csrf_origin_required, чужой → 403 csrf_origin_mismatch);
    // класс local — прежний щит ('0'/'1' в AUTH_CSRF_STRICT форсируют для всех).
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && apiZone) {
      const hasAuth =
        new RegExp(`(?:^|;\\s*)${COOKIE}=[0-9a-f]+`, "i").test(String(req.headers.cookie || "")) ||
        Boolean(url.searchParams.get("t"));
      const csrfBad = csrfDecision({
        method: req.method,
        origin: req.headers.origin,
        destClass,
        hasAuth,
      });
      if (csrfBad) {
        res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, reason: csrfBad.reason }));
        return;
      }
    }
    Promise.resolve(handleAuthHttp(req, res)).then((hit) => {
      if (hit) return;
      // Админ-операции «Игроки на поле» (/admin/players*): разбираются ДО
      // статики — страница /admin остаётся статичной (P1 их не прячет),
      // а вот эти API-пути живой домен room.js должен перехватить.
      return handleAdminOpsHttp(req, res).then((opsHit) => {
        if (opsHit) return;
      // Инвайт-коды регистрации (/admin/invites*): разбор ДО /locations и
      // статики, гейт (сессия + role=admin) домен проверяет сам.
      return handleInvitesHttp(req, res).then((invHit) => {
        if (invHit) return;
      return handleStatusesHttp(req, res).then((stHit) => {
        if (stHit) return;
      return handleHomeNewsHttp(req, res).then((newsHit) => {
        if (newsHit) return;
      return Promise.resolve(handleLocationsHttp(req, res)).then((locHit) => {
        if (locHit) return;
      // Текстуры ДО /cfg: на проде nginx уже шлёт весь /cfg в Node, а
      // handleCfgHttp заявляет всё подпространство (фолбэк-404). Обходные
      // /cfg/tex* и /cfg/tex-catalog|/cfg/tex-file должны попасть сюда раньше.
      return Promise.resolve(handleTexturesHttp(req, res)).then((texHit) => {
        if (texHit) return;
      // F2: per-room ветка /cfg-домена разбирается ПЕРВОЙ среди cfg:
      // глобальный /cfg-хендлер заявляет всё /cfg-подпространство, а room-роуты
      // отвечают false на всё, что не /cfg/rooms*.
      return Promise.resolve(handleRoomCfgHttp(req, res)).then((roomCfgHit) => {
        if (roomCfgHit) return;
        return Promise.resolve(handleCfgHttp(req, res)).then((cfgHit) => {
          if (cfgHit) return;
          return Promise.resolve(handleProfilesHttp(req, res)).then((profHit) => {
            if (profHit) return;
            // Личные окрасы (#83) — после адресных зон, до общих /sprites*:
            // маршруты /sprites/mine* строже и не пересекаются с каталогом.
            return Promise.resolve(handleMineSpritesHttp(req, res)).then((mineHit) => {
              if (mineHit) return;
              // Аватарки профилей: сессионные POST/DELETE /avatars/mine и
              // публичный GET /avatars/file/* — до статики, иначе файл
              // уходит в файловый 404 (тот же порядок, что у /sprites/*).
              return Promise.resolve(handleAvatarsHttp(req, res)).then((avatarsHit) => {
                if (avatarsHit) return;
                // Менеджер спрайтов: /sprites/catalog, /sprites/file/* и /admin/sprites/*
                // разбираются ПОСЛЕДНИМИ до статики — статические /sprites/<id>.png
                // в handler не попадают (маршруты длиннее и точнее), файловые 404
                // отдаёт сам домен.
                return Promise.resolve(handleSpritesHttp(req, res)).then((spritesHit) => {
                  if (spritesHit) return;
                  serveStatic(req, res, url);
                });
              });
            });
          });
        });
      });
      });
      });
      });
      });
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
      // B1: Origin на upgrade — ПАРА (origin, класс destination-хоста).
      // Отсутствие Origin допускается (гость-геймплей, originless-скрипты;
      // cookie-аутентифицированные кадры register/login на public/elyria
      // добьёт handleAuthFrame), но REQUIRE_ORIGIN=1 сохраняет старый смысл.
      const origin = info.origin || "";
      if (!origin) return !REQUIRE_ORIGIN;
      const destClass = siteClassOfRequest(info.req);
      const ok = originAllowedHere(origin, destClass);
      if (!ok) console.warn("ws origin rejected:", origin);
      return ok;
    },
  });

  /**
   * Heartbeat: обрыв без FIN (мобильная сеть, уход вкладки в сон) иначе держал бы
   * клетку и слот комнаты до таймаута nginx. Пинг раз в 30 с; AFK/фоновые вкладки
   * часто отвечают с задержкой — рвём только после 3 промахов (~90 с), иначе
   * соседи видят «исчез → появился через 5–10 с» при каждом фоновом terminate.
   */
  const HB_MISS_MAX = 3;
  const hb = setInterval(() => {
    for (const ws of wss.clients) {
      const misses = Number(ws.hbMisses) || 0;
      if (ws.isAlive === false) {
        if (misses + 1 >= HB_MISS_MAX) {
          ws.terminate();
          continue;
        }
        ws.hbMisses = misses + 1;
      } else {
        ws.hbMisses = 0;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  hb.unref();

  wss.on("connection", (ws, req) => {
    ws.isAlive = true;
    ws.hbMisses = 0;
    handshake(ws, req); // назначает ws.clientIp (loopback+XFF → реальный адрес)
    const ip = ws.clientIp || String(req.socket.remoteAddress || "0");
    let counted = false;
    const releaseSlot = () => {
      if (!counted) return;
      counted = false;
      const n = (socketsPerIp.get(ip) || 1) - 1;
      if (n > 0) socketsPerIp.set(ip, n);
      else socketsPerIp.delete(ip);
    };
    const held = (socketsPerIp.get(ip) || 0) + 1;
    socketsPerIp.set(ip, held);
    counted = true;
    if (held > WS_MAX_PER_IP) {
      // S5a (аудит Z.AI 2026-11-08): SOCKET-флуд с одного адреса закрыт.
      console.warn(`ws per-ip limit: ip=${ip} open=${held} max=${WS_MAX_PER_IP}`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify([EV.INFO, `Слишком много соединений с одного адреса (too_many_sockets), лимит ${WS_MAX_PER_IP}.`]));
      }
      ws.close(1013, "too_many_sockets");
      ws.on("close", releaseSlot);
      ws.on("error", releaseSlot);
      return;
    }
    ws.on("pong", () => {
      ws.isAlive = true;
      ws.hbMisses = 0;
    });
    console.log(`ws open ${req.socket.remoteAddress || "?"} origin=${req.headers.origin || "-"}`);
    ws.on("message", (raw) => onMessage(ws, raw));
    ws.on("close", () => {
      releaseSlot();
      leave(ws);
    });
    ws.on("error", () => {
      releaseSlot();
      leave(ws);
    });
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
