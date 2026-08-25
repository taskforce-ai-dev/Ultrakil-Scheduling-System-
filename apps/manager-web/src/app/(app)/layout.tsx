import { AppShell } from "@/components/shared/app-shell";
import { RouteGuard } from "@/components/shared/route-guard";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RouteGuard>
      <AppShell>{children}</AppShell>
    </RouteGuard>
  );
}
