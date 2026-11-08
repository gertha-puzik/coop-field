/**
 * Админ-операции «Игроки на поле» — HTTP-стык панели /admin (образец слайса:
 * room-config.js). Домен живёт в room.js (adminOccupancy/resetPlayerPosition),
 * здесь только маршруты и гейты. Стек защиты следующий:
 *   - host-гейт (net.js): public-класс прячет /admin ЦЕЛИКОМ — ручки «для
 *     гротов» нет в принципе, на elyria/local классы API открыт в HTTP;
 *   - сессия: 401 без cookie-сессии, 403 если роль не admin — роль читает
 *     сервер из сессии, слово клиента ничего не значит;
 *   - CSRF: маршруты отданы в общий apiZone-щит net.js (unsafe + cookie ⇒
 *     точный Origin, B1), отдельного токена в теле нет — cookie-сессии и
 *     SameSite=Strict достаточно.
 * Маршруты (тело reset строго {room, login}):
 *   GET  /admin/players        — живые комнаты и коты с координатами;
 *   POST /admin/players/reset  — сброс кота на свежую клетку спавна:
 *                                200 {ok, room, login, x, y, sprite} либо 400
 *                                {ok:false, reason, message} — человекочитаемые
 *                                отказы: комнаты нет / кота нет / нет свободной
 *                                клетки спавна (message отдаётся панели как есть).
 */
import { sessionFromRequest } from "./auth.js";
import { json, readJson, setCors } from "./runtime-config.js";
import { adminOccupancy, resetPlayerPosition } from "./room.js";

const PLAYERS = "/admin/players";
const RESET = "/admin/players/reset";

/** Сессия → админ: null = нет сессии (401), false = не админ (403). */
function adminGate(req, res) {
  const session = sessionFromRequest(req);
  if (!session) {
    json(res, 401, { ok: false, reason: "auth_required", message: "Нужен вход в аккаунт администратора." });
    return null;
  }
  if (session.account?.role !== "admin") {
    json(res, 403, { ok: false, reason: "forbidden", message: "Раздел открыт только администраторам." });
    return null;
  }
  return session;
}

/**
 * Разбор маршрута: true — запрос наш (ответ уже отписан), false — чужой,
 * пусть дальше в цепи net.js. Отказы не молчаливые: в любом
 * непредусмотренном ответвлении маршрутов отдаём 404 not_found.
 */
export async function handleAdminOpsHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  if (p !== PLAYERS && p !== RESET) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (!adminGate(req, res)) return true;
  if (p === PLAYERS && req.method === "GET") {
    json(res, 200, { ok: true, rooms: adminOccupancy() });
    return true;
  }
  if (p === RESET && req.method === "POST") {
    let body;
    try {
      body = await readJson(req);
    } catch {
      json(res, 400, { ok: false, reason: "json", message: "Тело запроса не читается как JSON." });
      return true;
    }
    const extra = Object.keys(body).filter((k) => k !== "room" && k !== "login");
    if (extra.length) {
      json(res, 400, { ok: false, reason: "unexpected_fields", unexpected: extra, expected: ["room", "login"] });
      return true;
    }
    const room = typeof body?.room === "string" ? body.room.trim() : "";
    const login = typeof body?.login === "string" ? body.login.trim() : "";
    if (!room || !login) {
      json(res, 400, { ok: false, reason: "invalid", message: "Нужны поля room и login (непустые строки)." });
      return true;
    }
    const out = resetPlayerPosition(room, login);
    if (out.error) {
      json(res, 400, { ok: false, ...out.error });
      return true;
    }
    json(res, 200, { ok: true, ...out });
    return true;
  }
  json(res, 404, { ok: false, reason: "not_found" });
  return true;
}
