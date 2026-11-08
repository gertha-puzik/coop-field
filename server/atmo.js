/**
 * Atmosphere domain (W4 carve, behavior-preserving): the shared per-room
 * day/night clock + weather — the «atmo» anchor {t, cs, pl, wl, w, ws, dp} the
 * whole room rides on. Weather rolls lazily on its own interval; the 5 s
 * ticker that resends the anchor on change lives in ./net.js. Phase and
 * weather names, default lengths and clamp bounds are imported from
 * ./protocol.js (W3 canon, mirrored by src/lib/net/protocol.ts).
 */
import {
  EV, ATMO_PHASE_LIST, ATMO_WEATHER_LIST, ATMO_PHASE_MS_DEF, ATMO_WEATHER_MS_DEF,
  ATMO_PHASE_MS_MIN, ATMO_PHASE_MS_MAX, ATMO_WEATHER_MS_MIN, ATMO_WEATHER_MS_MAX,
} from "./protocol.js";
import { broadcast } from "./room.js";
import { atmoLengths } from "./runtime-config.js";
// F2 §3.4: per-room гейт atmoset/atmo (admin-конфиг комнаты, НЕ путать с
// живым краевым механизмом: сам якорь и его трансляции не меняются — гейт
// только молча отбрасывает кадры УПРАВЛЕНИЯ от игроков выключенной комнаты).
import { isPlayerAtmoControlAllowed } from "./room-config.js";

const ATMO_DAYPARTS = new Set(ATMO_PHASE_LIST);
const ATMO_WEATHERS = new Set(ATMO_WEATHER_LIST);

/**
 * Стартовое состояние атмосферы новой комнаты: цикл открывается серединой «дня»,
 * погода — солнечная, её отсчёт пошёл сейчас.
 */
function atmoDefaults(now) {
  const len = atmoLengths();
  const pl = len.pl || ATMO_PHASE_MS_DEF;
  const wl = len.wl || ATMO_WEATHER_MS_DEF;
  return {
    cs: now - Math.round(1.5 * pl), // floor(1.5)=1 → «день»
    pl,
    wl,
    w: "sun",
    ws: now,
  };
}

const atmoPhaseIdx = (a, now) => Math.floor((((now - a.cs) / a.pl) % 4) + 4) % 4;

/**
 * Текущее состояние атмосферы комнаты. Погода доезжает лениво: если её интервал
 * истёк — выбирается другая (из двух оставшихся), отсчёт начинается заново.
 * Рассылку смен делает тикер (atmoTimer) и обработчики atmo/atmoset.
 */
function atmoState(room, now = Date.now()) {
  const a = room.atmo || (room.atmo = atmoDefaults(now));
  if (now - a.ws >= a.wl) {
    const others = [...ATMO_WEATHERS].filter((x) => x !== a.w);
    a.w = others[Math.floor(Math.random() * others.length)];
    a.ws = now;
  }
  return a;
}

/** Якорь атмосферы для рассылки: часы цикла + погода + часть суток на момент now. */
function atmoAnchor(room, now = Date.now()) {
  const a = atmoState(room, now);
  return { t: now, cs: a.cs, pl: a.pl, wl: a.wl, w: a.w, ws: a.ws, dp: ATMO_PHASE_LIST[atmoPhaseIdx(a, now)] };
}

function atmoBroadcast(room, now = Date.now()) {
  broadcast(room, EV.ATMO, atmoAnchor(room, now), null);
}

/**
 * Атмосфера комнаты — общая для всех и живёт сама: сутки едут непрерывно
 * (утро → день → вечер → ночь → утро), погода меняется по своему интервалу.
 * Клиент → ["atmo", { dp, w }] — перемотать цикл к середине части суток dp и
 * поставить погоду w (кнопки в панели). Сервер переприменяет значения и шлёт
 * ВСЕМ якорь (включая отправителя — эхо служит подтверждением). Новички получают
 * якорь в снапшоте field. Менять может любой игрок в комнате.
 */
function atmo(ws, payload = {}) {
  const room = ws.room;
  if (!room || !room.sockets.get(ws)) return;
  // F2 §3.4: админ может отключить игрокам управление атмосферой комнаты
  // (per-room override atmo.allowPlayerAtmosphereControl; default — можно).
  // Отказ — прежний механизм невалидных кадров: молчаливый drop без ответа.
  if (!isPlayerAtmoControlAllowed(room.code)) return;
  const dp = String(payload.dp || "");
  const w = String(payload.w || "");
  if (!ATMO_DAYPARTS.has(dp) || !ATMO_WEATHERS.has(w)) return;
  const now = Date.now();
  const a = atmoState(room, now);
  a.cs = now - (ATMO_PHASE_LIST.indexOf(dp) + 0.5) * a.pl;
  a.w = w;
  a.ws = now;
  atmoBroadcast(room, now);
}

/**
 * Клиент → ["atmoset", { pl, wl }] — длительности части суток (pl) и интервала
 * погоды (wl) в минутах. Общие для комнаты: применяет тот, кто повернул ползунок,
 * остальные получают новый якорь рассылкой. Позиция суток при смене темпа
 * сохраняется (день не прыгает в ночь), отсчёт погоды начинается заново.
 */
function atmoset(ws, payload = {}) {
  const room = ws.room;
  if (!room || !room.sockets.get(ws)) return;
  // F2 §3.4: тот же per-room гейт для слайдеров «Сутки»/«Погода» (atmoset).
  if (!isPlayerAtmoControlAllowed(room.code)) return;
  const plMin = Number(payload.pl);
  const wlMin = Number(payload.wl);
  // Отсутствующее/мусорное значение (NaN, 0, null) просто не применяется.
  const hasPl = Number.isFinite(plMin) && plMin > 0;
  const hasWl = Number.isFinite(wlMin) && wlMin > 0;
  if (!hasPl && !hasWl) return;
  const now = Date.now();
  const a = atmoState(room, now);
  if (hasPl) {
    const pl = Math.round(Math.min(ATMO_PHASE_MS_MAX, Math.max(ATMO_PHASE_MS_MIN, plMin * 60_000)));
    if (pl !== a.pl) {
      // Сохраняем позицию в цикле (0..1 долю полных суток), чтобы картинка не прыгала.
      const frac = ((((now - a.cs) / (a.pl * 4)) % 1) + 1) % 1;
      a.pl = pl;
      a.cs = now - frac * pl * 4;
    }
  }
  if (hasWl) {
    a.wl = Math.round(Math.min(ATMO_WEATHER_MS_MAX, Math.max(ATMO_WEATHER_MS_MIN, wlMin * 60_000)));
    a.ws = now;
  }
  atmoBroadcast(room, now);
}

export { atmoPhaseIdx, atmoState, atmoAnchor, atmoBroadcast, atmo, atmoset };
