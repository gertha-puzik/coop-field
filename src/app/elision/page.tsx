import type { Metadata } from "next";
import Simulator from "@/components/sim/simulator";
import { AuthGate } from "@/components/menu/auth-gate";
// Пересводка W2 (2026-11-08): общая шапка сайта над симулятором — тонкая
// стеклянная полоса сверху (экран входа и поле; слот селекта темы и
// «Мой профиль» из пересводки-предшественницы демонтированы: их несёт шапка).
import { SiteHeader } from "@/components/site/site-header";

export const metadata: Metadata = {
  title: "Wanderpaws: Elysiae",
  description: "Твой путь начинается здесь. Закрытая локация: мирная ходьба, редактор, сутки. Нужен аккаунт.",
};

export default function ElisionPage() {
  return (
    <AuthGate>
      <SiteHeader />
      <Simulator mode="elision" />
    </AuthGate>
  );
}
