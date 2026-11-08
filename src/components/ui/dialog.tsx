"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Accessible modal dialog WITHOUT external libs: native <div role="dialog"
 * aria-modal> with complete focus management —
 *   - Escape and scrim click close (caller decides what that means);
 *   - Tab/Shift+Tab are trapped inside the dialog (real focus trap);
 *   - first Tab lands on the first focusable element;
 *   - focus is restored to the opener on close;
 *   - body scroll is locked while open.
 * No animation by design (prefers-reduced-motion safe out of the box).
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Dialog({
  open,
  onClose,
  labelledBy,
  describedBy,
  className,
  children,
}: {
  /** Renders only when true (unmount-on-close keeps the trap simple). */
  open: boolean
  /** Close request: Escape, scrim click. Caller maps it to its own state. */
  onClose: () => void
  labelledBy?: string
  describedBy?: string
  className?: string
  children?: React.ReactNode
}) {
  const surfaceRef = React.useRef<HTMLDivElement>(null)
  const restoreRef = React.useRef<HTMLElement | null>(null)

  React.useEffect(() => {
    if (!open) return
    restoreRef.current = document.activeElement as HTMLElement | null
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    const onKeyDown = (e: KeyboardEvent) => {
      const surface = surfaceRef.current
      if (!surface) return
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key !== "Tab") return
      const nodes = Array.from(
        surface.querySelectorAll<HTMLElement>(FOCUSABLE)
      ).filter((el) => el.offsetParent !== null)
      if (!nodes.length) {
        /* nothing focusable: keep focus on the surface itself */
        e.preventDefault()
        surface.focus()
        return
      }
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey) {
        if (!active || active === first || !surface.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (!active || active === last || !surface.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", onKeyDown, true)
    return () => {
      document.removeEventListener("keydown", onKeyDown, true)
      document.body.style.overflow = prevOverflow
      restoreRef.current?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      data-slot="dialog-root"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* scrim: click closes; inert for AT */}
      <div
        className="absolute inset-0 bg-[var(--uk-scrim)]"
        onClick={() => onClose()}
        aria-hidden="true"
      />
      <div
        ref={surfaceRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cn(
          "relative z-10 max-h-[85vh] w-full max-w-md overflow-y-auto rounded-xl border border-[var(--uk-border-strong)] bg-[var(--uk-panel-soft-bg)] p-4 text-[var(--uk-panel-soft-text)] shadow-lg outline-none backdrop-blur-[6px]",
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}
