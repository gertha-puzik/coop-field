/**
 * Друзья: заявки и список. Литералы /friends/* только здесь.
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import type { PresenceTone } from "./http-presence";

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === "elyria";

function friendsRoute(path: string): string {
  return IS_ELYRIA ? path : "/dev/null";
}

export type FriendCard = {
  accountId: string;
  displayName: string;
  avatar: string | null;
  presence: PresenceTone;
  requestedAt?: number;
};

export type FriendRelation = "none" | "friends" | "outgoing" | "incoming" | "self";

export type FriendsMe = {
  friends: FriendCard[];
  incoming: FriendCard[];
  outgoing: FriendCard[];
};

function asPresence(v: unknown): PresenceTone {
  const s = asText(v, "resting");
  return ["online", "traveling", "away", "resting"].includes(s) ? (s as PresenceTone) : "resting";
}

function parseFriend(row: Record<string, unknown> | null): FriendCard | null {
  if (!row) return null;
  const accountId = asText(row.accountId);
  if (!accountId) return null;
  return {
    accountId,
    displayName: asText(row.displayName, accountId),
    avatar: asText(row.avatar) || null,
    presence: asPresence(row.presence),
    requestedAt: Number.isFinite(Number(row.requestedAt)) ? Number(row.requestedAt) : undefined,
  };
}

function parseList(raw: unknown): FriendCard[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x) => (x && typeof x === "object" ? parseFriend(x as Record<string, unknown>) : null))
    .filter((x): x is FriendCard => !!x);
}

export async function httpFriendsMe(): Promise<FriendsMe | null> {
  const { status, row } = await apiFetch(friendsRoute("/friends/me"));
  if (status !== 200 || row?.ok !== true) return null;
  return {
    friends: parseList(row.friends),
    incoming: parseList(row.incoming),
    outgoing: parseList(row.outgoing),
  };
}

export async function httpFriendsOf(accountId: string): Promise<FriendCard[]> {
  const { status, row } = await apiFetch(
    friendsRoute(`/friends/${encodeURIComponent(accountId)}`),
  );
  if (status !== 200 || row?.ok !== true) return [];
  return parseList(row.friends);
}

async function mutate(path: string, accountId: string): Promise<{ ok: boolean; reason?: string; status?: string }> {
  const { status, row } = await apiFetch(friendsRoute(path), {
    method: "POST",
    body: { accountId },
  });
  if (status === 200 && row?.ok === true) {
    return { ok: true, status: asText(row.status) || asText(row.already) || "ok" };
  }
  return {
    ok: false,
    reason: status === 401 ? "auth_required" : asText(row?.reason, "failed"),
  };
}

export const httpFriendRequest = (id: string) => mutate("/friends/request", id);
export const httpFriendAccept = (id: string) => mutate("/friends/accept", id);
export const httpFriendDecline = (id: string) => mutate("/friends/decline", id);
export const httpFriendCancel = (id: string) => mutate("/friends/cancel", id);
export const httpFriendRemove = (id: string) => mutate("/friends/remove", id);

export function humanFriendError(reason: string | undefined, fallback: string): string {
  switch (reason) {
    case "auth_required":
      return "Нужен вход в аккаунт.";
    case "self":
      return "Нельзя добавить самого себя.";
    case "unknown":
      return "Игрок не найден.";
    case "no_request":
      return "Заявки уже нет.";
    case "not_friends":
      return "Вы не в друзьях.";
    case "csrf_origin_required":
    case "csrf":
      return "Запрос отклонён защитой — обновите страницу.";
    default:
      return fallback;
  }
}
