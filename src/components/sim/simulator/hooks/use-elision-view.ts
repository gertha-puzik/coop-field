/**
 * Elision-only Babylon view. The module is imported with import() when the
 * field stage of /elision/ is on screen, the same way useAtmosphereLayer
 * loads Pixi. Beer grottos never pass enabled=true, so they do not download
 * Babylon and do not create a second canvas. If WebGL is missing or the
 * module fails, the canvas is removed and the existing 2D painter stays.
 */
import { useEffect, type RefObject } from 'react';
import type { ElisionView } from '@/lib/sim/elision-scene';

export function useElisionView(opts: {
  enabled: boolean;
  hostRef: RefObject<HTMLDivElement | null>;
  viewRef: RefObject<ElisionView | null>;
}): void {
  const { enabled, hostRef, viewRef } = opts;
  useEffect(() => {
    if (!enabled) return;
    const slot = hostRef.current;
    if (!slot) return;
    let dead = false;
    const canvas = document.createElement('canvas');
    canvas.className = 'pointer-events-none block h-full w-full rounded-lg';
    canvas.dataset.elisionWebgl = 'pending';
    slot.appendChild(canvas);
    import('@/lib/sim/elision-babylon')
      .then(({ createElisionView }) => (dead ? undefined : createElisionView(canvas)))
      .then((view) => {
        if (!view) return;
        if (dead) {
          view.destroy();
          return;
        }
        viewRef.current = view;
        canvas.dataset.elisionWebgl = view.webgl;
      })
      .catch(() => {
        canvas.remove();
      });
    return () => {
      dead = true;
      viewRef.current?.destroy();
      viewRef.current = null;
      canvas.remove();
    };
  }, [enabled, hostRef, viewRef]);
}
