/**
 * Field stage section, carved out of simulator.tsx (W5b stage 2): the bordered
 * frame that hosts the 2D world canvas, the HUD canvas and the atmosphere
 * slot, plus the transient battle-hint and map-loading chips, the editor
 * overlay slot and the keys legend strip. The atmosphere slot is a DIV
 * container, not a canvas (atmo-lifecycle fix): its canvas is created
 * imperatively by useAtmosphereLayer (fresh canvas + WebGL context on every
 * mount, removed on unmount). Contract: refs for the world/HUD canvases, the
 * atmosphere slot div and the frame div arrive via props (same ref objects as
 * before), pointer handlers keep their original identities, and
 * `editorOverlay` is a ReactNode slot rendered exactly where the inline
 * `{editorOpen && editorView ? <EditorOverlay ... /> : null}` used to be.
 */
import type { MouseEvent, PointerEvent, RefObject, ReactNode } from 'react';

export interface FieldStageProps {
  fieldFrameRef: RefObject<HTMLDivElement | null>;
  testField: boolean;
  fieldFit: { w: number; h: number } | null;
  fieldW: number;
  fieldH: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onMove: (ev: MouseEvent<HTMLCanvasElement>) => void;
  onPointerDown: (ev: PointerEvent<HTMLCanvasElement>) => void;
  onUp: (ev: PointerEvent<HTMLCanvasElement>) => void;
  onLeave: () => void;
  onContextMenu: (ev: MouseEvent<HTMLCanvasElement>) => void;
  onClick: (ev: MouseEvent<HTMLCanvasElement>) => void;
  pixiRef: RefObject<HTMLDivElement | null>;
  hudRef: RefObject<HTMLCanvasElement | null>;
  battleHint: string | null;
  mapLoading: boolean;
  editorOverlay: ReactNode;
}

export function FieldStage(props: FieldStageProps) {
  const {
    fieldFrameRef,
    testField,
    fieldFit,
    fieldW,
    fieldH,
    canvasRef,
    onMove,
    onPointerDown,
    onUp,
    onLeave,
    onContextMenu,
    onClick,
    pixiRef,
    hudRef,
    battleHint,
    mapLoading,
    editorOverlay,
  } = props;
  return (
      <section className="flex w-full min-w-0 flex-col gap-2 lg:h-full lg:min-h-0 lg:flex-1">
        <div className="relative w-full min-w-0 flex-1 lg:min-h-0">
          <div
            ref={fieldFrameRef}
            role="region"
            aria-label="Игровое поле"
            className="relative overflow-hidden rounded-xl border border-[var(--sim-line)] bg-[var(--sim-frame)] p-2 lg:absolute lg:inset-0"
          >
            <div
              className={
                testField
                  ? 'relative h-full w-full'
                  : fieldFit
                    ? 'relative mx-auto'
                    : 'relative mx-auto w-full max-w-full'
              }
              style={
                testField
                  ? undefined
                  : fieldFit
                    ? { width: fieldFit.w, height: fieldFit.h }
                    : { maxWidth: fieldW, aspectRatio: `${fieldW} / ${fieldH}` }
              }
            >
              <canvas
                ref={canvasRef}
                className="block h-full w-full cursor-crosshair rounded-lg"
                onPointerMove={onMove}
                onPointerDown={onPointerDown}
                onPointerUp={onUp}
                onPointerCancel={onUp}
                onPointerLeave={onLeave}
                onContextMenu={onContextMenu}
                onClick={onClick}
              />
              {/* Слот-контейнер слоя атмосферы (div, а НЕ канвас): сам канвас
                  создаётся императивно в useAtmosphereLayer и удаляется из DOM
                  при размонтировании. Так каждый монтаж слоя получает свежий
                  canvas и живой WebGL-контекст — повторный монтаж (React
                  StrictMode в dev, смена комнаты) больше не встречает контекст,
                  убитый прошлым destroy (pixi loseContext). PixiJS выводит мир
                  (как текстуру 2D-холста) вместе с цветокоррекцией, тенями
                  облаков и дождём; события мыши проходят сквозь слой на игровой
                  холст. Без WebGL слой прозрачен. */}
              <div
                ref={pixiRef}
                aria-hidden
                className="pointer-events-none absolute inset-0 z-10 block h-full w-full rounded-lg"
              />
              {/* HUD поля поверх атмосферы: циферблат день/ночь с движущимся
                  солнцем/луной и значок текущей погоды. Не темнеет ночью и
                  не прячется под дождём. */}
              <canvas
                ref={hudRef}
                aria-hidden
                className="pointer-events-none absolute inset-0 z-20 block h-full w-full rounded-lg"
              />
            </div>
            {battleHint ? (
              <div className="pointer-events-none absolute left-1/2 top-4 z-30 -translate-x-1/2 rounded-lg border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-3 py-1.5 text-xs text-[var(--sim-text)] shadow-lg">
                {battleHint}
              </div>
            ) : null}
            {mapLoading ? (
              <div className="pointer-events-none absolute left-1/2 top-4 z-40 -translate-x-1/2 animate-pulse rounded-lg border border-[var(--sim-line-strong)] bg-[var(--sim-panel)] px-4 py-2 text-sm font-semibold text-[var(--sim-text)] shadow-lg">
                Загрузка локации…
              </div>
            ) : null}
          {editorOverlay}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-[var(--sim-text-faint)]">
          <span>W A S D — идти (зажать; на траве — свободная ходьба по пикселям, в боевых клетках — шаг по клеткам)</span>
          <span>Q E Z X — диагонали</span>
          <span>Колесо мыши — приблизить/отдалить вид</span>
          <span>ЛКМ — идти к точке · манекен — тянуть</span>
          <span>{testField ? 'вход в бой — с клетки захода кнопкой «Боевой режим» (B), выход — ею же' : 'B — бой'}</span>
          <span>Enter — чат</span>
          <span>I — удар</span>
          <span>K (удерживать) — блок</span>
          <span>Пробел (удержать и отпустить) — прыжок через обрыв: чем дольше держите, тем выше перепад перепрыгнете</span>
          <span>J — стрела против часовой</span>
          <span>L — по часовой</span>
          <span className="ml-auto">
            Скорость = 100% − замедление · замедление фиксируется в момент прыжка
          </span>
        </div>
      </section>
  );
}
