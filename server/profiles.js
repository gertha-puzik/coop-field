/**
 * HTTP-профили игроков — каркас фазы P1 платформенного сплита. Полный каталог,
 * поиск и правка едут в P4; здесь зафиксированы маршруты и контракт:
 *
 *   GET    /profiles/me    200 { ok, ...publicProfile } | гость → 401 auth_required
 *   GET    /profiles       200 { ok:true, items: [], total: 0 } — заглушка каталога
 *   GET    /profiles/:id   404 { ok:false, reason: "unknown" } — заглушка до P4
 *   PATCH  /profiles/me    501 { ok:false, reason: "not_implemented" }
 *   прочие суб-пути/методы 404 not_found — статике ничего не проваливается.
 *
 * Идентичность строго из серверной сессии (auth.sessionFromRequest):
 * ни один параметр клиента не выбирает чужой профиль. DTO — accounts.publicProfile,
 * единый источник: без login, role и парольных полей.
 *
 * Домен-изоляция: на public-хосте весь /profiles/* закрыт гейтом net.js ещё
 * до этого обработчика; сюда класс public дотянуться не может.
 */
import { isAllowedOrigin } from "./config.js";
import { sessionFromRequest } from "./auth.js";
import { publicProfile } from "./accounts.js";

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Тот же CORS-набор, что у /auth и /cfg: белые Origin получают явное разрешение. */
function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET,PATCH,OPTIONS");
}

export function handleProfilesHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  if (p !== "/profiles" && !p.startsWith("/profiles/")) return false;
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (p === "/profiles/me") {
    if (req.method === "GET") {
      const session = sessionFromRequest(req);
      if (!session) {
        json(res, 401, { ok: false, reason: "auth_required" });
        return true;
      }
      json(res, 200, { ok: true, ...publicProfile(session.account) });
      return true;
    }
    if (req.method === "PATCH") {
      // Правка профиля — фаза P4; до неё честное 501, а не молчаливый no-op.
      json(res, 501, { ok: false, reason: "not_implemented" });
      return true;
    }
  }
  if (p === "/profiles" && req.method === "GET") {
    // Заглушка каталога игроков: перечисление/поиск/пагинация — P4.
    json(res, 200, { ok: true, items: [], total: 0 });
    return true;
  }
  if (req.method === "GET" && p.startsWith("/profiles/")) {
    const rest = p.slice("/profiles/".length);
    // Один сегмент-идентификатор: любой id пока «не найден» (P4 даст карточки).
    // Вложенные суб-пути (/profiles/a/b) и мусор — общий 404 ниже.
    if (rest && !rest.includes("/")) {
      json(res, 404, { ok: false, reason: "unknown" });
      return true;
    }
  }
  json(res, 404, { ok: false, reason: "not_found" });
  return true;
}
