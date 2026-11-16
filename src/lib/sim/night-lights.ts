/** Renderer-independent night lighting and bounded, continuous firefly paths. */
import type { ElisionActor, ElisionFrame } from "./elision-scene";
export const MAX_GLOW_LIGHTS = 24;
const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export function itemGlowAmount(progress: number) {
  if (!Number.isFinite(progress)) return 0;
  const p = ((progress % 4) + 4) % 4;
  return smooth(2, 2.45, p) * (1 - smooth(3.65, 4, p));
}
export function fireflyAmount(progress: number) {
  if (!Number.isFinite(progress)) return 0;
  const p = ((progress % 4) + 4) % 4;
  return smooth(3, 3.2, p) * (1 - smooth(3.75, 4, p));
}
export type NightLight = {
  id: string;
  kind: "firefly" | "item";
  x: number;
  y: number;
  z: number;
  energy: number;
};
type Flight = {
  from: { x: number; z: number };
  to: { x: number; z: number };
  start: number;
  duration: number;
  birth: number;
  life: number;
  phase: number;
};
export function actorLightPoint(actor: ElisionActor, frame: ElisionFrame) {
  const parent = actor.attachment
    ? frame.decals.find((a) => a.id === actor.attachment?.parentId)
    : undefined;
  const base = parent || actor,
    pose = base.pose;
  const ox =
    (actor.attachment?.x || 0) +
    (pose?.sway || 0) +
    (Math.sin((actor.rot * Math.PI) / 180) * actor.h) / 2;
  const front = parent ? 0.3 : 0;
  return {
    x:
      base.x +
      base.w / 2 +
      ox * Math.cos(frame.yaw) +
      front * Math.sin(frame.yaw),
    y:
      base.lift +
      0.2 +
      (pose?.lift || 0) +
      (actor.attachment?.y || 0) +
      (Math.cos((actor.rot * Math.PI) / 180) * actor.h) / 2 +
      front,
    z: base.y + base.h - ox * Math.sin(frame.yaw) + front * Math.cos(frame.yaw),
  };
}
export function createNightLightModel(random: () => number = Math.random) {
  let mapKey: unknown = null,
    flies: Flight[] = [];
  function update(
    frame: ElisionFrame,
    now: number,
    key: unknown,
    valid: (x: number, z: number) => boolean,
    height: (x: number, z: number) => number,
  ): NightLight[] {
    function sample(around?: { x: number; z: number }) {
      for (let i = 0; i < 80; i++) {
        const x = around
            ? around.x + (random() - 0.5) * 320
            : random() * frame.cols * frame.cellW,
          z = around
            ? around.z + (random() - 0.5) * 320
            : random() * frame.rows * frame.cellH;
        if (!valid(x, z)) continue;
        if (
          around &&
          [0.25, 0.5, 0.75].some(
            (t) =>
              !valid(
                around.x + (x - around.x) * t,
                around.z + (z - around.z) * t,
              ),
          )
        )
          continue;
        return { x, z };
      }
      return around || null;
    }
    if (key !== mapKey) {
      mapKey = key;
      flies = [];
      const count = Math.min(
        96,
        Math.max(
          16,
          Math.ceil(
            (frame.cols * frame.cellW * frame.rows * frame.cellH) / 90000,
          ),
        ),
      );
      for (let i = 0; i < count; i++) {
        const from = sample();
        if (!from) continue;
        flies.push({
          from,
          to: sample(from) || from,
          start: now,
          duration: 6000 + random() * 8000,
          birth: now - random() * 6000,
          life: 18000 + random() * 20000,
          phase: random() * Math.PI * 2,
        });
      }
    }
    const out: NightLight[] = [],
      night = frame.editor ? 0 : fireflyAmount(frame.dayProgress);
    flies.forEach((fly, i) => {
      if (now - fly.birth > fly.life) {
        const from = sample();
        if (from) {
          fly.from = from;
          fly.to = sample(from) || from;
        }
        fly.birth = now;
        fly.start = now;
      }
      if (now - fly.start > fly.duration) {
        fly.from = fly.to;
        fly.to = sample(fly.from) || fly.from;
        fly.start = now;
        fly.duration = 6000 + random() * 8000;
      }
      const t = smooth(0, 1, (now - fly.start) / fly.duration),
        x = fly.from.x + (fly.to.x - fly.from.x) * t,
        z = fly.from.z + (fly.to.z - fly.from.z) * t;
      const energy =
        night *
        smooth(0, 1700, now - fly.birth) *
        (1 - smooth(fly.life - 2500, fly.life, now - fly.birth)) *
        (0.65 + 0.35 * Math.sin(now * 0.002 + fly.phase) ** 2);
      if (energy > 0.001)
        out.push({
          id: "firefly:" + i,
          kind: "firefly",
          x,
          z,
          y: height(x, z) + 25 + 12 * Math.sin(now * 0.0013 + fly.phase),
          energy,
        });
    });
    const glow = frame.editor ? 0 : itemGlowAmount(frame.dayProgress);
    if (glow)
      for (const actor of frame.decals)
        if (actor.glows)
          out.push({
            id: actor.id,
            kind: "item",
            ...actorLightPoint(actor, frame),
            energy: glow,
          });
    return out;
  }
  return { update };
}
