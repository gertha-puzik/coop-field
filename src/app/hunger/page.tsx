import type { Metadata } from "next";
import { HungerGate } from "@/components/menu/wander-gate";

export const metadata: Metadata = {
  title: "Wanderpaws: Hunger Games",
  description: "Великие игры Пузорящиков, находятся в разработке.",
};

export default function HungerPage() {
  return <HungerGate />;
}
