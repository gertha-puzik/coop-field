/**
 * Уведомления колокольчика + админ-анонсы.
 * Литералы /cfg/notifications/* и /cfg/announcements* только здесь
 * (обход прод-nginx через location /cfg).
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";

const IS_ELYRIA = process.env.NEXT_PUBLIC_SITE === "elyria";

function route(path: string): string {
  if (!IS_ELYRIA) return "/dev/null";
  if (path.startsWith("/notifications")) return `/cfg${path}`;
  if (path.startsWith("/admin/announcements")) {
    return `/cfg/announcements${path.slice("/admin/announcements".length)}`;
  }
  return path;
}

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: number;
};

export type NotificationsMe = { items: NotificationItem[]; unread: number };

function parseItem(row: Record<string, unknown>): NotificationItem | null {
  const id = asText(row.id);
  if (!id) return null;
  return {
    id,
    type: asText(row.type),
    title: asText(row.title),
    body: asText(row.body),
    payload: row.payload && typeof row.payload === "object" ? (row.payload as Record<string, unknown>) : {},
    read: !!row.read,
    createdAt: Number(row.createdAt) || 0,
  };
}

export async function httpNotificationsMe(): Promise<NotificationsMe | null> {
  const { status, row } = await apiFetch(route("/notifications/me"));
  if (status !== 200 || row?.ok !== true) return null;
  const items = Array.isArray(row.items)
    ? row.items
        .map((x) => (x && typeof x === "object" ? parseItem(x as Record<string, unknown>) : null))
        .filter((x): x is NotificationItem => !!x)
    : [];
  const unread = Number.isFinite(Number(row.unread)) ? Number(row.unread) : items.filter((i) => !i.read).length;
  return { items, unread };
}

export async function httpNotificationsRead(opts: {
  ids?: string[];
  all?: boolean;
}): Promise<{ ok: boolean; unread: number }> {
  const { status, row } = await apiFetch(route("/notifications/me/read"), {
    method: "POST",
    body: opts,
  });
  if (status === 200 && row?.ok === true) {
    return { ok: true, unread: Number(row.unread) || 0 };
  }
  return { ok: false, unread: 0 };
}

/** Админ-анонсы. */
export type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  createdAt: number;
  authorLogin: string;
  delivered: number;
};

export async function httpAdminAnnouncements(): Promise<AnnouncementRow[]> {
  const { status, row } = await apiFetch(route("/admin/announcements"));
  if (status !== 200 || row?.ok !== true || !Array.isArray(row.items)) return [];
  return row.items
    .map((x) => {
      if (!x || typeof x !== "object") return null;
      const r = x as Record<string, unknown>;
      const id = asText(r.id);
      if (!id) return null;
      return {
        id,
        title: asText(r.title),
        body: asText(r.body),
        createdAt: Number(r.createdAt) || 0,
        authorLogin: asText(r.authorLogin),
        delivered: Number(r.delivered) || 0,
      };
    })
    .filter((x): x is AnnouncementRow => !!x);
}

export async function httpAdminAnnouncementCreate(
  title: string,
  body: string,
): Promise<{ ok: boolean; reason?: string }> {
  const { status, row } = await apiFetch(route("/admin/announcements"), {
    method: "POST",
    body: { title, body },
  });
  if (status === 200 && row?.ok === true) return { ok: true };
  return { ok: false, reason: asText(row?.reason, "failed") };
}

export async function httpAdminAnnouncementDelete(id: string): Promise<{ ok: boolean; reason?: string }> {
  const { status, row } = await apiFetch(route("/admin/announcements/delete"), {
    method: "POST",
    body: { id },
  });
  if (status === 200 && row?.ok === true) return { ok: true };
  return { ok: false, reason: asText(row?.reason, "failed") };
}
