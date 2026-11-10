import type { Metadata } from "next";

import PlayersCatalog from "@/components/players/players-catalog";
import { AuthGate } from "@/components/menu/auth-gate";
import { tabTitle } from "@/lib/net/modes";

const title = tabTitle("Игроки");
const description = "Каталог игроков закрытой локации: публичные карточки.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  openGraph: { title, description },
};

export default function PlayersPage() {
  return (
    <AuthGate>
      <PlayersCatalog />
    </AuthGate>
  );
}
