import type { Metadata } from "next";
import { WanderMenu } from "@/components/menu/wander-gate";

export const metadata: Metadata = {
  title: "Wanderpaws",
  description: "Твой путь начинается здесь",
};

export default function Home() {
  return <WanderMenu />;
}
