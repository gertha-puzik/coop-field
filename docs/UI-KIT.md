# UI Kit (`src/components/ui`)

Internal component + token foundation of the coop-field front. It is **not** a
separate package or a second design system: it is the *same* visual language
the game already speaks (glass panels, accent buttons, quiet chips), packaged
as semantic tokens + composable primitives.

**Scope note (owner decision, 2026-11-08):** the kit lives inside coop-field and
follows this repo's gates. Vue/other islands do not exist here; when a pattern
is shared between the simulator canvas chrome and the account pages, it belongs
in this directory, not copy-pasted.

---

## 1. The one import rule

`src/components/ui/index.ts` is the **only public surface**. Consumers import
from the barrel, never from the files behind it:

```tsx
// CORRECT
import { Button, Field, Input, Panel } from '@/components/ui';
// FORBIDDEN
import { Button } from '@/components/ui/button';
```

Why: internals may be split/merged/renamed without touching call sites, and
review has one place to check the public API.

## 2. Tokens (`tokens.css`), imported once from `src/app/globals.css`

Two layers exist in this repo, ONE palette:

- `--sim-*` — the live theme variables declared per `[data-theme='night'|'light'|'beer']`
  in `src/app/globals.css`. **They stay as they are** — all existing components
  keep working.
- `--uk-*` — semantic UI-kit tokens, declared **once** in `:root` as pure
  aliases over `--sim-*`. CSS custom properties resolve at computed-value time,
  and `data-theme` lives on `<html>`, so every theme switch repaints the whole
  tree exactly like the underlying `--sim-*` values. Theme switchers
  (`src/lib/sim/theme.ts`, compact selects, SiteHeader `ThemeSelect`) keep
  working with no wiring changes.

### Pair contract (grammar inherited from the stage-0 ui-kit audit)

A colour is only ever a **pair**: `--uk-<role>-bg` (surface) +
`--uk-<role>-text` (ink painted on that exact surface). The point: a theme that
changes a `-bg` must resupply a readable `-text`; "white on white" is
structurally impossible.

| Role | bg | text | Night alias (min AA ratio) |
| --- | --- | --- | --- |
| page | `--uk-page-bg` | `--uk-page-text` | app bg + `--sim-text` (≥14.8) |
| page-muted | `--uk-page-muted-bg` | `--uk-page-muted-text` | app + `--sim-text-muted` (≥6.3) |
| panel | `--uk-panel-bg` | `--uk-panel-text` | `--sim-panel` glass + `--sim-text` (≥15.4) |
| panel-soft | `--uk-panel-soft-bg` | `--uk-panel-soft-text` | `--sim-frame` + `--sim-text` (≥14.3) |
| inset | `--uk-inset-bg` | `--uk-inset-text` | `--sim-inset` + `--sim-text-soft` (≥11.6) |
| field | `--uk-field-bg` | `--uk-field-text` | `--sim-input-bg` + `--sim-text` (≥16.1) |
| accent (CTA) | `--uk-accent-bg` | `--uk-accent-text` | `--sim-accent` + near-black ink (≥5.6) |
| accent-soft | `--uk-accent-soft-bg` | `--uk-accent-soft-text` | `--sim-accent-tint` + `--sim-accent-text` (≥8.5) |
| muted | `--uk-muted-bg` | `--uk-muted-text` | `--sim-inset` + `--sim-text-muted` (≥6.7) |
| danger-soft | `--uk-danger-soft-bg` | `--uk-danger-soft-text` | `--sim-danger` wash + `--sim-danger` (≥5.4) |
| danger-strong | `--uk-danger-strong-bg` | `--uk-danger-strong-text` | solid red + near-white (≥4.9) |
| success-soft | `--uk-success-soft-bg` | `--uk-success-soft-text` | green wash + green ink (≥8.2) |
| disabled | `--uk-disabled-bg` | `--uk-disabled-text` | `--sim-inset-soft` + `--sim-text-faint` (exempt) |

Non-text scalars (borders, focus ring, scrim, radii): `--uk-border{,-strong,
-hover}`, `--uk-divider`, `--uk-focus-ring`, `--uk-scrim`, `--uk-radius{,
-field,-chip}`, `--uk-glass-blur`. WCAG 1.4.11 targets 3:1 for these
informationally; the historical `--sim-line` borders are the established
look and stay soft by design.

**Everything `--uk-*` resolves to `--sim-*` values** with exactly three
exceptions, each marked in `tokens.css`:
1. `--uk-accent-text` — ink ON the accent (the palette had the accent colour,
   never its ink; today's buttons used ad-hoc `text-black`);
2. success pairs — a semantic green absent from `--sim-*` (night accent is
   green, but beer accent is amber — success must not follow the accent);
3. `fix AA` steps in the **light** theme: soft-danger/soft-success ink one hue
   step darker so the pairs hold on milk-glass; night/beer stay pure aliases.

### WCAG

Night is the main (default) theme. Every TEXT pair ≥ **4.5:1** measured on
realistic compositions: glass panels over the three app-gradient points, fields,
tints over panels (checker: `node .hermes/cache/scratch/ui-kit-aa-check.mjs`,
palette values copied from `globals.css`). Night minimums are in the table
above; `disabled` is WCAG-exempt but kept readable. Light/beer minimums are
tracked informationally (light soft-pairs sit just under 4.5 on the very lightest
gradient point — accepted, existing look).

## 3. Public API

| Export | File | Purpose |
| --- | --- | --- |
| `Button`, `buttonVariants` | `button.tsx` | cva button; kit variants `primary` (accent pair) and `danger` (danger-strong pair) added additively over the stock base; sizes `sm/md/lg/icon` (`md` = default); `loading` prop → spinner + `disabled` + `aria-busy` |
| `Input` | `input.tsx` | stock styled input (unchanged) |
| `Select` | `select.tsx` | native styled `<select>` — minimal fallback where the OS control is fine; internal panels moved to `Dropdown` (2026-11-10) |
| `Dropdown` | `dropdown.tsx` | kit single-select replacing the native one: combobox trigger (today's select look + own chevron) + glass listbox portalled to `<body>`, positioned fixed by the trigger rect (flips up when short on space, escapes overflow-clipped panels); keyboard/ARIA per the owner-approved prototype — Enter/Space/arrows/Home/End/PgUp/PgDn, Esc, Tab closes, one open instance per page; data-driven options (`value`/`label`/`disabled`), sizes `md`/`sm`, `placeholder`; no animation by design |
| `Slider`, `Switch` | `slider.tsx`, `switch.tsx` | Radix wrappers (unchanged) |
| `Field` | `field.tsx` | label + ONE control + hint + error; auto-wires `htmlFor`, `aria-describedby` (incl. caller `describedBy`), `aria-invalid` on error |
| `Panel`, `panelVariants` | `panel.tsx` | glass surface `rounded-xl` + `--uk-panel-*` + explicit 6px blur; tones `default/soft/inset/muted`; `as="form"` renders a form panel |
| `Badge`, `badgeVariants` | `badge.tsx` | non-interactive status pill; tones `default/accent/success/danger`; `asChild` to wear it on any element |
| `Chip`, `chipVariants` | `chip.tsx` | interactive choice preset; tones `active` (accent pair) / `default` (quiet outline); sizes `sm/md` |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | `tabs.tsx` | ARIA tabs: arrow-key roving focus, Home/End, controlled or `defaultValue`; inactive content unmounts |
| `EmptyState` | `empty-state.tsx` | honest "nothing here" block: icon (aria-hidden) + title + hint + optional action |
| `LoadingState` | `loading-state.tsx` | inline busy row: `role="status"`, spinner freezes under `prefers-reduced-motion` |
| `Dialog` | `dialog.tsx` | accessible native modal: role/aria-modal, real focus trap, Escape/s scrim close, opener-focus restore, scroll lock — **no extra dependency** |
| `ConfirmDialog` | `confirm-dialog.tsx` | `Dialog` + title/description/two buttons; `danger` tone, `busy` blocks closing; the themed replacement target for raw `window.confirm` |
| `EditorShell` | `editor-shell.tsx` | root of the location-editor chrome. Paints class `uk-editor`, which reads `--ed-*` from `public/ui/editor-chrome.css` (the same file the KNS Paint bridge attaches). Slots are the existing editor children; the component does not restyle tools. Paint cannot import React, so it reuses the stylesheet, not the component |

## 4. Usage examples

```tsx
import { Badge, Button, Chip, ConfirmDialog, Field, Input, Panel } from '@/components/ui';

<Panel as="form" className="p-4" onSubmit={save}>
  <Field className="mt-3" label="Имя" htmlFor="my-name" hint="как вас будут звать"
         error={nameError} describedBy="form-status">
    <Input id="my-name" className="mt-1 h-8 text-sm" value={name} onChange={onName} />
  </Field>
  <Button type="submit" size="sm" variant="primary" className="h-8 text-xs" loading={busy}>
    Сохранить
  </Button>
</Panel>;

<Chip size="sm" tone={active ? 'active' : 'default'} onClick={pick}>0,5</Chip>
<Badge tone="success">онлайн</Badge>

<ConfirmDialog
  open={askReset}
  title="Сбросить настройки комнаты?"
  description="Комната вернётся к общим значениям."
  confirmLabel="Сбросить"
  danger
  busy={resetting}
  onConfirm={doReset}
  onCancel={closeAsk}
/>
```

## 5. Keyboard / motion / a11y rules

- Every interactive kit part is reachable by keyboard and paints
  `focus-visible` (token ring where new, the stock `<Button>` keeps its
  shadcn ring). Never remove focus styles from kit output.
- Non-interactive decorations that carry meaning must not: icons passed to
  `EmptyState` are aria-hidden, the meaning must live in the text.
- `prefers-reduced-motion`: spinners freeze (`motion-reduce:animate-none`),
  Dialog opens instantly by design. The global `.app-bg` hover-lift/pulse
  mechanics in `globals.css` already honour it — do not introduce new UA
  animations without a `motion-reduce:` branch.
- Visible UI strings stay human Russian (no internal codenames); machine
  contracts (`role`, `aria-*`, ids) stay latin/kebab.

## 6. Adding a new component — rules for AI agents

1. **Find first.** Grep `src/components` for the pattern you need — panel-like
   box? `Panel`. Small toggle? `Chip`. Error text under an input? `Field`.
   Status pill? `Badge`. Modal? `Dialog`/`ConfirmDialog`. Reuse what exists:
   the visual language stays one language.
2. **Extend second.** If an existing kit part covers 90% of your case, add a
   cva variant/tone/prop to it (additive, default unchanged) instead of
   a new file. Adding a variant to `Chip` beats creating `ToggleChip`.
3. **Never create the second one.** No `CustomButton`, no `GameModal`, no
   `AdminPanelButton`, no local `settings-input` — those names are exactly how
   the old god-files happened. If your case truly needs a new file: it goes in
   `src/components/ui/`, consumes ONLY `--uk-*`/`--sim-*` pairs (no raw hex for
   themeable roles), exports through `index.ts`, gets a row in §3 of this doc
   — in the same PR.
4. **Token discipline.** New colours enter as a PAIR (`-bg`/`-text`) in
   `tokens.css`, aliased to `--sim-*` unless the role is genuinely new (mark it
   `pair completion` / `fix AA` like the three documented exceptions). No new
   independent palette layer next to `--sim-*`.
5. **Migration discipline.** Moving a screen onto the kit is a PR-per-screen
   refactor that MUST keep the recognisable look: same radii, same glass, same
   chip metrics. The gauges are `npm run typecheck` + `npm run arch:check`
   (≤800 lines/module); re-run the AA checker when touching pairs.
6. **Do not deepen imports.** Consumers import the barrel only; internal files
   may compose each other (e.g. `ConfirmDialog` uses `Dialog`) — that is not a
   public API.

Cursor (owner update 2026-11-11): the original `lapka.svg` paths are reused
unchanged in `paw-cursor.svg` and `paw-cursor-small.svg`, with a fixed −20°
tilt around the pad. Shared CSS variables in `public/ui/editor-chrome.css`
keep hover/grab identical; the field uses the smaller paw without a reticle.
`PawCursor` only emits a bounded decorative left-click circular wave (disabled for
touch and reduced motion); it never rotates or reshapes the cursor or cancels input.

## 7. Drawbacks / accepted debts (honesty section)

- Kit `<Button>` keeps the shadcn base footprint for the ~20 existing call
  sites: its default focus stays the `--ring`-based shadcn look rather than
  `--uk-focus-ring`. Unifying it is a separate visual-decision wave — not
  silently in a refactor PR.
- `Dialog` restores opener focus optimistically; page-level unmount races
  (opener removed while dialog open) are not compensated — callers should pass
  stable openers.
- `Dropdown` has no option-group headers yet (the SettingsPanel dummy-sprite picker used to have native `<optgroup>` labels; its options are now a flat group-ordered list) — add a `groups` prop if a picker needs headers back.
- Light-theme soft pairs sit marginally under 4.5:1 on the very top gradient
  point (documented above); tightening means deviating from the live
  `--sim-danger` hue — owner's call, not a drive-by change.
