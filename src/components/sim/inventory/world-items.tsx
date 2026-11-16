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
  type WorldItemFrame,
} from "@/lib/sim/world-item-frame";
import { screenToWorld } from "@/lib/sim/geometry";
import {
  supportLevelAt,
  groundPointAtWorld,
  TERRAIN_LIFT_PX,
} from "@/lib/sim/test-field";
import type { ElisionActor } from "@/lib/sim/elision-scene";
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
  blocked,
}: {
  controller: InventoryController;
  characterId?: string;
  blocked: boolean;
}) {
  const [world, setWorld] = useState(EMPTY),
    [near, setNear] = useState<string | null>(null),
    [target, setTarget] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null),
    current = useRef({ world, controller, blocked }),
    nearRef = useRef<string | null>(null),
    targetRef = useRef<number | null>(null);
  current.current = { world, controller, blocked };
  useEffect(() => {
    let disposed = false,
      loading = false;
    setWorld(EMPTY);
    async function load() {
      if (!characterId || loading || document.hidden) return;
      loading = true;
      try {
        const row = await inventoryRequest<{ world: WorldItemsSnapshot }>(
          "/cfg/inventory/world?characterId=" + encodeURIComponent(characterId),
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
  }, [characterId]);
  useEffect(
    () =>
      observeWorldItemFrame(({ frame: f, rect }: WorldItemFrame) => {
        const w = current.current.world;
        const actor = (id: number) =>
          f.decals.find(
            (a) => a.id === (id === w.selfId ? f.controlledId : `p${id}`),
          );
        const self = w.selfId === null ? undefined : actor(w.selfId);
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
          distance = Infinity;
        for (const item of w.ground) {
          const lift = supportLevelAt(item.x, item.y) * TERRAIN_LIFT_PX;
          const p = project(item.x * f.cellW, item.y * f.cellH, lift);
          at(`ground-${item.id}`, p, Math.max(12, 30 * f.zoom));
          at(`prompt-${item.id}`, { x: p.x, y: p.y - 36 * f.zoom });
          if (self) {
            const d = Math.hypot(
              (self.x + self.w / 2) / f.cellW - item.x,
              (self.y + self.h) / f.cellH - item.y,
            );
            if (d < 1.5 && d < distance) {
              closest = item.id;
              distance = d;
            }
          }
        }
        let nextTarget: number | null = null,
          best = Infinity;
        for (const player of w.players) {
          const a = actor(player.id);
          if (player.mouth) {
            // Authored test1 muzzle: 6% from left, 29% down. Mirror and pose about the feet.
            const p = a ? muzzle(a) : null;
            const foot = a
              ? project(a.x + a.w / 2, a.y + a.h, a.lift + (a.pose?.lift || 0))
              : null;
            at(
              `mouth-${player.id}`,
              p && foot
                ? {
                    x: foot.x + (p.x + (a?.pose?.sway || 0)) * f.zoom,
                    y:
                      foot.y -
                      p.y * f.zoom +
                      (a ? Math.max(8, a.h * 0.145 * f.zoom) : 18) / 2,
                  }
                : null,
              a ? Math.max(8, a.h * 0.145 * f.zoom) : 18,
              a?.pose?.rot || 0,
            );
          }
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
            'input,textarea,select,[contenteditable="true"],button,[data-game-dialog]',
          ))
      )
        return;
      const action =
        e.code === "KeyR" ? "mouth" : e.code === "KeyF" ? "take" : null;
      if (action && nearRef.current) {
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
      void current.current.controller.worldAction({
        action: "drop",
        from: e.detail.from,
        expectedItemId: e.detail.expectedItemId,
        x: p.x / f.cellW,
        y: p.y / f.cellH,
      });
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
          <img
            data-world-key={`ground-${row.id}`}
            className={s.item}
            src={itemSprite(item(row.itemId)?.sprite || "/items/nugget.png")}
            alt={item(row.itemId)?.name || "Предмет"}
          />
          {near === row.id && !blocked ? (
            <div data-world-key={`prompt-${row.id}`} className={s.prompt}>
              <strong>{item(row.itemId)?.name}</strong>
              <button
                disabled={controller.busy || !!world.mouth}
                onClick={() => act({ action: "mouth", id: row.id })}
              >
                <kbd>R</kbd> Взять в пасть
              </button>
              <button
                disabled={controller.busy}
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
          {player.mouth ? (
            <img
              data-world-key={`mouth-${player.id}`}
              className={s.mouth}
              src={itemSprite(
                item(player.mouth.itemId)?.sprite || "/items/nugget.png",
              )}
              alt={`${player.name}: ${item(player.mouth.itemId)?.name || "предмет"} в пасти`}
            />
          ) : null}
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
          {world.offers
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
      {controller.snapshot?.mouth ? (
        <button
          className={s.carried}
          data-mouth-item
          onClick={() =>
            window.dispatchEvent(new CustomEvent("world-items:carry-mouth"))
          }
        >
          В пасти: {item(controller.snapshot.mouth.itemId)?.name} · положить
        </button>
      ) : null}
      {controller.error ? (
        <p className={s.error} role="status">
          {controller.error}
        </p>
      ) : null}
    </div>,
    document.body,
  );
}
function muzzle(a: ElisionActor) {
  const pose = a.pose,
    x = (a.mirror ? 1 : -1) * a.w * 0.44 * (pose?.scaleX ?? 1),
    y = a.h * 0.71 * (pose?.scaleY ?? 1),
    angle = -((a.rot * Math.PI) / 180 + (pose?.rot ?? 0));
  return {
    x: x * Math.cos(angle) - y * Math.sin(angle),
    y: x * Math.sin(angle) + y * Math.cos(angle),
  };
}
