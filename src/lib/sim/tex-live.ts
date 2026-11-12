/**
 * Живой каталог текстур редактора: builtin + кастомные из GET /tex/catalog.
 * Редактор и кисть читают opts отсюда; refreshTexCatalog вызывает apply.
 */
import {
  EXTRA_COVER_IDS,
  EXTRA_PLANT_IDS,
  EXTRA_ROCK_IDS,
  EXTRA_TREE_IDS,
  GROUND_COVER_OPTS,
  OBJECT_DIMS,
  PLANT_SPRITE_OPTS,
  ROCK_SPRITE_OPTS,
  TREE_SPRITE_OPTS,
} from './test-map';
import { GROUND_COVER_IDS, PAINT_MATS } from './paint';

export type LiveTexOpt = { id: string; label: string; group?: string | null };

type Listener = () => void;
const listeners = new Set<Listener>();
let revision = 0;

let treeOpts: LiveTexOpt[] = TREE_SPRITE_OPTS.map((o) => ({ id: o.id, label: o.label }));
let rockOpts: LiveTexOpt[] = ROCK_SPRITE_OPTS.map((o) => ({ id: o.id, label: o.label }));
let plantOpts: LiveTexOpt[] = PLANT_SPRITE_OPTS.map((o) => ({
  id: o.id,
  label: o.label,
  group: o.group,
}));
let coverOpts: LiveTexOpt[] = GROUND_COVER_OPTS.map((o) => ({ id: o.id, label: o.label }));
let surfaceOpts: LiveTexOpt[] = [
  { id: 'grass-ground', label: 'Трава (бесшовный пол)' },
  { id: 'stone-floor', label: 'Каменный пол' },
];

function notify() {
  revision += 1;
  for (const fn of listeners) fn();
}

export function subscribeTexLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function texLiveRevision(): number {
  return revision;
}

export function getTreeSpriteOpts(): LiveTexOpt[] { return treeOpts; }
export function getRockSpriteOpts(): LiveTexOpt[] { return rockOpts; }
export function getPlantSpriteOpts(): LiveTexOpt[] { return plantOpts; }
export function getCoverOpts(): LiveTexOpt[] { return coverOpts; }
export function getSurfaceOpts(): LiveTexOpt[] { return surfaceOpts; }

function rebuildPaintMats() {
  const mats = [
    ...coverOpts.map((c) => ({ id: c.id, label: c.label })),
    ...surfaceOpts
      .filter((s) => s.id !== 'grass-ground' && s.id !== 'stone-floor')
      .map((s) => ({ id: s.id, label: s.label })),
    { id: 'dirt', label: 'Земля' },
    { id: 'erase', label: 'Ластик' },
  ];
  PAINT_MATS.length = 0;
  PAINT_MATS.push(...mats);
  GROUND_COVER_IDS.clear();
  for (const c of coverOpts) GROUND_COVER_IDS.add(c.id);
  for (const s of surfaceOpts) {
    if (s.id !== 'grass-ground' && s.id !== 'stone-floor') GROUND_COVER_IDS.add(s.id);
  }
}

export type CatalogRow = {
  id: string;
  label: string;
  category: string;
  group?: string | null;
  w?: number;
  h?: number;
};

/** Применить каталог сервера (builtin+custom). */
export function applyTexCatalog(items: CatalogRow[]): void {
  const trees: LiveTexOpt[] = [];
  const rocks: LiveTexOpt[] = [];
  const plants: LiveTexOpt[] = [];
  const covers: LiveTexOpt[] = [];
  const surfaces: LiveTexOpt[] = [];
  EXTRA_TREE_IDS.clear();
  EXTRA_ROCK_IDS.clear();
  EXTRA_PLANT_IDS.clear();
  EXTRA_COVER_IDS.clear();
  for (const item of items) {
    const opt: LiveTexOpt = { id: item.id, label: item.label, group: item.group ?? null };
    if (item.category === 'trees') {
      trees.push(opt);
      if (!TREE_SPRITE_OPTS.some((b) => b.id === item.id)) EXTRA_TREE_IDS.add(item.id);
    } else if (item.category === 'rocks') {
      rocks.push(opt);
      if (!ROCK_SPRITE_OPTS.some((b) => b.id === item.id)) EXTRA_ROCK_IDS.add(item.id);
    } else if (item.category === 'plants') {
      plants.push(opt);
      if (!PLANT_SPRITE_OPTS.some((b) => b.id === item.id)) EXTRA_PLANT_IDS.add(item.id);
    } else if (item.category === 'covers') {
      covers.push(opt);
      if (!GROUND_COVER_OPTS.some((b) => b.id === item.id)) EXTRA_COVER_IDS.add(item.id);
    } else if (item.category === 'surfaces') {
      surfaces.push(opt);
      if (item.id !== 'grass-ground' && item.id !== 'stone-floor') EXTRA_COVER_IDS.add(item.id);
    }
    if ((item.category === 'trees' || item.category === 'rocks' || item.category === 'plants')
      && item.w && item.h && !OBJECT_DIMS[item.id]) {
      OBJECT_DIMS[item.id] = [item.w, item.h];
    }
  }
  if (!trees.length && !rocks.length) return;
  treeOpts = trees.length ? trees : treeOpts;
  rockOpts = rocks.length ? rocks : rockOpts;
  plantOpts = plants.length ? plants : plantOpts;
  coverOpts = covers.length ? covers : coverOpts;
  surfaceOpts = surfaces.length ? surfaces : surfaceOpts;
  rebuildPaintMats();
  notify();
}
