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

/** Публичный каталог локаций (GET /cfg/locations; алиас /locations). */
export async function httpLocations(): Promise<LocationsListAction> {
  const { status, row } = await apiFetch("/cfg/locations");
  if (status === 200 && row?.ok === true) {
    return { ok: true, locations: parseLocationPlaces(row.locations), rooms: parseRooms(row.rooms) };
  }
  return locationsErrorOf(row, status, "error");
}

export type LocationCreateAction =
  | { ok: true; place: LocationPlace; locations: LocationPlace[]; room: string }
  | LocationsError;

/** Создать локацию (POST /cfg/locations, admin). Без литерала /admin/ — безопасно для grotto-бандла. */
export async function httpCreateLocation(name?: string): Promise<LocationCreateAction> {
  const body = name && name.trim() ? { name: name.trim() } : {};
  const { status, row } = await apiFetch("/cfg/locations", { method: "POST", body });
  if (status === 200 && row?.ok === true) {
    const place = asLocationPlace(row.place && typeof row.place === "object" ? (row.place as ApiRow) : null);
    if (!place) return locationsErrorOf(row, status, "invalid");
    return {
      ok: true,
      place,
      locations: parseLocationPlaces(row.locations),
      room: asText(row.room, `test-loc-${place.id}`),
    };
  }
  return locationsErrorOf(row, status, "create_failed");
}
