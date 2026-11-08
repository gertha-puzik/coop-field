import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * EmptyState — honest "nothing here yet" block (empty catalog results, an
 * empty room list, an admin tab with zero rows). Decorative icon is aria-hidden;
 * the title/hint carry the meaning. `action` is for the way out (link/button).
 */
export function EmptyState({
  icon,
  title,
  hint,
  action,
  className,
}: {
  /** Decorative glyph (emoji/svg). Hidden from screen readers. */
  icon?: React.ReactNode
  /** Short honest statement (no made-up data). */
  title: React.ReactNode
  /** Secondary explanation, one line. */
  hint?: React.ReactNode
  /** Optional way out: a Button, a link, a reset action. */
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        "flex flex-col items-center gap-1 rounded-xl border border-dashed border-[var(--uk-border-strong)] bg-[var(--uk-inset-bg)] px-4 py-6 text-center",
        className
      )}
    >
      {icon ? (
        <span className="mb-1 text-2xl leading-none" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="m-0 text-sm font-semibold text-[var(--uk-panel-text)]">{title}</p>
      {hint ? (
        <p className="m-0 max-w-sm text-xs text-[var(--uk-panel-muted-text)]">{hint}</p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
