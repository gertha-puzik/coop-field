/**
 * Сессия комнаты: HttpOnly-cookie (P3, спек §3). Токен клиенту не виден и
 * нигде не хранится: кука ездит сама в каждом fetch/WS-хендшейке, а фигню
 * вроде ?t= в URL спек запрещает. Этот модуль остаётся точкой сборки WS-кадра
 * auth (hello/logout) и identity-пропуском whoami — профили и их HTTP-флои
 * живут в ./http-auth.ts.
 */
import { EV, type CoopWhoami } from "./protocol.ts";

/**
 * Ктоами-кадр с сервера: пропускаем как есть. Токен в кадре (legacy local)
 * игнорируем — состояние сессии на клиенте только роль/имя/accId, правда в куке.
 */
export function applyWhoami(row: CoopWhoami): CoopWhoami {
  return row;
}

/**
 * Пayload WS-кадра auth. hello — без токена: сессию сокет уже получил по куке
 * на хендшейке (server/auth.js handshake → tokenFromRequest → cookie).
 * logout остаётся кадром: им сокет отвязывает привязанную сессию.
 */
export function authPayload(
  action: "hello" | "register" | "login" | "logout",
  fields: { login?: string; pass?: string } = {},
) {
  return { action, ...fields };
}

export { EV };
