import type { Metadata } from "next";
import { WanderMenu } from "@/components/menu/wander-gate";
import { AuthGate } from "@/components/menu/auth-gate";
import { tabTitle } from "@/lib/net/modes";

const title = tabTitle();
const description = "Твой путь начинается здесь";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  openGraph: { title, description },
};

export default function Home() {
  return (
    <AuthGate live>
      <WanderMenu />
    </AuthGate>
  );
}
