"use client";

import { useEffect, useState, type RefObject } from "react";
import { inventoryRequest } from "@/lib/net/http-inventory";
import type { PlayerStats } from "@/lib/net/player-stats";

export function usePlayerStats(canSprint: RefObject<boolean>, characterId?: string, catId?: number | null) {
  const [snapshot, setSnapshot] = useState<{ key: string; stats: PlayerStats } | null>(null);
  const key = characterId && catId != null ? `${characterId}:${catId}` : null;

  useEffect(() => {
    canSprint.current = false;
    if (!key || !characterId || catId == null) return;
    let active = true;
    let sequence = 0;
    let pending = false;
    const refresh = async (force = false) => {
      if (pending && !force) return;
      pending = true;
      const request = ++sequence;
      try {
        const args = new URLSearchParams({ characterId, catId: String(catId) });
        const { stats } = await inventoryRequest<{ stats: PlayerStats }>(`/cfg/inventory/stats?${args}`);
        if (active && sequence === request) {
          canSprint.current = stats.canSprint;
          setSnapshot({ key, stats });
        }
      } catch {
        // Preserve the last view during a transient disconnect.
      } finally {
        if (sequence === request) pending = false;
      }
    };
    const forceRefresh = () => void refresh(true);
    forceRefresh();
    const timer = setInterval(() => void refresh(), 3000);
    window.addEventListener("player-stats:refresh", forceRefresh);
    return () => {
      active = false;
      canSprint.current = false;
      clearInterval(timer);
      window.removeEventListener("player-stats:refresh", forceRefresh);
    };
  }, [canSprint, characterId, catId, key]);

  return snapshot?.key === key ? snapshot.stats : null;
}
