import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* Glass panel — the standard surface of the game UI. Mirrors the historical
   hand-rolled pattern `rounded-xl border border-[var(--sim-line-strong)]
   bg-[var(--sim-panel)]` exactly (via the --uk-* aliases), plus an EXPLICIT
   backdrop blur: the .app-bg hook in globals.css matched the old literal
   class string, so the kit carries its own 6px blur instead. */
const panelVariants = cva(
  "rounded-xl border border-[var(--uk-border-strong)] bg-[var(--uk-panel-bg)] text-[var(--uk-panel-text)] backdrop-blur-[6px] transition-colors",
  {
    variants: {
      tone: {
        default: "",
        /* stronger glass — overlays, dialogs, raised blocks */
        soft: "bg-[var(--uk-panel-soft-bg)] text-[var(--uk-panel-soft-text)]",
        /* recessed well inside a panel */
        inset: "border-[var(--uk-border)] bg-[var(--uk-inset-bg)] text-[var(--uk-inset-text)]",
        /* quiet block (muted pair) */
        muted: "bg-[var(--uk-muted-bg)] text-[var(--uk-muted-text)]",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  }
)

type PanelTag = "div" | "section" | "aside" | "form"

type PanelProps = React.ComponentPropsWithoutRef<"form"> &
  VariantProps<typeof panelVariants> & {
    /** Semantics of the rendered element; "form" is the usual auth shape. */
    as?: PanelTag
  }

function Panel({ className, tone, as = "div", ...props }: PanelProps) {
  /* Polymorphic tag: hidden behind ElementType so props from either HTML
     shape type-check against the union (runtime accepts both). */
  const Tag = as as React.ElementType
  return (
    <Tag
      data-slot="panel"
      className={cn(panelVariants({ tone, className }))}
      {...props}
    />
  )
}

export { Panel, panelVariants, type PanelProps }
