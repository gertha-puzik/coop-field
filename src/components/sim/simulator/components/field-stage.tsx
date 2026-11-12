import styles from './editor-workspace.module.css';
/**
 * Field stage section, carved out of simulator.tsx (W5b stage 2): the bordered
 * frame that hosts the 2D world canvas, the HUD canvas and the atmosphere
 * slot, plus the transient battle-hint and map-loading chips, the editor
 * overlay slot and the keys legend strip. The atmosphere slot is a DIV
 * container, not a canvas (atmo-lifecycle fix): its canvas is created
 * imperatively by useAtmosphereLayer (fresh canvas + WebGL context on every
 * mount, removed on unmount). Contract: refs for the world/HUD canvases, the
 * atmosphere slot div and the frame div arrive via props (same ref objects as
 * pointer handlers keep their original identities, and
 * `editorOverlay` is a ReactNode slot rendered exactly where the inline
 * `{editorOpen && editorView ? <EditorOverlay ... /> : null}` used to be.
 * `touchControls` is the sibling ReactNode slot for the mobile joystick/jump
 * controls: rendered INSIDE the scene div above the HUD canvas (z-50);
 * mounting/gating (touch device, editor hidden) belongs to the slot owner
 * in simulator.tsx — FieldStage only provides the geometric anchor.
 */
import type { MouseEvent, PointerEvent, RefObject, ReactNode } from 'react';

export interface FieldStageProps {
  worldOverlay?:ReactNode;
  fieldFrameRef: RefObject<HTMLDivElement | null>;
  testField: boolean;
  fieldFit: { w: number; h: number } | null;
  fieldW: number;
  fieldH: number;
  canvasRef: RefObject<HTMLCanvasElement | null>;
  onMove: (ev: PointerEvent<HTMLCanvasElement>) => void;
  onPointerDown: (ev: PointerEvent<HTMLCanvasElement>) => void;
  onUp: (ev: PointerEvent<HTMLCanvasElement>) => void;
  onLeave: () => void;
  onContextMenu: (ev: MouseEvent<HTMLCanvasElement>) => void;
  onClick: (ev: MouseEvent<HTMLCanvasElement>) => void;
  pixiRef: RefObject<HTMLDivElement | null>;
  /** Слот WebGL-вида Элизии. На гротах не передаётся — разметки слота нет. */
  elisionHostRef?: (node: HTMLDivElement | null) => void;
  showElisionView?: boolean;
  hudRef: RefObject<HTMLCanvasElement | null>;
  battleHint: string | null;
  mapLoading: boolean;
  editorOverlay: ReactNode;
  /** Сенсорное управление (джойстик + «прыжок»): слот рисуется поверх HUD
   *  канваса внутри игровой сцены; монтировать/прятать его решает владелец
   *  слота в simulator.tsx (тач-устройство, редактор), FieldStage — только
   *  геометрическая точка, как у editorOverlay. */
  touchControls?: ReactNode;
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
    elisionHostRef,
    showElisionView,
    hudRef,
    battleHint,
    mapLoading,
    worldOverlay,
    editorOverlay,
    touchControls,
  } = props;
  return (
      <section className={`flex w-full min-w-0 flex-1 flex-col gap-2 min-h-0 lg:h-full lg:min-h-0 lg:flex-1 ${editorOverlay?'h-full min-h-[480px] flex-1':''}`}>
        <div className="relative w-full min-w-0 flex-1 lg:min-h-0">
          <div
            ref={fieldFrameRef}
            role="region"
            aria-label="Игровое поле"
            className={`${styles.frame} absolute inset-0 overflow-hidden rounded-xl border border-[var(--sim-line)] bg-[var(--sim-frame)] p-2`}
          >
            <div
              className={
                testField
                  ? `${styles.scene} relative h-full w-full`
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
              {showElisionView && testField && elisionHostRef ? (
                <div
                  ref={elisionHostRef}
                  aria-hidden
                  className="pointer-events-none absolute inset-0 z-[8] block h-full w-full rounded-lg"
                />
              ) : null}
              {/* Слот-контейнер слоя атмосферы (div, а НЕ канвас): сам канвас
                  создаётся императивно в useAtmosphereLayer и удаляется из DOM
                  при размонтировании. Так каждый монтаж слоя получает свежий
                  canvas и живой WebGL-контекст — повторный монтаж (React
                  StrictMode в dev, смена комнаты) больше не встречает контекст,
                  убитый прошлым destroy (pixi loseContext). PixiJS рисует только
                  тени облаков и дождь; тонировка суток живёт на самом мировом
                  холсте (цветная вуаль «source-atop»), события мыши проходят
                  сквозь слой на игровой холст. Без WebGL слой прозрачен. */}
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
              {/* Сенсорное управление (мобильный UX): джойстик слева-снизу и
                  «прыжок» справа-снизу поверх HUD (z-50); события ловят
                  только круги, поля кругами не перехватываются. Слот пуст
                  на десктопе или при спрятанных контролах. */}
              {worldOverlay}
              {touchControls}
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
      </section>
  );
}
