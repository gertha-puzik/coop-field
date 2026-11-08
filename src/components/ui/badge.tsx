import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* Non-interactive status pill. Every tone is a full pair from tokens.css:
   changing a tone never leaves the ink unreadable. Use asChild to render the
   same look on a <button>/<a>; interactive choice presets are the Chip. */
const badgeVariants = cva(
  "inline-flex shrink-0 items-center gap-1 rounded border border-transparent px-2 py-0.5 text-[10px] font-semibold leading-none",
  {
    variants: {
      tone: {
        default:
          "border-[var(--uk-border)] bg-[var(--uk-muted-bg)] text-[var(--uk-muted-text)]",
        accent:
          "bg-[var(--uk-accent-soft-bg)] text-[var(--uk-accent-soft-text)]",
        success:
          "bg-[var(--uk-success-soft-bg)] text-[var(--uk-success-soft-text)]",
        danger:
          "bg-[var(--uk-danger-soft-bg)] text-[var(--uk-danger-soft-text)]",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  }
)

function Badge({
  className,
  tone,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & {
    asChild?: boolean
}) {
  const Comp = asChild ? Slot : "span"
  return (
    <Comp
      data-slot="badge"
      className={cn(badgeVariants({ tone, className }))}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
