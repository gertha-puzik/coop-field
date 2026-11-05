import type { DummyConfig, SpriteId, DayPart, WeatherKind } from "@/lib/sim/settings";
import { SPRITES } from "@/lib/sim/settings";
import { sanitizeTestMap, type TestMap } from "@/lib/sim/test-map";

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

/** Состав одной комнаты для выбора: сколько игроков и кто именно. */
export type CoopRoomInfo = { id: string; count: number; logins: string[] };

/** Атмосфера комнаты: время суток + погода. Общая для всех игроков; хранится на
 *  сервере, меняется событиями «atmo» (перемотка) и «atmoset» (длительности),
 *  новичкам уходит в снапшоте field. */
export type CoopAtmo = { dp: DayPart; w: WeatherKind };

/** Якорь атмосферы — серверные часы непрерывного цикла суток и погоды. Клиент
 *  считает позицию суток сам по своим часам (dayProgressAt), погода живёт
 *  дискретно: w — текущая, ws — момент её начала, wl — интервал смены.
 *  t — момент снимка (серверные Date.now()); cs — начало текущего цикла суток;
 *  pl — длительность одной части суток; dp — часть суток на момент t (для
 *  логов и старых клиентов). */
export type CoopAtmoAnchor = CoopAtmo & {
  t: number;
  cs: number;
  pl: number;
  wl: number;
  ws: number;
};

export type CoopCat = {
  id: number;
  login?: string;
  color?: string;
  sprite?: string;
  x: number;
  y: number;
  deg?: number;
  size?: number;
  /** Кот держит блок (удержание К): любые удары по нему проводятся в «Лапы». */
  blocking?: boolean;
  /** Кот держит пробел (присед-желе): 1 — рисуем приплющивание/выстрел. */
  sq?: number;
  /** Комната «тест»: 1 — кот в свободной ходьбе (fx/fy — позиция в клеточных долях),
   *  0/нет — кот ходит по клеткам. */
  fm?: number;
  fx?: number;
  fy?: number;
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

/** Позиция общего предмета комнаты (манекен «ПОЧУХАТЬ») в клеточных долях (0 — левый верх спрайта). */
export type CoopDummyPos = { x: number; y: number };

/** Состояние манекена комнаты: включён/выключен, координаты, спрайт и кто его тащит. */
export type CoopDummyState = CoopDummyPos & { on: boolean; sprite: string; grab?: string | null };

/** Состояние боевой мишени «РАБ»: включена/выключена (позиция фиксирована). */
export type CoopRabState = { on: boolean };

/** Чужой удар по мишени РАБ: зона/название полосы и урон для всплывающей подписи и качания «желе». */
export type CoopRabHit = { zone: string; part: string; damage: number };

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
        emit("join", {
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
      if (event === "you") handlers.onYou?.(payload as CoopCat);
      else if (event === "field") handlers.onField?.(payload as { width?: number; height?: number; format?: string; room?: string; cats?: CoopCat[]; map?: TestMap; atmo?: CoopAtmoAnchor; dummy?: CoopDummyState | null; rab?: CoopRabState | null });
      else if (event === "map") {
        // Конфиг локации проходит ту же проверку, что и на сервере:
        // битый или чужой пакет просто игнорируется.
        const checked = sanitizeTestMap(payload);
        if (checked.map) handlers.onMap?.(checked.map);
      }
      else if (event === "update cat" || event === "move") handlers.onCat?.(payload as CoopCat);
      else if (event === "freemove") {
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
      else if (event === "dummyState") {
        const row = asDummyState(payload);
        if (row) handlers.onDummyState?.(row);
      } else if (event === "dummyMove") {
        const row = asDummyPos(payload);
        if (row) handlers.onDummyMove?.(row);
      } else if (event === "dummyGrab") {
        const login = (payload as { login?: unknown } | null)?.login;
        if (typeof login === "string") handlers.onDummyGrab?.({ login });
      } else if (event === "dummyDrop") {
        handlers.onDummyDrop?.();
      } else if (event === "rabState") {
        const row = payload as { on?: unknown } | null;
        if (row && typeof row === "object") handlers.onRabState?.({ on: !!row.on });
      } else if (event === "rabHit") {
        const row = payload as { zone?: unknown; part?: unknown; damage?: unknown } | null;
        if (row && typeof row === "object") {
          handlers.onRabHit?.({
            zone: typeof row.zone === "string" ? row.zone : "",
            part: typeof row.part === "string" ? row.part : "",
            damage: Number.isFinite(Number(row.damage)) ? Number(row.damage) : 0,
          });
        }
      } else if (event === "block") {
        const row = payload as { id?: unknown; on?: unknown } | null;
        if (row && typeof row === "object" && Number.isInteger(Number(row.id))) {
          handlers.onBlock?.({ id: Number(row.id), on: !!row.on });
        }
      } else if (event === "space") {
        const row = payload as { id?: unknown; on?: unknown; hold?: unknown; cancel?: unknown } | null;
        if (row && typeof row === "object" && Number.isInteger(Number(row.id))) {
          handlers.onSpace?.({
            id: Number(row.id),
            on: !!row.on,
            hold: Number.isFinite(Number(row.hold)) ? Number(row.hold) : undefined,
            cancel: !!row.cancel,
          });
        }
      } else if (event === "atmo") {
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
      } else if (event === "roomsinfo") {
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
        emit("join", { room: join.room || "demo", login: join.login || "", sprite: join.sprite, size: join.size });
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
    emit("rooms", { ids });
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
