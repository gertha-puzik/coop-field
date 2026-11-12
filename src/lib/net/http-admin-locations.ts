/**
 * Создание локаций мира (POST /admin/locations) — только редактор Элизии.
 * Литерал /admin/locations живёт здесь, чтобы grotto-бандл его не тащил.
 */
import { apiFetch, asText, type ApiRow } from "./http-auth";
import type { LocationPlace } from "@/lib/sim/location-map";
import {
  asLocationPlace,
  locationsErrorOf,
  parseLocationPlaces,
  type LocationsError,
} from "./http-locations";

export type LocationCreateAction =
  | { ok: true; place: LocationPlace; locations: LocationPlace[]; room: string }
  | LocationsError;

/** Создать локацию с следующим ID и пустой картой 10×10. */
export async function httpCreateLocation(name?: string): Promise<LocationCreateAction> {
  const body = name && name.trim() ? { name: name.trim() } : {};
  const { status, row } = await apiFetch("/admin/locations", { method: "POST", body });
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
