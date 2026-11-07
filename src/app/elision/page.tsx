import type { Metadata } from "next";
import Simulator from "@/components/sim/simulator";

export const metadata: Metadata = {
  title: "Элизия Эйдес — abnocw",
  description: "Закрытая локация Coop Field: мирная ходьба, редактор, сутки. Нужен аккаунт.",
};

export default function ElisionPage() {
  return <Simulator mode="elision" />;
}
