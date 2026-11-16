"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  inventoryRequest,
  itemSprite,
  type WorldItemsSnapshot,
} from "@/lib/net/http-inventory";
import {
  currentWorldItemFrame,
  markWorldItemDrop,
  observeWorldItemFrame,
  setWorldItemScene,
  clearWorldItemScene,
  ITEM_REACH_PX,
  type WorldItemFrame,
} from "@/lib/sim/world-item-frame";
import { screenToWorld } from "@/lib/sim/geometry";
import {
  supportLevelAt,
  groundPointAtWorld,
  TERRAIN_LIFT_PX,
} from "@/lib/sim/test-field";
import type { InventoryController } from "./inventory-panel";
import s from "./world-items.module.css";
const EMPTY: WorldItemsSnapshot = {
  room: null,
  selfId: null,
  ground: [],
  players: [],
  offers: [],
};
/** Ground projection and mouth anchor use the exact render frame, not polled positions. */
export function WorldItems({
  controller,
  characterId,
  meId,
  blocked,
}: {
  controller: InventoryController;
  characterId?: string;
  meId: number | null;
  blocked: boolean;
}) {
  const [world, setWorld] = useState(EMPTY),
    [near, setNear] = useState<string | null>(null),
    [target, setTarget] = useState<number | null>(null),
    [reachable, setReachable] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null),
    current = useRef({ world, controller, blocked }),
    nearRef = useRef<string | null>(null),
    targetRef = useRef<number | null>(null),
    pointer = useRef({ x: -10000, y: -10000 });
  const reachableRef = useRef(new Set<string>());
  current.current = { world, controller, blocked };
  useEffect(() => {
    let disposed = false,
      loading = false;
    setWorld(EMPTY);
    async function load() {
      if (!characterId || meId === null || loading || document.hidden) return;
      loading = true;
      try {
        const row = await inventoryRequest<{ world: WorldItemsSnapshot }>(
          "/cfg/inventory/world?characterId=" +
            encodeURIComponent(characterId) +
            "&catId=" +
            meId,
        );
        if (!disposed) {
          setWorld(row.world);
          if (
            row.world.room &&
            row.world.mouth?.itemId !==
              current.current.controller.snapshot?.mouth?.itemId
          )
            void current.current.controller.refresh();
        }
      } catch {
        if (!disposed) setWorld(EMPTY);
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 650);
    window.addEventListener("world-items:refresh", load);
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener("world-items:refresh", load);
    };
  }, [characterId, meId]);
  useEffect(() => {
    setWorldItemScene(
      world,
      (controller.snapshot?.items || []).map((item) => ({
        ...item,
        sprite: item.sprite ? itemSprite(item.sprite) : null,
      })),
    );
  }, [world, controller.snapshot?.items]);
  useEffect(() => {
    const move = (e: PointerEvent) => {
      pointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("pointermove", move);
    return () => {
      window.removeEventListener("pointermove", move);
      clearWorldItemScene();
    };
  }, []);
  useEffect(
    () =>
      observeWorldItemFrame(({ frame: f, rect }: WorldItemFrame) => {
        const w = current.current.world;
        const actor = (id: number) =>
          f.decals.find(
            (a) => a.id === (id === w.selfId ? f.controlledId : `p${id}`),
          );
        const self = w.selfId === null ? undefined : actor(w.selfId);
        const serverSelf = w.players.find((p) => p.id === w.selfId);
        const project = (x: number, y: number, lift = 0) => ({
          x:
            rect.left +
            f.viewW / 2 +
            ((x - f.camX) * Math.cos(f.yaw) - (y - f.camY) * Math.sin(f.yaw)) *
              f.zoom,
          y:
            rect.top +
            f.viewH / 2 +
            ((x - f.camX) * Math.sin(f.yaw) +
              (y - f.camY) * Math.cos(f.yaw) -
              lift) *
              f.zoom,
        });
        const at = (
          key: string,
          p: { x: number; y: number } | null,
          size?: number,
          rotation = 0,
        ) => {
          const el = root.current?.querySelector<HTMLElement>(
            `[data-world-key="${key}"]`,
          );
          if (!el) return;
          el.hidden = !p || f.editor;
          if (p) {
            el.style.left = p.x + "px";
            el.style.top = p.y + "px";
            if (size) {
              el.style.width = size + "px";
              el.style.height = size + "px";
            }
            el.style.transform = `translate(-50%,-100%) rotate(${rotation}rad)`;
          }
        };
        let closest: string | null = null,
          hovered: string | null = null,
          promptHovered: string | null = null,
          distance = Infinity;
        const canReach: string[] = [];
        for (const item of w.ground) {
          const lift = supportLevelAt(item.x, item.y) * TERRAIN_LIFT_PX;
          const p = project(item.x * f.cellW, item.y * f.cellH, lift);

          at(`prompt-${item.id}`, { x: p.x, y: p.y - 36 * f.zoom });
          if (self) {
            const visualDistance = Math.hypot(
              ((self.x + self.w / 2) / f.cellW - item.x) * 100,
              ((self.y + self.h) / f.cellH - item.y) * 150,
            );
            const serverDistance = serverSelf
              ? Math.hypot(
                  (serverSelf.x - item.x) * 100,
                  (serverSelf.y - item.y) * 150,
                )
              : Infinity;
            const d = Math.max(visualDistance, serverDistance);
            if (
              Math.abs(pointer.current.x - p.x) <= 20 * f.zoom &&
              pointer.current.y >= p.y - 36 * f.zoom &&
              pointer.current.y <= p.y + 4 * f.zoom
            )
              hovered = item.id;
            if (d <= ITEM_REACH_PX) canReach.push(item.id);
            if (nearRef.current === item.id) {
              const prompt = root.current
                ?.querySelector<HTMLElement>(
                  `[data-world-key="prompt-${item.id}"]`,
                )
                ?.getBoundingClientRect();
              if (
                prompt &&
                pointer.current.x >= prompt.left &&
                pointer.current.x <= prompt.right &&
                pointer.current.y >= prompt.top &&
                pointer.current.y <= prompt.bottom
              )
                promptHovered = item.id;
            }
            if (d <= ITEM_REACH_PX && d < distance) {
              closest = item.id;
              distance = d;
            }
          }
        }
        let nextTarget: number | null = null,
          best = Infinity;
        for (const player of w.players) {
          const a = actor(player.id);
          const p = a ? project(a.x + a.w / 2, a.y + a.h, a.lift) : null;
          at(
            `player-${player.id}`,
            p && a ? { x: p.x, y: p.y - a.h * f.zoom - 40 } : null,
          );
          at(
            `offer-${player.id}`,
            p && a ? { x: p.x, y: p.y - a.h * f.zoom - 45 } : null,
          );
          if (self && a && player.id !== w.selfId && !player.mouth) {
            const d = Math.hypot(
              (self.x + self.w / 2 - a.x - a.w / 2) / f.cellW,
              (self.y + self.h - a.y - a.h) / f.cellH,
            );
            if (d < 1.5 && d < best) {
              nextTarget = player.id;
              best = d;
            }
          }
        }
        if ([...reachableRef.current].join() !== canReach.join()) {
          reachableRef.current = new Set(canReach);
          setReachable(canReach);
        }
        closest = hovered || promptHovered || closest;
        if (nearRef.current !== closest) {
          nearRef.current = closest;
          setNear(closest);
        }
        if (targetRef.current !== nextTarget) {
          targetRef.current = nextTarget;
          setTarget(nextTarget);
        }
      }),
    [],
  );
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.repeat ||
        current.current.blocked ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        (e.target instanceof HTMLElement &&
          e.target.closest(
            'input,textarea,select,[contenteditable="true"],[data-game-dialog]',
          ))
      )
        return;
      const mouth = current.current.controller.snapshot
        ? current.current.controller.snapshot.mouth
        : current.current.world.mouth;
      if (e.code === "KeyR" && mouth) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void current.current.controller.worldAction({
          action: "release",
          expectedItemId: mouth.itemId,
        });
        return;
      }
      const action =
        e.code === "KeyR" ? "mouth" : e.code === "KeyF" ? "take" : null;
      if (
        action &&
        nearRef.current &&
        reachableRef.current.has(nearRef.current)
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void current.current.controller.worldAction({
          action,
          id: nearRef.current,
        });
      }
    };
    const drop = (event: Event) => {
      const e = event as CustomEvent<{
        from: unknown;
        expectedItemId?: string;
        x: number;
        y: number;
        onResult?: (ok: boolean) => void;
      }>;
      const value = currentWorldItemFrame();
      if (!value || value.frame.editor) return;
      const { frame: f, rect } = value;
      if (
        e.detail.x < rect.left ||
        e.detail.x > rect.right ||
        e.detail.y < rect.top ||
        e.detail.y > rect.bottom
      )
        return;
      markWorldItemDrop(e.detail.x, e.detail.y);
      const flat = screenToWorld(
        e.detail.x - rect.left,
        e.detail.y - rect.top,
        f.viewW,
        f.viewH,
        f.camX,
        f.camY,
        f.zoom,
        f.yaw,
      );
      // Use the same terrain ray pick as movement, including cliffs and rotated views.
      const p = groundPointAtWorld(flat.x, flat.y, f.cellW, f.cellH, f.yaw);
      void current.current.controller
        .worldAction({
          action: "drop",
          from: e.detail.from,
          expectedItemId: e.detail.expectedItemId,
          x: p.x / f.cellW,
          y: p.y / f.cellH,
        })
        .then((ok) => e.detail.onResult?.(ok));
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("world-items:drop", drop);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("world-items:drop", drop);
    };
  }, []);
  const item = (id: string) =>
    controller.snapshot?.items.find((i) => i.id === id);
  const act = (raw: Record<string, unknown>) =>
    void controller.worldAction(raw);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div ref={root} className={s.layer}>
      {world.ground.map((row) => (
        <div key={row.id}>
          {near === row.id && !blocked ? (
            <div data-world-key={`prompt-${row.id}`} className={s.prompt}>
              <strong>{item(row.itemId)?.name}</strong>
              <span>
                Вес: {item(row.itemId)?.weight}
                {item(row.itemId)?.glows ? " · Светится вечером и ночью" : ""}
              </span>
              {!reachable.includes(row.id) ? (
                <small>Подойдите ближе, чтобы поднять</small>
              ) : null}
              <button
                disabled={
                  controller.busy ||
                  !!world.mouth ||
                  !reachable.includes(row.id)
                }
                onClick={() => act({ action: "mouth", id: row.id })}
              >
                <kbd>R</kbd> Взять в пасть
              </button>
              <button
                disabled={controller.busy || !reachable.includes(row.id)}
                onClick={() => act({ action: "take", id: row.id })}
              >
                <kbd>F</kbd> Убрать в инвентарь
              </button>
            </div>
          ) : null}
        </div>
      ))}
      {world.players.map((player) => (
        <div key={player.id}>
          {world.mouth && player.id === target && !blocked ? (
            <div data-world-key={`player-${player.id}`} className={s.prompt}>
              <button
                disabled={controller.busy}
                onClick={() => act({ action: "offer", targetId: player.id })}
              >
                Толкнуть «{item(world.mouth.itemId)?.name}»
              </button>
            </div>
          ) : null}
          {!blocked &&
            world.offers
              .filter((o) => o.fromId === player.id)
              .map((offer) => (
                <div
                  key={offer.id}
                  data-world-key={`offer-${player.id}`}
                  className={s.prompt}
                  data-world-drop-block
                >
                  <strong>
                    {offer.name} предлагает «{item(offer.itemId)?.name}»
                  </strong>
                  <button
                    disabled={controller.busy}
                    onClick={() => act({ action: "accept", offerId: offer.id })}
                  >
                    Принять в пасть
                  </button>
                  <button
                    disabled={controller.busy}
                    onClick={() => act({ action: "cancel", offerId: offer.id })}
                  >
                    Отмена
                  </button>
                </div>
              ))}
        </div>
      ))}
    </div>,
    document.body,
  );
}
