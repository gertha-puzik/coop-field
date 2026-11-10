#!/usr/bin/env node
/**
 * Смоук модулей сервера (W4 «разрез server.js»): каждый новый server/*.js
 * обязан импортироваться без сети и без падения, а его ЧИСТЫЕ публичные
 * функции — возвращать те же значения, что давал монолитный server.js до
 * выреза. Золотые числа ниже сняты ИСХОДНОГО кода (функции выполнялись из
 * копии server.js@main перед вырезом) — drift между слоем чистой логики и
 * старым монолитом ловится здесь, wire-контракт держит test:ws.
 *
 * Импортируется и server/protocol.js (канон W3) — через него чистые модули
 * тянут константы. stateful-проверки (геометрия дефолтной карты) гоняются
 * через живой импорт testmap.js: DATA_DIR указываем в песочницу ДО импорта,
 * поэтому тест ничего не пишет в репозиторийный data/ и не поднимает сеть.
 * server.js (тонкий вход) намеренно НЕ импортируется: startServer() слушал бы
 * сокет — его покрывают self-spawn прогоны (test:queue/test:ws).
 *
 * Запуск: node scripts/test-server-modules.mjs (npm-раннер: npm run test:server-modules).
 */
import { deflateSync } from "node:zlib";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "w4-module-smoke-"));

// Модули сервера: импорт без побочных эффектов (кроме data-инициализации в песочнице).
const cfg = await import("../server/config.js");
const world = await import("../server/world.js");
const testmap = await import("../server/testmap.js");
const persist = await import("../server/persist.js");
const sanitize = await import("../server/sanitize.js");
const room = await import("../server/room.js");
const movement = await import("../server/movement.js");
const combat = await import("../server/combat.js");
const dummyRab = await import("../server/dummy-rab.js");
const atmo = await import("../server/atmo.js");
const net = await import("../server/net.js");
const protocol = await import("../server/protocol.js");
const modes = await import("../server/modes.js");
const accounts = await import("../server/accounts.js");
const auth = await import("../server/auth.js");
const hunger = await import("../server/hunger.js");
const runtimeConfig = await import("../server/runtime-config.js");
const roomConfig = await import("../server/room-config.js");
const cfgReg = await import("../server/cfg-registry.js");

let failed = 0;
let passed = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL ${label}\n  модуль: ${a}\n  до W4:  ${e}`);
  }
}

/* ---------- config.js ---------- */
eq("config.PORT (без env)", cfg.PORT, 3780);
eq("config.TEST_ROOM", cfg.TEST_ROOM, "test");
eq("config.WIDTH/HEIGHT", [cfg.WIDTH, cfg.HEIGHT], [10, 6]);
eq("config.SPRITES — whitelist размером 33", cfg.SPRITES.length, 33);
eq("config.FRAME_LIMIT 64 КиБ", cfg.FRAME_LIMIT, 64 * 1024);
eq("config.isAllowedOrigin: пустой Origin без REQUIRE_ORIGIN", cfg.isAllowedOrigin(""), true);
eq("config.isAllowedOrigin: чужой https", cfg.isAllowedOrigin("https://random.example"), false);

/* ---------- protocol.js (W3-канон, не изменился) ---------- */
eq("protocol: 23+23 событий", [protocol.CLIENT_EVENTS.length, protocol.SERVER_EVENTS.length], [23, 23]);
eq("protocol: ARMOR_CURVE точек", protocol.ARMOR_CURVE.length, 7);

/* ---------- combat.js — чистая математика боя (золото со старого кода) ---------- */
eq("armorMultiplier: 0 брони", combat.armorMultiplier(0), 1);
eq("armorMultiplier: узел 0.2", combat.armorMultiplier(0.2), 0.8654999999999999);
eq("armorMultiplier: узел 0.35", combat.armorMultiplier(0.35), 0.7905);
eq("armorMultiplier: узел 0.66", combat.armorMultiplier(0.66), 0.6637500000000001);
eq("armorMultiplier: узел 0.78", combat.armorMultiplier(0.78), 0.52325);
eq("armorMultiplier: 0.9 (экстраполяция)", combat.armorMultiplier(0.9), 0.38275);
eq("armorMultiplier: NaN → без брони", combat.armorMultiplier(NaN), 1);
eq("armorMultiplier: -5 → clamp 0", combat.armorMultiplier(-5), 1);
eq("wrap360(370)", combat.wrap360(370), 10);
eq("wrap360(-30)", combat.wrap360(-30), 330);
eq("wrap180(190)", combat.wrap180(190), -170);
eq("wrap180(-170)", combat.wrap180(-170), -170);
eq("normalizeDeg(359.96) — округление 0.1°", combat.normalizeDeg(359.96), 360);
eq("normalizeDeg('abc')", combat.normalizeDeg("abc"), null);
eq("resolveZone по id", combat.resolveZone("muzzle"), ["muzzle", protocol.STRIKE_ZONES.muzzle]);
eq("resolveZone по подписи", combat.resolveZone("Хвост"), ["tail", protocol.STRIKE_ZONES.tail]);
eq("resolveZone по подписи в нижнем регистре", combat.resolveZone("хвост"), ["tail", protocol.STRIKE_ZONES.tail]);
eq("resolveZone: неизвестная зона", combat.resolveZone("nope"), null);
eq("resolveZone: пустая строка", combat.resolveZone(""), null);
eq("diagonalZone(1,1) → морда", combat.diagonalZone(1, 1), "muzzle");
eq("diagonalZone(-1,-1) → хвост", combat.diagonalZone(-1, -1), "tail");
eq("diagonalZone(1,-1) → лапы", combat.diagonalZone(1, -1), "paws");
eq("diagonalZone(-1,1) → морда", combat.diagonalZone(-1, 1), "muzzle");
eq("diagonalZone(0,1) — не диагональ", combat.diagonalZone(0, 1), null);
const aimRoom = {
  cats: new Map([
    [1, { id: 1, x: 5, y: 5 }],
    [2, { id: 2, x: 6, y: 5 }],
    [3, { id: 3, x: 6, y: 6 }],
    [4, { id: 4, x: 20, y: 20 }], // не сосед — не цель
  ]),
};
eq("aimedNeighbor: угол 0° → сосед справа", combat.aimedNeighbor(aimRoom, aimRoom.cats.get(1), 0)?.id, 2);
eq("aimedNeighbor: угол 45° → сосед по диагонали", combat.aimedNeighbor(aimRoom, aimRoom.cats.get(1), 45)?.id, 3);
eq("aimedNeighbor: нечисловой угол", combat.aimedNeighbor(aimRoom, aimRoom.cats.get(1), NaN), null);

/* ---------- movement.js — нормализация шага (золото) ---------- */
eq("parseMove {1,0}", movement.parseMove({ x: 1, y: 0 }), { dx: 1, dy: 0 });
eq("parseMove {5,-3} — клампится в ±1", movement.parseMove({ x: 5, y: -3 }), { dx: 1, dy: -1 });
eq("parseMove {0,0} — не ход", movement.parseMove({ x: 0, y: 0 }), null);
eq("parseMove('')", movement.parseMove(""), null);
eq("parseMove {0.5,0} — дробь зануляется", movement.parseMove({ x: 0.5, y: 0 }), null);
eq("parseMove NaN", movement.parseMove({ x: NaN, y: 1 }), null);

/* ---------- sanitize.js — валидация входа и чат (золото) ---------- */
eq("sanitizeChat: невидимые → пробел + трим", sanitize.sanitizeChat("\t a​b \n"), "a b");
eq("sanitizeChat: сплошные пробелы", sanitize.sanitizeChat("   a   b   "), "a b");
eq("sanitizeChat: 250 симв. → 200", sanitize.sanitizeChat("x".repeat(250)).length, 200);
eq("clipChars по код-поинтам", sanitize.clipChars("abcdef", 2), "ab");
eq("sanitizeLogin: пустой → фолбэк", sanitize.sanitizeLogin("", "Кот"), "Кот");
eq("sanitizeLogin: пробелы", sanitize.sanitizeLogin("  Сы рь ", "Кот"), "Сы рь");
eq("uniqueLogin: свободное имя как есть", sanitize.uniqueLogin({ cats: new Map() }, "Альфа"), "Альфа");
eq(
  "uniqueLogin: занято — суффикс",
  sanitize.uniqueLogin({ cats: new Map([[1, { login: "Альфа" }]]) }, "Альфа"),
  "Альфа 2",
);
eq(
  "uniqueLogin: и суффикс занят",
  sanitize.uniqueLogin({ cats: new Map([[1, { login: "Альфа" }], [2, { login: "Альфа 2" }]]) }, "Альфа"),
  "Альфа 3",
);
eq(
  "uniqueLogin: длинный стем режется до 21",
  sanitize.uniqueLogin({ cats: new Map([[1, { login: "Двадцатьодинбуквенныйкотик" }]]) }, "Двадцатьодинбуквенныйкотик"),
  "Двадцатьодинбуквенный 2",
);

/* ---------- world.js — чистая геометрия (золото со старого кода) ---------- */
const poly = [
  { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 },
];
eq("pointInPolygon: внутри", world.pointInPolygon(poly, 1, 1), true);
eq("pointInPolygon: снаружи", world.pointInPolygon(poly, 3, 1), false);
eq("hashStr: сид 'test'", world.hashStr("test"), 2949673445);
eq("hashStr: число приводится", world.hashStr(123), 2166136261);
const seedVal = world.hashStr("test");
eq("mulberry32: детерминизм", world.mulberry32(seedVal)(), 0.7171058997046202);
eq("chaikin: квадрат ×1 → 8 вершин", world.chaikin(poly, 1).length, 8);
const def = testmap.defaultTestMap();
const st = testmap.sanitizeTestMap(def);
eq("sanitizeTestMap: дефолт проходит", [st.map?.v, st.map?.zones?.length, st.map?.cols, st.map?.rows], [2, 3, 19, 7]);
eq("sanitizeTestMap: v3", testmap.sanitizeTestMap({ v: 3, cols: 10, rows: 5 }).error, "неизвестная версия конфига");
eq("sanitizeTestMap: null", testmap.sanitizeTestMap(null).error, "конфиг не распознан");
const retiredTreeMap = testmap.defaultTestMap();
retiredTreeMap.objects = [{id:"retired-tree",kind:"tree",spr:"tree3d-200",c:2,r:2,x:2.5,y:3,s:1.2,rot:37,mir:1}];
const retiredTree = testmap.sanitizeTestMap(retiredTreeMap).map?.objects?.[0];
eq("снятая модель дерева: видимый fallback и сохранённая позиция", [retiredTree?.spr,retiredTree?.x,retiredTree?.y,retiredTree?.s,retiredTree?.rot], ["tree-1",2.5,3,1.2,37]);

eq("sanitizeTestMap: очищенная мирная карта", testmap.sanitizeTestMap({ v: 2, cols: 10, rows: 5, zones: [] }).error, undefined);
eq(
  "sanitizeTestMap: высота вне лимита",
  testmap.sanitizeTestMap({ v: 2, cols: 10, rows: 200, zones: [{ kind: "green", c0: 0, r0: 0, c1: 9, r1: 4 }] }).error,
  "высота мира должна быть 3–40",
);
const island = world.buildIsland(st.map);
const cells = world.buildCells(st.map, island);
eq("buildIsland: замкнутый контур дефолта", island.length, 208);
eq("buildCells: клетка в зоне боя (c=12,r=3)", cells[3][12], true);
eq("buildCells: клетка зоны на краю (c=10,r=1)", cells[1][10], true);
eq("buildCells: трава не боевая (0,0)", cells[0][0], false);
eq("bucket: world.testWalkable(13,4) по живому состоянию", world.testWalkable(13, 4), true);
eq("world.testWalkable(1,1) — трава", world.testWalkable(1, 1), false);
eq("world.cliffBetween на плоском дефолте", world.cliffBetween(11, 2, 12, 2), false);
eq("world.testEntryCell на дефолте без objects", world.testEntryCell(1, 1), null);
eq("world.testCellInIsland(12,3)", world.testCellInIsland(12, 3, island), true);
eq("world.nearestTestCell(0.2,0.2) — первая боевая кольцом", world.nearestTestCell(0.2, 0.2), { x: 11, y: 2 });
eq("testmap TEST_WIDTH/HEIGHT по дефолту", [testmap.TEST_WIDTH, testmap.TEST_HEIGHT], [19, 7]);

/* ---------- dummy-rab.js ---------- */
eq("normDummyCoord: -5 → clamp 0", dummyRab.normDummyCoord(-5, 9), 0);
eq("normDummyCoord: округление до сотых", dummyRab.normDummyCoord(4.567, 9), 4.57);
eq("normDummyCoord: сверху — clamp max", dummyRab.normDummyCoord(11.11, 9), 9);
eq("normDummyCoord: не число", dummyRab.normDummyCoord("x", 9), null);

/* ---------- atmo.js — якорь суток/погоды ---------- */
const anchor = atmo.atmoAnchor({ atmo: null }, 1000);
eq(
  "atmoAnchor дефолта: середина дня, солнце",
  [anchor.cs, anchor.pl, anchor.wl, anchor.w, anchor.ws, anchor.dp],
  [-629000, 420000, 720000, "sun", 1000, "day"],
);
eq("atmoPhaseIdx на якоре дефолта", atmo.atmoPhaseIdx(anchor, 1000), 1);
// Формула фазы (проверено по исходному коду до выреза): floor(((now-cs)/pl %4 +4)%4).
eq("atmoPhaseIdx: глубина ночи (500000 от старта)", atmo.atmoPhaseIdx({ cs: 0, pl: 420000, wl: 720000 }, 500000), 1);
eq("atmoPhaseIdx: якорь в прошлом (cs=500000, now=1000)", atmo.atmoPhaseIdx({ cs: 500000, pl: 420000, wl: 720000 }, 1000), 2);
eq("atmoPhaseIdx: граница дня (419999)", atmo.atmoPhaseIdx({ cs: 0, pl: 420000, wl: 720000 }, 419999), 0);
eq("atmoPhaseIdx: старт ночи (1140000)", atmo.atmoPhaseIdx({ cs: 0, pl: 420000, wl: 720000 }, 1140000), 2);
eq("modes: test registered-only", modes.requiresAccount("test"), true);
eq("modes: grot open", modes.requiresAccount("grot-1"), false);

/* ---------- P1: снятие combat-комнаты + хост-классы ---------- */
eq("modes: RETIRED_ROOMS алиас combat → grot-1", modes.RETIRED_ROOMS.combat, "grot-1");
eq("modes: combat нет в каталоге MODE_ROOMS", modes.MODE_ROOMS.some((r) => r.id === "combat"), false);
eq("modes: снятый код не закрыт аккаунтом (замок только у живых комнат)", modes.requiresAccount("combat"), false);

// env-листы host-политики читаются в момент вызова hostClassOf — задаём ДО проверок.
process.env.PUBLIC_HOSTS = "pub.example,.pub-zone.example";
process.env.ELYRIA_HOSTS = "ely.example,.ely-zone.example";
eq("hostClassOf: env PUBLIC_HOSTS — точное имя", cfg.hostClassOf("pub.example"), "public");
eq("hostClassOf: env PUBLIC_HOSTS — суффикс поддомена", cfg.hostClassOf("pr-45.pub-zone.example"), "public");
eq("hostClassOf: точка-метка не поглощает соседей", cfg.hostClassOf("stranger.pub.example"), "public");
eq("hostClassOf: дефолт abnocw.phainonsmilk.ru", cfg.hostClassOf("abnocw.phainonsmilk.ru"), "public");
eq("hostClassOf: дефолт суффикс .abnocw.phainonsmilk.ru", cfg.hostClassOf("pr-12.abnocw.phainonsmilk.ru"), "public");
eq("hostClassOf: дефолт coop.sslip", cfg.hostClassOf("coop.89-232-184-77.sslip.io"), "public");
eq("hostClassOf: дефолт abnocw.sslip", cfg.hostClassOf("abnocw.89-232-184-77.sslip.io"), "public");
eq("hostClassOf: дефолт суффикс .89-232-184-77.sslip.io", cfg.hostClassOf("pr-7.89-232-184-77.sslip.io"), "public");
eq("hostClassOf: env ELYRIA_HOSTS — точное имя", cfg.hostClassOf("ely.example"), "elyria");
eq("hostClassOf: env ELYRIA_HOSTS — суффикс", cfg.hostClassOf("pr-9.ely-zone.example"), "elyria");
eq("hostClassOf: дефолт phainonsmilk.ru", cfg.hostClassOf("phainonsmilk.ru"), "elyria");
eq("hostClassOf: дефолт суффикс .elysiae.phainonsmilk.ru", cfg.hostClassOf("pr-33.elysiae.phainonsmilk.ru"), "elyria");
eq("hostClassOf: localhost — local", cfg.hostClassOf("localhost"), "local");
eq("hostClassOf: порт не мешает классу (127.0.0.1)", cfg.hostClassOf("127.0.0.1:3780"), "local");
eq("hostClassOf: 127.* — local", cfg.hostClassOf("127.0.0.99"), "local");
eq("hostClassOf: *.localhost — local", cfg.hostClassOf("dev.localhost"), "local");
eq("hostClassOf: ::1 — local", cfg.hostClassOf("::1"), "local");
eq("hostClassOf: [::1]:8080 — local", cfg.hostClassOf("[::1]:8080"), "local");
eq("hostClassOf: неизвестный хост → public", cfg.hostClassOf("evil.example"), "public");
eq("hostClassOf: пустой хост → public (самый закрытый дефолт)", cfg.hostClassOf(""), "public");
eq("isPublicHost: по req.headers.host", cfg.isPublicHost({ headers: { host: "pub.example:9000" } }), true);
eq("isElyriaHost: по req.headers.host", cfg.isElyriaHost({ headers: { host: "ely.example" } }), true);
eq("isElyriaHost: public-хост — false", cfg.isElyriaHost({ headers: { host: "pub.example" } }), false);
eq("isElyriaHost: без заголовка host — false", cfg.isElyriaHost({ headers: {} }), false);
eq("hunger idle", hunger.hungerState({}).phase, "idle");
eq("auth cookie name", auth.COOKIE, "coop_session");
eq("accounts PASS_MIN", accounts.PASS_MIN, 8);
eq("cfg sanitize phase clamp", runtimeConfig.sanitizeConfig({ atmo: { phaseMin: 999, weatherMin: 12 } }).config.atmo.phaseMin, 120);
eq("cfg sanitize weather floor", runtimeConfig.sanitizeConfig({ atmo: { phaseMin: 7, weatherMin: 0 } }).config.atmo.weatherMin, 2);

/* ---------- F2 §7: MAX_ACCOUNTS — значение владелицы 500 (2026-11-08), env bounded ----------
 * Фактический код server/accounts.js: maxAccounts() = env-число (>0) или
 * дефолт 2000; потолок достижим ('full'). Проверяем через ПУБЛИЧНЫЙ
 * createAccount — контракт {account}|{error}, без правок модуля. */
{
  const stamp = Date.now();
  process.env.MAX_ACCOUNTS = "0"; // 0/мусор → дефолт 500 (bounded override)
  const zeroRes = await accounts.createAccount(`mh0_${stamp}`, "password123");
  eq("MAX_ACCOUNTS env=0/мусор → дефолт 500 (регистрация проходит)", zeroRes.error, undefined);
  process.env.MAX_ACCOUNTS = "3"; // в песочнице уже есть 1 аккаунт (мх-0)
  const a1 = await accounts.createAccount(`mh1_${stamp}`, "password123");
  const a2 = await accounts.createAccount(`mh2_${stamp}`, "password123");
  const a3 = await accounts.createAccount(`mh3_${stamp}`, "password123");
  delete process.env.MAX_ACCOUNTS;
  eq("MAX_ACCOUNTS: env-потолок достижим — лишний аккаунт 'full', лимитные созданы", [!!a1.account, !!a2.account, a3.error], [true, true, "full"]);
  eq("MAX_ACCOUNTS: env снят — дефолт 2000, регистрация снова свободна", (await accounts.createAccount(`mh4_${stamp}`, "password123")).error, undefined);
}

/* ---------- F2: room-config.js — per-room модель (слой поверх B2) ---------- */
eq(
  "room-config: 3 поддержанных per-room ключа",
  roomConfig.SUPPORTED_ROOM_KEYS,
  ["atmo.phaseMin", "atmo.weatherMin", "atmo.allowPlayerAtmosphereControl"],
);
eq("room-config: RETIRED-алиас combat → grot-1", roomConfig.canonicalRoomId("combat"), "grot-1");
eq("room-config: path traversal '../etc/passwd' → null (не зарегистрирована)", roomConfig.canonicalRoomId("../etc/passwd"), null);
eq("room-config: незарегистрированный код → null", roomConfig.canonicalRoomId("marja-room"), null);
eq(
  "room-config: гейт atmoset default true (комната без overrides)",
  roomConfig.isPlayerAtmoControlAllowed("grot-1"),
  true,
);
eq(
  "room-config: init без overrides → прежняя ленивая инициализация (null)",
  roomConfig.initialRoomAtmo("grot-1"),
  null,
);

/* ---------- F2 §4: сервер — авторитет выбора игрока (combat.armor) ----------
 * Канал фактический: WS-кадр "armor" → combat.armor → снап к ВИДИМОМУ игроку
 * списку (combatCaps читает runtime-состояние). Прогоняем чистую функцию
 * через saveConfig с явным playerSelectable=false. */
{
  const cur = runtimeConfig.combatCaps();
  eq("§4 combatCaps: дефолт — 10 десятых, потолок урона 9", [cur.armorTenths.length, cur.maxDamageLevel], [10, 9]);
  const saved = runtimeConfig.sanitizeConfig({ atmo: { phaseMin: 7, weatherMin: 12 } });
  runtimeConfig.saveConfig({ ...saved.config, universes: { strikeDamage: { levels: [0, 1, 2, 3], default: 1, playerSelectable: false }, armor: { tenths: [0.3, 0.5, 0.9], default: 0.5, playerSelectable: false }, arrowSpeed: { periods: [1.8, 2.5, 3.5, 4, 4.5, 5], default: 5, playerSelectable: true } } });
  const caps = runtimeConfig.combatCaps();
  eq(
    "§4 combatCaps: playerSelectable=false → игроку виден только defaultValue",
    [caps.maxDamageLevel, caps.armorTenths],
    [1, [0.5]],
  );
  // WS-гейт: мусорная броня вне видимого списка => снап к дефолту 0.5.
  const fakeCat = { armor: 0.9 };
  const fakeWs = {};
  fakeWs.room = { sockets: new Map([[fakeWs, fakeCat]]) };
  combat.armor(fakeWs, { armor: 0.9 });
  eq("§4 combat.armor: 0.9 при выключенном выборе → снап к defaultValue 0.5", fakeCat.armor, 0.5);
  runtimeConfig.saveConfig(runtimeConfig.defaults());
  const back = runtimeConfig.combatCaps();
  eq("§4 combatCaps: сброс к дефолтному реестру после теста", [back.armorTenths.length, back.maxDamageLevel], [10, 9]);
}

// Лапы, не верх картинки и не её экранная проекция, задают клетку опоры.
{
  const oldElev = testmap.testMap.elev;
  testmap.testMap.elev = {"4,3":3};
  const foot = {dx:0.3,dy:0.9};
  const attempt = (fromX,fromY,toX,toY) => {
    const cat = {id:"foot-test",fx:fromX-foot.dx,fy:fromY-foot.dy,x:4,y:3,freeFoot:foot};
    const ws = {}; ws.room = {fmt:"test",sockets:new Map([[ws,cat]])};
    movement.freeMove(ws,{x:toX-foot.dx,y:toY-foot.dy,foot,stop:true});
    return Math.abs(cat.fx-(toX-foot.dx))<0.011 && Math.abs(cat.fy-(toY-foot.dy))<0.011;
  };
  eq("плато: северная кромка блокирует ровно по лапам",attempt(4.5,2.98,4.5,3.02),false);
  eq("плато: южная кромка блокирует ровно по лапам",attempt(4.5,3.98,4.5,4.02),false);
  eq("плато: западная кромка блокирует ровно по лапам",attempt(3.98,3.5,4.02,3.5),false);
  eq("плато: восточная кромка блокирует ровно по лапам",attempt(4.98,3.5,5.02,3.5),false);
  eq("на северном краю плато нет ранней невидимой стены",attempt(4.5,3.1,4.5,3.01),true);
  eq("на южном краю плато нет экранной стены",attempt(4.5,3.8,4.5,3.99),true);
  eq("под северным краем можно дойти вплотную",attempt(4.5,2.8,4.5,2.99),true);
  const exactFoot = {dx:0.4666666666666666,dy:0.9333333333333333};
  const exactCat = {id:"edge-test",fx:4.001-exactFoot.dx,fy:3.5-exactFoot.dy,x:5,y:4,freeFoot:exactFoot};
  const exactWs = {};exactWs.room={fmt:"test",sockets:new Map([[exactWs,exactCat]])};
  movement.freeMove(exactWs,{x:4.00001-exactFoot.dx,y:exactCat.fy,foot:exactFoot,stop:true});
  eq("округление сетевой позиции не сбрасывает лапы с плато",Math.floor(exactCat.fx+exactFoot.dx),4);
  testmap.testMap.elev = oldElev;
}

// Тело кота, а не только точка опоры: зеркальные проверки контакта с обрывом.
{
  const oldElev=testmap.testMap.elev;testmap.testMap.elev={"4,3":2};
  const foot={dx:.4666666666666666,dy:140/150,rx:.28,ry:28/150};
  const attempt=(x0,y0,x1,y1)=>{
    const cat={id:"body-test",fx:x0-foot.dx,fy:y0-foot.dy,x:4,y:3,freeFoot:foot};
    const ws={};ws.room={fmt:"test",sockets:new Map([[ws,cat]])};
    movement.freeMove(ws,{x:x1-foot.dx,y:y1-foot.dy,foot,stop:true});
    return Math.abs(cat.fx-(x1-foot.dx))<1e-8&&Math.abs(cat.fy-(y1-foot.dy))<1e-8;
  };
  eq("тело у западной стены: контакт",attempt(3.6,3.5,3.72,3.5),true);
  eq("тело у западной стены: пересечение",attempt(3.72,3.5,3.74,3.5),false);
  eq("тело у южной стены: контакт",attempt(4.5,4.4,4.5,4+foot.ry),true);
  eq("тело у южной стены: пересечение",attempt(4.5,4+foot.ry,4.5,4+foot.ry-.02),false);
  eq("на плато тело не свешивается в пропасть",attempt(4.5,3.5,4.05,3.5),false);
  eq("из наложения после посадки можно выйти",attempt(4.05,3.5,4.12,3.5),true);
  eq("в наложение нельзя углубиться",attempt(4.12,3.5,4.05,3.5),false);
  const levelAt=(c,r)=>c===4&&r===3?2:0;
  eq("сервер: скругление у диагонального угла",world.terrainBodyOverlap(3.8,2.8,.28,28/150,0,levelAt),0);
  testmap.testMap.elev=oldElev;
}


// PNG scanline reconstruction is in-place to avoid a second full RGBA buffer.
// Exercise every predictor, including alpha crossing the 127 threshold.
function pngFixture(filter,bpp=4){
 const w=3,h=2,pixels=Buffer.from(Array.from({length:w*h*bpp},(_,i)=>bpp===4&&i%4===3?[0,128,255][Math.floor(i/4)%3]:(i*37)%256));
 const stride=w*bpp,raw=Buffer.alloc((stride+1)*h);
 for(let y=0;y<h;y++){
  raw[y*(stride+1)]=filter;
  for(let x=0;x<stride;x++){
   const i=y*stride+x,a=x>=bpp?pixels[i-bpp]:0,b=y?pixels[i-stride]:0,c=y&&x>=bpp?pixels[i-stride-bpp]:0;
   const pp=a+b-c,pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);
   const pred=[0,a,b,(a+b)>>1,pa<=pb&&pa<=pc?a:pb<=pc?b:c][filter];
   raw[y*(stride+1)+1+x]=(pixels[i]-pred)&255;
  }
 }
 const chunk=(type,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);return b;};
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=bpp===4?6:2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
for(let filter=0;filter<=4;filter++){
 eq(`PNG filter ${filter}: exact alpha`,[...world.decodePaintPng(pngFixture(filter)).mask],[0,1,1,0,1,1]);
 eq(`RGB filter ${filter}: opaque`,[...world.decodePaintPng(pngFixture(filter,3)).mask],[1,1,1,1,1,1]);
}

/* ---------- strike: урон считает сервер, клиентские 999 не применяются ----------
 * Гость (нет profile.sp) — таблица уровня 0. Уровень из профиля проходит
 * формулу maxStrikeDamage и режется потолком реестра. Сосед, зона и угол
 * проверяются как раньше: диагональное горло с damage 999 не становится ударом. */
{
  const OPEN = WebSocket.OPEN;
  function harness(damageLevel) {
    const inbox = [];
    const ws = {
      readyState: OPEN,
      send(raw) { inbox.push(JSON.parse(String(raw))); },
    };
    if (damageLevel !== undefined) ws.account = { profile: { sp: { damageLevel } } };
    const atk = { id: 11, login: "Альфа", x: 5, y: 5, lastStrike: 0, armor: 0 };
    const def = { id: 12, login: "Бета", x: 6, y: 5, blocking: false, armor: 0 };
    ws.room = { cats: new Map([[atk.id, atk], [def.id, def]]), sockets: new Map([[ws, atk]]) };
    return { ws, atk, def, inbox };
  }
  async function land(h, payload) {
    h.atk.lastStrike = 0;
    h.inbox.length = 0;
    combat.strike(h.ws, { target: h.def.id, angle: 0, flightMs: 0, ...payload });
    await new Promise((r) => setTimeout(r, 30));
    return {
      fight: h.inbox.find((m) => m[0] === "fight")?.[1] ?? null,
      info: h.inbox.filter((m) => m[0] === "info").map((m) => String(m[1])),
    };
  }
  const guest = harness();
  const throat999 = await land(guest, { zone: "throat", damage: 999, pawsDamage: 999 });
  eq(
    "strike 999 гостя: горло = таблица уровня 0, не 999",
    [throat999.fight?.zone, throat999.fight?.damage, throat999.fight?.damage === 999],
    ["throat", cfgReg.maxStrikeDamage("throat", 0), false],
  );
  const throat10 = await land(guest, { zone: "throat", damage: 10 });
  eq("strike damage 10 гостя тоже игнорируется", throat10.fight?.damage, cfgReg.maxStrikeDamage("throat", 0));
  const lvl9 = harness(9);
  const throatLvl = await land(lvl9, { zone: "throat", damage: 999 });
  eq(
    "strike 999 при profile.sp.damageLevel 9: горло по формуле уровня 9",
    throatLvl.fight?.damage,
    cfgReg.maxStrikeDamage("throat", 9),
  );
  const throatUnder = await land(lvl9, { zone: "throat", damage: 10, pawsDamage: 1 });
  eq("strike damage 10 при уровне 9 не занижает таблицу", throatUnder.fight?.damage, cfgReg.maxStrikeDamage("throat", 9));
  guest.def.blocking = true;
  const blocked = await land(guest, { zone: "muzzle", damage: 999, pawsDamage: 999 });
  eq(
    "блок: pawsDamage 999 игнорируется, лапы = таблица уровня 0",
    [blocked.fight?.zone, blocked.fight?.part, blocked.fight?.damage],
    ["paws", "Лапы", cfgReg.maxStrikeDamage("paws", 0)],
  );
  guest.def.blocking = false;
  guest.def.armor = 0.9;
  const armored = await land(guest, { zone: "throat", damage: 999 });
  eq(
    "броня режет уже серверный урон, не 999",
    armored.fight?.damage,
    Math.round(cfgReg.maxStrikeDamage("throat", 0) * combat.armorMultiplier(0.9)),
  );
  guest.def.armor = 0;
  guest.def.x = 6;
  guest.def.y = 6;
  const diag = await land(guest, { zone: "throat", angle: 45, damage: 999 });
  eq("диагональное горло с damage 999 не применяется", [diag.fight, diag.info.some((t) => t.includes("диагонали"))], [null, true]);
  const saved = runtimeConfig.defaults();
  try {
    runtimeConfig.saveConfig({
      ...saved,
      universes: {
        ...saved.universes,
        strikeDamage: { levels: [0, 1, 2], default: 0, playerSelectable: true },
      },
    });
    const capped = await land(harness(9), { zone: "throat", damage: 999 });
    eq(
      "реестр режет уровень 9 до видимого потолка 2, не до 999",
      capped.fight?.damage,
      cfgReg.maxStrikeDamage("throat", 2),
    );
  } finally {
    runtimeConfig.saveConfig(saved);
  }
}

// ---------- отчёт ----------
if (failed > 0) {
  console.error(`\nсмоук модулей сервера: FAIL — ${failed} провалено, ${passed} прошло.`);
  process.exit(1);
}

console.log(`смоук модулей сервера: зелёный — ${passed} проверок, модули импортированы чисто.`);
