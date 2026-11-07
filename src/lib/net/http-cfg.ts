/**
 * Админ-конфиг (/cfg) — клиент дашборда /admin (P4).
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

/** Мета ключа реестра (зеркало cfg-registry, сервер отдаёт всю подпись). */
export type CfgFieldMeta = {
  key: string;
  label: string;
  description: string;
  unit: string;
  kind: string;
  values: number[] | { min: number; max: number; step: number };
  default: number;
  applyPolicy: string;
  applyHint: string;
};

export type CfgUniversesValues = {
  levels?: number[];
  tenths?: number[];
  periods?: number[];
  default: number;
};

export type CfgAdminSnapshot = {
  v: number;
  values: { atmo: Record<string, number>; universes: Record<string, CfgUniversesValues> };
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
  const values = Array.isArray(row.values)
    ? (row.values as number[])
    : row.values && typeof row.values === "object"
      ? {
          min: Number((row.values as ApiRow).min),
          max: Number((row.values as ApiRow).max),
          step: Number((row.values as ApiRow).step || 1),
        }
      : null;
  const label = asText(row.label);
  const key = asText(row.key);
  if (!key || !label || values === null) return null;
  return {
    key,
    label,
    description: asText(row.description),
    unit: asText(row.unit),
    kind: asText(row.kind),
    values,
    default: Number(row.default),
    applyPolicy: asText(row.applyPolicy),
    applyHint: asText(row.applyHint),
  };
};

function parseAdminSnapshot(row: ApiRow): CfgAdminSnapshot | null {
  const values = row.values as { atmo?: unknown; universes?: unknown } | undefined;
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
    };
  }
  const registry: Record<string, CfgFieldMeta> = {};
  for (const [k, raw] of Object.entries((row.registry as Record<string, unknown>) || {})) {
    const meta = metaOf(raw);
    if (meta) registry[k] = meta;
  }
  const history = Array.isArray(row.history) ? (row.history as unknown[]).filter((n): n is string => typeof n === "string") : [];
  return {
    v: Number(row.v) || 1,
    values: { atmo: atmoNum, universes },
    registry,
    apply: asStrMap(row.apply),
    history,
    historyKeep: Number(row.historyKeep) || 0,
  };
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
export async function httpCfgApply(patch: { atmo?: Record<string, number>; universes?: Record<string, CfgUniversesValues> }): Promise<CfgAction> {
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
