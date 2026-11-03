import { WebSocket } from "ws";

const url = process.env.WS_URL || "ws://127.0.0.1:3780";
const room = `t${Date.now().toString(36)}`;

function client(name, roomCode = room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on("open", () => {
      ws.send(JSON.stringify(["join", { room: roomCode, login: name }]));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      inbox.push(msg);
    });
    ws.on("error", reject);
    ws.inbox = inbox;
    ws.once("open", () => resolve(ws));
  });
}

function waitFor(ws, event, ms = 1500) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = ws.inbox.find((m) => m[0] === event);
      if (hit) return resolve(hit);
      if (Date.now() - start > ms) {
        return reject(new Error(`timeout waiting ${event} for inbox=${JSON.stringify(ws.inbox)}`));
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function connectBare() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const inbox = [];
    ws.on("message", (raw) => {
      inbox.push(JSON.parse(String(raw)));
    });
    ws.on("error", reject);
    ws.inbox = inbox;
    ws.once("open", () => resolve(ws));
  });
}

function cellKey(cat) {
  return `${cat.x}:${cat.y}`;
}

function assertUniqueCats(cats, label) {
  const cells = cats.map(cellKey);
  const uniq = new Set(cells);
  if (uniq.size !== cats.length) {
    throw new Error(`${label}: ${cats.length} cats, ${uniq.size} cells (${cells.join(",")})`);
  }
  return uniq;
}

function assertUsersGrid(field, label) {
  const cats = field?.cats || [];
  assertUniqueCats(cats, label);
  const grid = [];
  const users = field?.users || {};
  for (const x of Object.keys(users)) {
    const col = users[x];
    if (!Array.isArray(col)) continue;
    for (let y = 0; y < col.length; y++) {
      if (col[y]) grid.push(`${Number(x)}:${y}`);
    }
  }
  if (grid.length !== cats.length) {
    throw new Error(`${label}: users grid ${grid.length} != cats ${cats.length} (${grid.join(",")})`);
  }
  const gset = new Set(grid);
  if (gset.size !== grid.length) throw new Error(`${label}: users grid duplicated a cell`);
  for (const c of cats) {
    if (!gset.has(cellKey(c))) throw new Error(`${label}: cat ${cellKey(c)} missing from users`);
  }
}

function placedInUsers(users) {
  let n = 0;
  for (const col of Object.values(users || {})) {
    if (!Array.isArray(col)) continue;
    for (const cell of col) if (cell) n += 1;
  }
  return n;
}

function waitUntil(pred, ms, label) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error(`timeout ${label}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}

const a = await client("Альфа");
const b = await client("Бета");
const c = await client("Гамма");
await waitFor(a, "you");
await waitFor(b, "you");
await waitFor(c, "you");
await waitFor(a, "field");
await waitFor(b, "field");
const youC = (await waitFor(c, "you"))[1];
if (!youC || youC.x == null) throw new Error("4th-ready third cat missing");

const youA = a.inbox.find((m) => m[0] === "you")[1];
const youB = b.inbox.find((m) => m[0] === "you")[1];

// Четвёртый кот в ту же комнату — старый потолок 3 его не выталкивает.
const d = await client("Дельта");
const youD = (await waitFor(d, "you"))[1];
const refusedD = d.inbox.find((m) => m[0] === "noplace");
if (refusedD) throw new Error(`4th cat refused: ${JSON.stringify(refusedD)}`);
if (!youD?.id) throw new Error("4th cat did not get you");

a.inbox.length = 0;
b.inbox.length = 0;
c.inbox.length = 0;

// Поворот стрелы на месте: клетка та же, угол виден другому сокету.
a.send(JSON.stringify(["aim", { deg: 123.4 }]));
const aimPatch = await waitFor(b, "update cat");
if (aimPatch[1].id !== youA.id) throw new Error("aim broadcast id mismatch");
if (aimPatch[1].x !== youA.x || aimPatch[1].y !== youA.y) {
  throw new Error(`aim moved the cat ${JSON.stringify(aimPatch[1])}`);
}
if (Math.abs(aimPatch[1].deg - 123.4) > 0.15) throw new Error(`aim deg ${aimPatch[1].deg}`);
if (a.inbox.some((m) => m[0] === "update cat")) throw new Error("aim echoed to the spinner");
a.send(JSON.stringify(["aim", { deg: 200 }]));
await sleep(80);
const spun = b.inbox.filter((m) => m[0] === "update cat");
const lastSpin = spun[spun.length - 1];
if (!lastSpin || Math.abs(lastSpin[1].deg - 200) > 0.15) {
  throw new Error(`coalesced aim missing, saw ${JSON.stringify(spun.map((m) => m[1].deg))}`);
}
b.inbox.length = 0;
a.send(JSON.stringify(["aim", { deg: 370 }]));
const wrappedAim = await waitFor(b, "update cat");
if (Math.abs(wrappedAim[1].deg - 10) > 0.15) throw new Error(`aim wrap ${wrappedAim[1].deg}`);
console.log("ok: aim in place", youA.x, youA.y, "→", wrappedAim[1].deg);

a.inbox.length = 0;
b.inbox.length = 0;
c.inbox.length = 0;

const aim = (Math.atan2(youB.y - youA.y, youB.x - youA.x) * 180) / Math.PI;
// damage — урон бьюшего (пресет «Урон игрока»): сервер обязан раздавать его как есть.
a.send(JSON.stringify(["strike", { target: youB.id, zone: "throat", angle: aim, damage: 60 }]));
const fightA = await waitFor(a, "fight");
const fightB = await waitFor(b, "fight");
const fightC = await waitFor(c, "fight");

for (const [who, msg] of [["A", fightA], ["B", fightB], ["C", fightC]]) {
  const hit = msg[1];
  if (hit.attackerId !== youA.id || hit.targetId !== youB.id) {
    throw new Error(`${who} fight ids ${JSON.stringify(hit)}`);
  }
  if (hit.attacker !== "Альфа" || hit.name !== "Бета") {
    throw new Error(`${who} fight names ${JSON.stringify(hit)}`);
  }
  if (hit.part !== "Горло" || hit.zone !== "throat") {
    throw new Error(`${who} fight part ${JSON.stringify(hit)}`);
  }
  if (hit.weapon !== "") throw new Error(`${who} unexpected weapon ${hit.weapon}`);
}
if (fightA[1].isAttacking !== true) throw new Error("attacker isAttacking");
if (fightB[1].isAttacking !== false) throw new Error("victim isAttacking");
if (fightC[1].isAttacking !== false) throw new Error("spectator isAttacking");
for (const [who, msg] of [["A", fightA], ["B", fightB], ["C", fightC]]) {
  if (msg[1].damage !== 60) throw new Error(`${who} fight damage ${JSON.stringify(msg[1].damage)}`);
}
console.log("ok: strike", fightA[1].attacker, "→", fightA[1].name, fightA[1].part, "damage", fightA[1].damage);

a.inbox.length = 0;
b.inbox.length = 0;

// First spawn is (4,3), second (5,3) — step left, not onto the neighbour.
const dx = youB && youB.x === youA.x + 1 ? -1 : 1;
a.send(JSON.stringify(["move", { x: dx, y: 0 }]));
const patchB = await waitFor(b, "update cat");
const patchA = await waitFor(a, "update cat");

if (patchB[1].id !== youA.id) throw new Error("broadcast id mismatch");
if (patchB[1].x !== youA.x + dx || patchB[1].y !== youA.y) {
  throw new Error(`bad coords ${JSON.stringify(patchB[1])}`);
}
if (patchA[1].x !== patchB[1].x) throw new Error("self echo mismatch");
if (Math.abs(patchB[1].deg - 10) > 0.15) throw new Error(`move reset arrow to ${patchB[1].deg}`);
console.log("ok: 2 sockets, room", room, "move", youA.x, youA.y, "→", patchB[1].x, patchB[1].y, "deg", patchB[1].deg);

a.inbox.length = 0;
b.inbox.length = 0;
await sleep(40);
a.send(JSON.stringify(["strike", { target: youB.id, zone: "throat", angle: aim }]));
const far = await waitFor(a, "info");
const farText = String(far[1]);
if (!farText.includes("Рядом") && !farText.includes("не на эту цель")) {
  throw new Error(`expected range reject, got ${farText}`);
}
await sleep(80);
if (b.inbox.some((m) => m[0] === "fight")) throw new Error("victim got a fight from a non-adjacent strike");
console.log("ok: non-adjacent strike rejected");

// Диагональ: отдельная комната, морда принимается, горло — нет.
const diagRoom = `d${Date.now().toString(36)}`;
const left = await client("Слева", diagRoom);
const right = await client("Справа", diagRoom);
const leftYou = (await waitFor(left, "you"))[1];
const rightYou = (await waitFor(right, "you"))[1];
left.inbox.length = 0;
right.inbox.length = 0;
left.send(JSON.stringify(["move", { x: 0, y: -1 }]));
await waitFor(left, "update cat");
await sleep(40);
const diagAngle = (Math.atan2(rightYou.y - (leftYou.y - 1), rightYou.x - leftYou.x) * 180) / Math.PI;
left.send(JSON.stringify(["strike", { target: rightYou.id, zone: "throat", angle: diagAngle }]));
const diagReject = await waitFor(left, "info");
if (!String(diagReject[1]).includes("диагонали")) {
  throw new Error(`expected diagonal reject, got ${diagReject[1]}`);
}
await sleep(40);
left.inbox.length = 0;
right.inbox.length = 0;
left.send(JSON.stringify(["strike", { target: rightYou.id, zone: "muzzle", angle: diagAngle }]));
const diagHit = await waitFor(right, "fight");
if (diagHit[1].part !== "Морда" || diagHit[1].name !== "Справа" || diagHit[1].isAttacking !== false) {
  throw new Error(`bad diagonal fight ${JSON.stringify(diagHit[1])}`);
}
// Без damage в ударе сервер берёт урон из своей таблицы (морда = 18).
if (diagHit[1].damage !== 18) throw new Error(`diagonal fallback damage ${JSON.stringify(diagHit[1].damage)}`);
console.log("ok: diagonal muzzle accepted, throat rejected");

// Блок: пока кот держит блок, любой его удар — только в «Лапы», стойка бьющего не важна.
right.send(JSON.stringify(["block", { on: true }]));
const blockOn = await waitFor(left, "block");
if (blockOn[1].id !== rightYou.id || blockOn[1].on !== true) {
  throw new Error(`block on relay ${JSON.stringify(blockOn[1])}`);
}
if (right.inbox.some((m) => m[0] === "block")) throw new Error("block echoed to the blocker");
// Новичок в комнате видит блокирующего в field с blocking: true.
const blockWatcher = await client("Наблюдатель", diagRoom);
const fieldW = (await waitFor(blockWatcher, "field"))[1];
const blockerInField = (fieldW.cats || []).find((c) => c.id === rightYou.id);
if (!blockerInField || blockerInField.blocking !== true) {
  throw new Error(`field blocking ${JSON.stringify(blockerInField)}`);
}
left.inbox.length = 0;
right.inbox.length = 0;
// Диагональное «горло» по блокирующему проходит — но как «Лапы» (урон бьющего 6).
left.send(JSON.stringify(["strike", { target: rightYou.id, zone: "throat", angle: diagAngle, damage: 6 }]));
const blockedHit = await waitFor(right, "fight");
if (blockedHit[1].zone !== "paws" || blockedHit[1].part !== "Лапы") {
  throw new Error(`blocked strike zone ${JSON.stringify(blockedHit[1])}`);
}
if (blockedHit[1].damage !== 6) throw new Error(`blocked strike damage ${JSON.stringify(blockedHit[1].damage)}`);
left.inbox.length = 0;
right.inbox.length = 0;
right.send(JSON.stringify(["block", { on: false }]));
const blockOff = await waitFor(left, "block");
if (blockOff[1].id !== rightYou.id || blockOff[1].on !== false) {
  throw new Error(`block off relay ${JSON.stringify(blockOff[1])}`);
}
left.inbox.length = 0;
await sleep(40);
// Блок снят — диагональное горло снова отклоняется.
left.send(JSON.stringify(["strike", { target: rightYou.id, zone: "throat", angle: diagAngle }]));
const diagReject2 = await waitFor(left, "info");
if (!String(diagReject2[1]).includes("диагонали")) {
  throw new Error(`expected diagonal reject after unblock, got ${diagReject2[1]}`);
}
console.log("ok: block", "→ relay on/off, any strike lands in paws");

// Удар «в полёте»: блок, вставший после броска, ловит удар в «Лапы»
// с лаповым уроном пресета бьющего (pawsDamage), а не с уроном исходной зоны.
left.inbox.length = 0;
right.inbox.length = 0;
await sleep(40); // кулдаун удара после отклонённого удара предыдущего теста
left.send(JSON.stringify(["strike", { target: rightYou.id, zone: "muzzle", angle: diagAngle, damage: 20, pawsDamage: 7, flightMs: 150 }]));
right.send(JSON.stringify(["block", { on: true }]));
const flightCatch = await waitFor(right, "fight");
if (flightCatch[1].zone !== "paws" || flightCatch[1].part !== "Лапы") {
  throw new Error(`flight catch zone ${JSON.stringify(flightCatch[1])}`);
}
if (flightCatch[1].damage !== 7) throw new Error(`flight catch damage ${JSON.stringify(flightCatch[1].damage)}`);
right.send(JSON.stringify(["block", { on: false }]));
await sleep(60);
console.log("ok: block catches a strike in flight → paws, paws damage");

// Блок успел встать и снялся до касания — удар летит как брошенный (морда, 20).
left.inbox.length = 0;
right.inbox.length = 0;
await sleep(40);
left.send(JSON.stringify(["strike", { target: rightYou.id, zone: "muzzle", angle: diagAngle, damage: 20, pawsDamage: 7, flightMs: 150 }]));
right.send(JSON.stringify(["block", { on: true }]));
right.send(JSON.stringify(["block", { on: false }]));
const flightMiss = await waitFor(right, "fight");
if (flightMiss[1].zone !== "muzzle" || flightMiss[1].part !== "Морда" || flightMiss[1].damage !== 20) {
  throw new Error(`flight miss ${JSON.stringify(flightMiss[1])}`);
}
console.log("ok: block dropped before impact → strike lands as thrown");

// Хвост и блок: хвост — ЕДИНСТВЕННОЕ исключение из блока. Блок проводит любой удар
// в «Лапы», но удар в хвост не переносит: он остаётся хвостом и по логу, и по урону.
// 1) Блок уже стоит — удар в хвост проходит хвостом с уроном бьющего (33).
// 2) Блока нет — то же самое: хвост проходит хвостом.
// 3) Блок встал, пока удар летит — хвост всё равно проходит хвостом (исключение).
// 4) Контраст: удар в морду по стоящему блоку — «Лапы» с лаповым уроном бьющего.
const tailRoom = `t${Date.now().toString(36)}tail`;
const tAtk = await client("Хвостобой", tailRoom);
const tDef = await client("Хвостостой", tailRoom);
const tAtkYou = (await waitFor(tAtk, "you"))[1];
const tDefYou = (await waitFor(tDef, "you"))[1];
const tailAngle = (Math.atan2(tDefYou.y - tAtkYou.y, tDefYou.x - tAtkYou.x) * 180) / Math.PI;
await sleep(60);
tDef.send(JSON.stringify(["block", { on: true }]));
await waitFor(tAtk, "block");
tAtk.inbox.length = 0;
tDef.inbox.length = 0;
tAtk.send(JSON.stringify(["strike", { target: tDefYou.id, zone: "tail", angle: tailAngle, damage: 33, pawsDamage: 5 }]));
const tailBlocked = await waitFor(tDef, "fight");
if (tailBlocked[1].zone !== "tail" || tailBlocked[1].part !== "Хвост" || tailBlocked[1].damage !== 33) {
  throw new Error(`tail vs block ${JSON.stringify(tailBlocked[1])}`);
}
console.log("ok: tail strike vs standing block → tail, tail damage (block exception)");
tDef.send(JSON.stringify(["block", { on: false }]));
await waitFor(tAtk, "block");
await sleep(80);
tAtk.inbox.length = 0;
tDef.inbox.length = 0;
tAtk.send(JSON.stringify(["strike", { target: tDefYou.id, zone: "tail", angle: tailAngle, damage: 33 }]));
const tailFree = await waitFor(tDef, "fight");
if (tailFree[1].zone !== "tail" || tailFree[1].part !== "Хвост" || tailFree[1].damage !== 33) {
  throw new Error(`tail without block ${JSON.stringify(tailFree[1])}`);
}
console.log("ok: tail strike without block → tail");
await sleep(80);
tAtk.inbox.length = 0;
tDef.inbox.length = 0;
tAtk.send(JSON.stringify(["strike", { target: tDefYou.id, zone: "tail", angle: tailAngle, damage: 33, pawsDamage: 5, flightMs: 150 }]));
tDef.send(JSON.stringify(["block", { on: true }]));
const tailFlight = await waitFor(tDef, "fight");
if (tailFlight[1].zone !== "tail" || tailFlight[1].part !== "Хвост" || tailFlight[1].damage !== 33) {
  throw new Error(`tail flight exception ${JSON.stringify(tailFlight[1])}`);
}
console.log("ok: tail strike vs block risen in flight → tail (exception)");
// Контраст: не-хвостовая зона по стоящему блоку по-прежнему ловится в «Лапы».
await sleep(80);
tAtk.inbox.length = 0;
tDef.inbox.length = 0;
tAtk.send(JSON.stringify(["strike", { target: tDefYou.id, zone: "muzzle", angle: tailAngle, damage: 33, pawsDamage: 5 }]));
const muzzleBlocked = await waitFor(tDef, "fight");
if (muzzleBlocked[1].zone !== "paws" || muzzleBlocked[1].part !== "Лапы" || muzzleBlocked[1].damage !== 5) {
  throw new Error(`muzzle vs block ${JSON.stringify(muzzleBlocked[1])}`);
}
tDef.send(JSON.stringify(["block", { on: false }]));
tAtk.close();
tDef.close();
console.log("ok: non-tail strike vs standing block → paws, paws damage");

// Броня: пресет цели режет получаемый урон по кривой замеров владельца
// (множитель = урон(броня) / урон(0,0): 0,9 ≈ 0,38275, 0,5 ≈ 0,72917).
// Броня режет любой входящий удар — включая хвост: блок хвост не ловит, а броня режет.
// 1) броня 0,9 — горло 42 проходит как round(42·0,38275) = 16;
// 2) броня 0,5 — горло 42 проходит как 31;
// 3) броня 0,0 — урон проходит целиком;
// 4) броня 0,9 + блок — морда переводится в «Лапы», лаповый урон 5 проходит как 2;
// 5) хвост по бронированному блокирующему — остаётся хвостом, 33 проходит как 13;
// 6) зажим: armor 5 ведёт себя как 0,9.
const armRoom = `t${Date.now().toString(36)}arm`;
const aAtk = await client("Пробойник", armRoom);
const aDef = await client("Панцирь", armRoom);
const aAtkYou = (await waitFor(aAtk, "you"))[1];
const aDefYou = (await waitFor(aDef, "you"))[1];
const armAngle = (Math.atan2(aDefYou.y - aAtkYou.y, aDefYou.x - aAtkYou.x) * 180) / Math.PI;
await sleep(60);
aDef.send(JSON.stringify(["armor", { armor: 0.9 }]));
await sleep(60);
aAtk.inbox.length = 0;
aDef.inbox.length = 0;
aAtk.send(JSON.stringify(["strike", { target: aDefYou.id, zone: "throat", angle: armAngle, damage: 42 }]));
const arm09 = await waitFor(aDef, "fight");
if (arm09[1].zone !== "throat" || arm09[1].damage !== 16) {
  throw new Error(`armor 0.9 damage ${JSON.stringify(arm09[1])}`);
}
console.log("ok: armor 0.9 → throat 42 lands as 16");
aDef.send(JSON.stringify(["armor", { armor: 0.5 }]));
await sleep(60);
aAtk.inbox.length = 0;
aDef.inbox.length = 0;
aAtk.send(JSON.stringify(["strike", { target: aDefYou.id, zone: "throat", angle: armAngle, damage: 42 }]));
const arm05 = await waitFor(aDef, "fight");
if (arm05[1].damage !== 31) throw new Error(`armor 0.5 damage ${JSON.stringify(arm05[1])}`);
console.log("ok: armor 0.5 → throat 42 lands as 31");
aDef.send(JSON.stringify(["armor", { armor: 0 }]));
await sleep(60);
aAtk.inbox.length = 0;
aDef.inbox.length = 0;
aAtk.send(JSON.stringify(["strike", { target: aDefYou.id, zone: "throat", angle: armAngle, damage: 42 }]));
const arm00 = await waitFor(aDef, "fight");
if (arm00[1].damage !== 42) throw new Error(`armor 0 damage ${JSON.stringify(arm00[1])}`);
console.log("ok: armor 0.0 → damage passes fully");
aDef.send(JSON.stringify(["armor", { armor: 0.9 }]));
aDef.send(JSON.stringify(["block", { on: true }]));
await waitFor(aAtk, "block");
await sleep(60);
aAtk.inbox.length = 0;
aDef.inbox.length = 0;
aAtk.send(JSON.stringify(["strike", { target: aDefYou.id, zone: "muzzle", angle: armAngle, damage: 42, pawsDamage: 5 }]));
const armBlock = await waitFor(aDef, "fight");
if (armBlock[1].zone !== "paws" || armBlock[1].part !== "Лапы" || armBlock[1].damage !== 2) {
  throw new Error(`armor + block ${JSON.stringify(armBlock[1])}`);
}
console.log("ok: armor 0.9 + block → paws damage 5 lands as 2");
await sleep(60);
aAtk.inbox.length = 0;
aDef.inbox.length = 0;
aAtk.send(JSON.stringify(["strike", { target: aDefYou.id, zone: "tail", angle: armAngle, damage: 33 }]));
const armTail = await waitFor(aDef, "fight");
if (armTail[1].zone !== "tail" || armTail[1].part !== "Хвост" || armTail[1].damage !== 13) {
  throw new Error(`armor tail ${JSON.stringify(armTail[1])}`);
}
aDef.send(JSON.stringify(["block", { on: false }]));
await waitFor(aAtk, "block");
console.log("ok: armored tail vs block → tail, 13");
await sleep(60);
aDef.send(JSON.stringify(["armor", { armor: 5 }]));
await sleep(60);
aAtk.inbox.length = 0;
aDef.inbox.length = 0;
aAtk.send(JSON.stringify(["strike", { target: aDefYou.id, zone: "throat", angle: armAngle, damage: 42 }]));
const armClamp = await waitFor(aDef, "fight");
if (armClamp[1].damage !== 16) throw new Error(`armor clamp ${JSON.stringify(armClamp[1])}`);
aAtk.close();
aDef.close();
console.log("ok: armor clamped to 0.9");

// Состав комнат для выбора: roomsinfo отвечает по запрошенным id в порядке запроса,
// пустая комната — count 0 и пустой список (комната при этом НЕ создаётся).
// Гроты запрашиваем одним взглядом (count >= 0), а точный состав — на уникальных
// комнатах, чтобы тест не зависел от живых игроков в общих комнатах.
const infoRoom = `g${Date.now().toString(36)}a`;
const infoRoom2 = `g${Date.now().toString(36)}b`;
const asker = await client("Осведомитель", infoRoom);
await waitFor(asker, "you");
asker.inbox.length = 0;
asker.send(JSON.stringify(["rooms", { ids: ["grot-1", infoRoom, infoRoom2, "Пивной грот №3!"] }]));
const roomsList = (await waitFor(asker, "roomsinfo"))[1];
if (!Array.isArray(roomsList) || roomsList.length !== 4) {
  throw new Error(`roomsinfo shape ${JSON.stringify(roomsList)}`);
}
if (roomsList[0].id !== "grot-1" || typeof roomsList[0].count !== "number" || roomsList[0].count < 0 || !Array.isArray(roomsList[0].logins)) {
  throw new Error(`roomsinfo grot-1 ${JSON.stringify(roomsList[0])}`);
}
if (roomsList[1].id !== infoRoom || roomsList[1].count !== 1 || JSON.stringify(roomsList[1].logins) !== JSON.stringify(["Осведомитель"])) {
  throw new Error(`roomsinfo own room ${JSON.stringify(roomsList[1])}`);
}
if (roomsList[2].id !== infoRoom2 || roomsList[2].count !== 0 || roomsList[2].logins.length !== 0) {
  throw new Error(`roomsinfo empty room ${JSON.stringify(roomsList[2])}`);
}
// Кириллица и «№» вычищаются нормализацией — код совпадает с join-нормализацией,
// для «Пивной грот №3!» останется только «3», комнаты нет — нули без создания.
if (roomsList[3].id !== "3" || roomsList[3].count !== 0) {
  throw new Error(`roomsinfo normalization ${JSON.stringify(roomsList[3])}`);
}
console.log("ok: roomsinfo counts, logins, empty rooms, code normalization");
// Второй кот в ту же комнату — состав обновляется (после минимального интервала).
const joiner = await client("Присоединившийся", infoRoom);
await waitFor(joiner, "you");
await sleep(300);
asker.inbox.length = 0;
asker.send(JSON.stringify(["rooms", { ids: [infoRoom] }]));
const roomsList2 = (await waitFor(asker, "roomsinfo"))[1];
if (roomsList2[0].count !== 2) throw new Error(`roomsinfo count after join ${JSON.stringify(roomsList2[0])}`);
if (!roomsList2[0].logins.includes("Присоединившийся")) throw new Error(`roomsinfo logins ${JSON.stringify(roomsList2[0])}`);
asker.close();
joiner.close();
console.log("ok: roomsinfo reflects a join");

// Потолок 30: 31-й получает noplace, клетки не совпадают.
const capRoom = `c${Date.now().toString(36)}`;
const held = [];
const cells = [];
for (let i = 0; i < 30; i++) {
  const ws = await client(`К${i + 1}`, capRoom);
  held.push(ws);
  const you = (await waitFor(ws, "you", 3000))[1];
  if (ws.inbox.some((m) => m[0] === "noplace")) throw new Error(`cat ${i + 1} got noplace`);
  cells.push(`${you.x}:${you.y}`);
}
const seen = new Set(cells);
if (seen.size !== 30) throw new Error(`expected 30 unique cells, got ${seen.size}`);
const field30 = held[held.length - 1].inbox.find((m) => m[0] === "field");
if (!field30) throw new Error("30th cat has no field");
if (field30[1].cats.length !== 30) throw new Error(`cap field cats ${field30[1].cats.length}`);
assertUsersGrid(field30[1], "cap field");
const overflow = await client("Лишний", capRoom);
const noplace = await waitFor(overflow, "noplace");
const reason = String(noplace[1]?.reason || "");
if (!reason.includes("30")) throw new Error(`noplace reason missing 30: ${reason}`);
if (overflow.inbox.some((m) => m[0] === "you")) throw new Error("31st cat was seated");
console.log("ok: cap 30, 31st refused,", reason);

// Второй вход не встаёт в занятую клетку. Спавны (4,3) и (5,3) соседние:
// шаг второго в клетку первого отвергается, сетка users не схлопывает котов.
const pairRoom = `p${Date.now().toString(36)}`;
const first = await client("Первый", pairRoom);
const firstYou = (await waitFor(first, "you"))[1];
const second = await client("Второй", pairRoom);
const secondYou = (await waitFor(second, "you"))[1];
if (cellKey(firstYou) === cellKey(secondYou)) {
  throw new Error(`second join landed on occupied ${cellKey(firstYou)}`);
}
const cheb = Math.max(Math.abs(firstYou.x - secondYou.x), Math.abs(firstYou.y - secondYou.y));
if (cheb !== 1) throw new Error(`spawns not adjacent: ${cellKey(firstYou)} ${cellKey(secondYou)}`);
const pairField = second.inbox.find((m) => m[0] === "field");
if (!pairField) throw new Error("second join has no field");
assertUsersGrid(pairField[1], "pair field");
second.inbox.length = 0;
second.send(JSON.stringify(["move", { x: Math.sign(firstYou.x - secondYou.x), y: Math.sign(firstYou.y - secondYou.y) }]));
const blocked = await waitFor(second, "info");
if (!String(blocked[1]).includes("занята")) {
  throw new Error(`expected occupied reject, got ${blocked[1]}`);
}
await sleep(40);
if (second.inbox.some((m) => m[0] === "update cat" && m[1].x === firstYou.x && m[1].y === firstYou.y)) {
  throw new Error("second moved onto first cell");
}
console.log("ok: second join", cellKey(firstYou), "!=", cellKey(secondYou));

// Пачка join без паузы между сокетами: обработчик синхронный, клетки всё равно разные.
const burstRoom = `b${Date.now().toString(36)}`;
const burstN = 12;
const burst = await Promise.all(Array.from({ length: burstN }, (_, i) => client(`Б${i + 1}`, burstRoom)));
const burstYous = [];
for (const ws of burst) burstYous.push((await waitFor(ws, "you", 3000))[1]);
assertUniqueCats(burstYous, "burst join");
let fullest = null;
for (const ws of burst) {
  const f = ws.inbox.find((m) => m[0] === "field");
  if (f && (!fullest || f[1].cats.length > fullest[1].cats.length)) fullest = f;
}
if (!fullest || fullest[1].cats.length !== burstN) {
  throw new Error(`burst field size ${fullest ? fullest[1].cats.length : 0}`);
}
assertUsersGrid(fullest[1], "burst field");
console.log("ok: burst", burstN, "unique cells");

// Углы с шагом в десятки мс доходят все, а не только первый и образец через ~200 мс.
// Шаг без deg оставляет последний aim, а не разворачивает стрелу по направлению клетки.
const aimRoom = `aim${Date.now().toString(36)}`;
const spinner = await client("Крутит", aimRoom);
const watcher = await client("Смотрит", aimRoom);
const spinYou = (await waitFor(spinner, "you"))[1];
await waitFor(watcher, "you");
watcher.inbox.length = 0;
const angles = [12, 24, 36, 48, 60];
for (const deg of angles) {
  spinner.send(JSON.stringify(["aim", { deg }]));
  await sleep(35);
}
await sleep(50);
const got = watcher.inbox
  .filter((m) => m[0] === "update cat" && m[1].id === spinYou.id)
  .map((m) => m[1].deg);
for (const deg of angles) {
  if (!got.some((g) => Math.abs(g - deg) < 0.15)) {
    throw new Error(`missing intermediate aim ${deg}, saw ${JSON.stringify(got)}`);
  }
}
watcher.inbox.length = 0;
spinner.send(JSON.stringify(["move", { x: 0, y: -1 }]));
const kept = await waitFor(watcher, "update cat");
if (Math.abs(kept[1].deg - 60) > 0.15) throw new Error(`move overwrote aim: ${kept[1].deg}`);
if (kept[1].y !== spinYou.y - 1 || kept[1].x !== spinYou.x) {
  throw new Error(`unexpected move ${JSON.stringify(kept[1])}`);
}
watcher.inbox.length = 0;
spinner.send(JSON.stringify(["aim", { deg: 70 }]));
spinner.send(JSON.stringify(["aim", { deg: 80 }]));
spinner.send(JSON.stringify(["aim", { deg: 90 }]));
await sleep(60);
const flushed = watcher.inbox
  .filter((m) => m[0] === "update cat" && m[1].id === spinYou.id)
  .map((m) => m[1].deg);
if (!flushed.some((g) => Math.abs(g - 90) < 0.15)) {
  throw new Error(`latest aim stuck, saw ${JSON.stringify(flushed)}`);
}
console.log("ok: aim cadence", got.join(","), "move kept", kept[1].deg, "flush", flushed.join(","));

// 30 входов в одну комнату без паузы между send: каждый join целиком
// синхронный, так что клетка в "you" не может уже быть занята.
const guardRoom = `b${Date.now().toString(36)}`;
const BURST = 30;
const guardBurst = await Promise.all(Array.from({ length: BURST }, () => connectBare()));
for (let i = 0; i < BURST; i++) {
  guardBurst[i].send(JSON.stringify(["join", { room: guardRoom, login: `Б${i + 1}` }]));
}
const burstYou = [];
const fieldSizes = [];
for (let i = 0; i < BURST; i++) {
  const ws = guardBurst[i];
  const you = (await waitFor(ws, "you", 4000))[1];
  const field = (await waitFor(ws, "field", 4000))[1];
  if (ws.inbox.some((m) => m[0] === "noplace")) {
    throw new Error(`burst cat ${i + 1} got noplace`);
  }
  if (you.x < 1 || you.x > field.width || you.y < 1 || you.y > field.height) {
    throw new Error(`burst cat ${i + 1} outside field ${cellKey(you)}`);
  }
  const same = (field.cats || []).filter((c) => c.x === you.x && c.y === you.y);
  if (same.length !== 1 || same[0].id !== you.id) {
    throw new Error(`join returned occupied cell ${cellKey(you)} cats=${JSON.stringify(same)}`);
  }
  const keys = (field.cats || []).map(cellKey);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`field cats share a cell: ${keys.join(" ")}`);
  }
  if (placedInUsers(field.users) !== (field.cats || []).length) {
    throw new Error(
      `users grid collapsed ${placedInUsers(field.users)} cats into ${(field.cats || []).length} cells`,
    );
  }
  const slot = field.users?.[you.x]?.[you.y];
  if (!slot || slot.id !== you.id) {
    throw new Error(`users grid at ${cellKey(you)} is ${JSON.stringify(slot)}`);
  }
  burstYou.push(you);
  fieldSizes.push((field.cats || []).length);
}
const burstCells = new Set(burstYou.map(cellKey));
if (burstCells.size !== BURST) {
  throw new Error(`expected ${BURST} unique cells, got ${burstCells.size}`);
}
const sizes = [...fieldSizes].sort((p, q) => p - q);
for (let i = 0; i < BURST; i++) {
  if (sizes[i] !== i + 1) {
    throw new Error(`field sizes skipped or doubled: ${sizes.join(",")}`);
  }
}
console.log(`ok: burst ${BURST} joins, ${burstCells.size} unique cells`);

// Выход освобождает клетку. Повторный вход не садится на оставшихся.
const leaveWatch = guardBurst[1];
const goneId = burstYou[0].id;
leaveWatch.inbox.length = 0;
guardBurst[0].close();
await waitUntil(
  () => leaveWatch.inbox.some((m) => m[0] === "move" && m[1].id === goneId && m[1].x === 0 && m[1].y === 0),
  3000,
  "leave marker",
);
const again = await connectBare();
again.send(JSON.stringify(["join", { room: guardRoom, login: "Снова" }]));
const youAgain = (await waitFor(again, "you", 3000))[1];
const fieldAgain = (await waitFor(again, "field", 3000))[1];
if (again.inbox.some((m) => m[0] === "noplace")) throw new Error("rejoin got noplace");
const againKeys = (fieldAgain.cats || []).map(cellKey);
if (fieldAgain.cats.length !== BURST || new Set(againKeys).size !== BURST) {
  throw new Error(`rejoin field not ${BURST} unique cells: ${againKeys.join(" ")}`);
}
if ((fieldAgain.cats || []).some((c) => c.id === goneId)) throw new Error("leaver still seated");
const againSame = fieldAgain.cats.filter((c) => c.x === youAgain.x && c.y === youAgain.y);
if (againSame.length !== 1 || againSame[0].id !== youAgain.id) {
  throw new Error(`rejoin returned occupied cell ${cellKey(youAgain)}`);
}
console.log("ok: leave/rejoin", cellKey(youAgain), "unique among", BURST);

// Два шага в одну свободную клетку, отправленные подряд: сервер пускает одного.
const clashRoom = `k${Date.now().toString(36)}`;
const p = await connectBare();
const q = await connectBare();
p.send(JSON.stringify(["join", { room: clashRoom, login: "Раз" }]));
q.send(JSON.stringify(["join", { room: clashRoom, login: "Два" }]));
const pYou = (await waitFor(p, "you", 3000))[1];
const qYou = (await waitFor(q, "you", 3000))[1];
const target = { x: 4, y: 4 };
const canReach = (cat) => Math.max(Math.abs(target.x - cat.x), Math.abs(target.y - cat.y)) === 1;
if (!canReach(pYou) || !canReach(qYou) || cellKey(pYou) === cellKey(qYou)) {
  throw new Error(`clash spawns ${cellKey(pYou)} ${cellKey(qYou)}`);
}
p.inbox.length = 0;
q.inbox.length = 0;
p.send(JSON.stringify(["move", { x: Math.sign(target.x - pYou.x), y: Math.sign(target.y - pYou.y) }]));
q.send(JSON.stringify(["move", { x: Math.sign(target.x - qYou.x), y: Math.sign(target.y - qYou.y) }]));
const settled = (ws, you) =>
  ws.inbox.some((m) => m[0] === "update cat" && m[1].id === you.id) ||
  ws.inbox.some((m) => m[0] === "info" && String(m[1]).includes("Клетка занята"));
await waitUntil(() => settled(p, pYou) && settled(q, qYou), 3000, "clash settle");
const finalOf = (ws, you) => {
  const mine = [...ws.inbox].reverse().find((m) => m[0] === "update cat" && m[1].id === you.id);
  return mine ? { x: mine[1].x, y: mine[1].y } : { x: you.x, y: you.y };
};
const fp = finalOf(p, pYou);
const fq = finalOf(q, qYou);
if (fp.x === fq.x && fp.y === fq.y) throw new Error(`move stacked both on ${fp.x}:${fp.y}`);
const rejects = [p, q].filter((ws) =>
  ws.inbox.some((m) => m[0] === "info" && String(m[1]).includes("Клетка занята")),
);
if (rejects.length !== 1) throw new Error(`expected one occupied reject, got ${rejects.length}`);
console.log("ok: simultaneous move, one cell", `${fp.x}:${fp.y}`, `${fq.x}:${fq.y}`);

// Чат комнаты: видят все, пустое молчит, длинное режется, частый отказ, новичок получает журнал.
const chatRoom = `c${Date.now().toString(36)}`;
const ca = await client("Альфа", chatRoom);
const cb = await client("Бета", chatRoom);
const caYou = (await waitFor(ca, "you"))[1];
await waitFor(cb, "you");
ca.inbox.length = 0;
cb.inbox.length = 0;
ca.send(JSON.stringify(["chat", { text: "  привет\nкомнате  " }]));
const chatA = await waitFor(ca, "chat");
const chatB = await waitFor(cb, "chat");
for (const [who, msg] of [["A", chatA], ["B", chatB]]) {
  const row = msg[1];
  if (row.id !== caYou.id || row.login !== "Альфа") throw new Error(`${who} chat author ${JSON.stringify(row)}`);
  if (row.text !== "привет комнате") throw new Error(`${who} chat text ${JSON.stringify(row.text)}`);
  if (!/^#[0-9a-fA-F]{6}$/.test(row.color)) throw new Error(`${who} chat color ${row.color}`);
  if (typeof row.seq !== "number" || typeof row.ts !== "number") throw new Error(`${who} chat meta ${JSON.stringify(row)}`);
}
if (cb.inbox.filter((m) => m[0] === "chat").length !== 1) throw new Error("chat echoed twice");
ca.send(JSON.stringify(["chat", { text: "   " }]));
ca.send(JSON.stringify(["chat", ""]));
await sleep(80);
if (cb.inbox.some((m) => m[0] === "chat" && m[1].seq !== chatB[1].seq)) {
  throw new Error(`empty chat leaked ${JSON.stringify(cb.inbox.filter((m) => m[0] === "chat"))}`);
}
await sleep(500);
ca.inbox.length = 0;
cb.inbox.length = 0;
ca.send(JSON.stringify(["chat", { text: "я".repeat(250) }]));
const clipped = (await waitFor(cb, "chat"))[1];
if (clipped.text !== "я".repeat(200)) throw new Error(`chat clip len ${clipped.text?.length}`);
await sleep(500);
ca.inbox.length = 0;
cb.inbox.length = 0;
ca.send(JSON.stringify(["chat", { text: "раз" }]));
ca.send(JSON.stringify(["chat", { text: "два" }]));
await sleep(200);
const paced = cb.inbox.filter((m) => m[0] === "chat");
if (paced.length !== 1 || paced[0][1].text !== "раз") {
  throw new Error(`chat rate ${JSON.stringify(paced.map((m) => m[1].text))}`);
}
if (!ca.inbox.some((m) => m[0] === "info" && String(m[1]).includes("частые"))) {
  throw new Error(`chat rate info missing ${JSON.stringify(ca.inbox)}`);
}
const outsider = await connectBare();
outsider.send(JSON.stringify(["chat", { text: "мимо" }]));
const outsiderInfo = await waitFor(outsider, "info");
if (!String(outsiderInfo[1]).includes("комнату")) throw new Error(`outsider ${outsiderInfo[1]}`);
await sleep(40);
if (cb.inbox.some((m) => m[0] === "chat" && m[1].text === "мимо")) throw new Error("outsider reached the room");
const cc = await client("Гамма", chatRoom);
const chatlog = (await waitFor(cc, "chatlog"))[1];
const logged = chatlog.map((row) => row.text);
if (logged.join("|") !== ["привет комнате", "я".repeat(200), "раз"].join("|")) {
  throw new Error(`chatlog ${JSON.stringify(logged)}`);
}
console.log("ok: chat", logged.length, "lines, clip 200, rate, history");

// Скин меняется на месте и виден другому сокету. Себе эхо не шлём.
const skinRoom = `s${Date.now().toString(36)}`;
const sa = await client("Альфа", skinRoom);
const sb = await client("Бета", skinRoom);
const skinYou = (await waitFor(sa, "you"))[1];
await waitFor(sb, "you");
sa.inbox.length = 0;
sb.inbox.length = 0;
sa.send(JSON.stringify(["sprite", { sprite: "puzatik" }]));
const skinSeen = await waitFor(sb, "update cat");
if (skinSeen[1].id !== skinYou.id) throw new Error(`sprite id ${JSON.stringify(skinSeen[1])}`);
if (skinSeen[1].sprite !== "puzatik") throw new Error(`sprite ${skinSeen[1].sprite}`);
if (skinSeen[1].x !== skinYou.x || skinSeen[1].y !== skinYou.y) {
  throw new Error(`sprite moved the cat ${JSON.stringify(skinSeen[1])}`);
}
if (sa.inbox.some((m) => m[0] === "update cat")) throw new Error("sprite echoed to the wearer");
sa.send(JSON.stringify(["sprite", { sprite: "not-a-cat" }]));
sa.send(JSON.stringify(["sprite", { sprite: "puzatik" }]));
await sleep(80);
const skinPatches = sb.inbox.filter((m) => m[0] === "update cat");
if (skinPatches.length !== 1) throw new Error(`sprite spam ${JSON.stringify(skinPatches)}`);
const skinJoiner = await client("Гамма", skinRoom);
const skinField = (await waitFor(skinJoiner, "field"))[1];
const worn = (skinField.cats || []).find((c) => c.id === skinYou.id);
if (!worn || worn.sprite !== "puzatik") throw new Error(`sprite not in field ${JSON.stringify(worn)}`);
for (const id of ["ryzhiy", "trehcvetny", "serebristyy", "maslina", "buran", "sumrak"]) {
  sb.inbox.length = 0;
  sa.send(JSON.stringify(["sprite", { sprite: id }]));
  const seen = await waitFor(sb, "update cat");
  if (seen[1].sprite !== id || seen[1].x !== skinYou.x || seen[1].y !== skinYou.y) {
    throw new Error(`sprite ${id} ${JSON.stringify(seen[1])}`);
  }
}
console.log("ok: sprite", skinYou.x, skinYou.y, "→", worn.sprite, "+ ryzhiy trehcvetny serebristyy maslina buran sumrak");

// Манекен «ПОЧУХАТЬ»: включение видно всем (и включившему), движение тащащему
// не эхоится, чужие получают dummyMove, новичку состояние приходит в field,
// клетка манекена непроходима, захват виден курсором с именем (dummyGrab/dummyDrop).
const tgtRoom = `t${Date.now().toString(36)}g`;
const ta = await client("Альфа", tgtRoom);
const tb = await client("Бета", tgtRoom);
await waitFor(ta, "you");
await waitFor(tb, "you");
const youBt = tb.inbox.find((m) => m[0] === "you")[1];
ta.inbox.length = 0;
tb.inbox.length = 0;
ta.send(JSON.stringify(["dummy", { on: true, sprite: "drel" }]));
const stA = await waitFor(ta, "dummyState");
const stB = await waitFor(tb, "dummyState");
for (const [who, st] of [["A", stA], ["B", stB]]) {
  if (st[1].on !== true) throw new Error(`${who} dummyState.on ${JSON.stringify(st[1])}`);
  if (st[1].sprite !== "drel") throw new Error(`${who} dummyState.sprite ${JSON.stringify(st[1])}`);
  if (!Number.isFinite(st[1].x) || !Number.isFinite(st[1].y)) {
    throw new Error(`${who} dummyState coords ${JSON.stringify(st[1])}`);
  }
}
ta.inbox.length = 0;
tb.inbox.length = 0;
ta.send(JSON.stringify(["dummyMove", { x: 2.5, y: 1.25 }]));
const mvB = await waitFor(tb, "dummyMove");
if (mvB[1].x !== 2.5 || mvB[1].y !== 1.25) throw new Error(`dummyMove ${JSON.stringify(mvB[1])}`);
await sleep(80);
if (ta.inbox.some((m) => m[0] === "dummyMove")) throw new Error("dummyMove echoed to the dragger");
// Грубые координаты зажимаются сервером в пределы поля.
ta.send(JSON.stringify(["dummyMove", { x: 99, y: -5 }]));
const clamped = await waitFor(tb, "dummyMove");
if (clamped[1].x < 0 || clamped[1].x > 9 || clamped[1].y < 0 || clamped[1].y > 5) {
  throw new Error(`dummyMove clamp ${JSON.stringify(clamped[1])}`);
}
// Новичок получает состояние манекена в field: объект есть — значит включён.
const tc = await client("Гамма", tgtRoom);
const fieldT = (await waitFor(tc, "field"))[1];
if (!fieldT.dummy || fieldT.dummy.on !== true || !Number.isFinite(fieldT.dummy.x) || !Number.isFinite(fieldT.dummy.y) || fieldT.dummy.sprite !== "drel") {
  throw new Error(`field dummy ${JSON.stringify(fieldT.dummy)}`);
}
// Клетка манекена непроходима: ставим его вплотную справа от Беты и пробуем шагнуть.
ta.send(JSON.stringify(["dummyMove", { x: youBt.x, y: youBt.y - 1 }]));
await waitFor(tb, "dummyMove");
tb.inbox.length = 0;
tb.send(JSON.stringify(["move", { x: 1, y: 0 }]));
const refused = await waitFor(tb, "refuse");
if (refused[1].code !== "cell_busy") throw new Error(`dummy cell passable: ${JSON.stringify(refused[1])}`);
// Курсор-обозначение: захват виден обоим (включая взявшего).
ta.send(JSON.stringify(["dummyGrab"]));
const grA = await waitFor(ta, "dummyGrab");
const grB = await waitFor(tb, "dummyGrab");
if (grA[1].login !== "Альфа" || grB[1].login !== "Альфа") {
  throw new Error(`dummyGrab ${JSON.stringify([grA[1], grB[1]])}`);
}
// Ушедший тащащий убирает курсор: close тащившего шлёт dummyDrop остальным.
ta.close();
const dropped = await waitFor(tb, "dummyDrop");
if (!dropped) throw new Error("dummyDrop on grabber leave");
console.log("ok: dummy", "on/move/clamp/field/block/grab/drop");

// Боевая мишень «РАБ»: включение видно всем, её клетка непроходима
// (второй кот спавнится мимо неё), новичку состояние приходит в field.
const rabRoom = `t${Date.now().toString(36)}r`;
const ra = await client("Альфа", rabRoom);
await waitFor(ra, "you");
ra.inbox.length = 0;
ra.send(JSON.stringify(["rab", { on: true }]));
const rsA = await waitFor(ra, "rabState");
if (rsA[1].on !== true) throw new Error(`rabState.on ${JSON.stringify(rsA[1])}`);
const rb = await client("Бета", rabRoom);
const youB2 = (await waitFor(rb, "you"))[1];
// РАБ стоит в 0-based (4,2) = серверной (5,3): второй спавн обязан её обойти.
if (youB2.x === 5 && youB2.y === 3) throw new Error(`spawn on RAB cell ${JSON.stringify(youB2)}`);
const rc = await client("Гамма", rabRoom);
const fieldR = (await waitFor(rc, "field"))[1];
if (!fieldR.rab || fieldR.rab.on !== true) throw new Error(`field rab ${JSON.stringify(fieldR.rab)}`);
ra.inbox.length = 0;
rb.inbox.length = 0;
ra.send(JSON.stringify(["rab", { on: false }]));
const rsOff = await waitFor(ra, "rabState");
const rsOffB = await waitFor(rb, "rabState");
if (rsOff[1].on !== false || rsOffB[1].on !== false) throw new Error("rabState off failed");
console.log("ok: rab", "on/spawn-skip/field/off");

// Удар по РАБ: rabHit уходит остальным (качание + урон), бьющему эхо не приходит,
// мусор нормализуется (урон зажат, строки подрезаны), без зоны/названия — молчок.
const rhRoom = `t${Date.now().toString(36)}h`;
const ha = await client("Альфа", rhRoom);
const hb = await client("Бета", rhRoom);
await waitFor(ha, "you");
await waitFor(hb, "you");
ha.inbox.length = 0;
hb.inbox.length = 0;
ha.send(JSON.stringify(["rabHit", { zone: "throat", part: "Горло", damage: 999 }]));
const rhB = await waitFor(hb, "rabHit");
if (rhB[1].zone !== "throat" || rhB[1].part !== "Горло" || rhB[1].damage !== 100) {
  throw new Error(`rabHit ${JSON.stringify(rhB[1])}`);
}
if (ha.inbox.some((m) => m[0] === "rabHit")) throw new Error("rabHit echoed to the striker");
hb.inbox.length = 0;
ha.send(JSON.stringify(["rabHit", { zone: "", part: "", damage: -5 }]));
ha.send(JSON.stringify(["rabHit", {}]));
await sleep(80);
if (hb.inbox.some((m) => m[0] === "rabHit")) throw new Error("rabHit empty relayed");
console.log("ok: rabHit", "relay/clamp/no-echo/no-empty");

function handshake(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers: { Origin: origin } });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve(ok);
    };
    ws.once("open", () => finish(true));
    ws.once("unexpected-response", () => finish(false));
    ws.once("error", () => finish(false));
    setTimeout(() => finish(false), 1500);
  });
}

// Одно движение — одно update cat шагнувшему и одно зрителю.
// Раньше broadcast без except дублировал эхо шагнувшему: в HAR пары с dt ~0.1 мс.
{
  const echoRoom = `e${Date.now().toString(36)}`;
  const mover = await client("Эхо", echoRoom);
  const watcher = await client("Зритель", echoRoom);
  const moverYou = (await waitFor(mover, "you"))[1];
  await waitFor(watcher, "you");
  mover.inbox.length = 0;
  watcher.inbox.length = 0;
  mover.send(JSON.stringify(["move", { x: 0, y: 1 }]));
  await waitFor(mover, "update cat");
  await waitFor(watcher, "update cat");
  await sleep(40);
  const selfEcho = mover.inbox.filter((m) => m[0] === "update cat" && m[1].id === moverYou.id);
  const peerEcho = watcher.inbox.filter((m) => m[0] === "update cat" && m[1].id === moverYou.id);
  if (selfEcho.length !== 1) throw new Error(`mover echo ×${selfEcho.length}, expected 1`);
  if (peerEcho.length !== 1) throw new Error(`peer echo ×${peerEcho.length}, expected 1`);
  if (selfEcho[0][1].x !== moverYou.x || selfEcho[0][1].y !== moverYou.y + 1) {
    throw new Error(`echo cell ${selfEcho[0][1].x}:${selfEcho[0][1].y}`);
  }
  // Шаг в кулдаун (80 мс) не глотается: встаёт в очередь и исполняется
  // в момент её снятия — иначе предикт клиента расходится с сервером.
  mover.send(JSON.stringify(["move", { x: 0, y: 1 }]));
  await sleep(250);
  const paced = mover.inbox.filter((m) => m[0] === "update cat" && m[1].id === moverYou.id);
  if (paced.length !== 2 || paced[1][1].y !== moverYou.y + 2) {
    throw new Error(`queued step lost or wrong: ${JSON.stringify(paced.map((m) => m[1]))}`);
  }
  console.log("ok: one move echo, step in cooldown queued not dropped");
  // Залп из 5 шагов: первый исполняется сразу, ещё 3 занимают очередь,
  // пятый — честный отказ с кодом cooldown. Итог: ровно 4 клетки по x.
  const dirX = moverYou.x <= 6 ? 1 : -1;
  for (let i = 0; i < 5; i++) mover.send(JSON.stringify(["move", { x: dirX, y: 0 }]));
  await sleep(600);
  const refuses = mover.inbox.filter((m) => m[0] === "refuse" && m[1].code === "cooldown");
  if (refuses.length !== 1) throw new Error(`overflow refuse ×${refuses.length}, expected 1`);
  const walk = mover.inbox.filter((m) => m[0] === "update cat" && m[1].id === moverYou.id).map((m) => m[1].x);
  if (walk[walk.length - 1] !== moverYou.x + dirX * 4) {
    throw new Error(`queued walk ended at x=${walk[walk.length - 1]}, expected ${moverYou.x + dirX * 4} (${JSON.stringify(walk)})`);
  }
  console.log("ok: queue of 3 executes, overflow refused cooldown");
  mover.close();
  watcher.close();
}

// ----- комната «тест»: другой формат поля (лужайка + переход + закуток) -----
{
  const ta = await client("Тестер", "test");
  const tYou = (await waitFor(ta, "you"))[1];
  const tField = (await waitFor(ta, "field"))[1];
  if (tField.format !== "test") throw new Error(`field.format=${tField.format}`);
  if (tField.width !== 19 || tField.height !== 7) throw new Error(`field ${tField.width}x${tField.height}`);
  if (tField.room !== "test") throw new Error(`field.room=${tField.room}`);
  // спавн — на лужайке (1..10 / 1..7)
  if (tYou.x < 1 || tYou.x > 10 || tYou.y < 1 || tYou.y > 7) {
    throw new Error(`spawn ${cellKey(tYou)} вне лужайки`);
  }
  console.log("ok: test room field 19x7, spawn", cellKey(tYou));
  // клеточная ходьба по зонам: вправо через лужайку, переход и закуток до кромки
  ta.inbox.length = 0;
  for (let i = 0; i < 15; i++) {
    ta.send(JSON.stringify(["move", { x: 1, y: 0 }]));
    await sleep(100);
  }
  await sleep(300);
  const walkX = ta.inbox.filter((m) => m[0] === "update cat" && m[1].id === tYou.id).map((m) => m[1].x);
  if (walkX[walkX.length - 1] !== 19) {
    throw new Error(`walk right ended x=${walkX[walkX.length - 1]}, expected 19 (кромка закутка)`);
  }
  console.log("ok: test room walk lawn→passage→nook, x →", walkX[walkX.length - 1]);
  // вверх из закутка выхода нет: y=1 → y=0 отказ «край»
  ta.inbox.length = 0;
  for (let i = 0; i < 3 && !ta.inbox.some((m) => m[0] === "refuse"); i++) {
    ta.send(JSON.stringify(["move", { x: 0, y: -1 }]));
    await sleep(110);
  }
  const edgeRefuse = ta.inbox.find((m) => m[0] === "refuse" && m[1].code === "edge");
  if (!edgeRefuse) throw new Error("expected edge refuse above nook");
  console.log("ok: test room edge refuse at location border");
  // свободная ходьба: freemove релеится соседу с логической клеткой, темп и stop
  const tb = await client("Сосед", "test");
  await waitFor(tb, "field");
  await sleep(50);
  tb.inbox.length = 0;
  ta.send(JSON.stringify(["freemove", { x: 3.5, y: 3.5 }]));
  // второй пакет внутри окна 50 мс — сервер его рассылать не должен
  await sleep(15);
  ta.send(JSON.stringify(["freemove", { x: 3.6, y: 3.5 }]));
  await sleep(120);
  const fm = tb.inbox.find((m) => m[0] === "freemove");
  if (!fm || fm[1].id !== tYou.id) throw new Error(`freemove relay missing: ${JSON.stringify(tb.inbox.find((m) => m[0] === "freemove"))}`);
  if (fm[1].x !== 3.5 || fm[1].y !== 3.5) throw new Error(`freemove pos ${fm[1].x}:${fm[1].y}`);
  // ближайшая проходимая клетка к (3.5, 3.5) — (5, 5) в 1-based
  if (fm[1].cx !== 5 || fm[1].cy !== 5) throw new Error(`freemove cell ${fm[1].cx}:${fm[1].cy}, expected 5:5`);
  const fmGap = tb.inbox.filter((m) => m[0] === "freemove");
  if (fmGap.length !== 1) throw new Error(`freemove gap failed: ${fmGap.length} packets`);
  ta.send(JSON.stringify(["freemove", { x: 4.2, y: 3.8, stop: true }]));
  await sleep(80);
  const fmStop = tb.inbox.filter((m) => m[0] === "freemove");
  if (fmStop.length !== 2 || fmStop[1][1].x !== 4.2) {
    throw new Error(`stop freemove: ${JSON.stringify(fmStop.map((m) => m[1]))}`);
  }
  // возврат в клеточный бой: cellsync рассылает publicCat с fm=0 (и самому игроку)
  ta.inbox.length = 0;
  tb.inbox.length = 0;
  ta.send(JSON.stringify(["cellsync", { x: 5, y: 4 }]));
  await sleep(120);
  const syncSelf = ta.inbox.find((m) => m[0] === "update cat" && m[1].id === tYou.id);
  const syncPeer = tb.inbox.find((m) => m[0] === "update cat" && m[1].id === tYou.id);
  if (!syncSelf || !syncPeer) throw new Error("cellsync echo missing");
  if (syncSelf[1].x !== 5 || syncSelf[1].y !== 4 || syncSelf[1].fm !== 0) {
    throw new Error(`cellsync self ${JSON.stringify(syncSelf[1])}`);
  }
  if (syncPeer[1].fm !== 0) throw new Error("cellsync peer fm must be 0");
  // манекен и мишень в «тесте» недоступны: info-отказ, состояния комнаты не рассылаются
  ta.inbox.length = 0;
  ta.send(JSON.stringify(["dummy", { on: true }]));
  ta.send(JSON.stringify(["rab", { on: true }]));
  await sleep(100);
  if (ta.inbox.some((m) => m[0] === "dummyState" || m[0] === "rabState")) {
    throw new Error("test room must not accept dummy/rab");
  }
  const guardInfo = ta.inbox.filter((m) => m[0] === "info");
  if (guardInfo.length < 2) throw new Error(`expected dummy+rab refusals, got ${JSON.stringify(guardInfo)}`);
  console.log("ok: test room freemove relay/gap/stop, cellsync, no dummy/rab");
  ta.close();
  tb.close();
  await sleep(50);
}

const originCases = [
  ["https://abnocw.89-232-184-77.sslip.io", true],
  ["https://coop.89-232-184-77.sslip.io", true],
  ["https://coop-field.vercel.app", true],
  ["https://coop-field-git-foo.vercel.app", true],
  ["https://evil.example", false],
];
for (const [origin, expectOpen] of originCases) {
  const opened = await handshake(origin);
  if (opened !== expectOpen) throw new Error(`origin ${origin} opened=${opened} expected=${expectOpen}`);
}
console.log("ok: origins");

for (const ws of [a, b, c, d, left, right, overflow, first, second, spinner, watcher, ...held, ...burst, ...guardBurst, again, p, q, ca, cb, cc, outsider, sa, sb, skinJoiner]) {
  try {
    ws.close();
  } catch {
    /* already closed */
  }
}
process.exit(0);
