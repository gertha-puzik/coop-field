import { terrainAt, terrainScreenPoint } from './terrain-shape.ts';
/** World identity and passages are separate from painted/battle zones.
 * Coordinates are ground cell fractions, never projected screen pixels.
 * Validation is mirrored in server/location-world.js and covered by parity tests.
 */
export type LocationPlace = {
    id: number;
    name: string;
    zoneId: number;
    zoneName: string;
};
export type LocationPassage = {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    targetId: number;
    link: string;
    direction: 'left' | 'right' | 'up' | 'down';
};
export const LOCATION_IDS = [1, 2] as const;
export function defaultPlace(id = 1): LocationPlace {
    return { id, name: id === 2 ? 'Редколесье' : 'Долина', zoneId: 1, zoneName: 'Средиземье' };
}
export const locationRoom = (id: number) => id === 1 ? 'test' : `test-loc-${id}`;
export function locationFromRoom(room: string): number {
    if (room === 'test')
        return 1;
    const m = /^test-loc-(\d+)$/.exec(room);
    return m ? Number(m[1]) : 0;
}
const name = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value.trim().normalize('NFC').slice(0, 64) : fallback;
export function sanitizeLocationFields(raw: {
    place?: unknown;
    passages?: unknown;
}, cols: number, rows: number): {
    place?: LocationPlace;
    passages?: LocationPassage[];
    error?: string;
} {
    let place: LocationPlace | undefined, passages: LocationPassage[] | undefined;
    if (raw.place != null) {
        const p = raw.place as Partial<LocationPlace>, id = Number(p.id), zoneId = Number(p.zoneId);
        if (!p || typeof p !== 'object' || !Number.isSafeInteger(id) || id < 1 || id > 9999 || !Number.isSafeInteger(zoneId) || zoneId < 1 || zoneId > 999)
            return { error: 'неверный ID локации или зоны' };
        const fallback = defaultPlace(id);
        place = { id, name: name(p.name, fallback.name), zoneId, zoneName: name(p.zoneName, fallback.zoneName) };
    }
    if (raw.passages != null) {
        if (!Array.isArray(raw.passages) || raw.passages.length > 128)
            return { error: 'областей перехода не больше 128' };
        passages = [];
        const ids = new Set<string>();
        for (const v of raw.passages) {
            if (!v || typeof v !== 'object')
                return { error: 'область перехода не распознана' };
            const p = v as LocationPassage, id = String(p.id ?? ''), x = Number(p.x), y = Number(p.y), w = Number(p.w), h = Number(p.h), targetId = Number(p.targetId);
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
            const round = (n: number) => Math.round(n * 10000) / 10000;
            passages.push({ id, x: round(x), y: round(y), w: round(w), h: round(h), targetId, link: p.link ?? '', direction });
        }
    }
    return { ...(place ? { place } : {}), ...(passages ? { passages } : {}) };
}
export const passageContains = (p: LocationPassage, x: number, y: number, padding = 0) => x >= p.x - padding && y >= p.y - padding && x <= p.x + p.w + padding && y <= p.y + p.h + padding;
export function newPassageId() { return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
/** Editor-only geometry. Uses the same ground projection as terrain, including
 * yaw, zoom and elevation. No per-passage DOM markers or game-time mesh work.
 */
export function drawLocationPassages(canvas: HTMLCanvasElement | null, frame: import('./elision-scene').ElisionFrame, passages: LocationPassage[], ghost?: LocationPassage) {
    if (!frame.editor)
        return;
    const g = canvas?.getContext('2d');
    if (!g)
        return;
    g.save();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const p of [...passages, ...(ghost ? [ghost] : [])]) {
        const points = [[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]].map(([x, y]) => terrainScreenPoint(frame, x * frame.cellW, y * frame.cellH, terrainAt(frame.elev, Math.min(x, frame.cols - .00001), Math.min(y, frame.rows - .00001)) * frame.terrainLiftStep));
        if (points.every(q => q.x < 0) || points.every(q => q.y < 0) || points.every(q => q.x > frame.viewW) || points.every(q => q.y > frame.viewH))
            continue;
        g.beginPath();
        points.forEach((q, i) => i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y));
        g.closePath();
        g.fillStyle = p === ghost ? 'rgba(232,206,131,.22)' : 'rgba(116,203,234,.17)';
        g.fill();
        g.strokeStyle = p === ghost ? '#ffe5a0' : '#9bdded';
        g.lineWidth = 1.5;
        g.setLineDash(p === ghost ? [5, 4] : []);
        g.stroke();
        g.setLineDash([]);
        g.font = '600 12px system-ui';
        g.textAlign = 'center';
        g.fillStyle = '#f6e9bd';
        g.fillText(`→ ID ${p.targetId}${p.link ? ' · ' + p.link : ''}`, points.reduce((n, q) => n + q.x, 0) / 4, points.reduce((n, q) => n + q.y, 0) / 4);
    }
    g.restore();
}
