import type { Metadata } from "next";
import Simulator from "@/components/sim/simulator";

export const metadata: Metadata = {
  title: "abnocw",
  description: "Симуляция активного боя из игры Catwar. Пивные гроты, гости заходят без аккаунта.",
};

export default function CombatPage() {
  // Гроты — режим «beer»: код «combat» снят с клиента (P3), старые ссылки
  // алиасит сервер (P1), а страница /combat/ остаётся входом в гроты.
  return <Simulator mode="beer" />;
}
