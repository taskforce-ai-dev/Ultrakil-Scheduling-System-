"use client";

import * as React from "react";
import { Lock, LockOpen } from "lucide-react";

import { AppDrawer } from "@/components/shared/app-drawer";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import {
  CrewBadge,
  VisitOwnershipBadges,
  VisitStatusBadge,
  protectionLabel,
} from "@/components/shared/visit-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ApiError,
  fetchVisit,
  lockVisit,
  unlockVisit,
  type VisitDetail,
} from "@/lib/api-client";
import { formatLongDate, formatMinuteOfDay } from "@/lib/calendar";
import { notify } from "@/lib/notify";

interface VisitDetailDrawerProps {
  visitId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a lock or unlock, so the calendar behind can refresh. */
  onChanged: () => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[10rem_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

const WEEKDAY_SHORT: Record<string, string> = {
  MONDAY: "Mon",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
  THURSDAY: "Thu",
  FRIDAY: "Fri",
  SATURDAY: "Sat",
  SUNDAY: "Sun",
};

/**
 * Why one visit exists, and the controls for taking it out of generation's
 * hands.
 *
 * The origin block is the point of the panel. It is read from the agreement
 * *version* the visit was generated from, so it keeps explaining the visit
 * correctly after the agreement itself has been edited — which is exactly when
 * a manager asks the question.
 */
export function VisitDetailDrawer({
  visitId,
  onOpenChange,
  onChanged,
}: VisitDetailDrawerProps) {
  const [visit, setVisit] = React.useState<VisitDetail | null>(null);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  const load = React.useCallback(() => {
    if (!visitId) return;
    setVisit(null);
    setIsLoading(true);
    setError(null);
    fetchVisit(visitId)
      .then(setVisit)
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
  }, [visitId]);

  // Fetching from the API — an external system, which is what effects are for.
  // The state resets live inside `load` so nothing sets state in the effect body.
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function toggleLock() {
    if (!visit) return;
    setIsSaving(true);
    try {
      if (visit.isLocked) {
        await unlockVisit(visit.id);
        notify.success("Visit released. The next generation run may move it.");
      } else {
        await lockVisit(visit.id);
        notify.success("Visit locked. Regeneration will leave it exactly as it is.");
      }
      load();
      onChanged();
    } catch (caught) {
      notify.error(
        caught instanceof ApiError ? caught.message : "Could not change the lock."
      );
    } finally {
      setIsSaving(false);
    }
  }

  const protection = protectionLabel(visit?.protectionReason ?? null);

  return (
    <AppDrawer
      open={visitId !== null}
      onOpenChange={onOpenChange}
      title={visit ? visit.customerName : "Visit"}
      description={visit ? formatLongDate(visit.visitDate) : undefined}
      footer={
        visit ? (
          <Button
            variant={visit.isLocked ? "outline" : "default"}
            onClick={toggleLock}
            disabled={isSaving}
          >
            {visit.isLocked ? <LockOpen aria-hidden="true" /> : <Lock aria-hidden="true" />}
            {visit.isLocked ? "Release this visit" : "Lock this visit"}
          </Button>
        ) : undefined
      }
    >
      {isLoading ? (
        <LoadingState rows={4} />
      ) : error ? (
        <ErrorState
          title="Couldn't load this visit"
          description={error.message}
          code={error.code}
          onRetry={load}
        />
      ) : visit ? (
        <div className="space-y-6 pb-4">
          <div className="flex flex-wrap gap-2">
            <VisitStatusBadge status={visit.status} />
            <VisitOwnershipBadges visit={visit} />
            <CrewBadge visit={visit} />
          </div>

          {visit.isProtected && protection && (
            <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              Regeneration will leave this visit alone: <strong>{protection}</strong>.
            </p>
          )}

          <section>
            <h3 className="mb-1 text-sm font-semibold">Why this visit exists</h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Taken from the agreement as it stood when this visit was generated,
              not as it reads today.
            </p>
            <dl className="divide-y divide-border">
              <Row label="Site">{visit.siteName}</Row>
              <Row label="Treatment">{visit.origin.jobTypeName}</Row>
              <Row label="Commitment">{visit.origin.frequencyLabel}</Row>
              <Row label="Agreement version">
                {visit.origin.agreementVersionNumber === null
                  ? "Not recorded"
                  : `Version ${visit.origin.agreementVersionNumber}`}
              </Row>
              <Row label="Allowed days then">
                {visit.origin.allowedDaysAtGeneration.length === 0
                  ? "Not recorded"
                  : visit.origin.allowedDaysAtGeneration
                      .map((day) => WEEKDAY_SHORT[day] ?? day)
                      .join(", ")}
              </Row>
            </dl>
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold">Service window</h3>
            <dl className="divide-y divide-border">
              <Row label="Arrives between">
                {formatMinuteOfDay(visit.windowStartMinute)} and{" "}
                {formatMinuteOfDay(visit.windowEndMinute)}
              </Row>
              <Row label="Takes">{visit.durationMinutes} minutes</Row>
              <Row label="Crew needed">
                {visit.requiredCrewSize}{" "}
                <span className="font-normal text-muted-foreground">
                  ({visit.assignmentCount} assigned)
                </span>
              </Row>
              <Row label="Branch">
                <Badge variant="outline">{visit.branchCode}</Badge>
              </Row>
            </dl>
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold">History</h3>
            <dl className="divide-y divide-border">
              <Row label="Generated">
                {visit.origin.generatedAt
                  ? new Date(visit.origin.generatedAt).toLocaleString()
                  : "Not recorded"}
              </Row>
              <Row label="Schedule run">
                {visit.origin.generatedByRunId ? (
                  <code className="text-xs">{visit.origin.generatedByRunId}</code>
                ) : (
                  "Not recorded"
                )}
              </Row>
              {visit.isManuallyAdjusted && (
                <Row label="Modified by hand">
                  {visit.manuallyAdjustedAt
                    ? new Date(visit.manuallyAdjustedAt).toLocaleString()
                    : "Yes"}
                </Row>
              )}
              {visit.isLocked && (
                <Row label="Lock reason">
                  {visit.lockReason ?? "No reason given"}
                </Row>
              )}
              <Row label="Last updated">
                {new Date(visit.updatedAt).toLocaleString()}
              </Row>
            </dl>
          </section>
        </div>
      ) : null}
    </AppDrawer>
  );
}
