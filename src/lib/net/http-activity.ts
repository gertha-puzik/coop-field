/**
 * Лента «Последние действия» профиля (спека 2026-11-14).
 * Литерал /cfg/activity только здесь (обход прод-nginx через location /cfg).
 */
import { apiFetch, asText } from "./http-auth";

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === "elyria";

export type ActivityType =
  | "joined_site"
  | "entered_game"
  | "moved"
  | "friend_added"
  | "avatar_changed"
  | "banner_changed";

export type ActivityItem = {
  id: string;
  type: ActivityType;
  at: number;
  data: { label?: string; locationId?: number; friendId?: string; friendName?: string };
};

const TYPES: readonly ActivityType[] = [
  "joined_site",
  "entered_game",
  "moved",
  "friend_added",
  "avatar_changed",
  "banner_changed",
];

function parseItem(raw: unknown): ActivityItem | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const type = asText(row.type) as ActivityType;
  const at = Number(row.at);
  if (!TYPES.includes(type) || !Number.isFinite(at)) return null;
  const d = row.data && typeof row.data === "object" ? (row.data as Record<string, unknown>) : {};
  const data: ActivityItem["data"] = {};
  if (asText(d.label)) data.label = asText(d.label);
  if (Number.isFinite(Number(d.locationId))) data.locationId = Number(d.locationId);
  if (asText(d.friendId)) data.friendId = asText(d.friendId);
  if (asText(d.friendName)) data.friendName = asText(d.friendName);
  return { id: asText(row.id, `${type}-${at}`), type, at, data };
}

export async function httpActivity(
  accountId: string,
): Promise<{ ok: true; items: ActivityItem[] } | { ok: false; reason: string }> {
  if (!IS_ELYRIA || !accountId) return { ok: false, reason: "not_found" };
  const { status, row } = await apiFetch(`/cfg/activity/${encodeURIComponent(accountId)}`);
  if (status !== 200 || row?.ok !== true) return { ok: false, reason: asText(row?.reason, "failed") };
  const list = Array.isArray(row.items) ? row.items : [];
  return { ok: true, items: list.map(parseItem).filter((x): x is ActivityItem => !!x) };
}
