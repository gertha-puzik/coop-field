import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Native styled <select> — the select look of the game (avatar editor, theme
 * picker): panel glass, strong border, no appearance-none tricks, the OS
 * keeps its own arrow. Styling matches the hand-rolled pattern exactly, plus
 * a keyboard focus ring (focus-visible only).
 */
function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "h-8 w-full rounded-md border border-[var(--uk-border-strong)] bg-[var(--uk-panel-bg)] px-2 text-sm text-[var(--uk-panel-text)] outline-none focus-visible:border-[var(--uk-border-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uk-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
}

export { Select }
