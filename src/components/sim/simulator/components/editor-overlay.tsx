/**
 * Location editor overlay panel, carved out of simulator.tsx verbatim (W5b
 * stage 2, behavior-preserving). Contract: renders NOTHING unless both
 * `editorOpen && editorView` are truthy — the caller keeps the original
 * conditional and passes the component only when the panel is open; the
 * returned DOM is byte-identical to the former inline block at the same
 * tree position (absolute panel over the field frame). All mutations go
 * through the original callbacks and `editorRef` (panel-only ghost state).
 */
import type { Dispatch, RefObject, SetStateAction } from 'react';
import {
  type EditorDraft,
  type EditorPlace,
  type EditorTool,
  type PaintBrushShape,
} from '@/lib/sim/editor-model';
import { PAINT_MATS, undoPaintStroke } from '@/lib/sim/paint';
import {
  GROUND_COVER_OPTS,
  OBJECT_ROT_STEP,
  OBJECT_SCALE_MAX,
  OBJECT_SCALE_MIN,
  ROCK_SPRITE_OPTS,
  TEST_MAP_LIMITS,
  TREE_SPRITE_OPTS,
  type GroundCover,
  type TestMapEntryDir,
} from '@/lib/sim/test-map';

export interface EditorOverlayProps {
  editorRef: RefObject<EditorDraft | null>;
  syncEditorView: () => void;
  editorView: EditorDraft;
  setEditorTool: (t: EditorTool) => void;
  editorEntryDir: TestMapEntryDir;
  setEditorEntryDir: (d: TestMapEntryDir) => void;
  editorPlace: EditorPlace | null;
  patchEditorPlace: (p: Partial<EditorPlace>) => void;
  confirmEditorPlace: () => void;
  cancelEditorPlace: () => void;
  resizeEditorWorld: (cols: number, rows: number) => void;
  undoEditor: () => void;
  resetEditor: () => void;
  mergeEditorZones: () => void;
  toggleEditorSel: (id: string) => void;
  renameEditorZone: (id: string, name: string) => void;
  deleteEditorZone: (id: string) => void;
  editorPass: string;
  setEditorPass: Dispatch<SetStateAction<string>>;
  saveEditorMap: () => void;
  editorCover: GroundCover;
  setEditorCover: (c: GroundCover) => void;
  editorMsg: string | null;
  closeEditor: () => void;
}

export function EditorOverlay(props: EditorOverlayProps) {
  const {
    editorRef,
    syncEditorView,
    editorView,
    setEditorTool,
    editorEntryDir,
    setEditorEntryDir,
    editorPlace,
    patchEditorPlace,
    confirmEditorPlace,
    cancelEditorPlace,
    resizeEditorWorld,
    undoEditor,
    resetEditor,
    mergeEditorZones,
    toggleEditorSel,
    renameEditorZone,
    deleteEditorZone,
    editorPass,
    setEditorPass,
    saveEditorMap,
    editorCover,
    setEditorCover,
    editorMsg,
    closeEditor,
  } = props;
  return (
                <div className="absolute left-3 top-3 z-20 flex max-h-[calc(100%-24px)] w-[272px] flex-col overflow-hidden rounded-xl border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] shadow-xl">
                  <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--sim-line)] px-3 py-2">
                    <div className="text-xs font-bold">Редактор локации</div>
                    <button
                      type="button"
                      aria-label="Закрыть редактор"
                      className="btn-neutral flex h-6 w-6 items-center justify-center rounded-md text-xs"
                      onClick={closeEditor}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3 text-[11px]">
                    <div>
                      <div className="mb-1 font-semibold text-[var(--sim-text-muted)]">Инструмент</div>
                      <div className="flex gap-1.5">
                        {(
                          [
                            { id: 'cells', label: 'Клетки' },
                            { id: 'green', label: 'Зелёная' },
                            { id: 'erase', label: 'Ластик' },
                          ] as { id: EditorTool; label: string }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={
                              editorView.tool === t.id
                                ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1.5 py-1 font-semibold text-white'
                                : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1'
                            }
                            onClick={() => setEditorTool(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        {(
                          [
                            { id: 'stone', label: '⛰ Камень' },
                            { id: 'tree', label: '🌲 Дерево' },
                            { id: 'dirt', label: '🟫 Земля' },
                          ] as { id: EditorTool; label: string }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={
                              editorView.tool === t.id
                                ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1.5 py-1 font-semibold text-white'
                                : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1'
                            }
                            onClick={() => setEditorTool(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        {(
                          [
                            { id: 'ground', label: '🌸 Покрытие' },
                            { id: 'entry', label: '🚪 Заход' },
                            { id: 'spawn', label: '🛏 Спавн' },
                            { id: 'battle', label: '⚔ Клетка' },
                            { id: 'paint', label: '🖌 Кисть' },
                          ] as { id: EditorTool; label: string }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={
                              editorView.tool === t.id
                                ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1.5 py-1 font-semibold text-white'
                                : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1'
                            }
                            onClick={() => setEditorTool(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      <div className="mt-1.5 flex gap-1.5">
                        {(
                          [
                            { id: 'raise', label: '⬆ Насыпать' },
                            { id: 'lower', label: '⬇ Срыть' },
                            { id: 'flat', label: '▬ Ровно' },
                          ] as { id: EditorTool; label: string }[]
                        ).map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={
                              editorView.tool === t.id
                                ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                            }
                            onClick={() => setEditorTool(t.id)}
                          >
                            {t.label}
                          </button>
                        ))}
                      </div>
                      {editorView.tool === 'raise' || editorView.tool === 'lower' || editorView.tool === 'flat' ? (
                        <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                          Клик или протяжка по клеткам: «Насыпать» поднимает землю на уровень (до трёх),
                          «Срыть» опускает, «Ровно» срезает весь росчерк в уровень первой клетки. Перепад
                          в один уровень проходится шагом, в два и больше — только прыжком с зарядом
                          (удержать Пробел и отпустить). Ластик и «Срыть» до нуля убирают насыпь совсем.
                        </p>
                      ) : null}
                      {editorView.tool === 'paint' ? (
                        <>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Материал кисти</div>
                          <div className="grid grid-cols-3 gap-1">
                            {PAINT_MATS.map((mt) => (
                              <button
                                key={mt.id}
                                type="button"
                                className={
                                  editorView.pmat === mt.id
                                    ? 'rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                    : 'btn-neutral rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                                }
                                onClick={() => {
                                  const d = editorRef.current;
                                  if (d) {
                                    d.pmat = mt.id;
                                    syncEditorView();
                                  }
                                }}
                              >
                                {mt.label}
                              </button>
                            ))}
                          </div>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Размер круглой кисти</div>
                          <div className="flex items-center gap-1.5">
                            <input
                              type="range"
                              min={1}
                              max={200}
                              value={editorView.psize}
                              className="min-w-0 flex-1"
                              onChange={(ev) => {
                                const d = editorRef.current;
                                if (d) {
                                  d.psize = Math.min(200, Math.max(1, Math.round(Number(ev.target.value) || 1)));
                                  syncEditorView();
                                }
                              }}
                            />
                            <span className="w-12 text-center font-semibold">{editorView.psize} px</span>
                          </div>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Готовые области</div>
                          <div className="flex gap-1.5">
                            {(
                              [
                                { id: 'round', label: '⚪ Круг' },
                                { id: 'cell', label: '▭ 150×100' },
                                { id: 'half', label: '▫ 75×50' },
                              ] as { id: PaintBrushShape; label: string }[]
                            ).map((sh) => (
                              <button
                                key={sh.id}
                                type="button"
                                className={
                                  editorView.pshape === sh.id
                                    ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                    : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                                }
                                onClick={() => {
                                  const d = editorRef.current;
                                  if (d) {
                                    d.pshape = sh.id;
                                    syncEditorView();
                                  }
                                }}
                              >
                                {sh.label}
                              </button>
                            ))}
                          </div>
                          <button
                            type="button"
                            className="btn-neutral mt-2 w-full rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1"
                            onClick={() => {
                              const d = editorRef.current;
                              if (!d) return;
                              if (undoPaintStroke(d)) {
                                d.dirty = true;
                                syncEditorView();
                              }
                            }}
                          >
                            ↩ Отменить мазок
                          </button>
                          <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                            Кисть рисует саму локацию в пикселях: закрашенное — земля, по ней ходят в мирном режиме;
                            стёртое — пустота за кромкой. ЛКМ — материал, ПКМ — ластик, колесо — размер круглой кисти.
                            Пресеты «150×100» и «75×50» — готовые области с привязкой к сетке: боевая клетка ставится
                            только на место, закрашенное областью «150×100» целиком. Росчерк можно отменить.
                          </p>
                        </>
                      ) : null}
                      {editorView.tool === 'battle' ? (
                        <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                          Боевая клетка — область 150×100 (одна клетка боевого поля). Клик ставит её на закрашенное
                          кистью место: область клетки обязана быть покрашена целиком, иначе клетка не ставится
                          (место подсвечивается красным). Повторный клик по стоящей клетке снимает её.
                        </p>
                      ) : null}
                      {editorView.tool === 'entry' ? (
                        <>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Направление шага</div>
                          <div className="flex gap-1.5">
                            {(
                              [
                                { id: 'left', label: '←' },
                                { id: 'up', label: '↑' },
                                { id: 'down', label: '↓' },
                                { id: 'right', label: '→' },
                              ] as { id: TestMapEntryDir; label: string }[]
                            ).map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                className={
                                  editorEntryDir === p.id
                                    ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                    : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                                }
                                onClick={() => setEditorEntryDir(p.id)}
                              >
                                {p.label}
                              </button>
                            ))}
                          </div>
                          <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                            Куда игрока перенесёт шаг с захода в боевом режиме: выберите направление в сторону
                            боевой зоны, затем кликните по травяной клетке рядом с ней. Повторный клик с тем же
                            направлением — убрать, с другим — сменить направление.
                          </p>
                        </>
                      ) : null}
                      {editorView.tool === 'stone' || editorView.tool === 'tree' ? (
                        <>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">
                            {editorView.tool === 'tree' ? 'Вид дерева' : 'Вид камня'}
                          </div>
                          <div className="grid grid-cols-3 gap-1">
                            {(editorView.tool === 'tree'
                              ? TREE_SPRITE_OPTS
                              : ROCK_SPRITE_OPTS
                            ).map((v) => (
                              <button
                                key={v.id}
                                type="button"
                                className={
                                  editorPlace?.kind === editorView.tool && editorPlace?.spr === v.id
                                    ? 'rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                    : 'btn-neutral rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                                }
                                onClick={() =>
                                  patchEditorPlace({ kind: editorView.tool === 'tree' ? 'tree' : 'stone', spr: v.id, pickId: null, anchored: false })
                                }
                              >
                                {v.label}
                              </button>
                            ))}
                          </div>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Размер и поворот</div>
                          <div className="flex items-center gap-1.5">
                            <span className="w-10 text-[var(--sim-text-faint)]">Разм.</span>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-6 rounded-md"
                              onClick={() =>
                                patchEditorPlace({
                                  s: Math.max(OBJECT_SCALE_MIN, Math.round(((editorPlace?.s ?? 1) - 0.1) * 100) / 100),
                                })
                              }
                            >
                              −
                            </button>
                            <span className="w-10 text-center font-semibold">×{(editorPlace?.s ?? 1).toFixed(1)}</span>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-6 rounded-md"
                              onClick={() =>
                                patchEditorPlace({
                                  s: Math.min(OBJECT_SCALE_MAX, Math.round(((editorPlace?.s ?? 1) + 0.1) * 100) / 100),
                                })
                              }
                            >
                              +
                            </button>
                          </div>
                          <div className="mt-1 flex items-center gap-1">
                            <span className="w-10 text-[var(--sim-text-faint)]">Поворот</span>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-6 rounded-md"
                              title="На шаг против часовой (15°)"
                              onClick={() =>
                                patchEditorPlace({ rot: (((editorPlace?.rot ?? 0) - OBJECT_ROT_STEP) % 360 + 360) % 360 })
                              }
                            >
                              ↺
                            </button>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-8 rounded-md text-[11px] font-semibold"
                              title="Поворот на 90° против часовой"
                              onClick={() =>
                                patchEditorPlace({ rot: (((editorPlace?.rot ?? 0) - 90) % 360 + 360) % 360 })
                              }
                            >
                              ⟲90°
                            </button>
                            <span className="w-9 text-center font-semibold">{editorPlace?.rot ?? 0}°</span>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-8 rounded-md text-[11px] font-semibold"
                              title="Поворот на 90° по часовой"
                              onClick={() =>
                                patchEditorPlace({ rot: (((editorPlace?.rot ?? 0) + 90) % 360 + 360) % 360 })
                              }
                            >
                              ⟳90°
                            </button>
                            <button
                              type="button"
                              className="btn-neutral h-6 w-6 rounded-md"
                              title="На шаг по часовой (15°)"
                              onClick={() =>
                                patchEditorPlace({ rot: (((editorPlace?.rot ?? 0) + OBJECT_ROT_STEP) % 360 + 360) % 360 })
                              }
                            >
                              ↻
                            </button>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5">
                            <span className="w-10 text-[var(--sim-text-faint)]">Зеркало</span>
                            <button
                              type="button"
                              className={
                                (editorPlace?.mir ?? 0) === 1
                                  ? 'flex-1 rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                  : 'btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                              }
                              title="Отзеркалить спрайт по горизонтали"
                              onClick={() => patchEditorPlace({ mir: (editorPlace?.mir ?? 0) === 1 ? 0 : 1 })}
                            >
                              ⇋ {(editorPlace?.mir ?? 0) === 1 ? 'отзеркален' : 'как есть'}
                            </button>
                          </div>
                          <div className="mt-2 flex gap-1.5">
                            <button
                              type="button"
                              className="flex-1 rounded-md bg-[var(--sim-accent)] px-1.5 py-1.5 font-semibold text-white hover:bg-[var(--sim-accent-hover)]"
                              onClick={confirmEditorPlace}
                            >
                              ✓ Поставить
                            </button>
                            <button
                              type="button"
                              className="btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1.5"
                              onClick={cancelEditorPlace}
                            >
                              ✕ Отмена
                            </button>
                          </div>
                          <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                            Призрак следует за курсором — клик фиксирует точку (потом можно перетащить).
                            Колесо мыши над полем — размер, кнопки — размер и поворот. Клик по уже
                            стоящему объекту поднимает его для правки. ✓ ставит, ✕ отменяет.
                          </p>
                        </>
                      ) : null}
                      {editorView.tool === 'ground' ? (
                        <>
                          <div className="mt-2 mb-1 font-semibold text-[var(--sim-text-muted)]">Вид покрытия</div>
                          <div className="grid grid-cols-3 gap-1">
                            {GROUND_COVER_OPTS.map((v) => (
                              <button
                                key={v.id}
                                type="button"
                                className={
                                  editorCover === v.id
                                    ? 'rounded-md border border-[var(--sim-accent)] bg-[var(--sim-accent)] px-1 py-1 font-semibold text-white'
                                    : 'btn-neutral rounded-md border border-[var(--sim-line-strong)] px-1 py-1'
                                }
                                onClick={() => setEditorCover(v.id)}
                              >
                                {v.label}
                              </button>
                            ))}
                          </div>
                          <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                            Клик или протяжка красит клетки: цветы, каменная плитка разной густоты,
                            сплошной пол, просто трава. Соседние клетки сходятся швами в сплошной настил.
                          </p>
                        </>
                      ) : null}
                      {editorView.tool === 'spawn' ? (
                        <p className="mt-1 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                          Точки появления игроков: клик по траве ставит клетку спавна, повторный клик
                          по той же клетке — снимает, протяжка красит несколько. Игроки появляются на
                          случайной свободной из них. На поле клетка ничем не отличается от соседних —
                          флажки видны только здесь, в редакторе.
                        </p>
                      ) : null}
                      <p className="mt-1 leading-snug text-[var(--sim-text-faint)]">
                        Тяните по полю — зона. Камень и дерево ставятся свободно: призрак едет за
                        курсором, размер и поворот подгоняются до ✓ «Поставить» (через них нельзя пройти).
                        Земля и покрытие — клик или протяжка, ходьбе не мешают. Кисти рельефа насыпают
                        и срывают уступы: перепад в уровень проходится шагом, выше — прыжком.
                        Заход — вход в боевую зону: травяная клетка с галочками,
                        в бою шаг с неё переносит по направлению захода.
                      </p>
                    </div>
                    <div>
                      <div className="mb-1 font-semibold text-[var(--sim-text-muted)]">Размер мира</div>
                      <div className="flex items-center gap-1.5">
                        <span className="w-4 text-[var(--sim-text-faint)]">Ш</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols - 1, editorView.rows)}>
                          −
                        </button>
                        <span className="w-7 text-center font-semibold">{editorView.cols}</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols + 1, editorView.rows)}>
                          +
                        </button>
                        <span className="ml-2 w-4 text-[var(--sim-text-faint)]">В</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols, editorView.rows - 1)}>
                          −
                        </button>
                        <span className="w-7 text-center font-semibold">{editorView.rows}</span>
                        <button type="button" className="btn-neutral h-6 w-6 rounded-md" onClick={() => resizeEditorWorld(editorView.cols, editorView.rows + 1)}>
                          +
                        </button>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <button type="button" className="btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1" onClick={undoEditor}>
                        Отменить
                      </button>
                      <button type="button" className="btn-neutral flex-1 rounded-md border border-[var(--sim-line-strong)] px-1.5 py-1" onClick={resetEditor}>
                        Сбросить
                      </button>
                    </div>
                    <div>
                      <div className="mb-1 flex items-center justify-between">
                        <span className="font-semibold text-[var(--sim-text-muted)]">
                          Зоны ({editorView.zones.length}/{TEST_MAP_LIMITS.zonesMax})
                        </span>
                        {editorView.dirty ? <span className="text-[10px] text-[var(--sim-text-faint)]">не сохранено</span> : null}
                      </div>
                      {editorView.sel.length >= 2 ? (
                        <button
                          type="button"
                          className="mb-1.5 w-full rounded-md bg-[var(--sim-accent)] px-1.5 py-1 text-[11px] font-semibold text-white hover:bg-[var(--sim-accent-hover)]"
                          onClick={mergeEditorZones}
                        >
                          Объединить ({editorView.sel.length})
                        </button>
                      ) : (
                        <p className="mb-1.5 leading-snug text-[10px] text-[var(--sim-text-faint)]">
                          Отметьте галочками две и более зон — появится кнопка объединения.
                        </p>
                      )}
                      <div className="flex flex-col gap-1">
                        {editorView.zones.map((z) => (
                          <div key={z.id} className="flex items-center gap-1.5 rounded-md border border-[var(--sim-line)] bg-[var(--sim-inset-soft)] px-1.5 py-1">
                            <input
                              type="checkbox"
                              checked={editorView.sel.includes(z.id)}
                              onChange={() => toggleEditorSel(z.id)}
                              className="h-3 w-3 shrink-0 accent-[var(--sim-accent)]"
                              aria-label={`Отметить зону ${z.name} для объединения`}
                            />
                            <span
                              aria-hidden
                              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                              style={{ background: z.kind === 'cells' ? 'rgba(120,170,250,0.85)' : 'rgba(112,178,92,0.9)' }}
                            />
                            <input
                              value={z.name}
                              onChange={(ev2) => renameEditorZone(z.id, ev2.target.value)}
                              className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-0.5 py-0.5 text-[11px] outline-none focus:border-[var(--sim-line-strong)] focus:bg-[var(--sim-input-bg)]"
                              aria-label="Название зоны"
                            />
                            <span className="shrink-0 text-[10px] text-[var(--sim-text-faint)]">
                              {z.c1 - z.c0 + 1}×{z.r1 - z.r0 + 1}
                            </span>
                            <button
                              type="button"
                              aria-label={`Удалить зону ${z.name}`}
                              className="btn-neutral flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px]"
                              onClick={() => deleteEditorZone(z.id)}
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        {editorView.zones.length === 0 ? (
                          <p className="text-[var(--sim-text-faint)]">Пока пусто — нарисуйте первую зону.</p>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-auto flex flex-col gap-1.5 border-t border-[var(--sim-line)] pt-2.5">
                      <input
                        type="password"
                        value={editorPass}
                        onChange={(ev2) => setEditorPass(ev2.target.value)}
                        placeholder="Пароль редактора"
                        aria-label="Пароль редактора локации"
                        className="h-7 rounded-md border border-[var(--sim-line-strong)] bg-[var(--sim-input-bg)] px-2 text-[11px] text-[var(--sim-text)] outline-none"
                      />
                      <button
                        type="button"
                        className="h-8 rounded-md bg-[var(--sim-accent)] px-2 text-xs font-semibold text-white hover:bg-[var(--sim-accent-hover)]"
                        onClick={saveEditorMap}
                      >
                        Сохранить локацию
                      </button>
                      {editorMsg ? <p className="leading-snug text-[var(--sim-text-muted)]">{editorMsg}</p> : null}
                      <p className="leading-snug text-[10px] text-[var(--sim-text-faint)]">
                        Сохранение применяет локацию всем в комнате сразу.
                      </p>
                    </div>
                  </div>
                </div>
  );
}
