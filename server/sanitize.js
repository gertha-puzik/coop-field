/**
 * Inbound sanitizers + chat (W4 carve, behavior-preserving): invisible/bidi
 * control characters are stripped from every login and chat text; chat is
 * clamped by code points (CHAT_MAX_LEN) and rate-limited per cat. The other
 * inbound guards keep living with their event handlers: setmap throttle
 * (1/10 s) in ./testmap.js, the 64 KiB non-setmap frame drop in ./net.js —
 * limits themselves are imported from ./protocol.js (W3 canon).
 */
import { EV, CHAT_MAX_LEN, CHAT_COOLDOWN_MS, CHAT_HISTORY } from "./protocol.js";
import { send, broadcast, rooms } from "./room.js";

/**
 * Невидимые и bidi-символы: нулевая ширина даёт подмену имён («Сы\u200Bрь» выглядит
 * как «Сырь»), bidi-управляющие переворачивают строку чата. Вырезаем и из логина,
 * и из текста сообщений. Составные эмодзи (ZWJ) тоже распадаются — осознанная цена.
 */
const INVISIBLE_RE = /[\u0000-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function clipChars(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join("");
}

function sanitizeChat(raw) {
  const text = String(raw ?? "")
    .replace(INVISIBLE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clipChars(text, CHAT_MAX_LEN);
}

/** Логин: только видимые символы, одинарные пробелы, не длиннее 24 код-поинтов. */
function sanitizeLogin(raw, fallback) {
  const text = clipChars(
    String(raw ?? "")
      .replace(INVISIBLE_RE, "")
      .replace(/\s+/g, " ")
      .trim(),
    24,
  );
  return text || fallback;
}

/** Имя, не совпадающее с уже сидящими в комнате (без учёта регистра):
 *  «Альфа» и «альфа» в одном чате — это одна и та же персона для читающего. */
function uniqueLogin(room, base) {
  const taken = new Set();
  for (const cat of room.cats.values()) taken.add(cat.login.toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  const stem = clipChars(base, 21);
  for (let n = 2; ; n++) {
    const candidate = `${stem} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/**
 * Чат комнаты. Клиент → ["chat", { text }].
 * Всем в комнате, включая отправителя → ["chat", { seq, id, login, color, text, ts }].
 * Новичку после field приходит ["chatlog", те же объекты], не больше CHAT_HISTORY.
 */
const globalChat=[];let globalChatSeq=0;
export function chatHistoryFor(room,ws){return ws.account && room.fmt==='test'?[...globalChat,...(room.chat || [])].sort((a,b)=>a.ts-b.ts):room.chat || [];}
function chat(ws, payload = {}) {
  const room = ws.room;
  const cat = room && room.sockets.get(ws);
  if (!cat) {
    send(ws, EV.INFO, "Сначала зайдите в комнату.");
    return;
  }
  const source = typeof payload === "string" ? payload : payload?.text ?? payload?.message ?? "";
  // Предрез по код-поинтам, а не по UTF-16: slice(0, 2000) мог разрезать суррогатную пару.
  const text = sanitizeChat(clipChars(String(source), 2000));
  if (!text) return;
  const now = Date.now();
  if (now - (cat.lastChat || 0) < CHAT_COOLDOWN_MS) {
    send(ws, EV.INFO, "Сообщения слишком частые.");
    return;
  }
  cat.lastChat = now;
  const global=payload?.channel==='global' && room.fmt==='test' && !!ws.account;
  if (!room.chat) room.chat = [];
  if(global)globalChatSeq++;else room.chatSeq=(room.chatSeq || 0)+1;
  const entry={seq:global?globalChatSeq:room.chatSeq,id:cat.id,login:cat.login,color:cat.color,text,ts:now,channel:global?'global':'near',room:room.code,...(ws.account?{characterId:ws.account.activeCharacterId}:{})};
  const history=global?globalChat:room.chat;history.push(entry);
  if(history.length>CHAT_HISTORY)history.splice(0,history.length-CHAT_HISTORY);
  if(global){for(const target of rooms.values())if(target.fmt==='test')for(const peer of target.sockets.keys())if(peer.account)send(peer,EV.CHAT,entry);}
  else broadcast(room,EV.CHAT,entry);
}

export { clipChars, sanitizeChat, sanitizeLogin, uniqueLogin, chat };
