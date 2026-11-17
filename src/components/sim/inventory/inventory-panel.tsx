"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/players/profile-icons";
import { createPortal } from "react-dom";
import { itemSprite, type InventorySlot } from "@/lib/net/http-inventory";
import { currentWorldItemFrame } from "@/lib/sim/world-item-frame";
import { useInventory } from "./use-inventory";
import s from "./inventory.module.css";
export type InventoryController = ReturnType<typeof useInventory>;
type Point = { x: number; y: number };
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
  const [flight, setFlight] = useState<Flight | null>(null),
    [landed, setLanded] = useState(""),
    [selectedBag, setSelectedBag] = useState<number | null>(null);
  const [carried, setCarried] = useState<{
    from: InventorySlot | "mouth";
    sprite: string;
    itemId: string;
    point: Point;
  } | null>(null);
  const carryRef = useRef(carried);
  carryRef.current = carried;
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (carryRef.current)
        setCarried((old) =>
          old ? { ...old, point: { x: e.clientX, y: e.clientY } } : null,
        );
    };
    const click = (e: MouseEvent) => {
      const value = carryRef.current;
      if (!value || e.button !== 0) return;
      const node = e.target instanceof Element ? e.target : null;
      if (node?.closest("button,input,textarea,a,nav,[data-world-drop-block]"))
        return;
      const valueFrame = currentWorldItemFrame();
      if (!valueFrame) return;
      const { rect } = valueFrame;
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      )
        return;
      e.preventDefault();
      e.stopImmediatePropagation();
      window.dispatchEvent(new Event("game-ui:pause-controls"));
      window.dispatchEvent(
        new CustomEvent("world-items:drop", {
          detail: {
            from: value.from,
            expectedItemId: value.itemId,
            x: e.clientX,
            y: e.clientY,
            onResult: (ok: boolean) => {
              if (ok) setCarried(null);
            },
          },
        }),
      );
    };
    const cancel = (e: KeyboardEvent) => {
      if (e.code === "Escape") setCarried(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("click", click, true);
    window.addEventListener("keydown", cancel, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("click", click, true);
      window.removeEventListener("keydown", cancel, true);
    };
  }, []);
  useEffect(() => setCarried(null), [snapshot?.characterId]);
  useEffect(() => {
    setCarried((old) =>
      old?.from === "mouth" && old.itemId !== snapshot?.mouth?.itemId
        ? null
        : old,
    );
  }, [snapshot?.mouth?.itemId]);
  const flightId = useRef(0),
    landingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    if (!target) return false;
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
    return true;
  }
  async function place(to: InventorySlot) {
    const held = carried;
    if (!held || busy) return;
    if (held.from === "mouth") {
      if (
        await controller.worldAction({
          action: "stash",
          to,
          expectedItemId: held.itemId,
        })
      )
        setCarried(null);
    } else {
      if (held.from.area === to.area && held.from.index === to.index) {
        setCarried(null);
        return;
      }
      if (await transfer(held.from, to, false, held.point)) setCarried(null);
    }
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
              ? `${item.name}${item.description ? `\n${item.description}` : ""}\nВес одной штуки: ${item.weight}\nShift + щелчок — перенести`
              : "Свободный слот"
          }
          onClick={(event) => {
            if (carried) {
              void place({ area, index });
              return;
            }
            if (area === "hotbar") onSelect(index);
            else setSelectedBag(index);
            if (!stack || !item?.sprite) return;
            if (event.shiftKey) {
              void transfer({ area, index }, undefined, true);
              return;
            }
            setCarried({
              from: { area, index },
              itemId: item.id,
              sprite: itemSprite(item.sprite),
              point: center(event.currentTarget),
            });
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
      {carried
        ? createPortal(
            <img
              className={s.flying}
              src={carried.sprite}
              style={{
                left: carried.point.x,
                top: carried.point.y,
                width: 32,
                height: 32,
                transform: "translate(-50%,-50%)",
              }}
              alt=""
            />,
            document.body,
          )
        : null}
      {open ? (
        <div
          className={s.backdrop}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !carried) onClose();
          }}
        >
          <section className={s.window} data-world-drop-block>
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
              ЛКМ — взять предмет, следующий ЛКМ — положить в слот или одну
              штуку на землю. Shift + ЛКМ — перенести стек. Escape — отменить.
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
        {snapshot?.mouth ? (
          <div className={s.mouthSlot}>
            <button
              type="button"
              disabled={busy}
              aria-label="Взять предмет из пасти для переноса в слот"
              onClick={(e) => {
                const item = snapshot.items.find(
                  (i) => i.id === snapshot.mouth?.itemId,
                );
                if (!item?.sprite) return;
                if (carried?.from === "mouth") {
                  setCarried(null);
                  return;
                }
                setCarried({
                  from: "mouth",
                  itemId: item.id,
                  sprite: itemSprite(item.sprite),
                  point: center(e.currentTarget),
                });
              }}
            >
              <img
                src={itemSprite(
                  snapshot.items.find((i) => i.id === snapshot.mouth?.itemId)
                    ?.sprite || "/items/nugget.png",
                )}
                alt="Предмет в пасти"
                draggable={false}
              />
            </button>
            <span>
              В пасти · ЛКМ — перенести в слот
              <br />R повторно — положить под себя
            </span>
          </div>
        ) : null}
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
