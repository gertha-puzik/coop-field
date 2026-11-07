import type { Metadata } from "next";
import Simulator from "@/components/sim/simulator";

export const metadata: Metadata = {
  title: "Wanderpaws: Elysiae",
  description: "Твой путь начинается здесь. Закрытая локация: мирная ходьба, редактор, сутки. Нужен аккаунт.",
};

export default function ElisionPage() {
  return <Simulator mode="elision" />;
}
