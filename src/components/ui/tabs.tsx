"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Accessible tabs (WAI-ARIA pattern): tablist + controlled value + arrow-key
 * roving focus + Home/End. Controlled AND uncontrolled use both supported:
 * pass `value` + `onValueChange` for a controlled panel, or just
 * `defaultValue`. Unselected content unmounts (keeps CSP/DCE auditing of the
 * existing panels straightforward — nothing hidden in the DOM).
 */

type TabsContextValue = {
  value: string
  setValue: (v: string) => void
  baseId: string
}

const TabsContext = React.createContext<TabsContextValue | null>(null)
const useTabs = (): TabsContextValue => {
  const ctx = React.useContext(TabsContext)
  if (!ctx) throw new Error("Tabs parts must render inside <Tabs>")
  return ctx
}

function Tabs({
  value,
  defaultValue,
  onValueChange,
  className,
  children,
  ...props
}: {
  value?: string
  defaultValue?: string
  onValueChange?: (v: string) => void
  className?: string
  children: React.ReactNode
} & Omit<React.ComponentProps<"div">, "onChange" | "children">) {
  const [inner, setInner] = React.useState(defaultValue ?? "")
  const current = value ?? inner
  const baseId = React.useId()
  const setValue = React.useCallback(
    (v: string) => {
      if (value === undefined) setInner(v)
      onValueChange?.(v)
    },
    [value, onValueChange]
  )
  return (
    <TabsContext.Provider value={{ value: current, setValue, baseId }}>
      <div data-slot="tabs" className={cn("flex flex-col gap-2", className)} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  )
}

function TabsList({
  className,
  onKeyDown,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const { setValue } = useTabs()

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e)
    const list = ref.current
    if (!list) return
    const tabs = Array.from(
      list.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')
    )
    if (!tabs.length) return
    const index = tabs.indexOf(document.activeElement as HTMLElement)

    let next: number | null = null
    if (e.key === "ArrowRight") next = index < 0 ? 0 : (index + 1) % tabs.length
    else if (e.key === "ArrowLeft")
      next = index < 0 ? tabs.length - 1 : (index - 1 + tabs.length) % tabs.length
    else if (e.key === "Home") next = 0
    else if (e.key === "End") next = tabs.length - 1
    else return

    e.preventDefault()
    const target = tabs[next]
    target?.focus()
    if (target instanceof HTMLButtonElement) setValue(target.dataset.value ?? "")
  }

  return (
    <div
      ref={ref}
      role="tablist"
      onKeyDown={handleKeyDown}
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--uk-radius-field)] border border-[var(--uk-border)] bg-[var(--uk-inset-bg)] p-1",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function TabsTrigger({
  value,
  className,
  children,
  ...props
}: { value: string } & React.ComponentProps<"button">) {
  const { value: current, setValue, baseId } = useTabs()
  const selected = current === value
  return (
    <button
      type="button"
      role="tab"
      data-slot="tabs-trigger"
      data-value={value}
      data-state={selected ? "active" : "inactive"}
      id={`${baseId}-tab-${value}`}
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      onClick={() => setValue(value)}
      className={cn(
        "h-7 shrink-0 rounded bg-transparent px-3 text-xs font-semibold leading-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--uk-focus-ring)] disabled:pointer-events-none disabled:text-[var(--uk-disabled-text)]",
        "text-[var(--uk-panel-muted-text)] hover:text-[var(--uk-panel-text)] data-[state=active]:bg-[var(--uk-accent-bg)] data-[state=active]:text-[var(--uk-accent-text)]",
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

function TabsContent({
  value,
  className,
  children,
  ...props
}: { value: string } & React.ComponentProps<"div">) {
  const { value: current, baseId } = useTabs()
  if (current !== value) return null
  return (
    <div
      role="tabpanel"
      data-slot="tabs-content"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      tabIndex={0}
      className={cn("outline-none", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, type TabsContextValue }
