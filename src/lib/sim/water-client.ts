import { consoleRequest } from '@/lib/net/http-console';
import { DEFAULT_WATER_RULES, normalizeWaterRules, type WaterRules } from './water-rules';

let rules = DEFAULT_WATER_RULES;
export const currentWaterRules = () => rules;
export async function refreshWaterRules() {
  const result = await consoleRequest<{ rules: WaterRules }>('/water');
  if (result.ok) rules = normalizeWaterRules(result.rules) ?? rules;
}
