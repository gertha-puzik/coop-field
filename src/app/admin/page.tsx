import type { Metadata } from "next";

import CfgDashboard from "@/components/admin/cfg-dashboard";
import { AuthGate } from "@/components/menu/auth-gate";
import { tabTitle } from "@/lib/net/modes";

const title = tabTitle("дашборд конфига");
const description = "Панель администратора закрытой локации.";

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  openGraph: { title, description },
};

export default function AdminPage() {
  return (
    <AuthGate>
      <CfgDashboard />
    </AuthGate>
  );
}
