export const WATERFALL_FRAMES = 8;
export const WATERFALL_FRAME_MS = 85;
export const WATERFALL_TILE_SIZE = 48;
export const waterfallFrame = (now: number) => Math.floor(now / WATERFALL_FRAME_MS) % WATERFALL_FRAMES;

let curtain: HTMLImageElement | undefined;
const tiles = new Map<string, HTMLCanvasElement[]>();

/** Opaque water base with the existing falling-water artwork blended over it. */
export function waterfallTile(color: string, frame: number) {
  if (typeof Image === 'undefined') return null;
  if (!curtain) {
    curtain = new Image();
    curtain.src = '/tex/waterfall/curtain-frames.png';
  }
  if (!curtain.complete || !curtain.naturalWidth) return null;
  let frames = tiles.get(color);
  if (!frames) {
    frames = [];
    tiles.set(color,frames);
  }
  if (frames[frame]) return frames[frame];
  const canvas = document.createElement('canvas');
  const size = WATERFALL_TILE_SIZE;
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = color;
  g.fillRect(0,0,size,size);
  g.globalAlpha = .48;
  g.drawImage(curtain,frame*size,0,size,size,0,0,size,size);
  return frames[frame] = canvas;
}
