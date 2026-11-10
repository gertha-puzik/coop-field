import type { Metadata } from "next";
import { GameBoot } from "@/components/sim/game-boot";
import Simulator from "@/components/sim/simulator";
import { AuthGate } from "@/components/menu/auth-gate";
import { MODE_COPY, tabTitle } from "@/lib/net/modes";
// Пересводка W2 (2026-11-08): общая шапка сайта над симулятором — тонкая
// стеклянная полоса сверху (экран входа и поле; слот селекта темы и
// «Мой профиль» из пересводки-предшественницы демонтированы: их несёт шапка).
import { SiteHeader } from "@/components/site/site-header";

const title = tabTitle(MODE_COPY.elision?.title);
const description = "Твой путь начинается здесь. Закрытая локация: мирная ходьба, редактор, сутки. Нужен аккаунт.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  openGraph: { title, description },
};

export default function ElisionPage() {
  return (
    <AuthGate>
      <SiteHeader />
      <GameBoot>
        <Simulator mode="elision" />
      </GameBoot>
    </AuthGate>
  );
}
