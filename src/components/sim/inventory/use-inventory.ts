"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  inventoryRequest,
  inventoryError,
  type InventorySnapshot,
  type InventorySlot,
} from "@/lib/net/http-inventory";
export function useInventory(
  characterId: string | undefined,
  catId?: number | null,
) {
  const [snapshot, setSnapshot] = useState<InventorySnapshot | null>(null),
    [busy, setBusy] = useState(false),
    [loadError, setLoadError] = useState(""),
    [actionError, setActionError] = useState("");
  const current = useRef(characterId),
    snapshotRef = useRef(snapshot),
    locked = useRef(false),
    requestSeq = useRef(0),
    loading = useRef(false);
  current.current = characterId;
  snapshotRef.current = snapshot;
  const refresh = useCallback(async () => {
    if (!characterId || locked.current || loading.current) return;
    loading.current = true;
    const seq = ++requestSeq.current;
    try {
      const row = await inventoryRequest<{ inventory: InventorySnapshot }>(
        "/cfg/inventory?characterId=" + encodeURIComponent(characterId),
      );
      if (current.current === characterId && requestSeq.current === seq) {
        setSnapshot((old) =>
          !old || row.inventory.version >= old.version ? row.inventory : old,
        );
        setLoadError("");
      }
    } catch (e) {
      if (current.current === characterId) setLoadError(inventoryError(e));
    } finally {
      loading.current = false;
    }
  }, [characterId]);
  useEffect(() => {
    setSnapshot(null);
    setLoadError("");
    setActionError("");
    void refresh();
    const id = setInterval(() => void refresh(), 3000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(id);
      requestSeq.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  const move = useCallback(
    async (from: InventorySlot, to?: InventorySlot, quick = false) => {
      const prior = snapshotRef.current;
      if (
        !prior ||
        !characterId ||
        prior.characterId !== characterId ||
        locked.current
      )
        return null;
      locked.current = true;
      setBusy(true);
      setActionError("");
      requestSeq.current++;
      try {
        const row = await inventoryRequest<{
          inventory: InventorySnapshot;
          target: InventorySlot;
        }>("/cfg/inventory/move", "POST", {
          characterId,
          version: prior.version,
          from,
          to,
          quick,
        });
        if (current.current !== characterId) return null;
        setSnapshot(row.inventory);
        return row.target;
      } catch (e) {
        if (current.current === characterId) setActionError(inventoryError(e));
        return null;
      } finally {
        locked.current = false;
        setBusy(false);
        void refresh();
      }
    },
    [characterId, refresh],
  );
  useEffect(() => {
    if (!actionError) return;
    const timer = setTimeout(() => setActionError(""), 4500);
    return () => clearTimeout(timer);
  }, [actionError]);
  const worldAction = useCallback(
    async (raw: Record<string, unknown>) => {
      const prior = snapshotRef.current;
      if (
        !characterId ||
        catId == null ||
        locked.current ||
        !prior ||
        prior.characterId !== characterId
      )
        return false;
      locked.current = true;
      setBusy(true);
      setActionError("");
      requestSeq.current++;
      try {
        const row = await inventoryRequest<{ inventory?: InventorySnapshot }>(
          "/cfg/inventory/world",
          "POST",
          { ...raw, characterId, catId, version: prior.version },
        );
        if (current.current !== characterId) return false;
        if (row.inventory) setSnapshot(row.inventory);
        return true;
      } catch (e) {
        if (current.current === characterId) setActionError(inventoryError(e));
        return false;
      } finally {
        locked.current = false;
        setBusy(false);
        void refresh();
        window.dispatchEvent(new Event("world-items:refresh"));
      }
    },
    [characterId, catId, refresh],
  );
  const consume = useCallback(async (from: InventorySlot, itemId: string) => {
    const prior = snapshotRef.current;
    if (!prior || !characterId || prior.characterId !== characterId || locked.current) return false;
    locked.current = true;
    setBusy(true);
    setActionError("");
    requestSeq.current++;
    try {
      const { inventory } = await inventoryRequest<{ inventory: InventorySnapshot }>(
        "/cfg/inventory/use", "POST", { characterId, version: prior.version, from, itemId },
      );
      if (current.current !== characterId) return false;
      setSnapshot(inventory);
      return true;
    } catch (error) {
      if (current.current === characterId) setActionError(inventoryError(error));
      return false;
    } finally {
      locked.current = false;
      setBusy(false);
      void refresh();
      window.dispatchEvent(new Event("player-stats:refresh"));
    }
  }, [characterId, refresh]);

  return {
    worldAction,
    consume,
    snapshot: snapshot?.characterId === characterId ? snapshot : null,
    busy,
    error: actionError || loadError,
    move,
    refresh,
  };
}
