"use client";

import * as React from "react";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";

interface AppDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
  /**
   * Set true when `children` is read-only content with no focusable
   * descendant of its own (a summary list, a preview) — axe's
   * scrollable-region-focusable rule needs the scrollable body itself to be
   * keyboard-reachable in that case. Leave false (the default) for any
   * drawer whose content already has its own focusable elements (a form):
   * making the wrapper focusable there would out-rank the form's own first
   * field for the Sheet's open-time autofocus.
   */
  contentTabIndex?: boolean;
}

/** Shared drawer shell. Every drawer in the portal (creation forms, detail panels) should render through this so open/close, header and footer stay consistent. */
export function AppDrawer({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  contentTabIndex = false,
}: AppDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        <div
          className="flex-1 overflow-y-auto px-4"
          tabIndex={contentTabIndex ? 0 : undefined}
        >
          {children}
        </div>
        {footer && <SheetFooter>{footer}</SheetFooter>}
      </SheetContent>
    </Sheet>
  );
}
