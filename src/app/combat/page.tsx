import type { Metadata } from "next";
import Simulator from "@/components/sim/simulator";

export const metadata: Metadata = {
  title: "abnocw",
  description: "Симуляция активного боя из игры Catwar. Пивные гроты, гости заходят без аккаунта.",
};

export default function CombatPage() {
  return <Simulator mode="combat" />;
}
