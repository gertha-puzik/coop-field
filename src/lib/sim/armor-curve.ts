// ============================================================
// Живая кривая брони (мандат владелицы 2026-11-08, «Броня: уровни
// защиты — сделай чтоб можно было добавлять значения»).
//
// Чистая параметризованная математика кривой: интерполяция по массиву
// пар [броня, урон%] — ТУТ ЖЕ формула, которой сервер режет урон
// (server/combat.js armorMultiplier), но кривая приходит ПАРАМЕТРОМ.
// Канон W3 — ARMOR_CURVE из settings.ts (побайтовое зеркало
// server/protocol.js, паритет держит test:protocol-parity); он остаётся
// fallback-ом: сборка обязана быть безопасной при оффлайне/пустом ответе.
// Живое значение приходит из публичного GET /cfg (combat.armorCurve —
// ключ реестра), канал — src/lib/net/cfg-live.ts (по образцу universes).
//
// Движок (simulator.tsx/simulator/*) НЕ трогается: потребители —
// UI-прогнозы урона (entry-screen, settings-panel).
// ============================================================

/** Точка кривой: [броня 0..0,9, проходящий урон% 5..60]. */
export type ArmorCurvePoint = readonly [number, number];
/** Кривая брони: 2..16 точек, x строго возрастает, y не растёт (защита). */
export type ArmorCurve = ReadonlyArray<ArmorCurvePoint>;

import { ARMOR_CURVE } from "./settings.ts";

/** Множитель полученного урона при броне a (0–0,9) по заданной кривой:
 *  проходящий урон / урон первой точки (первая точка = масштаб 100%).
 *  Зеркало сервера: server/combat.js armorMultiplier (правила одинаковы,
 *  значения проходят test:protocol-parity + золотые модуль-смоуки). */
export function armorMultiplierOn(curve: ArmorCurve, armor: number): number {
  const a = Number.isFinite(armor) ? Math.min(0.9, Math.max(0, Number(armor))) : 0;
  if (curve.length < 2) return 1;
  const base = curve[0][1];
  if (a <= curve[0][0]) return 1;
  for (let i = 1; i < curve.length; i++) {
    const [a1, p1] = curve[i];
    if (a <= a1) {
      const [a0, p0] = curve[i - 1];
      return Math.max(0, (p0 + ((p1 - p0) * (a - a0)) / (a1 - a0)) / base);
    }
  }
  const [a0, p0] = curve[curve.length - 2];
  const [a1, p1] = curve[curve.length - 1];
  // Последний отрезок задаёт наклон экстраполяции до 0,9 — как канон W3.
  return Math.max(0, (p1 + ((p1 - p0) * (a - a1)) / (a1 - a0)) / base);
}

/** Множитель для пресета уровня k (0..9 → 0,0..0,9) по заданной кривой. */
export function armorLevelMultiplierOn(curve: ArmorCurve, level: number): number {
  return armorMultiplierOn(curve, level / 10);
}

/** Пригодность сырого значения как живой кривой: массив из 2..16
 *  валидных пар [броня 0..0,9, урон 5..60], x строго возрастает,
 *  урон% не растёт — правила валидатора сервера (sanitizePoints).
 *  Всё, что не прошло, → канон (fail-safe сборки при оффлайне). */
export function isLiveArmorCurve(raw: unknown): raw is ArmorCurve {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 16) return false;
  let prevX = -Infinity;
  let prevY = Infinity;
  for (const item of raw) {
    if (!Array.isArray(item) || item.length !== 2) return false;
    const x = Number(item[0]);
    const y = Number(item[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x < 0 || x > 0.9 || y < 5 || y > 60) return false;
    if (!(x > prevX) || y > prevY) return false;
    prevX = x;
    prevY = y;
  }
  return true;
}

/** Живая кривая с сервера или канон W3 — единая точка fallback-а для UI. */
export function armorCurveOrCanon(raw: unknown): ArmorCurve {
  return isLiveArmorCurve(raw) ? raw : ARMOR_CURVE;
}
