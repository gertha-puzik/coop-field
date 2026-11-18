export type StatsRules = {
  startEnergy: number;
  travelCost: number;
  sprintCost: number;
  sprintSeconds: number;
  regenSeconds: number;
  startComfort: number;
  comfortFloor: number;
  comfortLoss: number;
  comfortMinutes: number;
  bonusStep: number;
  bonusPercent: number;
};

export type PlayerStats = {
  energy: number;
  comfort: number;
  bonus: number;
  recovering: boolean;
  canSprint: boolean;
  rules: StatsRules;
};

export type ItemUseEntry = { id: string; name: string; at: number; energy: number; comfort: number };
export type ItemUsePage = { entries: ItemUseEntry[]; nextOffset: number | null };
