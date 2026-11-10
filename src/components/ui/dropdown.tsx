'use client';

import * as React from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

/**
 * Dropdown — the kit's own single-select for internal panels, ported 1:1
 * from the owner-approved static prototype (select-demo.html): replaces the
 * styled native select element. The trigger keeps today's select look plus its own
 * chevron SVG (the OS arrow disappears); the popup is a glass listbox
 * portalled to <body> and positioned fixed by the trigger rect, so it
 * escapes overflow-clipped panels. No animation by design (same precedent
 * as the comments dialog).
 *
 * Behavior (prototype contract, do not drift):
 *  - role=combobox trigger (aria-expanded/haspopup/controls) + role=listbox
 *    popup with role=option/aria-selected and aria-activedescendant binding;
 *  - Enter/Space/ArrowDown/ArrowUp open; when open, arrows move the active
 *    option (disabled ones are skipped), Home/End jump to the first/last
 *    enabled option, PageUp/PageDown page through;
 *  - Enter/Space choose and close, Esc closes without changing; Tab is left
 *    to the browser (no focus trap — the popup just closes);
 *  - clicking the trigger toggles; pointerdown outside closes without
 *    choosing; at most one popup per page — instances coordinate through a
 *    window CustomEvent;
 *  - the popup opens below the trigger, flips up when less than FLIP_THRESHOLD
 *    remains below, keeps a POPUP_GAP gap and at least the trigger width; it
 *    follows the trigger on resize/scroll while open and scrolls the active
 *    option into view with block:"nearest".
 */

export type DropdownOption<T> = {
  value: T;
  label: string;
  disabled?: boolean;
};

type DropdownProps<T extends string | number> = Omit<
  React.ComponentProps<"button">,
  "value" | "onChange"
> & {
  /** Current value; null means "no selection" — the placeholder shows. */
  value: T | null;
  /** Reports the chosen option's value; the popup closes itself. */
  onChange: (value: T) => void;
  /** Options in display order. */
  options: Array<DropdownOption<T>>;
  /** md — h-8 text-sm trigger with h-8 options; sm — h-7 [13px]/h-7. */
  size?: "md" | "sm";
  /** Shown on the trigger while value is null. */
  placeholder?: string;
};

/** Space between the trigger and the popup (demo: POPUP_GAP = 4). */
const POPUP_GAP = 4;
/** Below-space threshold that flips the popup upwards (demo: 256px). */
const FLIP_THRESHOLD = 256;
/** Hard scroll cap for the popup (demo: max-height 240px). */
const POPUP_MAX_HEIGHT = 240;

/** Window channel keeping at most one dropdown open per page: an instance
 *  announces itself on open; every other open instance closes in response. */
const OPEN_EVENT = "coop-field:dropdown-open";

function firstEnabled<T extends string | number>(options: Array<DropdownOption<T>>): number {
  return options.findIndex((o) => !o.disabled);
}

function lastEnabled<T extends string | number>(options: Array<DropdownOption<T>>): number {
  for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
  return -1;
}

/** Fixed placement by the trigger rect (demo position() verbatim): opens
 *  below, flips up when the space below drops under FLIP_THRESHOLD; the
 *  popup is at least as wide as the trigger and clamped into the viewport. */
function positionPopup(trigger: HTMLElement, popup: HTMLElement) {
  const rect = trigger.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  popup.style.minWidth = `${rect.width}px`;
  popup.style.maxWidth = `${Math.max(160, vw - 16)}px`;
  const below = vh - rect.bottom;
  if (below < FLIP_THRESHOLD) {
    popup.style.maxHeight = `${Math.max(120, Math.min(POPUP_MAX_HEIGHT, rect.top - POPUP_GAP - 8))}px`;
    const popupH = popup.offsetHeight;
    popup.style.top = `${Math.max(8, rect.top - popupH - POPUP_GAP)}px`;
  } else {
    popup.style.maxHeight = `${Math.min(POPUP_MAX_HEIGHT, Math.max(96, below - POPUP_GAP - 4))}px`;
    popup.style.top = `${rect.bottom + POPUP_GAP}px`;
  }
  popup.style.left = `${Math.max(8, Math.min(rect.left, vw - popup.offsetWidth - 8))}px`;
}

const TRIGGER_CLS =
  "flex w-full items-center justify-between gap-2 rounded-md border border-[var(--uk-border-strong)] bg-[var(--uk-panel-bg)] px-2 text-left text-sm text-[var(--uk-panel-text)] outline-none hover:border-[var(--uk-border-hover)] focus-visible:border-[var(--uk-border-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uk-focus-ring)] aria-expanded:border-[var(--uk-border-hover)] disabled:cursor-not-allowed disabled:opacity-50";

const POPUP_CLS =
  "fixed z-[60] max-h-60 overflow-y-auto overflow-x-hidden rounded-md border border-[var(--uk-border-strong)] bg-[var(--uk-panel-soft-bg)] p-1 text-[var(--uk-panel-soft-text)] shadow-lg backdrop-blur-[var(--uk-glass-blur)]";

const OPTION_CLS =
  "flex items-center gap-2 whitespace-nowrap rounded px-2 text-[13px] text-[var(--uk-panel-text)]";
const OPTION_ACTIVE_CLS = "bg-[var(--sim-hover)]";
const OPTION_SELECTED_CLS = "bg-[var(--uk-accent-soft-bg)] text-[var(--uk-accent-soft-text)]";
const OPTION_SELECTED_ACTIVE_CLS = "shadow-[inset_0_0_0_1px_var(--uk-border-hover)]";
const OPTION_DISABLED_CLS = "cursor-default text-[var(--uk-disabled-text)]";

function ChevronDownIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6.25 8 9.75 12 6.25" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  );
}

function Dropdown<T extends string | number>({
  value,
  onChange,
  options,
  size = "md",
  placeholder = "Выберите…",
  disabled = false,
  className,
  ...rest
}: DropdownProps<T>) {
  const [open, setOpen] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(-1);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popupRef = React.useRef<HTMLDivElement>(null);
  const optionRefs = React.useRef<Array<HTMLDivElement | null>>([]);
  const instanceId = React.useId();

  const popupId = `${instanceId}-listbox`;
  const optionId = (i: number) => `${instanceId}-opt-${i}`;

  const selectedIdx = value === null ? -1 : options.findIndex((o) => o.value === value);
  const selected = selectedIdx >= 0 ? options[selectedIdx] : null;

  const closeList = React.useCallback(() => {
    setOpen(false);
    setActiveIdx(-1);
  }, []);

  /* On open the active option is the selected one, or the first enabled. */
  const openList = React.useCallback(() => {
    if (disabled) return;
    setActiveIdx(selectedIdx >= 0 ? selectedIdx : firstEnabled(options));
    setOpen(true);
    /* one popup per page: everyone else open hears this and steps aside */
    window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { id: instanceId } }));
  }, [disabled, instanceId, options, selectedIdx]);

  React.useEffect(() => {
    if (!open) return;
    const onOtherOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string }>).detail;
      if (detail && detail.id !== instanceId) closeList();
    };
    window.addEventListener(OPEN_EVENT, onOtherOpen);
    return () => window.removeEventListener(OPEN_EVENT, onOtherOpen);
  }, [open, instanceId, closeList]);

  /* pointerdown outside the trigger and the popup closes without choosing */
  React.useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      closeList();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, closeList]);

  /* place the popup right after mount (before paint) and keep it glued to
     the trigger on any resize/scroll while open (capture: inner scrollers) */
  React.useLayoutEffect(() => {
    if (!open) return;
    const sync = () => {
      const trigger = triggerRef.current;
      const popup = popupRef.current;
      if (trigger && popup) positionPopup(trigger, popup);
    };
    sync();
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [open]);

  /* keep the active option in view, including right after opening */
  React.useLayoutEffect(() => {
    if (!open) return;
    optionRefs.current[activeIdx]?.scrollIntoView({ block: "nearest" });
  }, [open, activeIdx]);

  /* index of the next enabled option one step from `base` in direction
     `dir`, skipping disabled options; -1 when the edge is hit */
  const nextEnabled = (dir: 1 | -1, base: number): number => {
    let i = (base >= 0 ? base : dir > 0 ? -1 : options.length) + dir;
    while (i >= 0 && i < options.length) {
      if (!options[i].disabled) return i;
      i += dir;
    }
    return -1;
  };

  const pageMove = (dir: 1 | -1) => {
    /* one "page" ≈ visible rows minus the padding row (demo pageMove) */
    const optionH = optionRefs.current[0]?.offsetHeight || 32;
    const popupH = popupRef.current?.clientHeight ?? 96;
    const step = Math.max(1, Math.floor((popupH - 8) / optionH) - 1);
    let i = activeIdx;
    for (let s = 0; s < step; s++) {
      const next = nextEnabled(dir, i);
      if (next < 0) break;
      i = next;
    }
    if (i >= 0 && i !== activeIdx) setActiveIdx(i);
  };

  const choose = (i: number) => {
    const opt = options[i];
    if (!opt || opt.disabled) return;
    onChange(opt.value);
    closeList();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const key = e.key;
    if (!open) {
      if (key === "Enter" || key === " " || key === "ArrowDown" || key === "ArrowUp") {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (key) {
      case "ArrowDown": {
        e.preventDefault();
        const i = nextEnabled(1, activeIdx);
        if (i >= 0) setActiveIdx(i);
        break;
      }
      case "ArrowUp": {
        e.preventDefault();
        const i = nextEnabled(-1, activeIdx);
        if (i >= 0) setActiveIdx(i);
        break;
      }
      case "Home": {
        e.preventDefault();
        const i = firstEnabled(options);
        if (i >= 0) setActiveIdx(i);
        break;
      }
      case "End": {
        e.preventDefault();
        const i = lastEnabled(options);
        if (i >= 0) setActiveIdx(i);
        break;
      }
      case "PageDown":
        e.preventDefault();
        pageMove(1);
        break;
      case "PageUp":
        e.preventDefault();
        pageMove(-1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeIdx >= 0) choose(activeIdx);
        else closeList();
        break;
      case "Escape":
        e.preventDefault();
        closeList();
        break;
      case "Tab":
        /* no preventDefault — Tab keeps walking the page and closes us */
        closeList();
        break;
      default:
        break;
    }
  };

  const listboxLabel = rest["aria-label"];

  const popup = open ? (
    <div
      ref={popupRef}
      id={popupId}
      role="listbox"
      aria-label={listboxLabel}
      className={POPUP_CLS}
    >
      {options.map((opt, i) => {
        const isSelected = i === selectedIdx;
        const isActive = i === activeIdx;
        return (
          <div
            key={String(opt.value)}
            id={optionId(i)}
            ref={(el) => {
              optionRefs.current[i] = el;
            }}
            role="option"
            aria-selected={isSelected}
            aria-disabled={opt.disabled || undefined}
            className={cn(
              OPTION_CLS,
              size === "sm" ? "h-7" : "h-8",
              isSelected && OPTION_SELECTED_CLS,
              !isSelected && isActive && OPTION_ACTIVE_CLS,
              isSelected && isActive && OPTION_SELECTED_ACTIVE_CLS,
              opt.disabled && OPTION_DISABLED_CLS
            )}
            onMouseOver={() => {
              if (!opt.disabled) setActiveIdx(i);
            }}
            onClick={() => choose(i)}
          >
            <span className="min-w-0 flex-1 truncate">{opt.label}</span>
            <CheckIcon className={cn("h-3.5 w-3.5 shrink-0", !isSelected && "invisible")} />
          </div>
        );
      })}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        data-slot="dropdown"
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-activedescendant={open && activeIdx >= 0 ? optionId(activeIdx) : undefined}
        disabled={disabled}
        className={cn(TRIGGER_CLS, size === "sm" ? "h-7 text-[13px]" : "h-8", className)}
        {...rest}
        onClick={open ? closeList : openList}
        onKeyDown={onKeyDown}
      >
        <span
          className={cn("min-w-0 flex-1 truncate", !selected && "text-[var(--uk-muted-text)]")}
        >
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDownIcon className="h-4 w-4 shrink-0" />
      </button>
      {popup && createPortal(popup, document.body)}
    </>
  );
}

export { Dropdown };
