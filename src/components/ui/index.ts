/**
 * coop-field UI kit — the ONLY public import surface (owner rule).
 *
 * Components, tokens and helpers live in their own files in this directory,
 * but every consumer imports from here:
 *
 *   import { Button, Field, Input } from '@/components/ui';   // CORRECT
 *   import { Button } from '@/components/ui/button';         // FORBIDDEN
 *
 * Rationale: this barrel is the versioned API — internals may be split or
 * merged without touching call sites, and the "find first, extend second,
 * never duplicate" rule has one place to point at. See docs/UI-KIT.md.
 */

export { Button, buttonVariants } from "./button";
export { Input } from "./input";
export { Select } from "./select";
export { Dropdown } from "./dropdown";
export { Slider } from "./slider";
export { Switch } from "./switch";
export { Field } from "./field";
export { Panel, panelVariants, type PanelProps } from "./panel";
export { Badge, badgeVariants } from "./badge";
export { Chip, chipVariants } from "./chip";
export { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
export { EmptyState } from "./empty-state";
export { LoadingState } from "./loading-state";
export { Dialog } from "./dialog";
export { ConfirmDialog } from "./confirm-dialog";
export { PawCursor } from "./paw-cursor";
export { EditorShell } from "./editor-shell";
