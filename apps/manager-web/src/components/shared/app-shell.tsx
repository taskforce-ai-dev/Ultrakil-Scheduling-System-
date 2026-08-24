"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  FileText,
  HardHat,
  Car,
  ClipboardList,
  AlertTriangle,
  History,
  Menu,
  LogOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetTrigger,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/customers", label: "Customers", icon: Users },
  { href: "/service-agreements", label: "Service Agreements", icon: FileText },
  { href: "/workforce", label: "Workforce", icon: HardHat },
  { href: "/vehicles", label: "Vehicles", icon: Car },
  { href: "/dispatch-board", label: "Dispatch Board", icon: ClipboardList },
  { href: "/unassigned-visits", label: "Unassigned Visits", icon: AlertTriangle },
  { href: "/schedule-history", label: "Schedule History", icon: History },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-1">
      {NAV_ITEMS.map((item) => {
        const isActive = pathname === item.href;
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 border-r bg-background lg:flex lg:flex-col">
        <div className="flex h-14 items-center border-b px-4">
          <span className="font-semibold">UltraKIL</span>
        </div>
        <div className="flex-1 overflow-y-auto p-3">
          <NavLinks />
        </div>
        <div className="flex items-center justify-between gap-2 border-t p-3">
          <span className="truncate text-sm text-muted-foreground">{user?.name}</span>
          <Button variant="ghost" size="icon" aria-label="Sign out" onClick={logout}>
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b px-4 lg:hidden">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger
              render={
                <Button variant="ghost" size="icon" aria-label="Open navigation menu">
                  <Menu className="h-5 w-5" />
                </Button>
              }
            />
            <SheetContent side="left" className="w-64 p-0">
              <SheetTitle className="flex h-14 items-center border-b px-4 text-base">
                UltraKIL
              </SheetTitle>
              <div className="flex-1 p-3">
                <NavLinks onNavigate={() => setMobileNavOpen(false)} />
              </div>
              <div className="flex items-center justify-between gap-2 border-t p-3">
                <span className="truncate text-sm text-muted-foreground">{user?.name}</span>
                <Button variant="ghost" size="icon" aria-label="Sign out" onClick={logout}>
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </SheetContent>
          </Sheet>
          <span className="font-semibold">UltraKIL</span>
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
