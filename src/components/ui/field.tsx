import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Field = label + control + hint + error, wired for screen readers.
 * Keeps the game's form DOM shape: the control stays NESTED inside the
 * <label> (as the auth panel does), the hint/error render as small spans.
 *
 * A11y contract (automatic, no caller effort):
 *  - label → `htmlFor` must point at the control id;
 *  - hint/error get their own ids and are linked into the control's
 *    aria-describedby (extra `describedBy` ids are merged in);
 *  - a non-empty error paints aria-invalid on the control.
 *
 * Field takes ONE control element as children and injects the props into it
 * via cloneElement. For exotic layouts (multiple controls) render the parts
 * yourself — do not fork a second field pattern.
 */
type FieldProps = {
  /** Visible label (human language — caller supplies it). */
  label: React.ReactNode
  /** Id of the control; also derives the hint/error ids. Must be unique. */
  htmlFor: string
  /** Small de-emphasized line under the control. */
  hint?: React.ReactNode
  /** Validation error; presence reads as aria-invalid + paints the line. */
  error?: string | null
  /** Extra aria-describedby ids to merge (e.g. a shared form status <p>). */
  describedBy?: string
  className?: string
  /** A single focusable control (Input/Select/textarea). */
  children: React.ReactElement
}

const mergeDescribedBy = (
  current: unknown,
  ...extra: Array<string | undefined>
): string | undefined => {
  const parts = [
    ...(typeof current === "string" && current ? [current] : []),
    ...extra.filter((x): x is string => Boolean(x)),
  ]
  return parts.length ? parts.join(" ") : undefined
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  describedBy,
  className,
  children,
}: FieldProps) {
  const hintId = `${htmlFor}-hint`
  const errorId = `${htmlFor}-error`

  const control =
    React.isValidElement(children)
      ? React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
          ...(mergeDescribedBy(describedBy, hint ? hintId : undefined, error ? errorId : undefined)
            ? {
                "aria-describedby": mergeDescribedBy(
                  (children.props as Record<string, unknown>)["aria-describedby"],
                  describedBy,
                  hint ? hintId : undefined,
                  error ? errorId : undefined
                ),
              }
            : {}),
          ...(error ? { "aria-invalid": true } : {}),
        } as Record<string, unknown>)
      : children

  return (
    <label
      className={cn("block text-[11px] text-[var(--uk-panel-muted-text)]", className)}
      htmlFor={htmlFor}
    >
      {label}
      {control}
      {hint ? (
        <span id={hintId} className="mt-0.5 block text-[10px] leading-snug">
          {hint}
        </span>
      ) : null}
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="mt-0.5 block text-[11px] font-semibold text-[var(--uk-danger-soft-text)]"
        >
          {error}
        </span>
      ) : null}
    </label>
  )
}
