"use client";

/**
 * Cursor paw with directional rotation and interaction states.
 *
 * An OS cursor cannot be rotated via CSS transform: the browser draws
 * the cursor image as-is. So at load we build rotated/styled variants of
 * the paw (public/lapka.svg) as inline SVG data-URLs:
 *   neutral — 16 rotations by 22.5°, quantised from mouse direction;
 *   hover   — paw with splayed claws (buttons/links), rotates together
 *             with neutral (same direction bucket);
 *   grab    — fingers squeezed to the pad (drag handles, hotspots);
 *   grabbing— squeezed paw, slightly tilted and darkened (while dragging);
 *   aim     — shrunken paw inside a 4-corner reticle, hotspot = pad
 *             center = the impact point (battle canvas).
 * A rotated variant shares the pivot with the static paw hotspot — the
 * pad center (16 22 in the 32px image): the paw "stands" under the
 * pointer while fingers point where the mouse is heading. After a short
 * idle the paw relaxes to neutral.
 *
 * Images live in CSS variables on <html>:
 *   --paw-cursor (neutral), --paw-cursor-hover, --paw-cursor-grab,
 *   --paw-cursor-grabbing, --paw-cursor-aim.
 * Cursor rules substitute them with a trailing generic keyword, e.g.
 *   cursor: var(--paw-cursor-grab, grab), grab;
 * Note: Chrome rejects an image-only cursor list (url + coords with no
 * trailing keyword), so every rule that uses these vars must end with a
 * generic (grab/crosshair/pointer/…). Until the vars are set, during SSR
 * and without JS the static /lapka.svg fallback stays in effect.
 */

import { useEffect } from "react";

const STEPS = 16; // rotation buckets, 22.5° each
const IDLE_MS = 400; // mouse idle — paw relaxes to neutral
const MIN_DISTANCE_PX = 2; // ignore sub-pixel hand jitter

// lapka.svg geometry: viewBox 100×100 drawn at 32px (scale 0.32), hotspot
// 16 22 points into the big pad center — rotate around it so the contact
// point of the paw never shifts.
const PIVOT_X = 50;
const PIVOT_Y = 68.75;
const PX_PER_UNIT = 0.32;

// Variant box: paw content spans ~58 units from the axis, half-box 64
// units leaves headroom for any rotation. Hotspot = image center (20 20
// at 41px).
const HALF_UNITS = 64;
const SIDE_PX = Math.round(HALF_UNITS * 2 * PX_PER_UNIT);
const HOT_PX = Math.round(HALF_UNITS * PX_PER_UNIT);

const VB = `${PIVOT_X - HALF_UNITS} ${PIVOT_Y - HALF_UNITS} ${HALF_UNITS * 2} ${HALF_UNITS * 2}`;

interface PawVariants {
  neutral: string[];
  hover: string[];
  grab: string;
  grabbing: string;
  aim: string;
}

/** wrap assembled art into a standalone svg document string */
function svgDoc(body: string, fill: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIDE_PX}" height="${SIDE_PX}" ` +
    `viewBox="${VB}" fill="${fill}">${body}</svg>`
  );
}

/** cursor value: image-only, `, keyword` tail is appended by CSS rules */
function cursorValue(body: string, fill: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svgDoc(body, fill))}") ${HOT_PX} ${HOT_PX}`;
}

const rotateShell = (angle: number, body: string) =>
  `<g transform="rotate(${angle} ${PIVOT_X} ${PIVOT_Y})">${body}</g>`;

/** one claw: small curved teardrop overlaid on a toe bin */
function claw(tx: number, ty: number, rot: number): string {
  return (
    `<g transform="translate(${tx} ${ty}) rotate(${rot})">` +
    `<path d="M -2.3 1.6 Q -3.0 -6.5 -1.0 -9.6 Q 0.2 -10.1 0.7 -8.6 Q 2.6 -4.8 2.6 1.6 Q 0.2 0.4 -2.3 1.6 Z"/></g>`
  );
}

/** squeeze a group towards a center: pressed-paw "fist" */
function squeeze(g: string, cx: number, cy: number, s: number, tx: number, ty: number): string {
  return (
    `<g transform="translate(${tx} ${ty}) translate(${cx} ${cy}) scale(${s}) ` +
    `translate(${-cx} ${-cy})">${g}</g>`
  );
}

/** Builds all state variants from lapka.svg: neutral/hover (16 buckets),
 *  grab/grabbing/aim (static images). */
async function buildPawVariants(): Promise<PawVariants> {
  const res = await fetch("/lapka.svg");
  if (!res.ok) throw new Error(`lapka fetch: ${res.status}`);
  const src = await res.text();
  const inner = src.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const fill = src.match(/\bfill="([^"]+)"/)?.[1] ?? "#fff6e8";

  const neutral: string[] = [];
  const hover: string[] = [];
  // claw tips sit just outside the four toe bins, angled outward
  const hoverArt =
    inner +
    claw(37.4, 15.2, -14) + claw(62.8, 15.0, 13) +
    claw(15.8, 41.5, -56) + claw(84.2, 40.5, 56);
  for (let i = 0; i < STEPS; i++) {
    const angle = (i * 360) / STEPS;
    neutral.push(cursorValue(rotateShell(angle, inner), fill));
    hover.push(cursorValue(rotateShell(angle, hoverArt), fill));
  }

  // grab/grabbing need the raw toe groups; fall back to neutral art when
  // the source structure is unexpected.
  const groups = inner.split(/(?=<g>)/).filter((s) => s.startsWith("<g>"));
  let fistBody = inner;
  if (groups.length === 5) {
    const [pad, b1, b2, b3, b4] = groups;
    fistBody =
      squeeze(pad, 50, 68.75, 1.1, 0, 0) +
      squeeze(b1, 36.9, 26.5, 0.74, 4.4, 14.1) +
      squeeze(b2, 63.4, 26.0, 0.74, -4.6, 14.3) +
      squeeze(b3, 23.4, 47.5, 0.78, 9.0, 7.0) +
      squeeze(b4, 77.5, 46.5, 0.78, -9.3, 7.3);
  }
  const grab = cursorValue(fistBody, fill);
  // grabbing: same fist, tilted 9° and slightly darkened
  const grabbing = cursorValue(rotateShell(9, fistBody), "#e5d9c0");

  // aim: paw scaled to the hotspot + 4-corner reticle around it
  const reticle: string[] = [];
  const corner = (cx: number, cy: number, dx: number, dy: number) => {
    const d = `M ${cx + dx} ${cy} L ${cx} ${cy} L ${cx} ${cy + dy}`;
    return `<path d="${d}" fill="none" stroke="${fill}" stroke-width="3.4" stroke-linecap="square"/>`;
  };
  reticle.push(corner(6, 24.75, 14, 14), corner(94, 24.75, -14, 14));
  reticle.push(corner(6, 112.75, 14, -14), corner(94, 112.75, -14, -14));
  const aimBody =
    `<g transform="translate(${PIVOT_X} ${PIVOT_Y}) scale(0.58) translate(${-PIVOT_X} ${-PIVOT_Y})">${inner}</g>` +
    reticle.join("");
  const aim = cursorValue(aimBody, fill);

  return { neutral, hover, grab, grabbing, aim };
}

export function PawCursor() {
  useEffect(() => {
    // prefers-reduced-motion: no cursor animation — static paw (CSS fallback) stays.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const root = document.documentElement;
    let variants: PawVariants | null = null;
    let applied = -1;
    let idleTimer: number | undefined;
    let lastX = 0;
    let lastY = 0;
    let hasLast = false;

    const apply = (bucket: number) => {
      if (!variants || bucket === applied) return;
      applied = bucket;
      root.style.setProperty("--paw-cursor", variants.neutral[bucket]);
      root.style.setProperty("--paw-cursor-hover", variants.hover[bucket]);
    };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerType === "touch") return; // no cursor on touch moves
      if (!hasLast) {
        lastX = ev.clientX;
        lastY = ev.clientY;
        hasLast = true;
        return;
      }
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      if (dx * dx + dy * dy < MIN_DISTANCE_PX * MIN_DISTANCE_PX) return;
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => apply(0), IDLE_MS);
      if (!variants) return;
      // 0° = paw up, 90° = right (screen Y axis looks down).
      const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
      const bucket = ((Math.round(deg / (360 / STEPS)) % STEPS) + STEPS) % STEPS;
      // pointermove is already frame-aligned — no extra rAF needed.
      apply(bucket);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    let cancelled = false;
    buildPawVariants()
      .then((v) => {
        if (cancelled) return;
        variants = v;
        applied = -1;
        apply(0);
        // static states live once set; rules fall back to system
        // grab/grabbing/crosshair while the vars are unset.
        root.style.setProperty("--paw-cursor-grab", v.grab);
        root.style.setProperty("--paw-cursor-grabbing", v.grabbing);
        root.style.setProperty("--paw-cursor-aim", v.aim);
      })
      .catch(() => {
        /* lapka fetch failed — keep the static cursor */
      });

    return () => {
      cancelled = true;
      window.removeEventListener("pointermove", onMove);
      window.clearTimeout(idleTimer);
      for (const name of [
        "--paw-cursor",
        "--paw-cursor-hover",
        "--paw-cursor-grab",
        "--paw-cursor-grabbing",
        "--paw-cursor-aim",
      ]) {
        root.style.removeProperty(name);
      }
    };
  }, []);
  return null;
}
