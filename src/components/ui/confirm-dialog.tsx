"use client"

import * as React from "react"

import { Dialog } from "./dialog"
import { Button } from "./button"

/**
 * ConfirmDialog — a modal question with explicit consequences, the reusable
 * replacement target for raw window.confirm (which cannot be themed, read by
 * AT consistently, or made non-blocking). Danger tone is for actions that
 * destroy data: the confirm button uses the danger-strong pair then.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Подтвердить",
  cancelLabel = "Отмена",
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
  className,
}: {
  open: boolean
  /** The question itself, in one line. */
  title: string
  /** What exactly will happen if confirmed — honest, no threats. */
  description?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive action: paints the confirm button with the danger pair. */
  danger?: boolean
  /** While true: confirm shows a spinner, closing is blocked. */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
  className?: string
}) {
  const id = React.useId()
  const titleId = `${id}-title`
  const bodyId = description ? `${id}-body` : undefined
  const noop = React.useCallback(() => {}, [])

  return (
    <Dialog
      open={open}
      onClose={busy ? noop : onCancel}
      labelledBy={titleId}
      describedBy={bodyId}
      className={className}
    >
      <h2 id={titleId} className="m-0 text-base font-bold text-[var(--uk-panel-soft-text)]">
        {title}
      </h2>
      {description ? (
        <p id={bodyId} className="mt-1 text-sm text-[var(--uk-panel-muted-text)]">
          {description}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={danger ? "danger" : "primary"}
          size="sm"
          onClick={onConfirm}
          loading={busy}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  )
}
