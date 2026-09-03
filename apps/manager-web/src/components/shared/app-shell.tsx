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
  CalendarDays,
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
  { href: "/visits", label: "Visit Calendar", icon: CalendarDays },
  { href: "/workforce", label: "Workforce", icon: HardHat },
  { href: "/vehicles", label: "Vehicles", icon: Car },
  { href: "/dispatch-board", label: "Dispatch Board", icon: ClipboardList },
  { href: "/unassigned-visits", label: "Unassigned Visits", icon: AlertTriangle },
  { href: "/schedule-history", label: "Schedule History", icon: History },
];

function Brand() {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
        U
      </span>
      <span className="text-base font-semibold tracking-tight text-white">UltraKIL</span>
    </div>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5">
      {NAV_ITEMS.map((item) => {
        const isActive = pathname === item.href;
        const Icon = item.icon;

        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              isActive
                ? "bg-sidebar-primary text-sidebar-primary-foreground shadow-sm"
                : "text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

function UserFooter({ name, onSignOut }: { name?: string; onSignOut: () => void }) {
  const initial = name?.trim().charAt(0).toUpperCase() || "U";

  return (
    <div className="flex items-center justify-between gap-2 border-t border-sidebar-border p-3">
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-sm font-semibold text-sidebar-foreground">
          {initial}
        </span>
        <span className="truncate text-sm font-medium text-sidebar-foreground">{name}</span>
      </div>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sign out"
        onClick={onSignOut}
        className="shrink-0 text-sidebar-foreground/75 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
      >
        <LogOut className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);
  const { user, logout } = useAuth();

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="hidden w-64 shrink-0 bg-sidebar lg:flex lg:flex-col">
        <div className="flex h-14 items-center px-4">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <NavLinks />
        </div>
        <UserFooter name={user?.fullName} onSignOut={logout} />
      </aside>

      {/* min-w-0: without it, this flex item's default min-width:auto lets it
          refuse to shrink below its descendants' min-content width — a wide
          table's whitespace-nowrap cells (already scrollable in their own
          overflow-x-auto container) would otherwise escape that container
          and force the whole page to scroll horizontally. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 bg-sidebar px-4 lg:hidden">
          <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
            <SheetTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Open navigation menu"
                  className="text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
                >
                  <Menu className="h-5 w-5" />
                </Button>
              }
            />
            <SheetContent side="left" className="w-64 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground">
              <SheetTitle className="flex h-14 items-center px-4">
                <Brand />
              </SheetTitle>
              <div className="flex-1 px-3 py-4">
                <NavLinks onNavigate={() => setMobileNavOpen(false)} />
              </div>
              <UserFooter name={user?.fullName} onSignOut={logout} />
            </SheetContent>
          </Sheet>
          <Brand />
        </header>

        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
