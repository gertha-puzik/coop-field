import type { Metadata } from "next";
import { HungerGate } from "@/components/menu/wander-gate";
import { MODE_COPY, tabTitle } from "@/lib/net/modes";

const title = tabTitle(MODE_COPY.hunger.title);
const description = "Великие игры Пузорящиков, находятся в разработке.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  openGraph: { title, description },
};

export default function HungerPage() {
  return <HungerGate />;
}
