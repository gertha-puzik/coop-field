/**
 * Combat domain (W4 carve, behavior-preserving): arrow angle coalescing (aim),
 * strike with the aimedNeighbor rule — MIRROR of the client's
 * src/lib/sim/targeting.ts pickStrikeTarget (both sides must pick the same
 * target part; parity is pinned by CI) — diagonal forcing, block re-check at
 * the moment of impact, and armor that cuts incoming damage along ARMOR_CURVE
 * (single source per side: ./protocol.js mirrors settings.ts; the client
 * mirror is NOT touched by W4). Damage stays client-authoritative (accepted
 * debt): the server only normalizes and cuts it.
 */
import { EV, STRIKE_ZONES, STRIKE_CATCH_MS, STRIKE_CATCH_MAX_MS, AIM_MIN_GAP_MS } from "./protocol.js";
import { maxStrikeDamage, snapArmorToUniverse } from "./cfg-registry.js";
import { combatCaps, armorCurve } from "./runtime-config.js";
import { STRIKE_COOLDOWN_MS } from "./config.js";
import { send, broadcast, publicCat } from "./room.js";

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
  broadcast(room, EV.UPDATE_CAT, publicCat(cat, room), exceptWs);
}

function aim(ws, payload = {}) {
  const cat = ws.room && ws.room.sockets.get(ws);
  if (!cat) {
    send(ws, EV.INFO, "Сначала зайдите в комнату.");
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

// ---------------- Броня ----------------
// Канон кривой — ARMOR_CURVE в server/protocol.js (W3, побайтовое зеркало —
// src/lib/sim/settings.ts; паритет держит CI test:protocol-parity). Живой
// расчёт ударов (мандат владелицы 2026-11-08) идёт по runtime-значению
// combat.armorCurve реестра (админ-панель), absence/мусор → канон W3
// (fail-safe в armorCurveFor). Клиентский прогноз урона считает по той же
// опубликованной кривой из GET /cfg (src/lib/sim/armor-curve.ts).

function armorMultiplier(armor) {
  const curve = armorCurve();
  const a = Number.isFinite(armor) ? Math.min(0.9, Math.max(0, Number(armor))) : 0;
  const base = curve[0][1];
  if (a <= curve[0][0]) return 1;
  for (let i = 1; i < curve.length; i++) {
    const [a1, p1] = curve[i];
    if (a <= a1) {
      const [a0, p0] = curve[i - 1];
      return Math.max(0, (p0 + ((p1 - p0) * (a - a0)) / (a1 - a0)) / base);
    }
  }
  const [a0, p0] = curve[curve.length - 2];
  const [a1, p1] = curve[curve.length - 1];
  return Math.max(0, (p1 + ((p1 - p0) * (a - a1)) / (a1 - a0)) / base);
}

/**
 * Пресет брони. Клиент → [EV.ARMOR-кадр, { armor: 0.3 }]. Whitelist реестра
 * (server/cfg-registry.js): значение снапится к НАИБОЛЬШЕЙ разрешённой десятой,
 * не превышающей вход (меньше или равно — больше запрошенного никогда не даём);
 * ниже наименьшей разрешённой — 0 (без брони). Хранится на коте. Соседям не
 * бродкастится: удар и так уходит всем в fight уже с порезанным бронёй урона
 * (см. strike).
 */
function armor(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!room || !cat) return;
  const allowed = combatCaps().armorTenths;
  cat.armor = snapArmorToUniverse(Number(payload.armor), allowed);
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
    send(ws, EV.INFO, "Сначала зайдите в комнату.");
    return;
  }
  const now = Date.now();
  if (now - cat.lastStrike < STRIKE_COOLDOWN_MS) return;

  const targetId = Number(payload.target ?? payload.id);
  const angle = Number(payload.angle);
  const resolved = resolveZone(payload.zone ?? payload.part);
  if (!Number.isInteger(targetId) || !resolved || !Number.isFinite(angle)) {
    cat.lastStrike = now;
    send(ws, EV.INFO, "Удар не разобран.");
    return;
  }
  const [zoneId0, zone0] = resolved;
  let zoneId = zoneId0;
  let zone = zone0;
  const target = room.cats.get(targetId);
  if (!target || target.id === cat.id) {
    cat.lastStrike = now;
    send(ws, EV.INFO, "Цель не в комнате.");
    return;
  }
  const aimed = aimedNeighbor(room, cat, angle);
  if (!aimed) {
    cat.lastStrike = now;
    send(ws, EV.INFO, "Рядом никого.");
    return;
  }
  if (aimed.id !== target.id) {
    cat.lastStrike = now;
    send(ws, EV.INFO, "Стрела смотрит не на эту цель.");
    return;
  }
  cat.lastStrike = now;
  // Блок цели: любой удар — в «Лапы», стойка бьющего (прямая/диагональ) не важна.
  // Исключение — хвост: удар в хвост блок не ловит, он проходит хвостом.
  if (target.blocking && zoneId0 !== "tail") {
    zoneId = "paws";
    zone = STRIKE_ZONES.paws;
  } else {
    const forced = diagonalZone(target.x - cat.x, target.y - cat.y);
    if (forced && zoneId !== forced) {
      cat.lastStrike = now;
      send(ws, EV.INFO, "С этой диагонали бьётся другая часть.");
      return;
    }
  }
  // Урон присылает бьющий (его пресет «Урон игрока», проценты энергии 0..100).
  // Число округляем и зажимаем; нет числа — фолбэк на серверную таблицу зон.
  // Whitelist P2: сверху режет формула зон из реестра по максимальному
  // РАЗРЕШЁННОМУ уровню (server/cfg-registry.js, maxStrikeDamage) — легальный
  // уровень игрока проходит без урезания, всё выше потолка срезается.
  const caps = combatCaps();
  const zoneCap = maxStrikeDamage(zoneId, caps.maxDamageLevel);
  const dmgRaw = Number(payload.damage);
  let damage = Number.isFinite(dmgRaw) ? Math.min(100, Math.max(0, Math.round(dmgRaw))) : zone.damage;
  damage = Math.min(damage, zoneCap);
  // Лаповый урон из пресета бьющего: если на моменте касания удар переводится
  // в «Лапы», списываем именно лаповый урон, а не урон исходной зоны.
  const pawsCap = maxStrikeDamage("paws", caps.maxDamageLevel);
  const pawsRaw = Number(payload.pawsDamage);
  const pawsDamage = Number.isFinite(pawsRaw)
    ? Math.min(pawsCap, Math.min(100, Math.max(0, Math.round(pawsRaw))))
    : null;
  // Окно полёта: блок, вставший после нажатия бьющего, но до касания, ловит удар.
  const flightRaw = Number(payload.flightMs);
  const flightMs = Number.isFinite(flightRaw)
    ? Math.min(STRIKE_CATCH_MAX_MS, Math.max(0, Math.round(flightRaw)))
    : STRIKE_CATCH_MS;
  const attackerId = cat.id;
  const thrown = {
    attacker: cat.login,
    attackerId: cat.id,
    targetId: target.id,
    name: target.login,
    part: zone.part,
    zone: zoneId,
    weapon: "",
    damage,
  };
  setTimeout(() => {
    // Цель вышла за время полёта — удар исчезает вместе с ней.
    if (!room.cats.has(targetId)) return;
    let part = thrown.part;
    let finalZoneId = thrown.zone;
    let finalDamage = thrown.damage;
    // Перепроверка блока в момент касания: удар «в полёте» блок ловит.
    // Исключение — хвост: блок не переносит удар из хвоста в «Лапы».
    if (target.blocking && zoneId0 !== "tail") {
      finalZoneId = "paws";
      part = STRIKE_ZONES.paws.part;
      if (pawsDamage !== null) finalDamage = pawsDamage;
      else if (zoneId0 !== "paws") finalDamage = STRIKE_ZONES.paws.damage;
    }
    // Броня цели режет любой входящий урон — и переведённый блоком в «Лапы»,
    // и хвост (блок хвост не ловит, а броня режет его как любой другой).
    finalDamage = Math.round(finalDamage * armorMultiplier(target.armor));
    const entry = {
      attacker: cat.login,
      attackerId,
      targetId: target.id,
      name: target.login,
      part,
      zone: finalZoneId,
      weapon: "",
      damage: finalDamage,
    };
    for (const sock of room.sockets.keys()) {
      send(sock, EV.FIGHT, {
        ...entry,
        isAttacking: room.sockets.get(sock)?.id === attackerId,
      });
    }
  }, flightMs);
}

export {
  clearAimTimer, normalizeDeg, aim, wrap360, wrap180, aimedNeighbor,
  diagonalZone, resolveZone, armorMultiplier, armor, strike,
};
