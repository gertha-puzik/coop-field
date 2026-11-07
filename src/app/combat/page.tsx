import type { Metadata } from "next";
import Simulator from "@/components/sim/simulator";

export const metadata: Metadata = {
  title: "Активный бой — abnocw",
  description: "Открытая комната с клеточным боем Coop Field. Гости заходят без аккаунта.",
};

export default function CombatPage() {
  return <Simulator mode="combat" />;
}
