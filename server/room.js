/**
 * Room domain (W4 carve, behavior-preserving): the rooms registry, per-cat
 * room state, join/leave lifecycle (one empty-room 10 min retention), spawn
 * cell selection, publicCat/field snapshots, and the per-room broadcast
 * primitives (send/broadcast) every other domain module reuses. Also holds
 * the player-state events that do not belong to a deeper domain: sprite
 * change, block, crouch-space, and the rooms list for the picker screen.
 * Event names and wire payloads are unchanged (server/protocol.js, W3).
 */
import { WebSocket } from "ws";
import { EV, MAX_PLAYERS, JOIN_COOLDOWN_MS, RAB_CELL } from "./protocol.js";
import { WIDTH, HEIGHT, SPAWNS, PALETTE, NAMES, SPRITES, TEST_ROOM, ROOMS_MAX } from "./config.js";
import { clearMoveTimer } from "./movement.js";
import { clearAimTimer } from "./combat.js";
import { rememberCat, flushCatBook, restoreCatPosition, forgetCat } from "./persist.js";
import { sanitizeLogin, uniqueLogin } from "./sanitize.js";
import { requiresAccount, RETIRED_ROOMS, modeOf } from "./modes.js";
// F2 (спек §3): per-room overrides атмосферных параметров — начальный якорь
// НОВОЙ комнаты из effective-слоёв (нет overrides → null → прежняя ленивая
// инициализация глобальным слоем, поведение неизменно).
import { initialRoomAtmo } from "./room-config.js";
import { activeCharacter, attachSprite } from "./accounts.js";
import { hungerState } from "./hunger.js";
import { atmoAnchor } from "./atmo.js";
import { testMap, TEST_PAINT, TEST_OBST_CELLS, TEST_WIDTH, TEST_HEIGHT } from "./testmap.js";
import { testCellInIsland, testWalkable, testPointInIsland } from "./world.js";

const rooms = new Map();
let nextId = 1001;

function send(ws, event, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify([event, payload]));
}

/** Нормализация кода комнаты: латиница/цифры/дефис/подчёркивание, до 24 символов.
 *  Одна и для join, и для списка комнат — иначе состав покажется не для той комнаты. */
function normalizeRoomCode(code) {
  return (
    String(code || "demo")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 24) || "demo"
  );
}

function roomOf(code) {
  const raw = normalizeRoomCode(code);
  // Снятые коды (P1, modes.RETIRED_ROOMS): легасий ?room=combat попадает в
  // grot-1, а не тихо разворачивается в произвольную открытую grid-комнату.
  const key = RETIRED_ROOMS[raw] || raw;
  if (!rooms.has(key)) {
    rooms.set(key, {
      code: key,
      fmt: key === TEST_ROOM ? 'test' : 'grid',
      cats: new Map(),
      sockets: new Map(),
      chat: [],
      chatSeq: 0,
      dummy: null,
      dummyLast: null,
      dummyGrab: null,
      rab: null,
      // Атмосфера комнаты — общая для всех: непрерывный цикл суток + погода.
      // Инициализируется лениво (atmoState): якорь уходит в снапшоте и событиями.
      // F2: у комнаты с admin-override atmo.* стартовый якорь строится сразу
      // из effective (движок ← глобал ← комната); без overrides — null.
      atmo: initialRoomAtmo(key),
    });
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
  // В «тесте» манекена и мишени нет — проверки не нужны.
  if (room.fmt === 'test') return false;
  if (room.dummy) {
    const c = objCell(room.dummy);
    if (c.cx === x - 1 && c.cy === y - 1) return true;
  }
  if (room.rab && RAB_CELL.x === x - 1 && RAB_CELL.y === y - 1) return true;
  return false;
}

function spawnCell(room) {
  const test = room.fmt === 'test';
  const W = test ? TEST_WIDTH : WIDTH;
  const H = test ? TEST_HEIGHT : HEIGHT;
  const ok = (x, y) => (test ? testWalkable(x, y) : true);
  if (test) {
    // Клетки спавна из конфига локации: новичок появляется на случайной свободной
    // из них. Занятые котами и заблокированные препятствиями клетки пропускаются;
    // свободных нет (или спавны не заданы) — прежняя логика ниже.
    const sp = testMap.spawns || [];
    if (sp.length > 0) {
      const free = [];
      for (const s of sp) {
        if (!Number.isInteger(s.c) || !Number.isInteger(s.r)) continue;
        if (s.c < 0 || s.r < 0 || s.c >= TEST_WIDTH || s.r >= TEST_HEIGHT) continue;
        if (TEST_OBST_CELLS.has(`${s.c},${s.r}`)) continue;
        if (occupied(room, s.c + 1, s.r + 1)) continue;
        free.push([s.c + 1, s.r + 1]);
      }
      if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
      console.log(`spawn cells all blocked/occupied: raw=${JSON.stringify(sp)}`);
    }
    // С пиксельной отрисовкой зелёные зоны больше не задают мирную территорию:
    // новичок появляется на любой закрашенной кистью клетке не на боевых.
    if (TEST_PAINT || testMap.zones.length===0) {
      for (let y = 1; y <= H; y++) {
        for (let x = 1; x <= W; x++) {
          if (!testPointInIsland(x-.5,y-.5)) continue;
          if (testWalkable(x, y)) continue; // боевые клетки — не для мирного спавна
          if (TEST_OBST_CELLS.has(`${x - 1},${y - 1}`)) continue;
          if (!occupied(room, x, y)) return [x, y];
        }
      }
      // закрашенных свободных нет — fallback на обычный перебор ниже
    }
    // Новичок в «тесте» появляется в мирном режиме — на траве (зелёная зона):
    // бой сам включится, когда игрок дойдёт до боевых клеток.
    const green = testMap.zones.filter((z) => z.kind === 'green');
    for (const z of green) {
      for (let y = z.r0 + 1; y <= z.r1 + 1; y++) {
        for (let x = z.c0 + 1; x <= z.c1 + 1; x++) {
          if (x < 1 || y < 1 || x > W || y > H) continue;
          if (!testCellInIsland(x - 1, y - 1)) continue;
          const onObj = TEST_OBST_CELLS.has(`${x - 1},${y - 1}`);
          if (onObj) continue;
          if (!occupied(room, x, y)) return [x, y];
        }
      }
    }
    // Зелёных зон нет или все заняты — fallback на боевые клетки.
  }
  for (const [x, y] of SPAWNS) {
    if (ok(x, y) && !occupied(room, x, y)) return [x, y];
  }
  for (let y = 1; y <= H; y++) {
    for (let x = 1; x <= W; x++) {
      if (ok(x, y) && !occupied(room, x, y)) return [x, y];
    }
  }
  return null;
}

function pickSprite(payload, slot) {
  const raw = String(payload.sprite || "").trim();
  if (SPRITES.includes(raw)) return raw;
  return SPRITES[slot % SPRITES.length];
}

/** Надетый окрас профиля, если он ещё в живом вайтлисте. Чужой и снятый id
 *  сюда не попадают: клиентский sprite в join их не воскрешает. */
function wornSprite(account) {
  const ch = account ? activeCharacter(account) : null;
  const saved = typeof ch?.sprite === "string" ? ch.sprite.trim() : "";
  return saved && SPRITES.includes(saved) ? saved : "";
}

function publicCat(cat, room) {
  const base = {
    id: cat.id,
    login: cat.login,
    color: cat.color,
    sprite: cat.sprite,
    x: cat.x,
    y: cat.y,
    deg: cat.deg,
    size: cat.size,
    blocking: !!cat.blocking,
    sq: cat.spaceHold ? 1 : 0,
  };
  // Комната «тест»: режим свободной ходьбы и позиция в клеточных долях —
  // новичкам и после переподключения (иначе свободный кот замрёт на клетке).
  if (room?.fmt === 'test') {
    base.fm = cat.fm ? 1 : 0;
    const fx = cat.fm ? cat.fx ?? cat.x - 1 : cat.x - 1;
    const fy = cat.fm ? cat.fy ?? cat.y - 1 : cat.y - 1;
    base.fx = Math.round(fx * 100) / 100;
    base.fy = Math.round(fy * 100) / 100;
  }
  return base;
}

function fieldPayload(room) {
  const test = room.fmt === 'test';
  const W = test ? TEST_WIDTH : WIDTH;
  const H = test ? TEST_HEIGHT : HEIGHT;
  const users = {};
  for (const cat of room.cats.values()) {
    if (!users[cat.x]) users[cat.x] = Array(H + 1).fill(null);
    users[cat.x][cat.y] = publicCat(cat, room);
  }
  return {
    width: W,
    height: H,
    format: test ? 'test' : undefined,
    room: room.code,
    // Конфиг локации «теста»: клиент рисует поле по нему и хранит как эталон
    // сохранённой локации (редактор откатывается к нему при закрытии без записи).
    ...(test ? { map: testMap } : {}),
    users,
    cats: [...room.cats.values()].map((c) => publicCat(c, room)),
    location: { name: test ? 'Пробная лужайка' : 'Расщелина меж скал', bg: test ? 4234811 : 71085 },
    dummy: room.dummy
      ? { on: true, x: room.dummy.x, y: room.dummy.y, sprite: room.dummy.sprite, grab: room.dummyGrab || null }
      : null,
    rab: room.rab ? { on: true } : null,
    // Атмосфера комнаты: якорь цикла суток и погоды — новичок видит то же, что и все.
    atmo: atmoAnchor(room),
    ...(room.code === "hunger" ? { hunger: hungerState(room) } : {}),
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
    broadcast(room, EV.DUMMY_DROP, {});
  }
  if (cat) {
    clearAimTimer(cat);
    clearMoveTimer(cat);
    cat.moveQueue = [];
    room.cats.delete(cat.id);
    // Книга позиций — только «тест». Клетка грота не должна затирать точку
    // Элизии, и наоборот: чужая клетка на поле 10×6 рисуется за кадром.
    if (room.fmt === "test") rememberCat(cat);
    flushCatBook(true);
    broadcast(room, EV.MOVE, { id: cat.id, x: 0, y: 0 });
    console.log(`ws leave room=${room.code} cat=${cat.login}#${cat.id}`);
  }
  ws.room = null;
  if (room.sockets.size === 0) keepEmptyRoom(room);
}

/**
 * Пустая комната живёт ещё RETENTION — на случай перезахода. Комната хранит
 * атмосферу (часы суток и погоду), чат и состояние манекена/мишени: когда игрок
 * «перезаходит на другого персонажа», сокет покидает комнату и тут же возвращается
 * — сброс комнаты в этот момент прыгал бы временем суток (часы стартовали заново
 * с середины «дня») и стирал чат. Если за отведённое время никто не вернулся,
 * комната удаляется совсем (память не течёт).
 */
const EMPTY_ROOM_RETENTION_MS = 10 * 60_000;

function keepEmptyRoom(room) {
  if (room.emptyTimer) clearTimeout(room.emptyTimer);
  room.emptyTimer = setTimeout(() => {
    room.emptyTimer = null;
    if (room.sockets.size === 0 && rooms.get(room.code) === room) rooms.delete(room.code);
  }, EMPTY_ROOM_RETENTION_MS);
  room.emptyTimer.unref();
}

function refuseJoin(ws, room, reason) {
  send(ws, EV.INFO, reason);
  send(ws, EV.NOPLACE, { room: room.code, reason });
}

/** S5b (аудит Z.AI 2026-11-08): живые комнаты — в которых есть хотя бы один
 * сокет; пустые (в 10-минутном удержании) слот потолка не занимают. */
function liveRoomsCount() {
  let n = 0;
  for (const room of rooms.values()) {
    if (room.sockets.size > 0) n += 1;
  }
  return n;
}

function join(ws, payload = {}) {
  const now = Date.now();
  if (now - (ws.lastJoin || 0) < JOIN_COOLDOWN_MS) {
    send(ws, EV.INFO, "Слишком часто. Подождите секунду.");
    return;
  }
  ws.lastJoin = now;
  if (ws.room) leave(ws);
  // S5b (аудит Z.AI 2026-11-08): потолок ЖИВЫХ комнат на процесс. Новую
  // комнату сверх ROOMS_MAX не создаём — отказ noplace 'rooms_full'
  // (не молчаливое создание). Существующая комната и вход по алиасу
  // RETIRED_ROOMS в УЖЕ созданную цель лимитом не затрагиваются:
  // alias резолвится в ключ target-комнаты и «новой» не считается.
  const rawKey = normalizeRoomCode(payload.room);
  const joinKey = RETIRED_ROOMS[rawKey] || rawKey;
  if (!rooms.has(joinKey) && liveRoomsCount() >= ROOMS_MAX) {
    send(ws, EV.INFO, "Сервер временно не открывает новые комнаты — попробуйте позже.");
    send(ws, EV.NOPLACE, { room: joinKey, reason: "rooms_full" });
    return;
  }
  const room = roomOf(payload.room);
  if (requiresAccount(room.code) && !ws.account) {
    send(ws, EV.REFUSE, { code: "auth_required", text: "Эта комната недоступна без входа." });
    send(ws, EV.INFO, "Эта комната недоступна без входа.");
    send(ws, EV.NOPLACE, { room: room.code, reason: "auth_required" });
    return;
  }
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
  const fromAccount = ws.account ? activeCharacter(ws.account) : null;
  // Надетый окрас — источник истины. Карусель входа и localStorage иначе
  // присылают базовый id и attachSprite затирает личный PNG в аккаунте.
  // Нет сохранённого (первый вход) — по-прежнему payload, если он в вайтлисте.
  const savedSprite = wornSprite(ws.account);
  if (fromAccount) attachSprite(ws.account, savedSprite || payload.sprite, payload.size);
  const wantedName = fromAccount ? fromAccount.name : payload.login;
  const login = uniqueLogin(room, sanitizeLogin(wantedName, NAMES[slot] || `Кот ${slot + 1}`));
  // Рост модельки, выбранный при спавне: клиент шлёт проценты (60–100).
  // Вне диапазона/не число — 100% (обычный рост).
  const sizeRaw = Number(payload.size);
  const size = Number.isFinite(sizeRaw) ? Math.min(100, Math.max(60, Math.round(sizeRaw))) : 100;
  const cat = {
    id: nextId++,
    login,
    color: PALETTE[slot % PALETTE.length],
    sprite: savedSprite || pickSprite(payload, slot),
    x: cell[0],
    y: cell[1],
    deg: 0,
    size,
    lastMove: 0,
    lastStrike: 0,
    lastAim: 0,
    lastChat: 0,
    // Блок (удержание К): любые удары по этому коту проводятся в «Лапы» (см. strike),
    // кроме хвоста — удар в хвост блок не ловит (исключение из правила).
    blocking: false,
    // Пресет брони 0–0,9: strike режет входящий урон по кривой замеров владельца.
    armor: 0,
    // Шаги, ждущие снятия кулдауна (см. queueMove), и их таймер.
    moveQueue: [],
    moveTimer: null,
    // В «тесте» новый кот — в мирном режиме (спавн на траве): fm=1, чтобы у соседей
    // до первого freemove не рисовалась боевая стрела (она видна только при fm=0).
    fm: room.fmt === 'test' ? 1 : 0,
  };
  room.cats.set(cat.id, cat);
  room.sockets.set(ws, cat);
  ws.room = room;
  // Рестарт сервера не выбрасывает кота на спавн: возвращаем его последнюю позицию
  // (см. restoreCatPosition) — особенно важно для АФК-котов.
  restoreCatPosition(room, cat);
  send(ws, EV.YOU, publicCat(cat, room));
  send(ws, EV.FIELD, fieldPayload(room));
  if (room.chat?.length) send(ws, EV.CHATLOG, room.chat);
  broadcast(room, EV.MOVE, publicCat(cat, room), ws);
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
    send(ws, EV.INFO, "Сначала зайдите в комнату.");
    return;
  }
  const sprite = String(payload.sprite || "").trim();
  if (!SPRITES.includes(sprite) || sprite === cat.sprite) return;
  cat.sprite = sprite;
  broadcast(
    room,
    EV.UPDATE_CAT,
    publicCat(cat, room),
    ws,
  );
}

/**
 * Блок (удержание К). Клиент → ["block", { on }]. Комнате (кроме отправителя) →
 * ["block", { id, on }]. Пока блок держится, strike проводит любые удары по этому
 * коту в зону «Лапы», кроме хвоста — удар в хвост блок не ловит (см. strike).
 * Состояние также входит в publicCat — новички видят его в field.
 */
function block(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat) return;
  cat.blocking = !!payload.on;
  broadcast(room, EV.BLOCK, { id: cat.id, on: cat.blocking }, ws);
}

/**
 * Присед-желе на пробеле (удержание). Клиент → ["space", { on: true }] при нажатии и
 * ["space", { on: false, hold, cancel? }] при отпускании: hold — сколько мс держал
 * (по нему чужие клиенты считают заряд «выстрела»), cancel — окно потеряло фокус,
 * выстрела не будет (кот просто выпрямляется). Комнате (кроме отправителя — он
 * анимирует локально) → ["space", { id, on, hold?, cancel? }]. Состояние «держит
 * пробел» входит в publicCat (sq) — новички и после обрыва видят приплющенного кота.
 */
function space(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat) return;
  cat.spaceHold = !!payload.on;
  const msg = { id: cat.id, on: cat.spaceHold };
  if (!cat.spaceHold) {
    msg.hold = Math.max(0, Math.min(4000, Math.round(Number(payload.hold) || 0)));
    msg.cancel = !!payload.cancel;
  }
  broadcast(room, EV.SPACE, msg, ws);
}

/**
 * Состав комнат для выбора: клиент → ["rooms", { ids: ["grot-1", ...] }],
 * сервер → ["roomsinfo", [{ id, count, logins }]] в порядке запроса.
 * Пустой комнаты в rooms нет — отвечаем нулём, НЕ создавая её (roomOf растит
 * карту; здесь только rooms.get — опрос состава комнат никогда не материализует
 * ленивую комнату).
 * Опрос частый (экран выбора обновляется каждые пару секунд), но обход дешёвый;
 * от спама одной строкой — минимальный интервал на сокет.
 * Закрытая комната (requiresAccount) для ГОСТЯ — призрак: count 0 и пустые
 * logins, как у несуществующей — гость не может даже сосчитать сидящих (P1,
 * спек §11: публичный гость не должен обнаруживать комнату Элизии).
 * Сессия с аккаунтом видит реальный состав — счётчик и имена.
 */
const ROOMS_MIN_GAP_MS = 250;

function roomsInfo(ws, payload = {}) {
  const now = Date.now();
  if (now - (ws.lastRooms || 0) < ROOMS_MIN_GAP_MS) return;
  ws.lastRooms = now;
  const ids = Array.isArray(payload?.ids) ? payload.ids : [];
  const list = ids.slice(0, 32).map((raw) => {
    const key = normalizeRoomCode(raw);
    // Гость простым кодом комнаты не разведает занятость закрытых комнат.
    const ghost = requiresAccount(key) && !ws.account;
    const room = ghost ? null : rooms.get(key);
    return {
      id: key,
      count: room ? room.cats.size : 0,
      logins: room ? [...room.cats.values()].map((c) => c.login) : [],
    };
  });
  send(ws, EV.ROOMSINFO, list);
}

/**
 * Занятость поля для админ-чтения (GET /admin/players): живые комнаты и их
 * коты — без копии состояния, строки собираются прямо из комнат через
 * publicCat (те же объекты, что рисуют поле). Пустые комнаты не показываем.
 * Полчленный fm/fx/fy — только для сверки freemove-точки «теста»: админ
 * принимает решение по координатам, не по подобию боевого протокола.
 */
function adminOccupancy() {
  const out = [];
  for (const room of rooms.values()) {
    if (room.cats.size === 0) continue;
    const cats = [];
    for (const cat of room.cats.values()) {
      const pc = publicCat(cat, room);
      cats.push({
        login: pc.login,
        id: pc.id,
        x: pc.x,
        y: pc.y,
        sprite: pc.sprite,
        fm: pc.fm ? 1 : 0,
        fx: Number.isFinite(pc.fx) ? pc.fx : null,
        fy: Number.isFinite(pc.fy) ? pc.fy : null,
      });
    }
    out.push({
      room: room.code,
      title: modeOf(room.code)?.title || room.code,
      fmt: room.fmt,
      count: room.cats.size,
      cats,
    });
  }
  return out;
}

/**
 * Админ-сброс положения кота (POST /admin/players/reset): вернуть его на
 * свежую клетку спавна spawnCell — как новичку после join. Персистная
 * freemove-точка стирается из книги точек (restore после рестарта не вернёт
 * прежнее место), очереди/прыжки гасятся, комнате раздан кадр EV.MOVE с
 * новыми координатами — им же join уже раздаёт вошедшего (EV не расширяется).
 * Ответ: { room, login, x, y, sprite } либо { error: { reason, message } } —
 * человекочитаемый message отдаётся панелью без перевода. Свободную клетку
 * обещает spawnCell: он исключает занятые клетки, включая клетку самого
 * сбрасываемого кота, — координаты меняются всегда.
 */
function resetPlayerPosition(rawRoom, rawLogin) {
  const key = RETIRED_ROOMS[normalizeRoomCode(rawRoom)] || normalizeRoomCode(rawRoom);
  const room = rooms.get(key);
  if (!room) {
    return {
      error: {
        reason: "unknown_room",
        message: `Комнаты «${key}» сейчас нет на сервере — она не открыта (в ней никого нет).`,
      },
    };
  }
  const login = String(rawLogin ?? "").trim();
  if (!login) return { error: { reason: "invalid_login", message: "Не указано имя кота." } };
  let cat = [...room.cats.values()].find((c) => c.login === login);
  if (!cat) {
    const low = login.toLowerCase();
    cat = [...room.cats.values()].find((c) => c.login.toLowerCase() === low);
  }
  if (!cat) {
    return {
      error: {
        reason: "unknown_cat",
        message: `Кота «${login}» в комнате «${modeOf(key)?.title || key}» нет.`,
      },
    };
  }
  const cell = spawnCell(room);
  if (!cell) {
    return {
      error: {
        reason: "no_free_cell",
        message: "На поле нет свободной клетки спавна — сбросить кота некуда.",
      },
    };
  }
  // Дозаписанные шаги очереди мертвы — движение после телепорта исполняется заново.
  clearMoveTimer(cat);
  cat.moveQueue = [];
  cat.x = cell[0];
  cat.y = cell[1];
  // Мирный режим, как у новичка со спавна (см. join): стрела не рисуется,
  // freemove-точка начинается заново с запаса клетки.
  cat.fm = room.fmt === "test" ? 1 : 0;
  delete cat.fx;
  delete cat.fy;
  cat.fsp = 0;
  cat.jp = 0;
  cat.freeJumpUntil = 0;
  // Прежняя точка уходит из книги персистентных позиций — атомарный слив
  // flushCatBook по конвенции записи; новая ходьба после сброса запишется сама.
  forgetCat(cat.login);
  flushCatBook(true);
  broadcast(room, EV.MOVE, publicCat(cat, room));
  console.log(`admin reset: room=${room.code} cat=${cat.login}#${cat.id} -> ${cell[0]},${cell[1]}`);
  return { room: room.code, login: cat.login, x: cell[0], y: cell[1], sprite: cat.sprite };
}

export {
  rooms, send, broadcast, normalizeRoomCode, occupied, publicCat, fieldPayload,
  leave, join, setSprite, block, space, roomsInfo, adminOccupancy, resetPlayerPosition,
};
