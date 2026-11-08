import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * LoadingState — inline busy placeholder ("Loading location…", tab refresh,
 * upload in progress). role="status" makes assistive tech announce it
 * politely; the spinner is aria-hidden and freezes for people who ask the
 * OS for reduced motion (no invented skeletons — the label is honest).
 */
export function LoadingState({
  label,
  className,
}: {
  /** Human text of what is being waited for. */
  label: React.ReactNode
  className?: string
}) {
  return (
    <div
      role="status"
      data-slot="loading-state"
      data-busy="true"
      className={cn(
        "flex items-center justify-center gap-2 rounded-[var(--uk-radius-field)] border border-[var(--uk-border)] bg-[var(--uk-inset-bg)] px-4 py-3 text-xs font-semibold text-[var(--uk-inset-text)]",
        className
      )}
    >
      <svg
        className="size-4 animate-spin motion-reduce:animate-none motion-reduce:opacity-60"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-90"
          d="M22 12a10 10 0 0 0-10-10"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />
      </svg>
      {label}
    </div>
  )
}
