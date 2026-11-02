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

/** Боевой лог комнаты. name / part / weapon / isAttacking — как в журнале удара. */
export type CoopFight = {
  attackerId: number;
  attacker: string;
  targetId: number;
  name: string;
  part: string;
  zone: string;
  weapon?: string;
  damage?: number;
  /** true только на сокете бьющего. Зритель смотрит на attacker и name. */
  isAttacking?: boolean;
};

export type CoopNoplace = {
  room?: string;
  reason?: string;
};

/** Позиция общей мишени комнаты в клеточных долях (0 — левый верх спрайта). */
export type CoopTargetPos = { x: number; y: number };

/** Состояние общей мишени: включена/выключена, координаты при включении. */
export type CoopTargetState = CoopTargetPos & { on: boolean };

/** Строка чата комнаты. id — кот, который написал. seq уникален в комнате. */
export type CoopChatMessage = {
  seq: number;
  id: number;
  login: string;
  color?: string;
  text: string;
  ts: number;
};

/** Структурированный отказ сервера: код вместо разбора русского текста info. */
export type CoopRefuse = {
  code?: string;
  text?: string;
};

/** Информация о закрытии сокета: retrying = клиент сам переподключается. */
export type CoopCloseInfo = {
  retrying: boolean;
  /** Порядковый номер следующей попытки (для подписи в статусе). */
  attempt: number;
};

export type CoopHandlers = {
  onYou?: (cat: CoopCat) => void;
  onField?: (field: {
    width?: number;
    height?: number;
    room?: string;
    cats?: CoopCat[];
    /** Общая мишень комнаты: null — выключена. */
    target?: CoopTargetPos | null;
  }) => void;
  onCat?: (cat: Partial<CoopCat> & { id: number }) => void;
  onFight?: (entry: CoopFight) => void;
  onChat?: (message: CoopChatMessage) => void;
  onChatLog?: (messages: CoopChatMessage[]) => void;
  onInfo?: (text: string) => void;
  onRefuse?: (refuse: CoopRefuse) => void;
  onNoplace?: (payload?: CoopNoplace) => void;
  /** Мишень включили/выключили (уходит и включившему). */
  onTargetState?: (state: CoopTargetState) => void;
  /** Кто-то другой тащит мишень — свежая позиция. */
  onTargetMove?: (pos: CoopTargetPos) => void;
  onOpen?: () => void;
  onClose?: (info: CoopCloseInfo) => void;
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
  const { hostname, protocol, host } = window.location;
  // ?ws= — только для локальной отладки и только со страниц localhost.
  // В продакшене произвольный адрес запрещён: ссылка вида
  // ?ws=wss://attacker.example иначе уводила бы сокет и логин на чужой сервер.
  const override = params.get("ws");
  if (override && isLocalHost(hostname)) {
    try {
      const parsed = new URL(override);
      if (parsed.protocol === "ws:" || parsed.protocol === "wss:") return override;
    } catch {
      /* некорректный адрес игнорируем, дальше — обычный выбор сокета */
    }
  }
  if (isLocalHost(hostname)) {
    if (host.includes(":3780")) {
      return `${protocol === "https:" ? "wss:" : "ws:"}//${host}`;
    }
    return LOCAL_WS;
  }
  if (hostname === "coop.89-232-184-77.sslip.io") {
    return `wss://${host}`;
  }
  // abnocw.89-232-184-77.sslip.io и vercel.app ходят на сокет комнаты,
  // а не на wss своего имени. Локальный хост разобран выше.
  return PRODUCTION_WS;
}

export function spriteOf(cat: { id?: number; sprite?: string; login?: string }): SpriteId {
  const hit = SPRITES.find((sp) => sp.id === cat.sprite);
  if (hit) return hit.id;
  const n = Number(cat.id) || 0;
  return SPRITES[Math.abs(n) % SPRITES.length].id;
}

function asChat(payload: unknown): CoopChatMessage | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Partial<CoopChatMessage>;
  if (typeof row.text !== "string" || !row.text) return null;
  if (typeof row.seq !== "number" || typeof row.id !== "number") return null;
  return {
    seq: row.seq,
    id: row.id,
    login: typeof row.login === "string" ? row.login : "",
    color: typeof row.color === "string" ? row.color : undefined,
    text: row.text,
    ts: typeof row.ts === "number" ? row.ts : Date.now(),
  };
}

function asRefuse(payload: unknown): CoopRefuse | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Partial<CoopRefuse>;
  if (typeof row.code !== "string" && typeof row.text !== "string") return null;
  return {
    code: typeof row.code === "string" ? row.code : undefined,
    text: typeof row.text === "string" ? row.text : undefined,
  };
}

/** Разбор позиции мишени: два конечных числа. */
function asTargetPos(payload: unknown): CoopTargetPos | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Partial<CoopTargetPos>;
  const x = Number(row.x);
  const y = Number(row.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Разбор targetState: флаг on плюс позиция. */
function asTargetState(payload: unknown): CoopTargetState | null {
  if (!payload || typeof payload !== "object") return null;
  const pos = asTargetPos(payload);
  if (!pos) return null;
  return { ...pos, on: !!(payload as { on?: unknown }).on };
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
    // Чужой кот — не локальная мишень: рисуем всегда, флаг по сети не шлём.
    visible: true,
  };
}

/** Пауза до первого переподключения. */
const RECONNECT_BASE_MS = 1000;
/** Потолок паузы между попытками. */
const RECONNECT_MAX_MS = 30_000;

export function createCoopClient(handlers: CoopHandlers) {
  let ws: WebSocket | null = null;
  let joinParams: { room?: string; login?: string; sprite?: string } | null = null;
  let manualClose = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = (event: string, payload?: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify([event, payload ?? {}]));
    }
  };

  const clearReconnect = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  /**
   * Экспоненциальный backoff с джиттером: 1–2–4–8–16–30 с, случайный разброс ±25%
   * развозит одновременные переподключения целой комнаты после общего обрыва.
   */
  const scheduleReconnect = () => {
    if (manualClose || !joinParams) return;
    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.min(attempt, 5));
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    attempt += 1;
    clearReconnect();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSocket();
    }, delay);
  };

  const detach = (sock: WebSocket) => {
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
  };

  const openSocket = () => {
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      attempt = 0;
      handlers.onOpen?.();
      // Каждый успешный open — повторный join теми же параметрами:
      // сервер вернёт you/field и клиент догонит состояние комнаты.
      if (joinParams) {
        emit("join", {
          room: joinParams.room || "demo",
          login: joinParams.login || "",
          sprite: joinParams.sprite,
        });
      }
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
      else if (event === "field") handlers.onField?.(payload as { width?: number; height?: number; room?: string; cats?: CoopCat[]; target?: CoopTargetPos | null });
      else if (event === "update cat" || event === "move") handlers.onCat?.(payload as CoopCat);
      else if (event === "fight") handlers.onFight?.(payload as CoopFight);
      else if (event === "chat") {
        const row = asChat(payload);
        if (row) handlers.onChat?.(row);
      } else if (event === "chatlog") {
        if (!Array.isArray(payload)) return;
        handlers.onChatLog?.(payload.map(asChat).filter((row): row is CoopChatMessage => row != null));
      } else if (event === "info") handlers.onInfo?.(String(payload));
      else if (event === "refuse") {
        const row = asRefuse(payload);
        if (row) handlers.onRefuse?.(row);
      } else if (event === "noplace") handlers.onNoplace?.(payload as CoopNoplace);
      else if (event === "targetState") {
        const row = asTargetState(payload);
        if (row) handlers.onTargetState?.(row);
      } else if (event === "targetMove") {
        const row = asTargetPos(payload);
        if (row) handlers.onTargetMove?.(row);
      }
    };
    ws.onclose = () => {
      ws = null;
      handlers.onClose?.({ retrying: !manualClose && !!joinParams, attempt: attempt + 1 });
      scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  };

  const connect = (join: { room?: string; login?: string; sprite?: string }) => {
    joinParams = join;
    manualClose = false;
    clearReconnect();
    if (ws) {
      detach(ws);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      ws = null;
    }
    openSocket();
  };

  return {
    emit,
    connect,
    close() {
      manualClose = true;
      clearReconnect();
      if (ws) {
        detach(ws);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      }
      ws = null;
    },
    get ready() {
      return ws?.readyState === WebSocket.OPEN;
    },
  };
}
