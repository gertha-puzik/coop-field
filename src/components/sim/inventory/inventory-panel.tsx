"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Icon } from "@/components/players/profile-icons";
import { createPortal } from "react-dom";
import {
  itemSprite,
  type InventorySlot,
  type ItemStack,
  type ItemDefinition,
} from "@/lib/net/http-inventory";
import { useInventory } from "./use-inventory";
import s from "./inventory.module.css";
export type InventoryController = ReturnType<typeof useInventory>;
type Point = { x: number; y: number };
type Drag = {
  from: InventorySlot;
  stack: ItemStack;
  item: ItemDefinition;
  start: Point;
  point: Point;
  active: boolean;
  tilt: number;
};
type Flight = { id: number; sprite: string; start: Point; end: Point };
const center = (el: Element): Point => {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
};
function FlyingSprite({
  flight,
  onFinish,
}: {
  flight: Flight;
  onFinish: () => void;
}) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dx = flight.end.x - flight.start.x,
      dy = flight.end.y - flight.start.y;
    const animation = ref.current?.animate(
      [
        { transform: "translate(-50%,-50%) scale(1.15)", opacity: 1 },
        {
          transform: `translate(calc(-50% + ${dx * 0.5}px),calc(-50% + ${dy * 0.5 - 70}px)) rotate(-12deg) scale(1.25)`,
          offset: 0.5,
          opacity: 1,
        },
        {
          transform: `translate(calc(-50% + ${dx}px),calc(-50% + ${dy}px)) scale(.6)`,
          opacity: 0.3,
        },
      ],
      {
        duration: reduced ? 1 : 460,
        easing: "cubic-bezier(.25,.65,.3,1)",
        fill: "forwards",
      },
    );
    if (animation) animation.onfinish = onFinish;
    else onFinish();
    return () => animation?.cancel();
  }, [flight, onFinish]);
  return (
    <img
      ref={ref}
      src={flight.sprite}
      className={s.flying}
      style={{ left: flight.start.x, top: flight.start.y }}
      alt=""
    />
  );
}
export function InventoryPanel({
  controller,
  open,
  onClose,
  selected,
  onSelect,
  characterName,
}: {
  controller: InventoryController;
  open: boolean;
  onClose: () => void;
  selected: number;
  onSelect: (index: number) => void;
  characterName: string;
}) {
  const { snapshot, busy, error, move } = controller;
  const finishFlight = useCallback(() => setFlight(null), []);
  const [drag, setDrag] = useState<Drag | null>(null),
    [flight, setFlight] = useState<Flight | null>(null),
    [landed, setLanded] = useState(""),
    [selectedBag, setSelectedBag] = useState<number | null>(null);
  const dragging = useRef<Drag | null>(null),
    flightId = useRef(0),
    landingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setDrag(null);
    dragging.current = null;
  }, [snapshot?.characterId, open]);
  useEffect(
    () => () => {
      if (landingTimer.current) clearTimeout(landingTimer.current);
    },
    [],
  );
  const element = (slot: InventorySlot) =>
    document.querySelector(
      `[data-inventory-slot="${slot.area}:${slot.index}"]`,
    );
  async function transfer(
    from: InventorySlot,
    to?: InventorySlot,
    quick = false,
    start?: Point,
  ) {
    const stack = snapshot?.[from.area][from.index],
      item = snapshot?.items.find((item) => item.id === stack?.itemId),
      source = element(from);
    const origin = start || (source ? center(source) : null);
    const target = await move(from, to, quick);
    if (!target) return;
    const targetElement = element(target);
    if (item?.sprite && origin && targetElement)
      setFlight({
        id: ++flightId.current,
        sprite: itemSprite(item.sprite),
        start: origin,
        end: center(targetElement),
      });
    setLanded(`${target.area}:${target.index}`);
    if (landingTimer.current) clearTimeout(landingTimer.current);
    landingTimer.current = setTimeout(() => setLanded(""), 650);
  }
  function down(
    event: ReactPointerEvent<HTMLButtonElement>,
    slot: InventorySlot,
    stack: ItemStack | null,
  ) {
    if (event.button !== 0 || busy || !stack) return;
    const item = snapshot?.items.find((item) => item.id === stack.itemId);
    if (!item) return;
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = { x: event.clientX, y: event.clientY };
    dragging.current = {
      from: slot,
      stack,
      item,
      start: point,
      point,
      active: false,
      tilt: 0,
    };
  }
  function pointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const old = dragging.current;
    if (!old) return;
    event.preventDefault();
    const point = { x: event.clientX, y: event.clientY },
      active =
        old.active ||
        Math.hypot(point.x - old.start.x, point.y - old.start.y) > 4;
    const next = {
      ...old,
      point,
      active,
      tilt: Math.max(-14, Math.min(14, (point.x - old.point.x) * 1.6)),
    };
    dragging.current = next;
    if (active) setDrag(next);
  }
  function up(event: ReactPointerEvent<HTMLButtonElement>) {
    const value = dragging.current;
    if (!value) return;
    event.preventDefault();
    event.stopPropagation();
    dragging.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!value.active) {
      if (event.shiftKey) void transfer(value.from, undefined, true);
      else if (value.from.area === "hotbar") onSelect(value.from.index);
      return;
    }
    const target = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-inventory-slot]")?.dataset.inventorySlot;
    if (!target) return;
    const [area, index] = target.split(":");
    if (area !== "bag" && area !== "hotbar") return;
    if (value.from.area === area && value.from.index === Number(index)) return;
    void transfer(value.from, { area, index: Number(index) }, false, {
      x: event.clientX,
      y: event.clientY,
    });
  }
  function slot(area: "bag" | "hotbar", index: number) {
    const stack = snapshot?.[area][index] || null,
      item = snapshot?.items.find((item) => item.id === stack?.itemId),
      key = `${area}:${index}`,
      isSelected =
        area === "hotbar" ? selected === index : selectedBag === index;
    return (
      <div className={s.slotWrap} key={key}>
        {area === "hotbar" ? <kbd className={s.key}>{index + 1}</kbd> : null}
        <button
          type="button"
          data-inventory-slot={key}
          className={`${s.slot} ${isSelected ? s.selected : ""} ${landed === key ? s.landed : ""}`}
          aria-label={`${area === "bag" ? "Инвентарь" : "Хотбар"}, слот ${index + 1}: ${item ? `${item.name}, ${stack?.quantity} шт., вес ${Number(((stack?.quantity || 0) * item.weight).toFixed(2))}` : "пусто"}`}
          aria-pressed={isSelected}
          disabled={busy || !snapshot}
          title={
            item
              ? `${item.name}\nВес одной штуки: ${item.weight}\nShift + щелчок — перенести`
              : "Свободный слот"
          }
          onPointerDown={(event) => down(event, { area, index }, stack)}
          onPointerMove={pointerMove}
          onPointerUp={up}
          onPointerCancel={() => {
            dragging.current = null;
            setDrag(null);
          }}
          onClick={(event) => {
            if (area === "hotbar") onSelect(index);
            else setSelectedBag(index);
            if (event.detail === 0 && event.shiftKey && stack)
              void transfer({ area, index }, undefined, true);
          }}
        >
          {stack && item ? (
            <>
              <span className={s.quantity}>{stack.quantity}</span>
              {item.sprite ? (
                <img
                  src={itemSprite(item.sprite)}
                  draggable={false}
                  alt={item.name}
                />
              ) : (
                <span className={s.missing} aria-label="Спрайт ещё не загружен">
                  ◇
                </span>
              )}
              <span className={s.weight}>
                {Number((item.weight * stack.quantity).toFixed(2))}
              </span>
            </>
          ) : (
            <span className={s.empty} aria-hidden>
              ＋
            </span>
          )}
        </button>
      </div>
    );
  }
  const weight = snapshot?.weight || 0;
  return (
    <div
      className={s.overlay}
      role={open ? "dialog" : undefined}
      aria-modal={open ? true : undefined}
      aria-labelledby={open ? "inventory-heading" : undefined}
      data-game-dialog={open ? "" : undefined}
    >
      {open ? (
        <div
          className={s.backdrop}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <section className={s.window}>
            <header>
              <span aria-hidden>
                <Icon name="paw" size={32} />
              </span>
              <div>
                <h2 id="inventory-heading">Инвентарь</h2>
                <small>{characterName}</small>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Закрыть инвентарь"
              >
                ×
              </button>
            </header>
            <div className={s.capacity}>
              <span>Общий вес</span>
              <strong>
                {weight} <span>/ 30</span>
              </strong>
              <meter
                min={0}
                max={30}
                value={weight}
                aria-label={`Вес ${weight} из 30`}
              />
            </div>
            <div className={s.bag}>
              {Array.from({ length: 10 }, (_, index) => slot("bag", index))}
            </div>
            {!snapshot ? (
              <p className={s.note} role="status">
                {error || "Загружаем инвентарь…"}
              </p>
            ) : null}
            <p className={s.note}>
              Перетащите предмет в хотбар или нажмите Shift + ЛКМ.
            </p>
            <p className={s.note}>
              Количество — слева сверху, суммарный вес — справа снизу.
            </p>
            {error && snapshot ? (
              <p role="alert" className={s.error}>
                {error}
              </p>
            ) : null}
            {weight >= 30 ? (
              <p className={s.full}>Инвентарь заполнен по весу.</p>
            ) : null}
          </section>
        </div>
      ) : null}
      <section className={s.hotbar} aria-label="Хотбар">
        <div className={s.hotbarSlots}>
          {Array.from({ length: 5 }, (_, index) => slot("hotbar", index))}
        </div>
        <div className={s.hotbarFooter}>
          <span>
            {selected >= 0 ? `Слот ${selected + 1}` : "Выберите слот"}
          </span>
          <span title="Общий вес инвентаря и хотбара">Вес {weight}/30</span>
        </div>
        {error && !open ? (
          <p role="alert" className={s.hotbarError}>
            {error}
          </p>
        ) : null}
      </section>
      {typeof document !== "undefined" && drag?.active && drag.item.sprite
        ? createPortal(
            <div
              className={s.dragGhost}
              style={{
                left: drag.point.x,
                top: drag.point.y,
                transform: `translate(-50%,-55%) rotate(${drag.tilt}deg)`,
              }}
            >
              <img
                src={itemSprite(drag.item.sprite)}
                draggable={false}
                alt=""
              />
              <span>{drag.stack.quantity}</span>
            </div>,
            document.body,
          )
        : null}
      {typeof document !== "undefined" && flight
        ? createPortal(
            <FlyingSprite
              key={flight.id}
              flight={flight}
              onFinish={finishFlight}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
