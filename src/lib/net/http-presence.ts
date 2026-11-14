/**
 * Heartbeat присутствия: сайт / игровая. Литералы /presence/* только здесь.
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";

export type PresenceWhere = "site" | "game";

export type PresenceTone = "online" | "traveling" | "away" | "resting";

export type HeartbeatResult =
  | { ok: true; presence: PresenceTone; playtimeMs: number }
  | { ok: false; reason: string };

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === "elyria";

function presenceRoute(): string {
  return IS_ELYRIA ? "/presence/heartbeat" : "/dev/null";
}

export async function httpPresenceHeartbeat(
  where: PresenceWhere,
  active = true,
): Promise<HeartbeatResult> {
  const { status, row } = await apiFetch(presenceRoute(), {
    method: "POST",
    body: { where, active },
  });
  if (status === 200 && row?.ok === true) {
    const presence = asText(row.presence, "resting") as PresenceTone;
    const playtimeMs = Number(row.playtimeMs);
    return {
      ok: true,
      presence: ["online", "traveling", "away", "resting"].includes(presence)
        ? presence
        : "resting",
      playtimeMs: Number.isFinite(playtimeMs) ? playtimeMs : 0,
    };
  }
  return {
    ok: false,
    reason: status === 401 ? "auth_required" : asText(row?.reason, "failed"),
  };
}
