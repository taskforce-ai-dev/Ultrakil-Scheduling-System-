"use client";

import * as React from "react";
import { AlertTriangle, Minus, Plus, RefreshCw, ShieldCheck } from "lucide-react";

import { AppDrawer } from "@/components/shared/app-drawer";
import { LoadingState } from "@/components/shared/loading-state";
import { protectionLabel } from "@/components/shared/visit-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  confirmVisitGeneration,
  previewVisitGeneration,
  type GenerationImpact,
} from "@/lib/api-client";
import { formatLongDate } from "@/lib/calendar";
import { notify } from "@/lib/notify";

interface GenerationImpactDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The visible calendar range. Generation applies to exactly what is on screen. */
  from: string;
  to: string;
  branchCode?: "COLOMBO" | "KANDY";
  /** Called after a confirmed run, so the calendar reloads. */
  onConfirmed: () => void;
}

function Section({
  icon: Icon,
  title,
  count,
  tone,
  children,
}: {
  icon: React.ElementType;
  title: string;
  count: number;
  tone?: "danger";
  children?: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Icon
          className={tone === "danger" ? "h-4 w-4 text-destructive" : "h-4 w-4"}
          aria-hidden="true"
        />
        {title}
        <Badge variant={count === 0 ? "outline" : tone === "danger" ? "destructive" : "secondary"}>
          {count}
        </Badge>
      </h3>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">None.</p>
      ) : (
        <ul className="space-y-1.5 text-sm">{children}</ul>
      )}
    </section>
  );
}

/** The API's removal reasons, in words a manager reads rather than an enum. */
const REMOVAL_REASON: Record<string, string> = {
  NO_LONGER_REQUIRED: "the agreement no longer asks for it",
};

/** At most eight rows, then a count. A month on real data runs to hundreds. */
function capped<T>(items: T[]): { shown: T[]; hidden: number } {
  return { shown: items.slice(0, 8), hidden: Math.max(0, items.length - 8) };
}

/**
 * What regeneration would do, before it does any of it.
 *
 * Preview and confirm are separate calls against the same range, so what is
 * listed here is what gets applied — the manager is never told one thing and
 * given another. Protected visits are shown as prominently as additions, since
 * "this will be left alone" is the reassurance the whole screen exists to give.
 */
export function GenerationImpactDrawer({
  open,
  onOpenChange,
  from,
  to,
  branchCode,
  onConfirmed,
}: GenerationImpactDrawerProps) {
  const [impact, setImpact] = React.useState<GenerationImpact | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isConfirming, setIsConfirming] = React.useState(false);
  // A ref alongside the state: two clicks fired in the same tick (a fast
  // double-click) both close over the same pre-update `isConfirming`, so the
  // state check alone can't stop the second one.
  const isConfirmingRef = React.useRef(false);

  const loadPreview = React.useCallback(() => {
    if (!open) return;
    setIsLoading(true);
    setError(null);
    setImpact(null);
    previewVisitGeneration({ from, to, branchCode })
      .then(setImpact)
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught.message
            : "Could not work out what generation would change."
        );
      })
      .finally(() => setIsLoading(false));
  }, [open, from, to, branchCode]);

  // Re-preview whenever the drawer opens or the visible range moves. The
  // preview must always describe the range the manager is looking at.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadPreview();
  }, [loadPreview]);

  async function confirm() {
    if (isConfirmingRef.current) return; // Collapses a double-click into one request.
    isConfirmingRef.current = true;
    setIsConfirming(true);
    try {
      const result = await confirmVisitGeneration({ from, to, branchCode });
      notify.success(
        result.additions.length === 0 && result.updates.length === 0
          ? "Nothing to change — the calendar already matches the agreements."
          : `${result.additions.length} visits created, ${result.updates.length} updated.`
      );
      onConfirmed();
      onOpenChange(false);
    } catch (caught) {
      notify.error(
        caught instanceof ApiError ? caught.message : "Could not generate the visits."
      );
    } finally {
      isConfirmingRef.current = false;
      setIsConfirming(false);
    }
  }

  const nothingToDo =
    impact !== null &&
    impact.additions.length === 0 &&
    impact.updates.length === 0 &&
    impact.removals.length === 0;

  return (
    <AppDrawer
      open={open}
      onOpenChange={onOpenChange}
      title="Generate visits"
      description={`${formatLongDate(from)} to ${formatLongDate(to)}`}
      // This body is a read-only impact summary — no form fields, nothing
      // for the Sheet's open-time autofocus to prefer instead.
      contentTabIndex
      footer={
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={isLoading || isConfirming || !impact || nothingToDo}>
            {isConfirming ? "Generating…" : "Generate"}
          </Button>
        </div>
      }
    >
      {isLoading ? (
        <LoadingState rows={4} />
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : impact ? (
        <div className="space-y-6 pb-4">
          <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">
            Nothing has been written yet. This is what pressing Generate would do to{" "}
            <strong>{impact.agreementsConsidered}</strong>{" "}
            {impact.agreementsConsidered === 1 ? "agreement" : "agreements"}
            {branchCode ? ` in ${branchCode}` : ""}.
          </p>

          <Section icon={Plus} title="Visits to create" count={impact.additions.length}>
            {capped(impact.additions).shown.map((visit, index) => (
              <li key={`${visit.serviceAgreementId}-${visit.visitDate}-${index}`}>
                <span className="font-medium">{visit.visitDate}</span> — {visit.customerName},{" "}
                {visit.siteName}
              </li>
            ))}
            {capped(impact.additions).hidden > 0 && (
              <li className="text-muted-foreground">
                and {capped(impact.additions).hidden} more
              </li>
            )}
          </Section>

          <Section icon={RefreshCw} title="Safe changes" count={impact.updates.length}>
            {capped(impact.updates).shown.map((update) => (
              <li key={update.visitId}>
                <span className="font-medium">{update.visitDate}</span> — {update.customerName}
                {update.changes.length > 0 && (
                  <span className="text-muted-foreground">
                    {" "}
                    ({update.changes
                      .map((change) => `${change.field} ${change.from} → ${change.to}`)
                      .join(", ")}
                    )
                  </span>
                )}
              </li>
            ))}
            {capped(impact.updates).hidden > 0 && (
              <li className="text-muted-foreground">
                and {capped(impact.updates).hidden} more
              </li>
            )}
          </Section>

          <Section icon={Minus} title="No longer required" count={impact.removals.length}>
            {capped(impact.removals).shown.map((removal) => (
              <li key={removal.visitId}>
                <span className="font-medium">{removal.visitDate}</span> — {removal.customerName}
                <span className="text-muted-foreground">
                  {" "}
                  ({REMOVAL_REASON[removal.reason] ?? removal.reason})
                </span>
              </li>
            ))}
            {capped(impact.removals).hidden > 0 && (
              <li className="text-muted-foreground">
                and {capped(impact.removals).hidden} more
              </li>
            )}
          </Section>

          <Section
            icon={ShieldCheck}
            title="Protected — will not be touched"
            count={impact.protectedVisits.length}
          >
            {capped(impact.protectedVisits).shown.map((visit) => (
              <li key={visit.visitId}>
                <span className="font-medium">{visit.visitDate}</span> — {visit.customerName}
                <span className="text-muted-foreground">
                  {" "}
                  ({protectionLabel(visit.protection)}; generation would have{" "}
                  {visit.wouldHave === "REMOVE" ? "removed" : "updated"} it)
                </span>
              </li>
            ))}
            {capped(impact.protectedVisits).hidden > 0 && (
              <li className="text-muted-foreground">
                and {capped(impact.protectedVisits).hidden} more
              </li>
            )}
          </Section>

          <Section
            icon={AlertTriangle}
            title="Conflicts"
            count={impact.shortfalls.length}
            tone="danger"
          >
            {capped(impact.shortfalls).shown.map((shortfall, index) => (
              <li key={`${shortfall.serviceAgreementId}-${shortfall.periodStart}-${index}`}>
                <span className="font-medium">
                  {shortfall.customerName}, {shortfall.siteName}
                </span>
                <br />
                <span className="text-muted-foreground">
                  {shortfall.periodStart} to {shortfall.periodEnd}: asked for{" "}
                  {shortfall.requested}, can place {shortfall.scheduled}. {shortfall.message}
                </span>
              </li>
            ))}
            {capped(impact.shortfalls).hidden > 0 && (
              <li className="text-muted-foreground">
                and {capped(impact.shortfalls).hidden} more
              </li>
            )}
          </Section>

          <p className="text-sm text-muted-foreground">
            {impact.unchangedCount} visits are already correct and need nothing.
          </p>
        </div>
      ) : null}
    </AppDrawer>
  );
}
