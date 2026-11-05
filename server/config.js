/**
 * Server config (W4 carve, behavior-preserving): environment, listen socket,
 * Origin whitelist, payload/frame caps and every static registry a domain
 * module needs (palette, sprite whitelist, spawn cells, object dims). Values
 * are singletons for the whole process; nothing here is ever reassigned after
 * boot. Owner of ADMIN_PASS (legacy default; override via env) and DATA_DIR.
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
    return protocol === "https:" && /^coop-field(-[a-z0-9-]+)?\.vercel\.app$/.test(hostname);
  } catch {
    return false;
  }
}
const WIDTH = 10;
const HEIGHT = 6;
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
const SPRITES = ["blestyashka", "puhlyashik", "puhlyashshshshshshshsh", "puzatik", "razdora", "pohititel", "gromoryov", "gremuchnik", "syrstyashka", "ryzhiy", "trehcvetny", "negr", "chis", "lera", "anya1", "anya2", "serebristyy", "evr", "drel", "maslina", "buran", "sumrak", "izya", "kameshechek", "klubochek", "podushka", "plyushik", "rvanitse", "puhlyashik-kit", "blestyashka-kit", "chistolapik-kit"];
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
/** Пароль редактора локации (событие setmap). */
// legacy default; смена значения — через env ADMIN_PASS на VPS (см. аудит SRV-01), решение заказчицы 2026-11-05: пока оставить.
const ADMIN_PASS = process.env.ADMIN_PASS || '1946';
/** Конфиг локации «теста» живёт в data/test-map.json рядом с server.js: правится
 *  редактором локации и переживает перезапуски (apply.sh копирует только server.js
 *  и package*.json — каталог data не трогает). Переопределяется переменной
 *  DATA_DIR — для тестов, чтобы песочница не трогала живую карту. */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

export {
  // net/transport
  __dirname, PUBLIC, HOST, PORT, HEARTBEAT_MS, MAX_PAYLOAD, FRAME_LIMIT,
  isAllowedOrigin,
  // field/rooms
  WIDTH, HEIGHT, SPAWNS, PALETTE, NAMES, SPRITES, TEST_ROOM,
  STRIKE_COOLDOWN_MS,
  // location objects (sanitize + geometry)
  OBJECT_DIMS, TREE_SPRITE_IDS, ROCK_SPRITE_IDS, OBJECT_SCALE_MIN, OBJECT_SCALE_MAX,
  ADMIN_PASS, DATA_DIR,
};
