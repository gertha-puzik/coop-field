"use client";

import { useEffect } from "react";

/** The paw itself is a static CSS cursor, including before hydration.
 * Only a left click emits a short decorative wave; gameplay and the
 * browser context menu keep their existing pointer handlers.
 */
export function PawCursor() {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const waves = new Map<HTMLElement, { animation:Animation; timer:number }>();
    const remove = (wave: HTMLElement) => {
      const current=waves.get(wave);current?.animation.cancel();if(current)window.clearTimeout(current.timer);
      waves.delete(wave);
      wave.remove();
    };
    const onDown = (ev: PointerEvent) => {
      if (ev.button !== 0 || ev.pointerType === "touch" || reduced.matches) return;
      // Keep the decorative overlay bounded even during rapid clicking.
      if (waves.size >= 6) remove(waves.keys().next().value!);
      const wave = document.createElement("span");
      wave.className = "paw-click-wave";
      wave.setAttribute("aria-hidden", "true");
      wave.style.left = `${ev.clientX}px`;
      wave.style.top = `${ev.clientY}px`;
      document.body.appendChild(wave);
      const animation = wave.animate([
        { opacity: 0.38, transform: "translate(-50%, -50%) scale(0.35)" },
        { opacity: 0, transform: "translate(-50%, -50%) scale(1.35)" },
      ], { duration: 650, easing: "ease-out" });
      const timer=window.setTimeout(()=>remove(wave),700);
      waves.set(wave, {animation,timer});
      animation.onfinish = () => remove(wave);
    };
    window.addEventListener("pointerdown", onDown, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown);
      for (const wave of waves.keys()) remove(wave);
    };
  }, []);
  return null;
}
