export const MAX_WATER_DEPTH = 4;
export const DEFAULT_WATER_RULES = {
  slow1: 30, slow2: 45, slow3: 60, slow4: 80,
  sink1: 10, sink2: 15, sink3: 35, sink4: 45,
  submergedOpacity: 20, swimDepth: 4,
  drainDepth: 3, drainSeconds: 3, drainEnergy: 3,
};

export type WaterRules = typeof DEFAULT_WATER_RULES;
export const WATER_FIELDS = [
  ['slow1', 'Замедление на глубине 1 (%)', 0, 99],
  ['slow2', 'Замедление на глубине 2 (%)', 0, 99],
  ['slow3', 'Замедление на глубине 3 (%)', 0, 99],
  ['slow4', 'Замедление на глубине 4 (%)', 0, 99],
  ['sink1', 'Погружение модели на глубине 1 (%)', 0, 99],
  ['sink2', 'Погружение модели на глубине 2 (%)', 0, 99],
  ['sink3', 'Погружение модели на глубине 3 (%)', 0, 99],
  ['sink4', 'Погружение модели на глубине 4 (%)', 0, 99],
  ['submergedOpacity', 'Непрозрачность под водой (%)', 0, 100],
  ['swimDepth', 'Глубина начала плавания', 1, 4],
  ['drainDepth', 'Глубина начала расхода энергии', 1, 4],
  ['drainSeconds', 'Интервал расхода (секунды)', 1, 600],
  ['drainEnergy', 'Расход энергии за интервал (%)', 0, 100],
] as const;

export function normalizeWaterRules(value: unknown): WaterRules | null {
  if (!value || typeof value !== 'object') return null;
  const rules = { ...DEFAULT_WATER_RULES };
  for (const [key, , min, max] of WATER_FIELDS) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field !== 'number' || !Number.isInteger(field) || field < min || field > max) return null;
    rules[key] = field;
  }
  return rules;
}

export function waterSpeed(rules: WaterRules, depth: number) {
  return 1 - ([0, rules.slow1, rules.slow2, rules.slow3, rules.slow4][depth] ?? 0) / 100;
}


export function submergedPixels(rules: WaterRules, depth: number, height: number, jump = 0) {
  const percent = [0, rules.sink1, rules.sink2, rules.sink3, rules.sink4][depth] ?? 0;
  return Math.max(0, height*percent/100 - jump);
}
