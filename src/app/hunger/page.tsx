import type { Metadata } from "next";
import Simulator from "@/components/sim/simulator";

export const metadata: Metadata = {
  title: "Голодные игры — abnocw",
  description: "Открытая комната-каркас. Правила раунда владелицы ещё не задали.",
};

export default function HungerPage() {
  return <Simulator mode="hunger" />;
}
