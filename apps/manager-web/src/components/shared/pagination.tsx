"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface PaginationProps {
  /** 1-based, as the API counts pages. */
  page: number;
  pageSize: number;
  /** The API's own total, not the number of rows currently rendered. */
  total: number;
  onPageChange: (page: number) => void;
  /**
   * Plural noun for what is being counted — "customers", "runs". It appears
   * in the visible range line and in the nav's accessible name, so a screen
   * reader on a page with two lists can tell them apart.
   */
  noun: string;
  /** Held down while a page is in flight, so a double-click can't skip one. */
  disabled?: boolean;
}

export function pageCount(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Server pagination made visible.
 *
 * The truncation this replaces was invisible: a page asked the API for the
 * first N rows and rendered them with nothing to say there were more, so a
 * customer past that boundary simply did not exist as far as the portal was
 * concerned. The range line here is the fix — it states the API's own total,
 * so a manager can always see whether they are looking at all of something.
 *
 * Previous/Next stay rendered even on a single page, disabled. A control that
 * appears only once the data grows is a control nobody learns is there.
 */
export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  noun,
  disabled = false,
}: PaginationProps) {
  const pages = pageCount(total, pageSize);
  const current = Math.min(Math.max(page, 1), pages);
  const firstRow = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const lastRow = Math.min(current * pageSize, total);

  return (
    <nav
      aria-label={`${noun} pagination`}
      className="flex flex-wrap items-center justify-between gap-3 pt-1"
    >
      <p className="text-sm text-muted-foreground" data-testid="pagination-range">
        {total === 0
          ? `No ${noun}`
          : `Showing ${firstRow}–${lastRow} of ${total} ${noun}`}
      </p>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground" aria-hidden="true">
          Page {current} of {pages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(current - 1)}
          disabled={disabled || current <= 1}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Previous
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onPageChange(current + 1)}
          disabled={disabled || current >= pages}
        >
          Next
          <ChevronRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </nav>
  );
}
