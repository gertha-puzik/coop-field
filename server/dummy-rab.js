/**
 * Room bots (W4 carve, behavior-preserving): the «ПОЧУХАТЬ» dummy (toggle,
 * drag in cell fractions, one grabber at a time) and the fixed «РАБ» target
 * dummy with its hit echo — both are DEMO-room props, disabled in the «test»
 * room (server-only check). Geometry defaults come from ./protocol.js
 * (DUMMY_DEFAULT, W3); the client only renders what these handlers broadcast.
 */
import { EV, DUMMY_DEFAULT } from "./protocol.js";
import { WIDTH, HEIGHT, SPRITES } from "./config.js";
import { send, broadcast } from "./room.js";

/**
 * Манекен «ПОЧУХАТЬ». Клиент → ["dummy", { on, sprite? }].
 * Включение ставит манекен туда, где его выключили (или в дефолт), sprite обновляет
 * скин из списка персонажей. Комнате (и включившему тоже) → один пакет dummyState.
 */
function dummyToggle(ws, payload = {}) {
  const room = ws.room;
  if (!room) {
    send(ws, EV.INFO, "Сначала зайдите в комнату.");
    return;
  }
  // В «тесте» — чистый полигон: манекен и мишень недоступны.
  if (room.fmt === 'test') {
    send(ws, EV.INFO, "В «Элизии Эйдес» манекен недоступен.");
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
  broadcast(room, EV.DUMMY_STATE, {
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
  broadcast(room, EV.DUMMY_MOVE, { x, y }, ws);
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
  broadcast(room, EV.DUMMY_GRAB, { login: room.dummyGrab });
}

/** Манекен отпущен. Клиент → ["dummyDrop"]. Комнате → ["dummyDrop"]. */
function dummyDrop(ws) {
  const room = ws.room;
  if (!room || !room.dummyGrab) return;
  const cat = room.sockets.get(ws);
  if (cat && room.dummyGrab !== cat.login) return;
  room.dummyGrab = null;
  broadcast(room, EV.DUMMY_DROP, {});
}

/**
 * Боевая мишень «РАБ». Клиент → ["rab", { on }]. Включение/выключение уходит всей
 * комнате (и включившему тоже) пакетом rabState. Позиция фиксирована (RAB_CELL).
 */
function rabToggle(ws, payload = {}) {
  const room = ws.room;
  if (!room) {
    send(ws, EV.INFO, "Сначала зайдите в комнату.");
    return;
  }
  if (room.fmt === 'test') {
    send(ws, EV.INFO, "В «Элизии Эйдес» мишень недоступна.");
    return;
  }
  const on = !!payload.on;
  room.rab = on ? { on: true } : null;
  broadcast(room, EV.RAB_STATE, { on });
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
    send(sock, EV.RAB_HIT, { zone, part, damage });
  }
}

export { dummyToggle, normDummyCoord, dummyMove, dummyGrab, dummyDrop, rabToggle, rabHit };
