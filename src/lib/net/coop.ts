import type { DummyConfig, SpriteId } from "@/lib/sim/settings";
import { SPRITES } from "@/lib/sim/settings";
import { sanitizeTestMap, type TestMap } from "@/lib/sim/test-map";
// Протокол-реестр W3: имена событий (EV), guard-валидаторы и типы payload
// живут в ./protocol — вместе с каноном значений, который паритетит CI
// против server/protocol.js (см. scripts/test-protocol-parity.mjs).
import {
  EV,
  isCoopCat,
  isCoopFight,
  isCoopNoplace,
  type CoopAtmo,
  type CoopAtmoAnchor,
  type CoopCat,
  type CoopChatMessage,
  type CoopDummyPos,
  type CoopDummyState,
  type CoopFight,
  type CoopNoplace,
  type CoopRabHit,
  type CoopRabState,
  type CoopRefuse,
  type CoopRoomInfo,
} from "./protocol";

// Типы протокола переехали в ./protocol (W3); прежние потребители
// (simulator.tsx, entry-screen, room-picker, settings-panel) тянут их отсюда же.
export type {
  CoopAtmo,
  CoopAtmoAnchor,
  CoopCat,
  CoopChatMessage,
  CoopDummyPos,
  CoopDummyState,
  CoopFight,
  CoopNoplace,
  CoopRabHit,
  CoopRabState,
  CoopRefuse,
  CoopRoomInfo,
} from "./protocol";

export const PRODUCTION_WS = "wss://coop.89-232-184-77.sslip.io";
export const LOCAL_WS = "ws://localhost:3780";

/**
 * Постоянные комнаты: три «Пивных грота» и «Элизия Эйдес» — другой формат поля
 * (лужайка, переход и закуток нарисованной локации, свободная ходьба в мирном режиме).
 * id уходит на сервер (латиница — сервер нормализует коды комнат до [a-z0-9_-]),
 * title — то, что видят игроки. У «Элизии» id остаётся «test»: это протокольный код,
 * по нему сервер и клиент узнают формат поля.
 */
export const ROOMS = [
  { id: "grot-1", title: "Пивной грот №1" },
  { id: "grot-2", title: "Пивной грот №2" },
  { id: "grot-3", title: "Пивной грот №3" },
  { id: "test", title: "Элизия Эйдес" },
] as const;

/** Заголовок комнаты для интерфейса: у гротов — людское имя, у прочих — код. */
export function roomTitle(code: string): string {
  return ROOMS.find((r) => r.id === code)?.title ?? code;
}

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
    /** «test» — поле нового формата (лужайка/переход/закуток, камера, свободная ходьба). */
    format?: string;
    room?: string;
    cats?: CoopCat[];
    /** Конфиг локации «теста»: зоны с клетками и зелёные зоны (рисование поля, редактор). */
    map?: TestMap;
    /** Атмосфера комнаты: время суток и погода (общие для всех). */
    atmo?: CoopAtmoAnchor;
    /** Манекен «ПОЧУХАТЬ» комнаты: null — выключен. */
    dummy?: CoopDummyState | null;
    /** Боевая мишень «РАБ» комнаты: null — выключена. */
    rab?: CoopRabState | null;
  }) => void;
  /** Кто-то сохранил локацию «теста» в редакторе: сервер разослал новый конфиг всем в комнате. */
  onMap?: (map: TestMap) => void;
  onCat?: (cat: Partial<CoopCat> & { id: number }) => void;
  onFight?: (entry: CoopFight) => void;
  onChat?: (message: CoopChatMessage) => void;
  onChatLog?: (messages: CoopChatMessage[]) => void;
  onInfo?: (text: string) => void;
  onRefuse?: (refuse: CoopRefuse) => void;
  onNoplace?: (payload?: CoopNoplace) => void;
  /** Манекен включили/выключили или сменили спрайт (уходит и включившему). */
  onDummyState?: (state: CoopDummyState) => void;
  /** Кто-то другой тащит манекен — свежая позиция. */
  onDummyMove?: (pos: CoopDummyPos) => void;
  /** Кто-то взял манекен (имя тащщего — для курсора-обозначения). */
  onDummyGrab?: (info: { login: string }) => void;
  /** Манекен отпустили. */
  onDummyDrop?: () => void;
  /** Мишень РАБ включили/выключили (уходит и включившему). */
  onRabState?: (state: CoopRabState) => void;
  /** Кто-то другой ударил мишень РАБ — показать качание и урон (бьющему эхо не приходит). */
  onRabHit?: (info: CoopRabHit) => void;
  /** Атмосфера комнаты: якорь непрерывного цикла суток + погода (при входе —
   *  снапшот, при смене — рассылка всем, включая отправителя). */
  onAtmo?: (info: CoopAtmoAnchor) => void;
  /** Кто-то встал в блок / вышел из него (отправителю эхо не приходит). */
  onBlock?: (info: { id: number; on: boolean }) => void;
  /** Чужой кот присел на пробел / отпустил его (отправителю эхо не приходит).
   *  hold — сколько мс держал (для заряда «выстрела»), cancel — окно потеряло
   *  фокус: выстрела не будет, кот просто выпрямляется. */
  onSpace?: (info: { id: number; on: boolean; hold?: number; cancel?: boolean }) => void;
  /** Чужой кот идёт свободно (комната «тест», мирный режим): свежая позиция
   *  в клеточных долях мира; cx/cy — ближайшая клетка сервера (1-based).
   *  jp — кот в прыжке через обрыв: чужие клиенты рисуют дугу. */
  onFreeMove?: (m: { id: number; x: number; y: number; cx?: number; cy?: number; sp?: boolean; jp?: boolean }) => void;
  /** Состав комнат в ответ на requestRooms(): по запрошенным id, пустые — с нулями. */
  onRooms?: (rooms: CoopRoomInfo[]) => void;
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

/** Разбор позиции манекена: два конечных числа. */
function asDummyPos(payload: unknown): CoopDummyPos | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Partial<CoopDummyPos>;
  const x = Number(row.x);
  const y = Number(row.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** Разбор dummyState: флаг on, позиция, спрайт и имя тащщего. */
function asDummyState(payload: unknown): CoopDummyState | null {
  if (!payload || typeof payload !== "object") return null;
  const pos = asDummyPos(payload);
  if (!pos) return null;
  const row = payload as Partial<CoopDummyState>;
  return {
    ...pos,
    on: !!row.on,
    sprite: typeof row.sprite === "string" ? row.sprite : "",
    grab: typeof row.grab === "string" && row.grab ? row.grab : null,
  };
}

export function catToDummy(cat: CoopCat): DummyConfig {
  // Рост модельки, выбранный при спавне (сервер шлёт его в size, % высоты клетки).
  // Вне диапазона 60–100 (старый сервер со своим size: 3.2, отсутствие поля) — 100%.
  const rawScale = Math.round(Number(cat.size));
  const scale = Number.isFinite(rawScale) && rawScale >= 60 && rawScale <= 100 ? rawScale : 100;
  return {
    id: `p${cat.id}`,
    name: cat.login || `#${cat.id}`,
    sprite: spriteOf(cat),
    col: Math.max(0, (cat.x || 1) - 1),
    row: Math.max(0, (cat.y || 1) - 1),
    scale,
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
  let joinParams: { room?: string; login?: string; sprite?: string; size?: number } | null = null;
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
      // room пуст (экран выбора комнаты) — только слушаем: join не шлём.
      if (joinParams?.room) {
        emit(EV.JOIN, {
          room: joinParams.room,
          login: joinParams.login || "",
          sprite: joinParams.sprite,
          size: joinParams.size,
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
      if (event === EV.YOU) {
        // Канон-валидация вместо слепого каста: битый publicCat не попадает в стейт.
        if (isCoopCat(payload)) handlers.onYou?.(payload);
      } else if (event === EV.FIELD) handlers.onField?.(payload as { width?: number; height?: number; format?: string; room?: string; cats?: CoopCat[]; map?: TestMap; atmo?: CoopAtmoAnchor; dummy?: CoopDummyState | null; rab?: CoopRabState | null });
      else if (event === EV.MAP) {
        // Конфиг локации проходит ту же проверку, что и на сервере:
        // битый или чужой пакет просто игнорируется.
        const checked = sanitizeTestMap(payload);
        if (checked.map) handlers.onMap?.(checked.map);
      }
      else if (event === EV.UPDATE_CAT || event === EV.MOVE) {
        // «move» с сервера — двойной смысл (publicCat вошедшего | маркер выхода
        // x0/y0): оба проходят одну и ту же валидацию, различает потребитель.
        if (isCoopCat(payload)) handlers.onCat?.(payload);
      }
      else if (event === EV.FREEMOVE) {
        const row = payload as { id?: unknown; x?: unknown; y?: unknown; cx?: unknown; cy?: unknown; sp?: unknown; jp?: unknown } | null;
        if (row && typeof row === "object" && Number.isFinite(Number(row.id)) && Number.isFinite(Number(row.x)) && Number.isFinite(Number(row.y))) {
          handlers.onFreeMove?.({
            id: Number(row.id),
            x: Number(row.x),
            y: Number(row.y),
            cx: Number.isFinite(Number(row.cx)) ? Number(row.cx) : undefined,
            cy: Number.isFinite(Number(row.cy)) ? Number(row.cy) : undefined,
            sp: Number(row.sp) === 1,
            jp: Number(row.jp) === 1,
          });
        }
      }
      else if (event === EV.FIGHT) {
        // fight проверяется каноном (isCoopFight): адресаты и подписи лога обязательны.
        if (isCoopFight(payload)) handlers.onFight?.(payload);
      } else if (event === EV.CHAT) {
        const row = asChat(payload);
        if (row) handlers.onChat?.(row);
      } else if (event === EV.CHATLOG) {
        if (!Array.isArray(payload)) return;
        handlers.onChatLog?.(payload.map(asChat).filter((row): row is CoopChatMessage => row != null));
      } else if (event === EV.INFO) handlers.onInfo?.(String(payload));
      else if (event === EV.REFUSE) {
        const row = asRefuse(payload);
        if (row) handlers.onRefuse?.(row);
      } else if (event === EV.NOPLACE) {
        if (isCoopNoplace(payload)) handlers.onNoplace?.(payload);
      } else if (event === EV.DUMMY_STATE) {
        const row = asDummyState(payload);
        if (row) handlers.onDummyState?.(row);
      } else if (event === EV.DUMMY_MOVE) {
        const row = asDummyPos(payload);
        if (row) handlers.onDummyMove?.(row);
      } else if (event === EV.DUMMY_GRAB) {
        const login = (payload as { login?: unknown } | null)?.login;
        if (typeof login === "string") handlers.onDummyGrab?.({ login });
      } else if (event === EV.DUMMY_DROP) {
        handlers.onDummyDrop?.();
      } else if (event === EV.RAB_STATE) {
        const row = payload as { on?: unknown } | null;
        if (row && typeof row === "object") handlers.onRabState?.({ on: !!row.on });
      } else if (event === EV.RAB_HIT) {
        const row = payload as { zone?: unknown; part?: unknown; damage?: unknown } | null;
        if (row && typeof row === "object") {
          handlers.onRabHit?.({
            zone: typeof row.zone === "string" ? row.zone : "",
            part: typeof row.part === "string" ? row.part : "",
            damage: Number.isFinite(Number(row.damage)) ? Number(row.damage) : 0,
          });
        }
      } else if (event === EV.BLOCK) {
        const row = payload as { id?: unknown; on?: unknown } | null;
        if (row && typeof row === "object" && Number.isInteger(Number(row.id))) {
          handlers.onBlock?.({ id: Number(row.id), on: !!row.on });
        }
      } else if (event === EV.SPACE) {
        const row = payload as { id?: unknown; on?: unknown; hold?: unknown; cancel?: unknown } | null;
        if (row && typeof row === "object" && Number.isInteger(Number(row.id))) {
          handlers.onSpace?.({
            id: Number(row.id),
            on: !!row.on,
            hold: Number.isFinite(Number(row.hold)) ? Number(row.hold) : undefined,
            cancel: !!row.cancel,
          });
        }
      } else if (event === EV.ATMO) {
        const row = payload as { dp?: unknown; w?: unknown; t?: unknown; cs?: unknown; pl?: unknown; wl?: unknown; ws?: unknown } | null;
        if (row && typeof row === "object") {
          const dp = row.dp;
          const w = row.w;
          if (
            (dp === 'morning' || dp === 'day' || dp === 'evening' || dp === 'night') &&
            (w === 'sun' || w === 'cloud' || w === 'rain')
          ) {
            // Числа якоря обязательны конечные; без них (старый сервер) — якорь
            // собирается на месте: середина заявленной части суток, локальные темпы.
            const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
            const now = Date.now();
            const DAY_MS = 60_000;
            const pl = num(row.pl);
            const phaseMs = pl >= DAY_MS && pl <= 120 * DAY_MS ? pl : 7 * DAY_MS;
            const idx = dp === 'morning' ? 0 : dp === 'day' ? 1 : dp === 'evening' ? 2 : 3;
            const cs = num(row.cs);
            const t = num(row.t);
            const wl = num(row.wl);
            const ws = num(row.ws);
            handlers.onAtmo?.({
              dp,
              w,
              t: Number.isFinite(t) ? t : now,
              cs: Number.isFinite(cs) ? cs : now - (idx + 0.5) * phaseMs,
              pl: phaseMs,
              wl: Number.isFinite(wl) && wl >= DAY_MS && wl <= 240 * DAY_MS ? wl : 12 * DAY_MS,
              ws: Number.isFinite(ws) ? ws : now,
            });
          }
        }
      } else if (event === EV.ROOMSINFO) {
        if (!Array.isArray(payload)) return;
        const list: CoopRoomInfo[] = [];
        for (const raw of payload) {
          const row = raw as Partial<CoopRoomInfo> | null;
          if (!row || typeof row.id !== "string" || !row.id) continue;
          list.push({
            id: row.id,
            count: Math.max(0, Math.round(Number(row.count) || 0)),
            logins: Array.isArray(row.logins)
              ? row.logins.filter((x): x is string => typeof x === "string")
              : [],
          });
        }
        handlers.onRooms?.(list);
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

  const connect = (join: { room?: string; login?: string; sprite?: string; size?: number } | null) => {
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

  /**
   * Зайти в комнату (первый вход или переход с той же связи): обновляет параметры
   * переподключения и шлёт join сразу, если сокет открыт — сервер сам выведет кота
   * из прежней комнаты и заведёт в новую. Новое соединение поднимаем, только если
   * связи нет вовсе (или она доживает — тогда дождёмся open и уйдём join-ом оттуда).
   */
  const joinRoom = (join: { room?: string; login?: string; sprite?: string; size?: number }) => {
    joinParams = join;
    manualClose = false;
    clearReconnect();
    if (ws) {
      if (ws.readyState === WebSocket.OPEN) {
        attempt = 0;
        emit(EV.JOIN, { room: join.room || "demo", login: join.login || "", sprite: join.sprite, size: join.size });
        return;
      }
      if (ws.readyState === WebSocket.CONNECTING) return; // open пошлёт join уже с новыми параметрами
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

  /** Состав комнат для экрана выбора: сервер ответит roomsinfo по этим id. */
  const requestRooms = (ids: string[]) => {
    emit(EV.ROOMS, { ids });
  };

  return {
    emit,
    connect,
    joinRoom,
    requestRooms,
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
