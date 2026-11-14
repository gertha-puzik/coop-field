/**
 * Публичное чтение новостей доски главной (GET /cfg/news).
 * Пишется только админкой — POST /cfg/news живёт в http-admin-ops.ts
 * (обход nginx; литерал /admin/news не попадает в grotto-бандл меню).
 */
import { apiFetch, asText, type ApiRow } from './http-auth';

export type HomeNewsItem = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
};

export type HomeNewsAction =
  | { ok: true; items: HomeNewsItem[]; updatedAt: number }
  | { ok: false; reason: string; details?: string };

function parseItem(row: ApiRow): HomeNewsItem | null {
  const id = asText(row.id);
  const title = asText(row.title);
  const body = asText(row.body);
  if (!id || !title || !body) return null;
  return { id, title, body, pinned: row.pinned === true };
}

/** GET /cfg/news — доступно обоим сайтам (тот же room-сервер). */
export async function httpHomeNews(): Promise<HomeNewsAction> {
  const { status, row, text } = await apiFetch('/cfg/news');
  if (status === 200 && row?.ok === true) {
    const raw = Array.isArray(row.items) ? row.items : [];
    const items: HomeNewsItem[] = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const it = parseItem(item as ApiRow);
      if (it) items.push(it);
    }
    return {
      ok: true,
      items,
      updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
    };
  }
  return {
    ok: false,
    reason: status === 0 ? 'offline' : asText(row?.reason, `http_${status}`),
    details: text || undefined,
  };
}
