/**
 * Server config (W4 carve, behavior-preserving): environment, listen socket,
 * Origin whitelist, payload/frame caps and every static registry a domain
 * module needs (palette, sprite whitelist, spawn cells, object dims). Values
 * are singletons for the whole process; nothing here is ever reassigned after
 * boot. Legacy ADMIN_PASS is exported for compatibility and no longer gates editing
 * and DATA_DIR.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

// Репозиторный корень: config.js после выреза W4 живёт в server/, а PUBLIC и
// дефолт DATA_DIR обязаны указывать на корень репо, как при едином server.js.
const __dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(__dirname, "public");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT) || 3780;
// На VPS порт задаёт systemd-юнит: Environment=PORT=8787 (образец — deploy/vps/coop-field.service).
// Локальный запуск без переменных слушает 3780 — на него настроен клиент разработки.
/** 1 = требовать заголовок Origin (не-браузерные клиенты без Origin не пускаются).
 *  По умолчанию 0: скрипты тестов (scripts/test-ws.mjs) подключаются без Origin. */
const REQUIRE_ORIGIN = process.env.REQUIRE_ORIGIN === "1";
const WS_HOSTNAME = "coop.89-232-184-77.sslip.io";
const FRONT_HOSTNAME = "abnocw.89-232-184-77.sslip.io";
const DEFAULT_ORIGINS = [
  "http://localhost:3780",
  "http://127.0.0.1:3780",
  `https://${WS_HOSTNAME}`,
  `https://${FRONT_HOSTNAME}`,
];

function allowedOrigins() {
  const extra = (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ORIGINS, ...extra]);
}

function isAllowedOrigin(origin) {
  if (!origin) return !REQUIRE_ORIGIN;
  if (allowedOrigins().has(origin)) return true;
  try {
    const { hostname, protocol } = new URL(origin);
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") return true;
    // S3 (аудит Z.AI 2026-11-08): легаси-шаблон *.vercel.app УДАЛЁН из любой
    // ветки — хосты превью/прода перечисляются ТОЧНО через env ALLOWED_ORIGINS
    // (запасной выход для явных строк) и свои списки классов хостов выше.
    return false;
  } catch {
    return false;
  }
}

/* ---------- B1: per-destination Origin-политика ----------
 * Один инстанс обслуживает оба сайта (гроты и Элизию), превью повторяет
 * топологию: pr-<N>.abnocw.phainonsmilk.ru и pr-<N>.elysiae.phainonsmilk.ru на одном сервере,
 * а env ALLOWED_ORIGINS — один общий список. Поэтому «разрешён» — это ПАРА
 * (Origin, класс destination-хоста), а не вхождение в общий список: origin
 * гротов не может читать credentialed-ответы Элизии и наоборот. Origin-хост
 * класса определяется только ТОЧНЫМ вхождением в списки хостов класса
 * (превью-инстансы регистрируют свои pr-<N>-хосты через env); поддомены и
 * подстроки не считаются «своими». Scheme+host+port сравниваются канонично:
 * нестандартный порт разрешён только явной строкой в ALLOWED_ORIGINS.
 */

/** Канонизация web-origin: {origin: 'scheme://host[:port]', host, explicitPort}. */
function canonicalOrigin(raw) {
  let u;
  try {
    u = new URL(String(raw || ""));
  } catch {
    return null;
  }
  const protocol = u.protocol === "https:" || u.protocol === "http:" ? u.protocol : null;
  if (!protocol) return null;
  const host = String(u.hostname || "").toLowerCase();
  if (!host) return null;
  const origin = u.port ? `${protocol}//${host}:${u.port}` : `${protocol}//${host}`;
  return { origin, host, protocol, explicitPort: Boolean(u.port) };
}

/** Класс ХОСТА ОРИГИНА по точным спискам классов; null = чужой (fail-closed).
 *  Ведущие точки (суффикс-зоны вроде '.89-232-184-77.sslip.io') точным
 *  вхождением не match-атся — origin такого хоста должен быть явно в env. */
function originHostClass(hostname) {
  if (!hostname) return null;
  if (isLocalHostName(hostname)) return "local";
  const sets = hostSets();
  const exact = (list) => list.some((h) => !h.startsWith(".") && h === hostname);
  if (exact(sets.public)) return "public";
  if (exact(sets.elyria)) return "elyria";
  return null;
}

/** Точные origin-строки из ALLOWED_ORIGINS, относящиеся к классу: общий список
 *  превью этим и спасается — каждый его origin уходит СВОЕМУ классу по хосту. */
function envClassOrigins(hostClass) {
  const out = [];
  for (const raw of String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const c = canonicalOrigin(raw);
    if (c && originHostClass(c.host) === hostClass) out.push(c.origin);
  }
  return out;
}

/** ПАРА (origin, destination-класс): разрешение одно, точное и fail-closed.
 *  local-destination — прежняя пермиссивная политика (isAllowedOrigin). */
function originAllowedHere(rawOrigin, destClass) {
  const c = canonicalOrigin(rawOrigin);
  if (!c || !destClass) return false;
  if (destClass === "local") return isAllowedOrigin(rawOrigin);
  // Явная env-строка своего класса — разрешение как есть (нестандартный порт).
  if (envClassOrigins(destClass).includes(c.origin)) return true;
  // Иначе: scheme http/https, хост ТОЧНО из списка класса, порт дефолтный.
  if (c.explicitPort) return false;
  return originHostClass(c.host) === destClass;
}

/* ---------- B1: CSRF fail-closed ----------
 * env AUTH_CSRF_STRICT: 'auto' (дефолт) — strict на public/elyria, легаси
 * permissive на local; '0'/'1' форсируют permissive/strict для ВСЕХ классов
 * (контроль тестовых стендов). strict: unsafe+cookie-аутентификация ⇒ Origin
 * обязателен и точен; пустой Origin → 403 csrf_origin_required, чужой →
 * 403 csrf_origin_mismatch. Локальный класс оставлен прежним: на нём стоят
 * легаси-тесты и originless-скрипты карт.
 */
function csrfStrictFor(destClass) {
  const v = String(process.env.AUTH_CSRF_STRICT ?? "auto").trim().toLowerCase();
  if (["0", "no", "off", "false"].includes(v)) return false;
  if (["1", "yes", "on", "true"].includes(v)) return true;
  return destClass === "public" || destClass === "elyria";
}

/* ---------- §5: инстанс-класс для fail-closed startup CSRF ----------
 * COOP_INSTANCE_CLASS: 'production' | 'preview' | 'local' | 'test'.
 *  - unknown значения → throw (fail closed, §5 «Unknown environment names»);
 *  - без явного env: preview-маркеры (PREVIEW_SITES_MODE|PREVIEW_SLUG, их
 *    пишет preview-apply.sh в env инстанса) → 'preview', иначе 'local';
 *  - «production» НИКОГДА не выводится по косвенным признакам — прод обязан
 *    заявить себя явно через systemd-юнит (deploy/vps/coop-field.service:
 *    Environment=COOP_INSTANCE_CLASS=production); неявный дефолт — local.
 * Это контекст ЗАПУСКА процесса, а не Host-класс запроса (destClass выше) —
 * разные оси: per-request destClass решает origin/CSRF для конкретного хоста,
 * инстанс-класс решает,ему ли вообще разрешено стартовать с ослаблениями.
 */
export function instanceEnvClass() {
  const v = String(process.env.COOP_INSTANCE_CLASS || "").trim().toLowerCase();
  if (v) {
    if (v === "production" || v === "preview" || v === "local" || v === "test") {
      return v;
    }
    throw new Error(
      `COOP_INSTANCE_CLASS='${process.env.COOP_INSTANCE_CLASS}': неизвестное значение — допустимы production|preview|local|test (fail-closed, §5).`,
    );
  }
  if (process.env.PREVIEW_SITES_MODE || process.env.PREVIEW_SLUG) return "preview";
  return "local";
}

/** Fail-closed старт инстанса (§5): на production/preview выключенный
 *  AUTH_CSRF_STRICT — ошибка старта, а не тихое ослабление. Локальная
 *  разработка и тест-стенды (class local/test) сохраняют легаси-режим,
 *  им нужен AUTH_CSRF_STRICT='0' для контрольных сценариев B1. */
export function assertStartupSecurity() {
  const cls = instanceEnvClass();
  const v = String(process.env.AUTH_CSRF_STRICT ?? "auto").trim().toLowerCase();
  if (cls === "production" || cls === "preview") {
    if (["0", "no", "off", "false"].includes(v)) {
      throw new Error(
        `AUTH_CSRF_STRICT='${v}' запрещён на инстансе '${cls}': CSRF-защита не может быть выключена — старт отменён (fail-closed, §5).`,
      );
    }
  }
}

/** Решение по unsafe-запросу: null — пропустить, иначе {status, reason} = 403.
 *  hasAuth = запрос несёт сессию-реквизиты (cookie coop_session / ?t=token,
 *  в т.ч. невалидные — fail-closed: серверу не важно, жив ли токен, чтобы
 *  требовать Origin у credentialed-запроса). */
function csrfDecision({ method, origin, destClass, hasAuth }) {
  const m = String(method || "").toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  const known = String(destClass || "");
  if (!csrfStrictFor(known)) {
    // Легаси-режим: прежний щит — непустой чужой Origin из ГЛОБАЛЬНОГО
    // списка → 403 'csrf'; пустой/отсутствующий Origin не блокируется.
    const raw = String(origin || "").trim();
    if (raw && !isAllowedOrigin(raw)) return { status: 403, reason: "csrf" };
    return null;
  }
  if (known !== "public" && known !== "elyria" && known !== "local") return null;
  const originRaw = String(origin || "").trim();
  // Браузер на unsafe-методах шлёт Origin всегда; отсутствие Origin при
  // credentialed-запросе → отказ. Originless-запрос БЕЗ сессии-реквизитов
  // (curl, сервер-сервер, легаси-скрипты) пролезает: ambient-авторитета нет.
  if (!originRaw) return hasAuth ? { status: 403, reason: "csrf_origin_required" } : null;
  if (!originAllowedHere(originRaw, known)) return { status: 403, reason: "csrf_origin_mismatch" };
  return null;
}

/* ---------- B1: доверенная метка класса сайта (за прокси) ----------
 * env AUTH_TRUST_PROXY_HEADER — имя внутреннего заголовка (например
 * 'X-Coop-Site'), которым nginx помечает класс сайта на каждый vhost.
 * Прод/превью: сервер слушает 8787 НА localhost за nginx, наружу порт не
 * проброшен — напрямую к бэку снаружи не достучаться, поэтому метке можно
 * верить ТОЛЬКО у loopback-сокета (nginx перезаписывает заголовок в каждом
 * vhost, входящие копии с улицы сбрасывает). Запрос НЕ с loopback метку
 * ИГНОРИРУЕТ (класс по Host, как раньше); неизвестное значение — тоже
 * (fail-closed к Host-классификации). */
function isLoopbackRemote(req) {
  const sock = req?.socket || req?._socket;
  const ip = String(sock?.remoteAddress || "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function siteClassOfRequest(req) {
  const byHost = hostClassOf(req?.headers?.host);
  // env читается на вызов (а не на загрузку модуля): тесты перезаписывают env.
  const headerName = String(process.env.AUTH_TRUST_PROXY_HEADER || "").trim().toLowerCase();
  if (!headerName || !isLoopbackRemote(req)) return byHost;
  const value = String(req?.headers?.[headerName] || "").trim().toLowerCase();
  if (value === "public" || value === "elyria" || value === "local") return value;
  return byHost;
}
const WIDTH = 10;
const HEIGHT = 6;

/* ---------- Хост-политика (P1 сплит доменов) ----------
 * Один room-сервер обслуживает оба публичных фронтенда (пивные гроты и Элизию),
 * поэтому класс запроса определяется по заголовку Host: public | elyria | local.
 * Класс решает доступность API-зон: на public сетевой гейт (net.js) закрывает
 * /auth/*, /profiles/*, /admin/* и пишущий /cfg; elyria и local работают как
 * раньше. Хост сравнивается точным именем или суффиксом через точку (метка
 * зоны), поэтому превью-поддомены pr-<N>.abnocw.phainonsmilk.ru наследуют класс.
 * env PUBLIC_HOSTS / ELYRIA_HOSTS (имена через запятую) ДОПОЛНЯЮТ дефолты.
 * Неизвестный хост → public: класс по умолчанию — самый закрытый.
 */
const PUBLIC_DEFAULT_HOSTS = [
  "abnocw.phainonsmilk.ru",
  "coop.89-232-184-77.sslip.io",
  "abnocw.89-232-184-77.sslip.io",
];
/** Зоны превью под суффиксом грот: pr-<N>.abnocw.phainonsmilk.ru (+ sslip-легаси). */
const PUBLIC_SUFFIX_HOSTS = [".89-232-184-77.sslip.io", ".abnocw.phainonsmilk.ru"];
/** Основа = apex точное имя (рега/меню); превью Элизии — зона *.elysiae.phainonsmilk.ru. */
const ELYRIA_DEFAULT_HOSTS = ["phainonsmilk.ru", ".elysiae.phainonsmilk.ru"];
const LOCAL_HOST_ALIASES = new Set(["ip6-localhost", "ip6-loopback"]);

/** Host из req.headers.host: trim + lower, порт отрезан, IPv6-литерал в скобках цел. */
function bareHost(raw) {
  const host = String(raw || "").trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  if (colon === -1) return host;
  // Больше одного двоеточия — это IPv6-литерал без скобок (::1): двоеточия
  // и есть адрес, отрезать по ним порт нельзя.
  if (host.indexOf(":", colon + 1) !== -1) return host;
  return host.slice(0, colon);
}

/**
 * Метка имени хоста: запись с ВЕДУЩЕЙ ТОЧКОЙ (".89-232-184-77.sslip.io")
 * — зона: матчит любой поддомен; запись без точки ("abnocw.phainonsmilk.ru")
 * — ТОЛЬКО точное имя. Точка-метка обязательна с миграцией на apex-домен
 * phainonsmilk.ru (2026-11-08): запись "phainonsmilk.ru" без метки обязана
 * НЕ поглощать поддомены соседних сайтов зоны (abnocw.*, icelation.*,
 * elysiae.*) — иначе zone-suffix-матч уводит гроты в класс elyria и
 * закрывает гостевые комнаты (регрессия ловится test-server-modules:
 * "дефолт abnocw.phainonsmilk.ru" / "дефолт суффикс .abnocw.phainonsmilk.ru").
 */
function hostMatches(host, entry) {
  return entry.startsWith(".")
    ? host.endsWith(entry)
    : host === entry;
}

function envHostList(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function isLocalHostName(host) {
  if (!host) return false;
  if (host === "localhost" || LOCAL_HOST_ALIASES.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  if (host === "::1" || host === "[::1]") return true;
  if (/^127(\.\d+){1,3}$/.test(host)) return true;
  return false;
}

/** Локальные имена — петлевые IP, *.localhost и алиасы; env-списки дополняют дефолты. */
function hostSets() {
  return {
    public: [...PUBLIC_DEFAULT_HOSTS, ...envHostList("PUBLIC_HOSTS"), ...PUBLIC_SUFFIX_HOSTS],
    elyria: [...ELYRIA_DEFAULT_HOSTS, ...envHostList("ELYRIA_HOSTS")],
  };
}

/** Класс хоста: public | elyria | local. Порядок: local → elyria → public (дефолт). */
function hostClassOf(rawHost) {
  const host = bareHost(rawHost);
  if (isLocalHostName(host)) return "local";
  const sets = hostSets();
  for (const entry of sets.elyria) if (hostMatches(host, entry)) return "elyria";
  for (const entry of sets.public) if (hostMatches(host, entry)) return "public";
  return "public";
}

/** Класс запроса по req.headers.host (хендшейки WS и HTTP видят один и тот же Host). */
function hostClassOfRequest(req) {
  return hostClassOf(req?.headers?.host);
}

/** B1: класс САЙТА запроса — Host-классификация с опциональной доверенной
 *  меткой прокси (siteClassOfRequest); гейты ниже решают по ней. */
function isPublicHost(req) {
  return siteClassOfRequest(req) === "public";
}

function isElyriaHost(req) {
  return siteClassOfRequest(req) === "elyria";
}

/** Пауза между ping-ами. Браузер отвечает pong сам, клиентский код не нужен. */
const HEARTBEAT_MS = 30_000;
/** Потолок входящего кадра: протокол состоит из коротких JSON-строк,
 *  дефолтные 100 МиБ библиотеки ws здесь только помогали расходу памяти.
 *  Исключение — рисунок локации (кисть): PNG base64 до 3,5 МБ едет в setmap
 *  одним кадром, поэтому потолок поднят до 4 МиБ. */
const MAX_PAYLOAD = 4 * 1024 * 1024;
/** Потолок обычного кадра: всё, кроме setmap, — команды в сотни байт,
 *  64 КиБ покрывает их с запасом на порядки. Кадр длиннее — молчаливый
 *  drop в onMessage. Исключение только одно — setmap: maxPayload библиотеки
 *  ws глобален (см. MAX_PAYLOAD выше), поэтому размер для отдельного события
 *  различаем уже на приёме: setmap с рисунком легально весит мегабайты,
 *  раздутый кадр любого другого события до обработчиков не доходит. */
const FRAME_LIMIT = 64 * 1024;
/** Нижняя граница отклика удара в симе — 30 мс. Кулдаун чуть ниже, чтобы легитимный удар не отбрасывался. */
const STRIKE_COOLDOWN_MS = 25;
/**
 * Окно «полёта» удара, мс: применение откладывается на этот срок, и блок цели
 * перепроверяется в момент касания. Удар, брошенный в неблокирующего, но ещё
 * «висящий в воздухе», когда цель встала в блок, всё равно уходит в «Лапы».
 * Клиент присылает свой отклик удара (flightMs); без него — 170 мс.
 */
const SPAWNS = [
  [4, 3],
  [5, 3],
  [3, 4],
  [6, 3],
  [4, 4],
  [5, 4],
  [2, 3],
  [7, 3],
];
const PALETTE = ["#d85e90", "#4b8fd0", "#e6b84d", "#73a13a", "#bf5af2", "#2dd4bf", "#ff9f0a", "#64d2ff"];
const NAMES = ["Сырь", "Пухляшик", "Травожуй"];
const SPRITES = ["blestyashka", "puhlyashik", "puhlyashshshshshshshsh", "puzatik", "razdora", "pohititel", "gromoryov", "gremuchnik", "syrstyashka", "ryzhiy", "trehcvetny", "negr", "chis", "lera", "anya1", "anya2", "serebristyy", "evr", "drel", "maslina", "buran", "sumrak", "izya", "kameshechek", "klubochek", "podushka", "plyushik", "rvanitse", "puhlyashik-kit", "blestyashka-kit", "chistolapik-kit", "test1"];
/* ---------- размеры спрайтов пака и их варианты.
   Объявлены ДО loadTestMap(): sanitizeTestMap читает их при загрузке карты —
   раньше константы стояли ниже по файлу, sanitize падал с «Cannot access
   before initialization», пустой catch молча подменял сохранённую карту
   дефолтом при каждом старте сервера (карта «слетала» после каждого деплоя). ---------- */
const OBJECT_DIMS = {
  'tree-1': [113, 139],
  'tree-2': [97, 136],
  'tree-3': [79, 120],
  'rock-1': [57, 42],
  'rock-2': [11, 10],
  'rock-3': [16, 14],
  'rock-4': [24, 19],
  'rock-5': [24, 19],
  'rock-6': [27, 22],
  'rock-7': [27, 27],
  'rock-8': [18, 16],
  'rock-9': [19, 16],
  'rock-10': [31, 19],
};
const TREE_SPRITE_IDS = new Set(['tree-1', 'tree-2', 'tree-3']);
const ROCK_SPRITE_IDS = new Set(Object.keys(OBJECT_DIMS).filter((k) => k.startsWith('rock')));
const OBJECT_SCALE_MIN = 0.4;
const OBJECT_SCALE_MAX = 3.5;
/**
 * Комната «тест» — другой формат поля: нарисованная локация с лужайкой, переходом
 * и закутком. В боевом режиме ходьба по клеткам трёх зон, в мирном — свободная
 * (клиент шлёт позицию freemove, сервер зажимает её в мир локации и обновляет
 * логическую клетку — ближайшую проходимую — для ударов и препятствий).
 */
const TEST_ROOM = 'test';
/** Устаревшая настройка: больше не проверяется редактором локации. */
const ADMIN_PASS = process.env.ADMIN_PASS || null;

/** S5 (аудит Z.AI 2026-11-08): ресурсные лимиты процесса против исчерпания
 * сокетов/памяти гостевым флудом. WS_MAX_PER_IP — потолок ОДНОВРЕМЕННЫХ
 * WS-соединений с одного клиентского IP (сверх — close с info
 * 'too_many_sockets', server/net.js); ROOMS_MAX — потолок ЖИВЫХ (занятых
 * игроками) комнат на процесс, новая комната сверх даёт noplace 'rooms_full'
 * (server/room.js), существующим комнатам и алиасам RETIRED_ROOMS лимит
 * не мешает. Формат: целое >= 1; мусор/пусто → дефолт. */
const intEnv = (name, def) => {
  const n = parseInt(process.env[name] || "", 10);
  return Number.isInteger(n) && n >= 1 ? n : def;
};
const WS_MAX_PER_IP = intEnv("WS_MAX_PER_IP", 8);
const ROOMS_MAX = intEnv("ROOMS_MAX", 32);
/** Конфиг локации «теста» живёт в data/test-map.json рядом с server.js: правится
 *  редактором локации и переживает перезапуски (apply.sh копирует только server.js
 *  и package*.json — каталог data не трогает). Переопределяется переменной
 *  DATA_DIR — для тестов, чтобы песочница не трогала живую карту. */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

export {
  // net/transport
  __dirname, PUBLIC, HOST, PORT, HEARTBEAT_MS, MAX_PAYLOAD, FRAME_LIMIT,
  isAllowedOrigin, REQUIRE_ORIGIN,
  // хост-политика (P1): классы public | elyria | local
  hostClassOf, isPublicHost, isElyriaHost,
  // B1: per-destination Origin/CSRF-политика + класс сайта по запросу
  originAllowedHere, csrfDecision, siteClassOfRequest, csrfStrictFor,
  // field/rooms
  WIDTH, HEIGHT, SPAWNS, PALETTE, NAMES, SPRITES, TEST_ROOM,
  STRIKE_COOLDOWN_MS,
  // location objects (sanitize + geometry)
  OBJECT_DIMS, TREE_SPRITE_IDS, ROCK_SPRITE_IDS, OBJECT_SCALE_MIN, OBJECT_SCALE_MAX,
  ADMIN_PASS, DATA_DIR, WS_MAX_PER_IP, ROOMS_MAX,
};
