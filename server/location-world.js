/** Location model mirror and trusted world travel. No client coordinates are accepted for arrival. */
import fs from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { DATA_DIR } from './config.js';
import { writeFileAtomic } from './atomic-file.js';
import { EV, MAX_PLAYERS } from './protocol.js';
import { testMap, TEST_OBST_BODIES, withTestLocation, sanitizeTestMap } from './testmap.js';
import { rooms, roomOf, spawnCell, join, send, occupied, broadcast } from './room.js';
import { testPointInIsland, testWalkable } from './world.js';
import { sessionFromRequest } from './auth.js';
import { json, readJson, setCors } from './runtime-config.js';
import { pushActivity } from './activity.js';
import { locationLabelOf } from './presence.js';

const INDEX_FILE = path.join(DATA_DIR, 'locations-index.json');
const MAX_LOCATIONS = 64;
/** Mutable registry: seed 1+2, then index file + location-N.json discovery. */
function discoverLocationIds() {
    const ids = new Set([1, 2]);
    try {
        for (const entry of fs.readdirSync(DATA_DIR)) {
            const m = /^location-(\d+)\.json$/.exec(entry);
            if (m) {
                const id = Number(m[1]);
                if (Number.isSafeInteger(id) && id >= 1 && id <= 9999) ids.add(id);
            }
        }
    } catch { /* empty DATA_DIR on first boot */ }
    try {
        const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
        if (Array.isArray(raw?.ids)) {
            for (const value of raw.ids) {
                const id = Number(value);
                if (Number.isSafeInteger(id) && id >= 1 && id <= 9999) ids.add(id);
            }
        }
    } catch { /* missing index = seed only */ }
    return [...ids].sort((a, b) => a - b);
}
export const LOCATION_IDS = discoverLocationIds();
function persistLocationIds() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(INDEX_FILE, JSON.stringify({ v: 1, ids: [...LOCATION_IDS] }, null, 2));
}
export function defaultPlace(id = 1) {
    const name = id === 1 ? 'Долина' : id === 2 ? 'Редколесье' : `Локация ${id}`;
    return { id, name, zoneId: 1, zoneName: 'Средиземье' };
}
export const locationRoom = (id) => id === 1 ? 'test' : `test-loc-${id}`;
export const locationRooms = () => LOCATION_IDS.map(locationRoom);
export function locationFromRoom(room) {
    if (room === 'test')
        return 1;
    const m = /^test-loc-(\d+)$/.exec(room);
    return m ? Number(m[1]) : 0;
}
const name = (value, fallback) => typeof value === 'string' && value.trim() ? value.trim().normalize('NFC').slice(0, 64) : fallback;
export function sanitizeLocationFields(raw, cols, rows) {
    let place, passages;
    if (raw.place != null) {
        const p = raw.place, id = Number(p.id), zoneId = Number(p.zoneId);
        if (!p || typeof p !== 'object' || !Number.isSafeInteger(id) || id < 1 || id > 9999 || !Number.isSafeInteger(zoneId) || zoneId < 1 || zoneId > 999)
            return { error: 'неверный ID локации или зоны' };
        const fallback = defaultPlace(id);
        place = { id, name: name(p.name, fallback.name), zoneId, zoneName: name(p.zoneName, fallback.zoneName) };
    }
    if (raw.passages != null) {
        if (!Array.isArray(raw.passages) || raw.passages.length > 128)
            return { error: 'областей перехода не больше 128' };
        passages = [];
        const ids = new Set();
        for (const v of raw.passages) {
            if (!v || typeof v !== 'object')
                return { error: 'область перехода не распознана' };
            const p = v, id = String(p.id ?? ''), x = Number(p.x), y = Number(p.y), w = Number(p.w), h = Number(p.h), targetId = Number(p.targetId);
            if (!/^[a-zA-Z0-9_-]{1,48}$/.test(id) || ids.has(id))
                return { error: 'ID областей перехода должны быть уникальны' };
            if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w < .1 || h < .1 || x + w > cols + .0001 || y + h > rows + .0001)
                return { error: 'область перехода выходит за границы карты' };
            if (!Number.isSafeInteger(targetId) || targetId < 1 || targetId > 9999 || targetId === place?.id)
                return { error: 'укажите ID другой локации' };
            const direction = ['left', 'right', 'up', 'down'].includes(p.direction) ? p.direction : 'right';
            if (p.link != null && (typeof p.link !== 'string' || !/^[a-zA-Z0-9_-]{0,32}$/.test(p.link)))
                return { error: 'ключ связи: до 32 латинских букв, цифр, дефисов' };
            ids.add(id);
            const round = (n) => Math.round(n * 10000) / 10000;
            passages.push({ id, x: round(x), y: round(y), w: round(w), h: round(h), targetId, link: p.link ?? '', direction });
        }
    }
    return { ...(place ? { place } : {}), ...(passages ? { passages } : {}) };
}
export const passageContains = (p, x, y, padding = 0) => x >= p.x - padding && y >= p.y - padding && x <= p.x + p.w + padding && y <= p.y + p.h + padding;

export const knownLocation=id=>LOCATION_IDS.includes(Number(id));
export const locationFile=id=>path.join(DATA_DIR,Number(id)===1?'test-map.json':`location-${id}.json`);
export const placeOf=(map,id)=>({...defaultPlace(id),...(map.place??{}),id});
/** New maps get an opaque 10×10 grass plane. Existing files are never reseeded. */
function grassPng(){
  const w=1000,h=1500,stride=w*4+1,pixels=Buffer.alloc(stride*h);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let seed=(Math.imul((x>>2)+2718,374761393)+Math.imul((y>>2)+611,668265263))>>>0;
    seed=Math.imul(seed^(seed>>>13),1274126177);seed=(seed^(seed>>>16))>>>0;
    const n=((seed>>>24)%13)-6,i=y*stride+1+x*4;
    pixels[i]=125+n;pixels[i+1]=133+n;pixels[i+2]=55+Math.round(n/2);pixels[i+3]=255;
  }
  const crc=b=>{let c=0xffffffff;for(const v of b){c^=v;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;};
  const chunk=(type,body)=>{const t=Buffer.from(type),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(body.length);sum.writeUInt32BE(crc(Buffer.concat([t,body])));return Buffer.concat([len,t,body,sum]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
export function loadLocationMap(id) {
    if (!knownLocation(id))
        throw new Error('Неизвестная локация');
    const file = locationFile(id);
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw new Error(`Локация ${id}: не удалось прочитать карту (${error.message})`);
        raw = { v: 2, cols: 10, rows: 10, margin: .5, seed: `location-${id}`, place: defaultPlace(id), zones: [], objects: [], spawns: [{ c: 2, r: 5 }], passages: [], paint: grassPng() };
        fs.mkdirSync(DATA_DIR, { recursive: true });
        writeFileAtomic(file, JSON.stringify(raw, null, 2));
    }
    const checked = sanitizeTestMap({ ...raw, place: placeOf(raw, id) });
    if (!checked.map)
        throw new Error(`Локация ${id}: ${checked.error}`);
    return checked.map;
}
const catalogueErrors=new Set();
export function locationCatalogue() {
    return LOCATION_IDS.map(id=>{
        try{const place=withTestLocation(id,()=>placeOf(testMap,id));catalogueErrors.delete(id);return place;}
        catch(error){if(!catalogueErrors.has(id)){console.warn(`location ${id} unavailable:`,error.message);catalogueErrors.add(id);}return defaultPlace(id);}
    });
}
export function broadcastLocationCatalogue() {
    const catalogue = locationCatalogue();
    for (const room of rooms.values()) {
        if (room.fmt === 'test') broadcast(room, EV.LOCATIONS, catalogue);
    }
    return catalogue;
}
/** Admin create: next free id after max(LOCATION_IDS), blank 10×10 grass map. */
export function createLocation(opts = {}) {
    if (LOCATION_IDS.length >= MAX_LOCATIONS)
        return { error: `локаций не больше ${MAX_LOCATIONS}` };
    const id = LOCATION_IDS.reduce((max, value) => Math.max(max, value), 0) + 1;
    if (id > 9999)
        return { error: 'исчерпан диапазон ID локаций' };
    const file = locationFile(id);
    if (fs.existsSync(file))
        return { error: `файл локации ${id} уже существует` };
    const place = { ...defaultPlace(id), name: name(opts.name, defaultPlace(id).name) };
    const raw = {
        v: 2, cols: 10, rows: 10, margin: .5, seed: `location-${id}`, place,
        zones: [], objects: [], spawns: [{ c: 2, r: 5 }], passages: [], paint: grassPng(),
    };
    const checked = sanitizeTestMap(raw);
    if (!checked.map)
        return { error: checked.error || 'карта не прошла проверку' };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    writeFileAtomic(file, JSON.stringify(checked.map, null, 2));
    LOCATION_IDS.push(id);
    LOCATION_IDS.sort((a, b) => a - b);
    persistLocationIds();
    try { withTestLocation(id, () => {}); }
    catch (error) {
        console.warn(`location ${id} warm-up failed:`, error.message);
    }
    const locations = broadcastLocationCatalogue();
    return { place: locations.find(p => p.id === id) ?? place, locations };
}
function locationsAdminGate(req, res) {
    const session = sessionFromRequest(req);
    if (!session) {
        json(res, 401, { ok: false, reason: 'auth_required', message: 'Нужен вход в аккаунт администратора.' });
        return null;
    }
    if (session.account?.role !== 'admin') {
        json(res, 403, { ok: false, reason: 'forbidden', message: 'Раздел открыт только администраторам.' });
        return null;
    }
    return session;
}
/** Создать локацию (admin): общий обработчик POST /locations и POST /admin/locations. */
async function handleCreateLocationHttp(req, res) {
    setCors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    if (!locationsAdminGate(req, res)) return true;
    if (req.method === 'GET') {
        json(res, 200, { ok: true, locations: locationCatalogue(), rooms: locationRooms() });
        return true;
    }
    if (req.method !== 'POST') {
        json(res, 405, { ok: false, reason: 'method_not_allowed' });
        return true;
    }
    let body = {};
    try { body = await readJson(req); }
    catch {
        json(res, 400, { ok: false, reason: 'json', message: 'Тело запроса не читается как JSON.' });
        return true;
    }
    const extra = Object.keys(body).filter(k => k !== 'name');
    if (extra.length) {
        json(res, 400, { ok: false, reason: 'unexpected_fields', unexpected: extra, expected: ['name'] });
        return true;
    }
    const result = createLocation({ name: body.name });
    if (result.error) {
        json(res, 400, { ok: false, reason: 'invalid', message: result.error });
        return true;
    }
    json(res, 200, { ok: true, place: result.place, locations: result.locations, room: locationRoom(result.place.id) });
    return true;
}
/** GET /locations|/cfg/locations + POST create (алиасы /admin/locations).
 *  /cfg/locations — обход без exact nginx location: прод уже проксирует весь /cfg. */
export async function handleLocationsHttp(req, res) {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    if (p === '/locations' || p === '/cfg/locations') {
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
        if (req.method === 'GET') {
            json(res, 200, { ok: true, locations: locationCatalogue(), rooms: locationRooms() });
            return true;
        }
        // Admin create without /admin/ in the client bundle (A1 grotto gate).
        return handleCreateLocationHttp(req, res);
    }
    if (p !== '/admin/locations') return false;
    return handleCreateLocationHttp(req, res);
}
const direction = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
function freeArrival(room, x, y) {
    if (!testPointInIsland(x, y) || testWalkable(Math.floor(x) + 1, Math.floor(y) + 1) || occupied(room, Math.floor(x) + 1, Math.floor(y) + 1))
        return false;
    for (const b of TEST_OBST_BODIES) {
        if (b.o?.kind === 'stone' || !(b.hw > 0 && b.h > 0))
            continue;
        const dx = (x - b.x) * 100, dy = (y - b.y) * 150, cos = Math.cos(-b.rot), sin = Math.sin(-b.rot);
        if (((dx * cos - dy * sin) / b.hw) ** 2 + ((dx * sin + dy * cos) / b.h) ** 2 <= 1)
            return false;
    }
    return true;
}
function arrivalAt(room, sourceId, passage, foot) {
    const reverse = (testMap.passages ?? []).filter(p => p.targetId === sourceId && (!passage.link || p.link === passage.link));
    if (reverse.length > 1)
        return { error: 'У нескольких обратных проходов одинаковая связь. Задайте уникальный ключ связи в редакторе.' };
    const points = [];
    if (reverse.length) {
        const p = reverse[0], [dx, dy] = direction[p.direction], cx = p.x + p.w / 2, cy = p.y + p.h / 2;
        for (const distance of [.4, .7, 1, 1.5, 2, 2.5, 3, 4]) {
            points.push([cx - dx * (p.w / 2 + distance), cy - dy * (p.h / 2 + distance)]);
            points.push([p.x - distance, cy], [p.x + p.w + distance, cy], [cx, p.y - distance], [cx, p.y + p.h + distance]);
        }
    }
    else {
        const spawn = spawnCell(room);
        if (spawn)
            points.push([spawn[0] - .5, spawn[1] - .2]);
    }
    for (const [x, y] of points) {
        if (!freeArrival(room, x, y) || (reverse.length && passageContains(reverse[0], x, y, .1)))
            continue;
        return { fx: x - foot.dx, fy: y - foot.dy, x: Math.floor(x) + 1, y: Math.floor(y) + 1, foot };
    }
    // Обратный проход есть, но кольцо у выхода забито — не soft-lock перехода:
    // запасной спавн локации, вне триггера обратного прохода.
    if (reverse.length) {
        const spawn = spawnCell(room);
        if (spawn) {
            const x = spawn[0] - .5, y = spawn[1] - .2;
            if (freeArrival(room, x, y) && !passageContains(reverse[0], x, y, .1))
                return { fx: x - foot.dx, fy: y - foot.dy, x: Math.floor(x) + 1, y: Math.floor(y) + 1, foot };
        }
    }
    return { error: reverse.length ? 'У обратного прохода нет свободной площадки для появления.' : 'В локации нет свободной точки появления.' };
}
/** JOIN {passageId} is a trusted transition, not an arbitrary target/arrival.
 * A normal room JOIN remains available for authenticated editor switching.
 */
export function travel(ws, payload) {
    const source = ws.room, cat = source?.sockets.get(ws), fail = text => send(ws, EV.INFO, `Переход: ${text}`);
    if(Date.now()-(ws.lastTravelAttempt??0)<1000)return fail('подождите секунду перед новой попыткой.');
    ws.lastTravelAttempt=Date.now();
    if (!ws.account || source?.fmt !== 'test' || !cat || cat.fm !== 1 || cat.jp || cat.blocking)
        return fail('доступен только в мирном режиме, стоя на земле.');
    if (Date.now() - (ws.lastTravel ?? 0) < 2000)
        return fail('подождите перед следующим переходом.');
    const passage = (testMap.passages ?? []).find(p => p.id === payload.passageId), foot = cat.freeFoot ?? { dx: .45, dy: .95 };
    if (!passage || !passageContains(passage, cat.fx + foot.dx, cat.fy + foot.dy, .15))
        return fail('подойдите в область прохода.');
    if (!knownLocation(passage.targetId) || passage.targetId === locationFromRoom(source.code))
        return fail('целевая локация не найдена.');
    try {
        const target = roomOf(locationRoom(passage.targetId));
        if (target.cats.size >= MAX_PLAYERS)
            return fail('в следующей локации сейчас нет мест.');
        const arrival = withTestLocation(passage.targetId, () => arrivalAt(target, locationFromRoom(source.code), passage, foot));
        if (arrival.error)
            return fail(arrival.error);
        ws.lastTravel = Date.now();
        join(ws, { room: target.code, login: cat.login, sprite: cat.sprite, size: cat.size }, { arrival });
        pushActivity(ws.account.id, 'moved', { locationId: passage.targetId, label: locationLabelOf(ws.account) || '' });
    }
    catch (error) {
        console.warn('location travel failed:', error.message);
        fail('не удалось открыть локацию. Вы остались на прежней карте.');
    }
}
