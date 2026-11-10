import type { Metadata } from "next";
import Simulator from "@/components/sim/simulator";
import { MODE_COPY, tabTitle } from "@/lib/net/modes";

const title = tabTitle(MODE_COPY.beer.title);
const description = "Симуляция активного боя из игры Catwar. Пивные гроты, гости заходят без аккаунта.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  openGraph: { title, description },
};

export default function CombatPage() {
  // Гроты — режим «beer»: код «combat» снят с клиента (P3), старые ссылки
  // алиасит сервер (P1), а страница /combat/ остаётся входом в гроты.
  return <Simulator mode="beer" />;
}
