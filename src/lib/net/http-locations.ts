/**
 * Публичный каталог локаций мира (GET /locations). Без админ-маршрутов —
 * модуль можно тянуть в меню обеих сборок.
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import type { LocationPlace } from "@/lib/sim/location-map";

export type LocationsError = { ok: false; reason: string; message?: string };
export type LocationsListAction =
  | { ok: true; locations: LocationPlace[]; rooms: string[] }
  | LocationsError;

export function asLocationPlace(row: ApiRow | null | undefined): LocationPlace | null {
  if (!row || typeof row !== "object") return null;
  const id = typeof row.id === "number" && Number.isSafeInteger(row.id) ? row.id : Number(row.id);
  const zoneId =
    typeof row.zoneId === "number" && Number.isSafeInteger(row.zoneId) ? row.zoneId : Number(row.zoneId);
  if (!Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(zoneId) || zoneId < 1) return null;
  return {
    id,
    name: asText(row.name, `Локация ${id}`),
    zoneId,
    zoneName: asText(row.zoneName, "Средиземье"),
  };
}

export function parseLocationPlaces(raw: unknown): LocationPlace[] {
  if (!Array.isArray(raw)) return [];
  const out: LocationPlace[] = [];
  for (const entry of raw) {
    const place = asLocationPlace(entry && typeof entry === "object" ? (entry as ApiRow) : null);
    if (place) out.push(place);
  }
  return out;
}

function parseRooms(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.length > 0);
}

export function locationsErrorOf(row: ApiRow | null, status: number, fallback: string): LocationsError {
  return {
    ok: false,
    reason:
      status === 401
        ? "auth_required"
        : status === 403 && row?.reason === "forbidden"
          ? "forbidden"
          : status === 403
            ? "csrf_origin"
            : status === 0
              ? "offline"
              : asText(row?.reason, fallback),
    message: asText(row?.message) || undefined,
  };
}

/** Публичный каталог локаций (GET /locations). */
export async function httpLocations(): Promise<LocationsListAction> {
  const { status, row } = await apiFetch("/locations");
  if (status === 200 && row?.ok === true) {
    return { ok: true, locations: parseLocationPlaces(row.locations), rooms: parseRooms(row.rooms) };
  }
  return locationsErrorOf(row, status, "error");
}
