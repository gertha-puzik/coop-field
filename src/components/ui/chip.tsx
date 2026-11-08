import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* Interactive choice chip (toggle presets, filters, segmented choices).
   Visual identity is the game's SP-chip pattern: active = a flat accent
   pill with dark ink, inactive = an outlined quiet chip. Keyboard focus
   gets a token ring (focus-visible only — no visual change for mouse. */
const chipVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded font-semibold leading-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uk-focus-ring)] disabled:pointer-events-none disabled:bg-[var(--uk-disabled-bg)] disabled:text-[var(--uk-disabled-text)]",
  {
    variants: {
      tone: {
        active:
          "border border-transparent bg-[var(--uk-accent-bg)] px-2 text-[var(--uk-accent-text)] hover:bg-[var(--uk-accent-bg-hover)]",
        default:
          "border border-[var(--uk-border-strong)] bg-transparent px-2 text-[var(--uk-panel-text)] hover:border-[var(--uk-border-hover)]",
      },
      size: {
        sm: "h-6 text-[10px]",
        md: "h-7 px-2.5 text-[11px]",
      },
    },
    defaultVariants: {
      tone: "default",
      size: "sm",
    },
  }
)

function Chip({
  className,
  tone,
  size,
  type = "button",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof chipVariants>) {
  return (
    <button
      type={type}
      data-slot="chip"
      className={cn(chipVariants({ tone, size, className }))}
      {...props}
    />
  )
}

export { Chip, chipVariants }
