import type { DummyConfig, SpriteId } from "@/lib/sim/settings";
import { SPRITES } from "@/lib/sim/settings";

export const PRODUCTION_WS = "wss://coop.89-232-184-77.sslip.io";
export const LOCAL_WS = "ws://localhost:3780";

export type CoopCat = {
  id: number;
  login?: string;
  color?: string;
  sprite?: string;
  x: number;
  y: number;
  deg?: number;
  size?: number;
};

export type CoopHandlers = {
  onYou?: (cat: CoopCat) => void;
  onField?: (field: { width?: number; height?: number; room?: string; cats?: CoopCat[] }) => void;
  onCat?: (cat: Partial<CoopCat> & { id: number }) => void;
  onInfo?: (text: string) => void;
  onNoplace?: () => void;
  onOpen?: () => void;
  onClose?: () => void;
};

function isLocalHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export function roomFromUrl(): string {
  if (typeof window === "undefined") return "demo";
  const params = new URLSearchParams(window.location.search);
  return (params.get("room") || "demo").trim() || "demo";
}

export function nameFromUrl(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  return (params.get("name") || params.get("login") || "").trim();
}

export function wsUrl(): string {
  if (typeof window === "undefined") return PRODUCTION_WS;
  const params = new URLSearchParams(window.location.search);
  const override = params.get("ws");
  if (override) return override;
  const { hostname, protocol, host } = window.location;
  if (isLocalHost(hostname)) {
    if (host.includes(":3780")) {
      return `${protocol === "https:" ? "wss:" : "ws:"}//${host}`;
    }
    return LOCAL_WS;
  }
  if (hostname === "coop.89-232-184-77.sslip.io") {
    return `wss://${host}`;
  }
  return PRODUCTION_WS;
}

export function spriteOf(cat: { id?: number; sprite?: string; login?: string }): SpriteId {
  const hit = SPRITES.find((sp) => sp.id === cat.sprite);
  if (hit) return hit.id;
  const n = Number(cat.id) || 0;
  return SPRITES[Math.abs(n) % SPRITES.length].id;
}

export function catToDummy(cat: CoopCat): DummyConfig {
  return {
    id: `p${cat.id}`,
    name: cat.login || `#${cat.id}`,
    sprite: spriteOf(cat),
    col: Math.max(0, (cat.x || 1) - 1),
    row: Math.max(0, (cat.y || 1) - 1),
    scale: 100,
    angle: Number.isFinite(Number(cat.deg)) ? Number(cat.deg) : 0,
    present: true,
  };
}

export function createCoopClient(handlers: CoopHandlers) {
  let ws: WebSocket | null = null;

  const emit = (event: string, payload?: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify([event, payload ?? {}]));
    }
  };

  const connect = (join: { room?: string; login?: string; sprite?: string }) => {
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      handlers.onOpen?.();
      emit("join", {
        room: join.room || "demo",
        login: join.login || "",
        sprite: join.sprite,
      });
    };
    ws.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      const [event, payload] = msg as [string, unknown];
      if (event === "you") handlers.onYou?.(payload as CoopCat);
      else if (event === "field") handlers.onField?.(payload as { width?: number; height?: number; room?: string; cats?: CoopCat[] });
      else if (event === "update cat" || event === "move") handlers.onCat?.(payload as CoopCat);
      else if (event === "info") handlers.onInfo?.(String(payload));
      else if (event === "noplace") handlers.onNoplace?.();
    };
    ws.onclose = () => handlers.onClose?.();
    ws.onerror = () => {
      /* onclose follows */
    };
  };

  return {
    emit,
    connect,
    close() {
      ws?.close();
      ws = null;
    },
    get ready() {
      return ws?.readyState === WebSocket.OPEN;
    },
  };
}
