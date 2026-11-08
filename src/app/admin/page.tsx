import type { Metadata } from "next";

import CfgDashboard from "@/components/admin/cfg-dashboard";
import { AuthGate } from "@/components/menu/auth-gate";

export const metadata: Metadata = {
  title: "Wanderpaws: дашборд конфига",
  description: "Панель администратора закрытой локации.",
};

export default function AdminPage() {
  return (
    <AuthGate>
      <CfgDashboard />
    </AuthGate>
  );
}
