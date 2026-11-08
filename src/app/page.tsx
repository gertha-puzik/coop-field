import type { Metadata } from "next";
import { WanderMenu } from "@/components/menu/wander-gate";
import { AuthGate } from "@/components/menu/auth-gate";

export const metadata: Metadata = {
  title: "Wanderpaws",
  description: "Твой путь начинается здесь",
};

export default function Home() {
  return (
    <AuthGate live>
      <WanderMenu />
    </AuthGate>
  );
}
