import {
  elisionDayTint,
  type ElisionFrame,
  type ElisionActor,
} from "./elision-scene";
import type { WorldItemsSnapshot, ItemDefinition } from "../net/http-inventory";
import {
  currentTestMap,
  testPointInIsland,
  supportLevelAt,
  TERRAIN_LIFT_PX,
} from "./test-field";
import { createNightLightModel, itemGlowAmount } from "./night-lights";
const fallbackLights = createNightLightModel();
export const ITEM_REACH_PX = 70;
export const WORLD_ITEM_SIZE = 30;
export type WorldItemFrame = { frame: ElisionFrame; rect: DOMRect };
let latest: WorldItemFrame | null = null;
const listeners = new Set<(value: WorldItemFrame) => void>();
let scene: { world: WorldItemsSnapshot; items: ItemDefinition[] } | null = null;
const images = new Map<string, HTMLImageElement>();
function imageFor(url: string) {
  let image = images.get(url);
  if (!image) {
    image = new Image();
    image.crossOrigin = "anonymous";
    image.src = url;
    images.set(url, image);
  }
  return image;
}
export function itemDimensions(url: string) {
  const image = imageFor(url),
    w = image.naturalWidth || 30,
    h = image.naturalHeight || 30,
    k = WORLD_ITEM_SIZE / Math.max(w, h);
  return { w: w * k, h: h * k };
}
export function setWorldItemScene(
  world: WorldItemsSnapshot,
  items: ItemDefinition[],
) {
  scene = { world, items };
}
export function clearWorldItemScene() {
  scene = null;
  fallback?.remove();
  fallback = null;
}
export function muzzle(a: ElisionActor) {
  const pose = a.pose,
    x = (a.mirror ? 1 : -1) * a.w * 0.44 * (pose?.scaleX ?? 1),
    y = a.h * 0.71 * (pose?.scaleY ?? 1),
    angle = -((a.rot * Math.PI) / 180 + (pose?.rot ?? 0));
  return {
    x: x * Math.cos(angle) - y * Math.sin(angle),
    y: x * Math.sin(angle) + y * Math.cos(angle),
  };
}
/** Geometry lives in the same world as cats: tint, weather, depth and UI layering apply naturally. */
export function appendWorldItems(frame: ElisionFrame) {
  if (!scene || frame.editor) return [];
  const { world, items } = scene,
    out: ElisionActor[] = [];
  const url = (id: string) =>
    items.find((item) => item.id === id)?.sprite || "/items/nugget.png";
  for (const item of world.ground) {
    const src = url(item.itemId),
      size = itemDimensions(src);
    out.push({
      id: "item:" + item.id,
      x: item.x * frame.cellW - size.w / 2,
      y: item.y * frame.cellH - size.h,
      ...size,
      lift: supportLevelAt(item.x, item.y) * TERRAIN_LIFT_PX,
      url: src,
      glows: !!items.find((i) => i.id === item.itemId)?.glows,
      mirror: false,
      rot: 0,
    });
  }
  for (const player of world.players) {
    if (!player.mouth) continue;
    const parent = frame.decals.find(
      (a) =>
        a.id ===
        (player.id === world.selfId ? frame.controlledId : `p${player.id}`),
    );
    if (!parent) continue;
    const src = url(player.mouth.itemId),
      size = itemDimensions(src),
      anchor = muzzle(parent);
    out.push({
      id: "mouth:" + player.id,
      x: 0,
      y: 0,
      ...size,
      lift: 0,
      url: src,
      glows: !!items.find((i) => i.id === player.mouth?.itemId)?.glows,
      mirror: parent.mirror,
      rot: parent.rot + ((parent.pose?.rot ?? 0) * 180) / Math.PI,
      attachment: {
        parentId: parent.id,
        x: anchor.x,
        y: anchor.y - size.h / 2,
      },
    });
  }
  frame.decals.push(...out);
  return out;
}
let fallback: HTMLCanvasElement | null = null;
const scratch = () => document.createElement("canvas");
let itemCanvas: HTMLCanvasElement | null = null,
  alphaCanvas: HTMLCanvasElement | null = null;
function drawFallback(
  frame: ElisionFrame,
  canvas: HTMLCanvasElement,
  items: ElisionActor[],
  webgl: boolean,
) {
  if (webgl) {
    fallback?.remove();
    fallback = null;
    return;
  }
  if (!fallback) {
    fallback = scratch();
    fallback.style.cssText =
      "position:absolute;inset:0;width:100%;height:100%;z-index:9;pointer-events:none";
    canvas.parentElement?.appendChild(fallback);
  }
  const dpr = Math.min(2, devicePixelRatio || 1),
    w = Math.round(frame.viewW * dpr),
    h = Math.round(frame.viewH * dpr);
  if (fallback.width !== w || fallback.height !== h) {
    fallback.width = w;
    fallback.height = h;
  }
  const out = fallback.getContext("2d");
  if (!out) return;
  out.clearRect(0, 0, w, h);
  if (!itemCanvas) itemCanvas = scratch();
  if (itemCanvas.width !== w || itemCanvas.height !== h) {
    itemCanvas.width = w;
    itemCanvas.height = h;
  }
  const g = itemCanvas.getContext("2d");
  if (!g) return;
  const project = (x: number, y: number, lift: number) => ({
    x:
      frame.viewW / 2 +
      ((x - frame.camX) * Math.cos(frame.yaw) -
        (y - frame.camY) * Math.sin(frame.yaw)) *
        frame.zoom,
    y:
      frame.viewH / 2 +
      ((x - frame.camX) * Math.sin(frame.yaw) +
        (y - frame.camY) * Math.cos(frame.yaw) -
        lift) *
        frame.zoom,
  });
  const draw = (a: ElisionActor, mask = false) => {
    const image = a.image || imageFor(a.url);
    if (
      image instanceof HTMLImageElement &&
      (!image.complete || !image.naturalWidth)
    )
      return;
    const parent = a.attachment
      ? frame.decals.find((p) => p.id === a.attachment?.parentId)
      : undefined;
    const pose = parent?.pose || a.pose;
    const foot = parent
      ? project(
          parent.x + parent.w / 2,
          parent.y + parent.h,
          parent.lift + (pose?.lift || 0),
        )
      : project(a.x + a.w / 2, a.y + a.h, a.lift + (pose?.lift || 0));
    g.save();
    g.translate(foot.x + (pose?.sway || 0) * frame.zoom, foot.y);
    if (a.attachment)
      g.translate(a.attachment.x * frame.zoom, -a.attachment.y * frame.zoom);
    g.rotate((a.rot * Math.PI) / 180 + (a.pose?.rot || 0));
    g.scale(a.mirror ? -1 : 1, 1);
    g.drawImage(
      image,
      (-a.w * (a.pose?.scaleX || 1) * frame.zoom) / 2,
      -a.h * (a.pose?.scaleY || 1) * frame.zoom,
      a.w * (a.pose?.scaleX || 1) * frame.zoom,
      a.h * (a.pose?.scaleY || 1) * frame.zoom,
    );
    g.restore();
  };
  const paintItem = (item: ElisionActor) => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.imageSmoothingEnabled = false;
    g.globalCompositeOperation = "source-over";
    draw(item);
    g.globalCompositeOperation = "destination-out";
    const itemFoot = item.attachment
      ? frame.decals.find((a) => a.id === item.attachment?.parentId)
      : item;
    if (itemFoot)
      for (const actor of frame.decals) {
        if (actor.id.startsWith("item:") || actor.id.startsWith("mouth:"))
          continue;
        const depth = (a: ElisionActor) =>
          (a.x + a.w / 2) * Math.sin(frame.yaw) +
          (a.y + a.h) * Math.cos(frame.yaw);
        if (
          actor.id !== item.attachment?.parentId &&
          depth(actor) >= depth(itemFoot)
        )
          draw(actor, true);
      }
    g.globalCompositeOperation = "source-over";
    out.drawImage(itemCanvas!, 0, 0);
  };
  for (const item of items) paintItem(item);
  if (!alphaCanvas) alphaCanvas = scratch();
  alphaCanvas.width = w;
  alphaCanvas.height = h;
  alphaCanvas.getContext("2d")?.drawImage(fallback, 0, 0);
  const tint = elisionDayTint(frame.dayProgress);
  out.globalCompositeOperation = "multiply";
  out.fillStyle = `rgb(${tint.map((v) => Math.round(v * 255)).join(",")})`;
  out.fillRect(0, 0, w, h);
  out.globalCompositeOperation = "destination-in";
  out.drawImage(alphaCanvas, 0, 0);
  out.globalCompositeOperation = "source-over";
  const glowAmount = frame.editor ? 0 : itemGlowAmount(frame.dayProgress);
  if (glowAmount) {
    out.globalAlpha = glowAmount * 0.65;
    for (const item of items) if (item.glows) paintItem(item);
    out.globalAlpha = 1;
  }
  const now = performance.now();
  const sources = fallbackLights.update(
    frame,
    now,
    currentTestMap(),
    (x, z) => testPointInIsland(x / frame.cellW, z / frame.cellH),
    (x, z) =>
      supportLevelAt(x / frame.cellW, z / frame.cellH) * TERRAIN_LIFT_PX,
  );
  out.save();
  out.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const source of sources) {
    const p = project(source.x, source.z, source.y),
      radius = 120 * frame.zoom;
    if (
      p.x < -radius ||
      p.x > frame.viewW + radius ||
      p.y < -radius ||
      p.y > frame.viewH + radius
    )
      continue;
    const light = out.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
    light.addColorStop(
      0,
      `rgba(255,223,112,${source.energy * (source.kind === "firefly" ? 0.1 : 0.18)})`,
    );
    light.addColorStop(1, "rgba(255,223,112,0)");
    out.fillStyle = light;
    out.fillRect(p.x - radius, p.y - radius, radius * 2, radius * 2);
    const r = (source.kind === "firefly" ? 9 : 45) * frame.zoom;
    const halo = out.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    halo.addColorStop(
      0,
      `rgba(255,247,159,${source.energy * (source.kind === "firefly" ? 1 : 0.22)})`,
    );
    halo.addColorStop(
      0.16,
      `rgba(255,235,116,${source.energy * (source.kind === "firefly" ? 0.45 : 0.14)})`,
    );
    halo.addColorStop(1, "rgba(255,220,100,0)");
    out.fillStyle = halo;
    out.fillRect(p.x - r, p.y - r, r * 2, r * 2);
  }
  out.restore();
}
export function publishWorldItemFrame(
  frame: ElisionFrame,
  canvas: HTMLCanvasElement,
  webgl = true,
) {
  const items = appendWorldItems(frame);
  drawFallback(frame, canvas, items, webgl);
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
let dropClick: { x: number; y: number; until: number } | null = null;
export function markWorldItemDrop(x: number, y: number) {
  dropClick = { x, y, until: Date.now() + 1500 };
}
export function consumeWorldItemDrop(event: {
  clientX: number;
  clientY: number;
}) {
  if (
    !dropClick ||
    dropClick.until < Date.now() ||
    Math.hypot(event.clientX - dropClick.x, event.clientY - dropClick.y) > 4
  )
    return false;
  dropClick = null;
  return true;
}
