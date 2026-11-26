import type { TestMap } from './test-map';
import { cachedTerrainTiles, terrainAt, WATER_COLORS as colors } from './terrain-shape';
const textures = [
  { src: 'river', crop: [0, 26, 96, 44] as const, tile: undefined as HTMLCanvasElement | undefined },
  { src: 'pool', crop: [74, 24, 116, 46] as const, tile: undefined as HTMLCanvasElement | undefined },
];
let loading = false;
let revision = 0;

export function waterTextureRevision() {
  return revision;
}

function loadWaterTextures() {
  if (loading) return;
  loading = true;
  for (const texture of textures) {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      const [x,y,w,h] = texture.crop;
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d')?.drawImage(image,x,y,w,h,0,0,w,h);
      texture.tile = canvas;
      revision++;
    };
    image.src = `/tex/water/${texture.src}.png`;
  }
}

const cached = new WeakMap<Record<string, number>, {
  size: string; paths: Path2D[];
}>();

function waterPaths(water: Record<string, number>, cols: number, rows: number, cellW: number, cellH: number) {
  const size = `${cols},${rows},${cellW},${cellH}`;
  const old = cached.get(water);
  if (old?.size === size) return old.paths;

  const paths = colors.map(() => new Path2D());
  for (const {x,y,w,d,level} of cachedTerrainTiles(water,cols,rows)) {
    if (!level) continue;
    const path = paths[level - 1];
    path.moveTo(x * cellW, y * cellH);
    function edge(ax: number, ay: number, bx: number, by: number, nx: number, ny: number) {
      const count = Math.ceil(Math.hypot((bx-ax)*cellW, (by-ay)*cellH) / 5);
      for (let i = 1; i < count; i++) {
        const px = ax + (bx-ax)*i/count;
        const py = ay + (by-ay)*i/count;
        const shore = !terrainAt(water, px + nx*.00001, py + ny*.00001);
        const roughness = 2 + 4 * (0.5 + 0.5*Math.sin(px*19 + py*31));
        const notch = shore ? Math.min(roughness, .25*(nx ? w*cellW : d*cellH)) : 0;
        path.lineTo(px*cellW - nx*notch, py*cellH - ny*notch);
      }
      path.lineTo(bx*cellW, by*cellH);
    }
    edge(x,y,x+w,y,0,-1);
    edge(x+w,y,x+w,y+d,1,0);
    edge(x+w,y+d,x,y+d,0,1);
    edge(x,y+d,x,y,-1,0);
    path.closePath();
  }
  cached.set(water, {size,paths});
  return paths;
}

export function drawWaterSurface(g: CanvasRenderingContext2D, map: TestMap, cellW: number, cellH: number) {
  if (!map.water) return;
  loadWaterTextures();
  const patterns = textures.map(({tile}) => tile && g.createPattern(tile, 'repeat'));
  const paths = waterPaths(map.water,map.cols,map.rows,cellW,cellH);
  g.save();
  for (const [i, path] of paths.entries()) {
    g.fillStyle = colors[i];
    g.fill(path);
    const pattern = patterns[i < 2 ? 0 : 1];
    if (pattern) {
      g.save();
      g.globalAlpha *= .32;
      g.fillStyle = pattern;
      g.fill(path);
      g.restore();
    }
  }
  g.restore();
}

// The 2D renderer samples this transparent layer at the same coordinates as
// terrain paint, then projects each sample onto the top of its own plateau.
let terrainWater: {
  map: TestMap; cellW: number; cellH: number; revision: number; canvas: HTMLCanvasElement;
} | undefined;

export function terrainWaterCanvas(map: TestMap, cellW: number, cellH: number) {
  if (!map.water) return null;
  if (terrainWater?.map === map && terrainWater.cellW === cellW &&
      terrainWater.cellH === cellH && terrainWater.revision === revision) return terrainWater.canvas;
  const canvas = terrainWater?.canvas ?? document.createElement('canvas');
  canvas.width = Math.round(map.cols * cellW);
  canvas.height = Math.round(map.rows * cellH);
  const context = canvas.getContext('2d');
  if (!context) return null;
  drawWaterSurface(context,map,cellW,cellH);
  terrainWater = {map,cellW,cellH,revision,canvas};
  return canvas;
}

export function drawSubmergedSprite(g: CanvasRenderingContext2D, image: HTMLImageElement | HTMLCanvasElement,
  width: number, height: number, sink: number, opacity: number) {
  if (!sink) {
    g.drawImage(image, -width/2, -height, width, height);
    return;
  }
  const top = height - sink;
  const sourceTop = image.height * top / height;
  g.drawImage(image, 0, 0, image.width, sourceTop, -width/2, -top, width, top);
  g.save();
  g.globalAlpha *= opacity;
  g.drawImage(image, 0, sourceTop, image.width, image.height-sourceTop, -width/2, 0, width, sink);
  g.restore();
}
