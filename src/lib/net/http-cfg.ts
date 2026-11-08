/**
 * Админ-конфиг (/cfg) — клиент дашборда /admin (P4 + волна B2: меты visibility/
 * scope отдаются сервером в mutationsForAdmin, клиент типизирует их для
 * тех-деталей строк реестра).
 * Вынесен из http-auth.ts, чтобы модуль-граф симулятора не тянул
 * /cfg-маршруты в public-бандл гротов (изоляция сайтов, §10.4).
 *
 * Контракты (server/runtime-config.js): GET /cfg/admin, POST /cfg (PATCH/reset),
 * POST /cfg/restore {name}, GET /cfg/export, POST /cfg/import — все пишущие
 * под ролью admin; не-админ получает {ok:false, reason:'auth_required'}.
 * На public-хосте гротов этих маршрутов нет (гейт net.js).
 */
import { httpOrigin } from "./coop";
import { apiFetch, asText, type ApiRow } from "./http-auth";
import { armorCurveOrCanon, type ArmorCurve } from "@/lib/sim/armor-curve";

/** Мета ключа реестра (зеркало cfg-registry, сервер отдаёт всю подпись). */
export type CfgFieldMeta = {
  key: string;
  label: string;
  description: string;
  unit: string;
  kind: string;
  /** null — у bool-ключа (гейт atmoset F2 §3.4) юниверса значений нет. */
  values: number[] | { min: number; max: number; step: number } | null;
  /** Число; у гейта atmoset — 1/0; у kind points — defaultValue-кривая
   *  (канон W3 для combat.armorCurve, мандат владелицы 2026-11-08). */
  default: number | number[][];
  /** Границы точек [x, y] — только у kind points. */
  points?: { xMin: number; xMax: number; xStep: number; yMin: number; yMax: number };
  applyPolicy: string;
  applyHint: string;
  /** «public» — параметр виден игрокам; «global» — охват (не per-room). */
  visibility: string;
  scope: string;
};

/** F2 §4: universes-поля читаются тройкой allowedValues (массив kind),
 *  defaultValue и ЯВНЫМ playerSelectable (toggle не режет список). */
export type CfgUniversesValues = {
  levels?: number[];
  tenths?: number[];
  periods?: number[];
  default: number;
  playerSelectable?: boolean;
};

export type CfgAdminSnapshot = {
  v: number;
  values: {
    atmo: Record<string, number>;
    universes: Record<string, CfgUniversesValues>;
    combat: { armorCurve: ArmorCurve };
  };
  registry: Record<string, CfgFieldMeta>;
  apply: Record<string, string>;
  history: string[];
  historyKeep: number;
};

export type CfgAction = { ok: boolean; reason?: string; details?: string; snapshot?: CfgAdminSnapshot };

const asStrMap = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
};

const metaOf = (raw: unknown): CfgFieldMeta | null => {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as ApiRow;
  const isBoolGate = typeof row.default === "boolean";
  const values = Array.isArray(row.values)
    ? (row.values as number[])
    : row.values && typeof row.values === "object"
      ? {
          min: Number((row.values as ApiRow).min),
          max: Number((row.values as ApiRow).max),
          step: Number((row.values as ApiRow).step || 1),
        }
      : null; // bool-ключ (гейт atmoset F2 §3.4): юниверса нет
  const label = asText(row.label);
  const key = asText(row.key);
  // kind points: default — канон-кривая (массив пар), не число; границы
  // осей приезжают отдельным полем points.
  const isPoints = asText(row.kind) === "points";
  const defaultCurve = isPoints && Array.isArray(row.default)
    ? (row.default as unknown[]).filter(
        (p): p is [number, number] =>
          Array.isArray(p) &&
          p.length === 2 &&
          Number.isFinite(Number(p[0])) &&
          Number.isFinite(Number(p[1])),
      ) as number[][]
    : undefined;
  if (!key || !label || (!isBoolGate && values === null && !Array.isArray(row.engineCap))) return null;
  const pts = row.points && typeof row.points === "object" ? (row.points as ApiRow) : null;
  return {
    key,
    label,
    description: asText(row.description),
    unit: asText(row.unit),
    kind: asText(row.kind),
    // Гейт atmoset (bool): default сохраняем как 1/0-число; UI тракует как вкл/выкл.
    values: isBoolGate ? null : values,
    default: isBoolGate ? (row.default ? 1 : 0) : defaultCurve ?? Number(row.default),
    points: pts
      ? {
          xMin: Number(pts.xMin),
          xMax: Number(pts.xMax),
          xStep: Number(pts.xStep) || 0.01,
          yMin: Number(pts.yMin),
          yMax: Number(pts.yMax),
        }
      : undefined,
    applyPolicy: asText(row.applyPolicy),
    applyHint: asText(row.applyHint),
    visibility: asText(row.visibility),
    scope: asText(row.scope),
  };
};

function parseAdminSnapshot(row: ApiRow): CfgAdminSnapshot | null {
  const values = row.values as { atmo?: unknown; universes?: unknown; combat?: unknown } | undefined;
  if (!values || typeof values !== "object") return null;
  const atmoNum: Record<string, number> = {};
  for (const [k, v] of Object.entries((values.atmo as Record<string, unknown>) || {})) {
    if (Number.isFinite(Number(v))) atmoNum[k] = Number(v);
  }
  const universes: Record<string, CfgUniversesValues> = {};
  const u = (values.universes as Record<string, unknown>) || {};
  for (const [name, raw] of Object.entries(u)) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as ApiRow;
    const numList = (v: unknown): number[] | undefined =>
      Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : undefined;
    universes[name] = {
      levels: numList(row.levels),
      tenths: numList(row.tenths),
      periods: numList(row.periods),
      default: Number.isFinite(Number(row.default)) ? Number(row.default) : 0,
      playerSelectable: typeof row.playerSelectable === "boolean" ? row.playerSelectable : undefined,
    };
  }
  const registry: Record<string, CfgFieldMeta> = {};
  for (const [k, raw] of Object.entries((row.registry as Record<string, unknown>) || {})) {
    const meta = metaOf(raw);
    if (meta) registry[k] = meta;
  }
  const combatRaw = (values.combat as { armorCurve?: unknown } | undefined) || undefined;
  const history = Array.isArray(row.history) ? (row.history as unknown[]).filter((n): n is string => typeof n === "string") : [];
  return {
    v: Number(row.v) || 1,
    values: { atmo: atmoNum, universes, combat: { armorCurve: armorCurveOrCanon(combatRaw?.armorCurve) } },
    registry,
    apply: asStrMap(row.apply),
    history,
    historyKeep: Number(row.historyKeep) || 0,
  };
}

/* ---------- B2: клиентская логика черновика реестра (чистые функции) ----------
 * Редактор списков /admin работает поверх значений /cfg: канонизация зеркалит
 * серверную asInt/tenth из cfg-registry.js, диффы и статусы — honest-семантика
 * applyPolicy (спек §4). Реакта здесь нет — только значения и строки. */

/** Черновик дашборда: значения atmo, разрешённые списки юниверсов и их дефолты,
 *  кривые kind points (мандат владелицы 2026-11-08: combat.armorCurve). */
export type CfgDraft = {
  atmo: Record<string, number>;
  defaults: Record<string, number>;
  lists: Record<string, number[]>;
  /** F2 §4: явный флаг «игроки могут выбирать» per universes-поле.
   *  Выключение НЕ режет список: allowedValues живёт на сервере, повторное
   *  включение возвращает кураторский список (а не весь движковый юниверс). */
  selectable: Record<string, boolean>;
  /** Кривые kind points (уже отсортированы/canonизированы normalizePoints). */
  points: Record<string, number[][]>;
};

/** Диф по одному ключу реестра — для предпросмотра «было → станет». */
export type CfgFieldDiff = {
  key: string;
  label: string;
  policy: string;
  hint: string;
  range?: { before: number; after: number; unit: string };
  list?: {
    kind: string;
    before: number[];
    after: number[];
    added: number[];
    removed: number[];
    defBefore: number;
    defAfter: number;
    unit: string;
  };
  /** §4: флип «выбор игроками» без изменения списка (off-then-on фикс). */
  choice?: { before: boolean; after: boolean; kept: number };
  /** kind points: сколько точек добавилось/убавилось (по x). */
  curve?: {
    before: number[][];
    after: number[][];
    added: number[];
    removed: number[];
  };
};

/** Черновик из админ-снапшота: значения сервера, готовые к редактированию.
 *  Списки — ПОЛНЫЕ кураторские (playerView=false), флаг выбора — явный
 *  (§4.3: старый файл без флага мигрируется выводом из списка).
 *  Кривые points — из блока combat (armorCurveOrCanon уже отфильтровал мусор). */
export function draftFromSnapshot(snap: CfgAdminSnapshot): CfgDraft {
  const atmo: Record<string, number> = { ...snap.values.atmo };
  const defaults: Record<string, number> = {};
  const lists: Record<string, number[]> = {};
  const selectable: Record<string, boolean> = {};
  for (const [field, val] of Object.entries(snap.values.universes)) {
    const list = val.levels || val.tenths || val.periods || [];
    defaults[field] = val.default;
    lists[field] = list;
    selectable[field] = typeof val.playerSelectable === "boolean" ? val.playerSelectable : list.length > 1;
  }
  const points: Record<string, number[][]> = {};
  for (const def of Object.values(snap.registry)) {
    if (def.kind !== "points") continue;
    const [field] = def.key.split(".").slice(1);
    points[field] = normalizePoints(
      ((snap.values.combat as unknown) as Record<string, unknown>)[field],
      def.points,
    ) ??
      (Array.isArray(def.default) ? (def.default as number[][]).map((p) => [...p]) : []);
  }
  return { atmo, defaults, lists, selectable, points };
}

/** Канонизация точек кривой ПО ХОДУ РЕДАКТИРОВАНИЯ (сервер валидирует всё
 *  равно — это UX-зеркало валидатора sanitizePoints): числа к двум знакам,
 *  сортировка по x («сортируем сами при отправке»), мусорные строки
 *  отбрасываются (вход ещё не набран). Возвращает null, если точек нет. */
export function normalizePoints(raw: unknown, bounds?: CfgFieldMeta["points"]): number[][] | null {
  if (!Array.isArray(raw)) return null;
  const b = bounds;
  const pts: number[][] = [];
  for (const item of raw) {
    if (!Array.isArray(item)) continue;
    const x = Number(item[0]);
    const y = Number(item[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const rx = Math.round(x * 100) / 100;
    const ry = Math.round(y * 100) / 100;
    if (b && (rx < b.xMin || rx > b.xMax || ry < b.yMin || ry > b.yMax)) continue;
    if (!pts.some((p) => p[0] === rx)) pts.push([rx, ry]);
    else {
      const hit = pts.find((p) => p[0] === rx);
      if (hit) hit[1] = ry;
    }
  }
  pts.sort((p, q) => p[0] - q[0]);
  return pts.length ? pts : null;
}

/** Валидация у поля (§4-образец listIssue): правила сервера для kind points —
 *  2..16 точек, x в границах и строго возрастает (после normalizePoints дубли
 *  уже сняты), y в границах и не растёт. null = кривая готова к отправке. */
export function curveIssue(points: number[][] | undefined, meta: CfgFieldMeta): string | null {
  const b = meta.points ?? { xMin: 0, xMax: 0.9, xStep: 0.01, yMin: 5, yMax: 60 };
  const countDef = meta.values && !Array.isArray(meta.values) ? meta.values : { min: 2, max: 16, step: 1 };
  if (!Array.isArray(points) || !points.length) return 'Кривая пуста — нужны хотя бы две точки.';
  if (points.length < countDef.min) return `Точек меньше ${countDef.min}.`;
  if (points.length > countDef.max) return `Точек больше ${countDef.max}.`;
  let prevX = -Infinity;
  let prevY = Infinity;
  for (const p of points) {
    if (p[0] < b.xMin || p[0] > b.xMax) return `Броня вне ${fmtNum(b.xMin)}–${fmtNum(b.xMax)}: ${fmtNum(p[0])}.`;
    if (p[1] < b.yMin || p[1] > b.yMax) return `Урон% вне ${b.yMin}–${b.yMax}: ${fmtNum(p[1])}.`;
    if (!(p[0] > prevX)) return `Броня обязана строго возрастать: ${fmtNum(p[0])} после ${fmtNum(prevX)}.`;
    if (p[1] > prevY) return `Урон% не растёт (кривая защиты): ${fmtNum(p[1])} после ${fmtNum(prevY)}.`;
    prevX = p[0];
    prevY = p[1];
  }
  return null;
}

/** Патч тела POST /cfg из черновика: atmo-числа + юниверсы (список+дефолт+
 *  ЯВНЫЙ playerSelectable — §4) + combat-кривые (kind points, мандат
 *  2026-11-08). Пустой список/кривая не отправляется никогда — UI
 *  блокирует такую кнопку; scope-room ключи глобальным POST не пишутся. */
export function cfgPatchFromDraft(draft: CfgDraft, snap: CfgAdminSnapshot) {
  const atmo: Record<string, number> = {};
  const universes: Record<string, CfgUniversesValues> = {};
  const combat: Record<string, number[][]> = {};
  for (const def of Object.values(snap.registry)) {
    const [section, field] = def.key.split(".");
    if (def.scope === "room") continue;
    if (section === "atmo") {
      const v = draft.atmo[field];
      if (Number.isFinite(v)) atmo[field] = v;
    } else if (def.kind === "points") {
      const pts = draft.points[field] || [];
      if (pts.length) combat[field] = pts.map((p) => [...p]);
    } else {
      const arr = draft.lists[field] || [];
      if (!arr.length) continue;
      universes[field] = {
        [def.kind]: arr,
        default: Number.isFinite(draft.defaults[field]) ? draft.defaults[field] : arr[0],
        playerSelectable: draft.selectable[field] ?? arr.length > 1,
      } as CfgUniversesValues;
    }
  }
  return combat && Object.keys(combat).length ? { atmo, universes, combat } : { atmo, universes };
}

/** Канонизация значения по kind-у (levels → int, tenths → десятые, периоды — как есть). */
export const canonByKind = (kind: string, v: number): number =>
  kind === 'levels' ? Math.round(v) : kind === 'tenths' ? Math.round(v * 10) / 10 : v;

/** Человекочитаемое число: 0.3 → «0,3» (подписи реестра используют запятые). */
export const fmtNum = (v: number): string => String(v).replace('.', ',');

/** Диф двух списков: что добавится/убавится (для предпросмотра). */
export function listDiff(prev: number[], next: number[]): { added: number[]; removed: number[] } {
  const a = new Set(prev);
  const b = new Set(next);
  return { added: [...b].filter((v) => !a.has(v)), removed: [...a].filter((v) => !b.has(v)) };
}

/** Короткая надпись apply-политики на бейдже строки (§4.6). */
export function applyBadgeText(policy: string): string {
  if (policy === 'on-next-event') return 'применяется сразу';
  if (policy === 'new-session') return 'игроки увидят в новой сессии';
  if (policy === 'new-room') return 'вступает в новых комнатах';
  return policy;
}

/** Предупреждение про сужение списка по kind-у (что будет с активными игроками). */
export function narrowingWarning(kind: string): string {
  if (kind === 'levels')
    return 'Убранные уровни: игроки с ними продолжат бить, но урон следующих ударов сервер дополнительно зажмёт по максимальному оставшемуся уровню.';
  if (kind === 'tenths')
    return 'Убранные десятые: игроки с такой бронёй при следующем кадре сснапятся вниз к ближайшей разрешённой (ниже наименьшей — без брони).';
  return 'Убранные периоды: у открытых сессий поле на ходу не меняется, при новой сессии выпавшее значение сснапится к дефолту.';
}

/** Валидация у поля: список непуст и дефолт входит в него (§4.3). */
export function listIssue(list: number[], defaultValue: number): string | null {
  if (!list.length) return 'Список пуст — оставьте хотя бы одно значение.';
  if (!list.includes(defaultValue))
    return 'Дефолт обязан входить в список — выберите дефолт из оставшихся значений.';
  return null;
}

/** Диф черновика против сервера: только реально меняющиеся ключи. */
export function buildCfgDiff(snap: CfgAdminSnapshot, draft: CfgDraft): CfgFieldDiff[] {
  const out: CfgFieldDiff[] = [];
  for (const def of Object.values(snap.registry)) {
    const [section, field] = def.key.split('.');
    if (section === 'atmo') {
      const before = snap.values.atmo[field];
      const after = draft.atmo[field];
      if (Number.isFinite(before) && Number.isFinite(after) && before !== after) {
        out.push({ key: def.key, label: def.label, policy: def.applyPolicy, hint: def.applyHint, range: { before, after, unit: def.unit } });
      }
      continue;
    }
    if (def.kind === 'points') {
      const before = (((snap.values.combat as unknown) as Record<string, unknown>)[field] as number[][] | undefined) ?? [];
      const after = draft.points[field] || [];
      const { added, removed } = listDiff(before.map((p) => p[0]), after.map((p) => p[0]));
      const same =
        !added.length &&
        !removed.length &&
        JSON.stringify(before.map((p) => [p[0], p[1]])) === JSON.stringify(after.map((p) => [p[0], p[1]]));
      if (same) continue;
      out.push({
        key: def.key,
        label: def.label,
        policy: def.applyPolicy,
        hint: def.applyHint,
        curve: { before: before.map((p) => [p[0], p[1]]), after: after.map((p) => [p[0], p[1]]), added, removed },
      });
      continue;
    }
    const stored = snap.values.universes[field];
    const before = stored?.levels || stored?.tenths || stored?.periods || [];
    const after = draft.lists[field] || [];
    const defBefore = stored?.default ?? 0;
    const defAfter = draft.defaults[field];
    const { added, removed } = listDiff(before, after);
    // §4: флаг «выбор игроками» — самостоятельная часть диффа: список при
    // флипе НЕ трогаем (allowedValues сохранены на сервере).
    const selBefore = typeof stored?.playerSelectable === "boolean" ? stored.playerSelectable : before.length > 1;
    const selAfter = draft.selectable[field] ?? after.length > 1;
    const choiceChanged = selBefore !== selAfter;
    if (!added.length && !removed.length && defBefore === defAfter && !choiceChanged) continue;
    out.push({
      key: def.key,
      label: def.label,
      policy: def.applyPolicy,
      hint: def.applyHint,
      list: { kind: def.kind, before, after, added, removed, defBefore, defAfter, unit: def.unit },
      choice: choiceChanged ? { before: selBefore, after: selAfter, kept: after.length } : undefined,
    });
  }
  return out;
}

/** Честный статус после удачного POST: «действует сразу» — только on-next-event
 * (§4.6); new-room/new-session НЕ подаются как «применено». */
export function successText(diff: CfgFieldDiff[]): string {
  const labels = (policy: string) => diff.filter((d) => d.policy === policy).map((d) => d.label);
  const now = labels('on-next-event');
  const room = labels('new-room');
  const sess = labels('new-session');
  const parts = ['Сохранено.'];
  if (now.length) parts.push(`Действует сразу (на следующие события): ${now.join(', ')}.`);
  if (room.length)
    parts.push(`Начнёт действовать только в новых комнатах: ${room.join(', ')} — уже открытые комнаты едут на своих циклах.`);
  if (sess.length) parts.push(`Игроки увидят в новой сессии: ${sess.join(', ')}.`);
  return parts.join(' ');
}

/** Дашборд-снимок /cfg/admin: значения + мета реестра + история бэкапов. */
export async function httpCfgAdmin(): Promise<CfgAction> {
  const { status, row, text } = await apiFetch("/cfg/admin");
  const snapshot = status === 200 && row?.ok === true ? parseAdminSnapshot(row) : null;
  if (snapshot) return { ok: true, snapshot };
  return { ok: false, reason: row?.reason === "auth_required" ? "auth_required" : "error", details: text };
}

/** Применение патча значений/дефолтов (POST /cfg). 400-я ошибка (unknown_keys/
 * invalid) отдаётся в details целиком — дашборд показывает её без обрезки. */
export async function httpCfgApply(patch: {
  atmo?: Record<string, number>;
  universes?: Record<string, CfgUniversesValues>;
  combat?: Record<string, number[][]>;
}): Promise<CfgAction> {
  const { status, row, text } = await apiFetch("/cfg", { method: "POST", body: patch });
  if (status === 200 && row?.ok === true) return { ok: true };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Сброс на дефолты реестра (POST /cfg {reset:true}). */
export async function httpCfgReset(): Promise<CfgAction> {
  const { status, row, text } = await apiFetch("/cfg", { method: "POST", body: { reset: true } });
  if (status === 200 && row?.ok === true) return { ok: true };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Восстановление бэкапа по имени из свежей истории (POST /cfg/restore). */
export async function httpCfgRestore(name: string): Promise<CfgAction> {
  const { status, row, text } = await apiFetch("/cfg/restore", { method: "POST", body: { name } });
  if (status === 200 && row?.ok === true) return { ok: true };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Экспорт значений: сырой JSON-текст файла (GET /cfg/export). */
export async function httpCfgExportText(): Promise<{ ok: boolean; text: string; reason?: string }> {
  const res = await fetch(`${httpOrigin()}/cfg/export`, { credentials: "include" }).catch(() => null);
  if (!res) return { ok: false, text: "", reason: "offline" };
  const text = await res.text();
  if (res.ok && text.startsWith("{")) return { ok: true, text };
  let reason = "error";
  try {
    const row = JSON.parse(text) as ApiRow;
    if (row?.reason === "auth_required") reason = "auth_required";
  } catch {
    /* не JSON — общий error */
  }
  return { ok: false, text, reason };
}

/** Импорт экспортного JSON (POST /cfg/import, всё-или-ничего). */
export async function httpCfgImportText(text: string): Promise<CfgAction> {
  const { status, row, text: body } = await apiFetch("/cfg/import", { method: "POST", body: text });
  if (status === 200 && row?.ok === true) return { ok: true };
  return { ok: false, reason: cfgErrorReason(status, row), details: body };
}

function cfgErrorReason(status: number, row: ApiRow | null): string {
  if (status === 0) return "offline";
  if (typeof row?.reason === "string" && row.reason) return row.reason;
  if (status === 403) return "auth_required";
  return "error";
}

/* ============ F2 per-room конфиг: слои engine ← global ← room (§3) ============ */

/** Whitelist per-room v1 — зеркало SUPPORTED_ROOM_KEYS сервера. */
export type RoomConfigKey =
  | "atmo.phaseMin"
  | "atmo.weatherMin"
  | "atmo.allowPlayerAtmosphereControl";

export type RoomConfigValue = number | boolean;

/** Вид одного ключа комнаты: глобальный слой, override (если есть), effective. */
export type RoomKeyView = {
  state: "overridden" | "inherited";
  global: RoomConfigValue;
  override: RoomConfigValue | null;
  effective: RoomConfigValue;
  applyHint: string;
};

/** Ответ GET /cfg/rooms/<id> (эффективные слои + маркеры per-key). */
export type RoomConfigView = {
  id: string;
  title: string;
  mode: string;
  access: string;
  overrides: Record<string, RoomConfigValue>;
  overrideCount: number;
  hasOverrides: boolean;
  effective: { phaseMin: number; weatherMin: number; allowPlayerAtmosphereControl: boolean };
  keys: Record<string, RoomKeyView>;
  supportedKeys: RoomConfigKey[];
};

/** Элемент GET /cfg/rooms. */
export type RoomListItem = {
  id: string;
  title: string;
  mode: string;
  access: string;
  hasOverrides: boolean;
  overrideCount: number;
  supportedKeys: RoomConfigKey[];
};

export type RoomConfigAction = {
  ok: boolean;
  reason?: string;
  details?: string;
  room?: RoomConfigView;
  rooms?: RoomListItem[];
  history?: string[];
  keep?: number;
  restoredFrom?: string;
  inherited?: RoomConfigValue;
  reset?: string;
};

const roomViewOf = (row: ApiRow): RoomConfigView | null => {
  if (!row || typeof row !== "object") return null;
  const keys = (row.keys as Record<string, ApiRow>) || {};
  const view: Record<string, RoomKeyView> = {};
  for (const [key, raw] of Object.entries(keys)) {
    const k = raw as ApiRow;
    const num = (v: unknown) => (typeof v === "boolean" ? v : Number.isFinite(Number(v)) ? Number(v) : null);
    view[key] = {
      state: k?.state === "overridden" ? "overridden" : "inherited",
      global: (num(k.global) as RoomConfigValue),
      override: k.override === null || k.override === undefined ? null : (num(k.override) as RoomConfigValue),
      effective: (num(k.effective) as RoomConfigValue),
      applyHint: typeof k.applyHint === "string" ? k.applyHint : "",
    };
  }
  const eff = (row.effective as ApiRow) || {};
  return {
    id: asText(row.id),
    title: asText(row.title),
    mode: asText(row.mode),
    access: asText(row.access),
    overrides: (row.overrides as Record<string, RoomConfigValue>) || {},
    overrideCount: Number(row.overrideCount) || 0,
    hasOverrides: row.hasOverrides === true,
    effective: {
      phaseMin: Number(eff.phaseMin),
      weatherMin: Number(eff.weatherMin),
      allowPlayerAtmosphereControl: eff.allowPlayerAtmosphereControl !== false,
    },
    keys: view,
    supportedKeys: (row.supportedKeys as RoomConfigKey[]) || [],
  };
};

const roomListRow = (raw: unknown): RoomListItem | null => {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as ApiRow;
  return {
    id: asText(row.id),
    title: asText(row.title),
    mode: asText(row.mode),
    access: asText(row.access),
    hasOverrides: row.hasOverrides === true,
    overrideCount: Number(row.overrideCount) || 0,
    supportedKeys: (row.supportedKeys as RoomConfigKey[]) || [],
  };
};

/** Каталог комнат + бейджи overrides (GET /cfg/rooms). */
export async function httpRoomList(): Promise<RoomConfigAction> {
  const { status, row, text } = await apiFetch("/cfg/rooms");
  if (status === 200 && row?.ok === true) {
    const rooms = Array.isArray(row?.rooms) ? row.rooms.map(roomListRow).filter((r): r is RoomListItem => !!r) : [];
    return { ok: true, rooms };
  }
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Слои конкретной комнаты (GET /cfg/rooms/<id>): global/override/effective. */
export async function httpRoomConfig(id: string): Promise<RoomConfigAction> {
  const { status, row, text } = await apiFetch(`/cfg/rooms/${encodeURIComponent(id)}`);
  if (status === 200 && row?.ok === true) return { ok: true, room: roomViewOf((row as ApiRow).room as ApiRow) || undefined };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Merge validated overrides (PUT /cfg/rooms/<id> {values:{key:value}} ONLY). */
export async function httpRoomUpdate(id: string, values: Record<RoomConfigKey, RoomConfigValue>): Promise<RoomConfigAction> {
  const { status, row, text } = await apiFetch(`/cfg/rooms/${encodeURIComponent(id)}`, { method: "PUT", body: { values } });
  if (status === 200 && row?.ok === true) return { ok: true, room: roomViewOf((row as ApiRow).room as ApiRow) || undefined };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Сброс одного override (DELETE /cfg/rooms/<id>/<key>) → комната наследует. */
export async function httpRoomResetKey(id: string, key: RoomConfigKey): Promise<RoomConfigAction> {
  const { status, row, text } = await apiFetch(`/cfg/rooms/${encodeURIComponent(id)}/${encodeURIComponent(key)}`, { method: "DELETE" });
  if (status === 200 && row?.ok === true) return { ok: true, room: roomViewOf((row as ApiRow).room as ApiRow) || undefined, inherited: (row.inherited as RoomConfigValue) ?? undefined, reset: key };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Сброс всех overrides комнаты (DELETE /cfg/rooms/<id>/all). */
export async function httpRoomResetAll(id: string): Promise<RoomConfigAction> {
  const { status, row, text } = await apiFetch(`/cfg/rooms/${encodeURIComponent(id)}/all`, { method: "DELETE" });
  if (status === 200 && row?.ok === true) return { ok: true, room: roomViewOf((row as ApiRow).room as ApiRow) || undefined };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** История бэкапов room-configs.json (GET /cfg/rooms/<id>/history). */
export async function httpRoomHistory(id: string): Promise<RoomConfigAction> {
  const { status, row, text } = await apiFetch(`/cfg/rooms/${encodeURIComponent(id)}/history`);
  if (status === 200 && row?.ok === true) {
    const history = Array.isArray(row?.history) ? (row.history as unknown[]).filter((n): n is string => typeof n === "string") : [];
    return { ok: true, history, keep: Number(row?.keep) || 0 };
  }
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}

/** Restore overrides комнаты из бэкапа (POST /cfg/rooms/<id>/restore). */
export async function httpRoomRestore(id: string, name: string): Promise<RoomConfigAction> {
  const { status, row, text } = await apiFetch(`/cfg/rooms/${encodeURIComponent(id)}/restore`, { method: "POST", body: { name } });
  if (status === 200 && row?.ok === true) return { ok: true, room: roomViewOf((row as ApiRow).room as ApiRow) || undefined, restoredFrom: name };
  return { ok: false, reason: cfgErrorReason(status, row), details: text };
}
