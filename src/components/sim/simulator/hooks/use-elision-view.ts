/**
 * Elision-only Babylon view. The module is imported with import() when the
 * field stage of /game/ is on screen, the same way useAtmosphereLayer
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
  statusRef: RefObject<'pending'|'ready'|'fallback'>;
}): void {
  const { enabled, hostRef, viewRef, statusRef } = opts;
  useEffect(() => {
    if (!enabled) return;
    const slot = hostRef.current;
    if (!slot) return;
    let dead = false;
    statusRef.current='pending';
    const canvas = document.createElement('canvas');
    canvas.className = 'pointer-events-none block h-full w-full rounded-lg';
    canvas.dataset.elisionWebgl = 'pending';
    slot.appendChild(canvas);
    import('@/lib/sim/elision-babylon')
      .then(({ createElisionView }) => (dead ? undefined : createElisionView(canvas)))
      .then((view) => {
        if (!view) {if(!dead)statusRef.current='fallback';canvas.remove();return;}
        if (dead) {
          view.destroy();
          return;
        }
        viewRef.current = view;
        statusRef.current='ready';
        canvas.dataset.elisionWebgl = view.webgl;
      })
      .catch(() => {
        if(!dead)statusRef.current='fallback';
        canvas.remove();
      });
    return () => {
      dead = true;
      viewRef.current?.destroy();
      viewRef.current = null;
      canvas.remove();
    };
  }, [enabled, hostRef, viewRef, statusRef]);
}
