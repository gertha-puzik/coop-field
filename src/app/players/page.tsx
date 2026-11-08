import type { Metadata } from "next";

import PlayersCatalog from "@/components/players/players-catalog";
import { AuthGate } from "@/components/menu/auth-gate";

export const metadata: Metadata = {
  title: "Wanderpaws: Игроки",
  description: "Каталог игроков закрытой локации: публичные карточки.",
};

export default function PlayersPage() {
  return (
    <AuthGate>
      <PlayersCatalog />
    </AuthGate>
  );
}
