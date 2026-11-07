import type { Metadata } from "next";

import PlayersCatalog from "@/components/players/players-catalog";

export const metadata: Metadata = {
  title: "Wanderpaws: Игроки",
  description: "Каталог игроков закрытой локации: публичные карточки.",
};

export default function PlayersPage() {
  return <PlayersCatalog />;
}
