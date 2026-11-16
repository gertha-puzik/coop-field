import type { ElisionFrame } from "./elision-scene";
/** Read-only render bridge: item UI consumes the actual animated actors/camera. */
export type WorldItemFrame = { frame: ElisionFrame; rect: DOMRect };
let latest: WorldItemFrame | null = null;
const listeners = new Set<(value: WorldItemFrame) => void>();
export function publishWorldItemFrame(
  frame: ElisionFrame,
  canvas: HTMLCanvasElement,
) {
  latest = { frame, rect: canvas.getBoundingClientRect() };
  for (const listener of listeners) listener(latest);
}
export function observeWorldItemFrame(
  listener: (value: WorldItemFrame) => void,
) {
  listeners.add(listener);
  if (latest) listener(latest);
  return () => {
    listeners.delete(listener);
  };
}
export function currentWorldItemFrame() {
  return latest;
}
// Pointer drops also produce a subsequent canvas click in some input adapters.
let dropClick: { x: number; y: number; until: number } | null = null;
export function markWorldItemDrop(x: number, y: number) {
  dropClick = { x, y, until: Date.now() + 1500 };
}
export function consumeWorldItemDrop(event: {
  clientX: number;
  clientY: number;
}) {
  if (!dropClick || dropClick.until < Date.now()) return false;
  if (Math.hypot(event.clientX - dropClick.x, event.clientY - dropClick.y) > 4)
    return false;
  dropClick = null;
  return true;
}
