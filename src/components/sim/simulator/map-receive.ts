/** Reconcile a received world map with its editor draft. Kept outside the
 * engine so switching locations cannot mix async paint snapshots and histories.
 */
import type { RefObject, Dispatch, SetStateAction } from 'react';
import type { TestMap } from '@/lib/sim/test-map';
import { mapHasPaint } from '@/lib/sim/test-map';
import type { EditorDraft } from '@/lib/sim/editor-model';
import { setTestMap, ensurePaintDecoded, setPaintOverride } from '@/lib/sim/test-field';
import { copyPaintCanvas } from '@/lib/sim/paint';
type MapReceiveDeps = {
    savedMapRef: RefObject<TestMap>;
    editorRef: RefObject<EditorDraft | null>;
    setEditorView: Dispatch<SetStateAction<EditorDraft | null>>;
    setEditorMsg: Dispatch<SetStateAction<string | null>>;
};
export function receiveEditorMap({ savedMapRef, editorRef, setEditorView, setEditorMsg }: MapReceiveDeps, map: TestMap) {
    setTestMap(map);
    savedMapRef.current = map;
    // Пиксельная отрисовка чужого/нового конфига: декод асинхронный — как только
    // готов, кэши контура пересобираются и поле перерисовывается уже по рисунку.
    if (mapHasPaint(map))
        void ensurePaintDecoded();
    const d = editorRef.current;
    if (d) {
        // Свой только что сохранённый конфиг возвращается рассылкой «map»:
        // черновик совпал с сохранённой локацией — метка «не сохранено» гаснет.
        const same = (d.seed ?? map.seed) === map.seed && (d.margin ?? map.margin) === map.margin &&
            d.cols === map.cols &&
            d.rows === map.rows &&
            JSON.stringify(d.zones.map((z) => [z.name, z.kind, z.c0, z.r0, z.c1, z.r1])) ===
                JSON.stringify(map.zones.map((z) => [z.name, z.kind, z.c0, z.r0, z.c1, z.r1])) &&
            JSON.stringify(d.objects.map((o) => [o.kind, o.x ?? o.c, o.y ?? o.r, o.s ?? 1, o.rot ?? 0, o.spr ?? null, o.cv ?? null, o.mir ?? 0])) ===
                JSON.stringify((map.objects ?? []).map((o) => [o.kind, o.x ?? o.c, o.y ?? o.r, o.s ?? 1, o.rot ?? 0, o.spr ?? null, o.cv ?? null, o.mir ?? 0])) &&
            JSON.stringify(d.passages ?? []) === JSON.stringify(map.passages ?? []) && JSON.stringify(d.place) === JSON.stringify(map.place) &&
            JSON.stringify(d.spawns.map((s) => [s.c, s.r])) ===
                JSON.stringify((map.spawns ?? []).map((s) => [s.c, s.r])) &&
            JSON.stringify(d.elev) === JSON.stringify(map.elev ?? {}) &&
            (d.pcv ? d.ppaint ?? '' : '') === (map.paint ?? '');
        if (same) {
            for (const entry of [...d.undo, ...(d.redo ?? [])])
                entry.dirty = true;
            d.dirty = false;
            d.seed = map.seed;
            d.margin = map.margin;
            d.zones = map.zones.map((z) => ({ ...z }));
            d.objects = (map.objects ?? []).map((o) => ({ ...o }));
            d.place = map.place;
            d.passages = map.passages?.map(p => ({ ...p }));
            d.spawns = (map.spawns ?? []).map((s) => ({ ...s }));
            d.elev = { ...(map.elev ?? {}) };
            setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
            return;
        }
    }
    if (!d)
        return;
    d.undo = [];
    d.redo = [];
    if (d.dirty) {
        // Внешняя карта при открытом черновике с правками: несводимую правку не
        // слить с чужим конфигом — черновик сбрасывается на новую карту целиком
        // (как при открытии редактора), игрок видит предупреждение в панели.
        d.undo = [];
        d.sel = [];
        d.drag = null;
        d.dirty = false;
        setEditorMsg('Локацию сохранил другой игрок — несохранённая правка черновика сброшена на новую карту.');
    }
    d.seed = map.seed;
    d.margin = map.margin;
    d.zones = map.zones.map((z) => ({ ...z }));
    d.objects = (map.objects ?? []).map((o) => ({ ...o }));
    d.place = map.place;
    d.passages = map.passages?.map(p => ({ ...p }));
    d.spawns = (map.spawns ?? []).map((s) => ({ ...s }));
    d.elev = { ...(map.elev ?? {}) };
    d.cols = map.cols;
    d.rows = map.rows;
    // Холст кисти переснимается из рисунка новой карты — те же вызовы, что
    // начальный снапшот при открытии редактора. Без этого pcv остаётся в
    // размерах старой карты: кисть красит в старых координатах (WYSIWYG
    // сломан), а сохранение молча переносит старый холст 1:1 (encodeDraftPaint).
    d.pundo = [];
    d.pdirty = false;
    d.ppaint = map.paint ?? null;
    d.pcv = copyPaintCanvas();
    if (!d.pcv && mapHasPaint(map)) {
        // Рисунок новой карты ещё декодируется: снимок снимется по готовности
        // (как при открытии редактора); кисть до того ленивая и создаст холст
        // уже в размерах новой карты (ensureDraftPaint).
        void ensurePaintDecoded().then((ok2) => {
            const e = editorRef.current;
            if (!ok2 || !e || e !== d || savedMapRef.current !== map || e.pcv || e.pdirty)
                return;
            e.pcv = copyPaintCanvas();
            if (e.pcv)
                setPaintOverride(e.pcv, true);
        });
    }
    setEditorView({ ...d, zones: d.zones.map((z) => ({ ...z })), objects: d.objects.map((o) => ({ ...o })), undo: [...d.undo] });
}
