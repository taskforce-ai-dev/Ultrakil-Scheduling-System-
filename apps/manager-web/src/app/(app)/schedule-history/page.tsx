"use client";

import * as React from "react";
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Play,
  Rocket,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import {
  ApiError,
  cancelScheduleRun,
  fetchScheduleRuns,
  publishScheduleRun,
  startScheduleRun,
  type ScheduleRun,
} from "@/lib/api-client";
import { addDays, todayIso } from "@/lib/calendar";
import { notify } from "@/lib/notify";

type BranchFilter = "ALL" | "COLOMBO" | "KANDY";

const BRANCH_LABELS: Record<BranchFilter, string> = {
  ALL: "Both branches",
  COLOMBO: "Colombo",
  KANDY: "Kandy",
};

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);

/** How often the run list is re-fetched while anything is queued or running. */
const POLL_INTERVAL_MS = 3000;

function StatusBadge({ run }: { run: ScheduleRun }) {
  if (run.status === "QUEUED") {
    return (
      <Badge variant="outline">
        <CircleDashed className="h-3 w-3" aria-hidden="true" />
        Queued
      </Badge>
    );
  }
  if (run.status === "RUNNING") {
    return (
      <Badge variant="outline">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Running — {run.progressPercent}%
      </Badge>
    );
  }
  if (run.status === "FAILED") {
    return (
      <Badge variant="destructive">
        <XCircle className="h-3 w-3" aria-hidden="true" />
        Failed
      </Badge>
    );
  }
  if (run.status === "CANCELLED") {
    return (
      <Badge variant="outline">
        <Ban className="h-3 w-3" aria-hidden="true" />
        Cancelled
      </Badge>
    );
  }
  if (run.status === "SUPERSEDED") {
    return (
      <Badge variant="secondary">
        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
        Superseded
      </Badge>
    );
  }
  // SUCCEEDED
  if (run.isPublished) {
    return (
      <Badge variant="success">
        <Rocket className="h-3 w-3" aria-hidden="true" />
        Published
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
      Draft — ready to publish
    </Badge>
  );
}

/**
 * Generating, cancelling and publishing a schedule (ULK-O06), and the run
 * history that distinguishes draft, published and superseded work.
 *
 * There is no push channel for a run's progress — `POST /schedule-runs`
 * queues the solve and returns immediately (see
 * `apps/api/src/scheduling/optimizer/schedule-runs.controller.ts`). This page
 * polls `GET /schedule-runs` on an interval instead, which is also what makes
 * a refresh or a reconnect mid-run "just work": the next poll (or the load on
 * mount) asks the API for the current truth rather than trusting anything
 * held in memory.
 */
export default function ScheduleHistoryPage() {
  const [runs, setRuns] = React.useState<ScheduleRun[]>([]);
  const [total, setTotal] = React.useState(0);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  const [from, setFrom] = React.useState(todayIso());
  const [to, setTo] = React.useState(addDays(todayIso(), 6));
  const [branch, setBranch] = React.useState<BranchFilter>("ALL");
  const [timeLimitSeconds, setTimeLimitSeconds] = React.useState(20);
  const [isStarting, setIsStarting] = React.useState(false);
  // A ref alongside the state: two clicks fired in the same tick (a real
  // double-click) both close over the same pre-update `isStarting`, so the
  // state check alone can't stop the second one. The ref updates
  // synchronously, before React has scheduled a re-render.
  const isStartingRef = React.useRef(false);

  const [busyRunId, setBusyRunId] = React.useState<string | null>(null);
  // Same double-click hazard as isStartingRef above, for the cancel button.
  const busyRunIdRef = React.useRef<string | null>(null);
  const [publishTarget, setPublishTarget] = React.useState<ScheduleRun | null>(null);
  const [publishReason, setPublishReason] = React.useState("");
  const [isPublishing, setIsPublishing] = React.useState(false);
  const isPublishingRef = React.useRef(false);

  const load = React.useCallback(() => {
    setError(null);
    return fetchScheduleRuns({ pageSize: 50 })
      .then((page) => {
        setRuns(page.items);
        setTotal(page.total);
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
  }, []);

  React.useEffect(() => {
    // Fetching from the API on mount — an external system, which is what
    // effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const hasActiveRun = runs.some((run) => ACTIVE_STATUSES.has(run.status));

  React.useEffect(() => {
    if (!hasActiveRun) return;
    // Poll while anything is queued or running. This is what makes a
    // refresh or a lost connection "just work": the next tick re-asks the
    // API for the truth instead of trusting stale in-memory state.
    const timer = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveRun, load]);

  async function handleStart() {
    if (isStartingRef.current) return; // Collapses a double-click into one request.
    if (!from || !to) {
      notify.error("Pick a start and end date.");
      return;
    }
    isStartingRef.current = true;
    setIsStarting(true);
    try {
      await startScheduleRun({
        from,
        to,
        ...(branch === "ALL" ? {} : { branchCode: branch }),
        timeLimitSeconds,
      });
      notify.success("Schedule run queued.");
      load();
    } catch (caught) {
      notify.error(caught instanceof ApiError ? caught.message : "Could not start the run.");
    } finally {
      isStartingRef.current = false;
      setIsStarting(false);
    }
  }

  async function handleCancel(run: ScheduleRun) {
    if (busyRunIdRef.current) return; // Collapses a double-click into one request.
    busyRunIdRef.current = run.id;
    setBusyRunId(run.id);
    try {
      await cancelScheduleRun(run.id);
      notify.success("Cancellation requested.");
      load();
    } catch (caught) {
      notify.error(caught instanceof ApiError ? caught.message : "Could not cancel this run.");
    } finally {
      busyRunIdRef.current = null;
      setBusyRunId(null);
    }
  }

  function openPublish(run: ScheduleRun) {
    setPublishTarget(run);
    setPublishReason("");
  }

  async function confirmPublish() {
    if (!publishTarget) return;
    if (isPublishingRef.current) return; // Collapses a double-click into one request.
    isPublishingRef.current = true;
    setIsPublishing(true);
    try {
      await publishScheduleRun(publishTarget.id, {
        ...(publishReason.trim() ? { reason: publishReason.trim() } : {}),
      });
      notify.success("Schedule published.");
      setPublishTarget(null);
      load();
    } catch (caught) {
      notify.error(caught instanceof ApiError ? caught.message : "Could not publish this run.");
    } finally {
      isPublishingRef.current = false;
      setIsPublishing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Schedule History</h1>
        <p className="text-muted-foreground">
          Run the optimizer over a date range, watch it work, then publish what it finds. A
          published run is never edited — a new run supersedes it, and both stay on the record.
        </p>
      </div>

      <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Generate a schedule</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="run-from">From</Label>
            <Input
              id="run-from"
              type="date"
              value={from}
              onChange={(event) => event.target.value && setFrom(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="run-to">To</Label>
            <Input
              id="run-to"
              type="date"
              value={to}
              onChange={(event) => event.target.value && setTo(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="run-branch">Branch</Label>
            <Select
              items={BRANCH_LABELS}
              value={branch}
              onValueChange={(value) => setBranch((value as BranchFilter) ?? "ALL")}
            >
              <SelectTrigger id="run-branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Both branches</SelectItem>
                <SelectItem value="COLOMBO">Colombo</SelectItem>
                <SelectItem value="KANDY">Kandy</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="run-time-limit">Search time (seconds)</Label>
            <Input
              id="run-time-limit"
              type="number"
              min={1}
              max={300}
              value={timeLimitSeconds}
              onChange={(event) => setTimeLimitSeconds(Number(event.target.value) || 20)}
            />
          </div>
        </div>
        <Button type="button" onClick={handleStart} disabled={isStarting}>
          <Play className="h-4 w-4" aria-hidden="true" />
          {isStarting ? "Starting…" : "Start run"}
        </Button>
      </section>

      {isLoading ? (
        <LoadingState rows={4} />
      ) : error ? (
        <ErrorState
          title="Couldn't load schedule runs"
          description={error.message}
          code={error.code}
          onRetry={load}
        />
      ) : runs.length === 0 ? (
        <EmptyState
          title="No schedule runs yet"
          description="Start a run above to have the optimizer propose crews and vehicles over a date range."
        />
      ) : (
        <>
          {total > runs.length && (
            <p className="text-sm text-muted-foreground">
              Showing the {runs.length} most recent of {total} runs.
            </p>
          )}
          <ul className="space-y-3">
            {runs.map((run) => {
              const isActive = ACTIVE_STATUSES.has(run.status);
              const canCancel = isActive && !run.cancelRequested;
              const canPublish = run.status === "SUCCEEDED" && !run.isPublished;

              return (
                <li key={run.id} className="rounded-xl border bg-card p-4 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">
                        {run.rangeStart} – {run.rangeEnd}
                        {run.branchCode && (
                          <span className="ml-2 text-sm font-normal text-muted-foreground">
                            {run.branchCode}
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Started {new Date(run.createdAt).toLocaleString()}
                        {run.publishedAt &&
                          ` · Published ${new Date(run.publishedAt).toLocaleString()}`}
                      </p>
                    </div>
                    <StatusBadge run={run} />
                  </div>

                  {run.status === "RUNNING" && (
                    <div
                      className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                      role="progressbar"
                      aria-valuenow={run.progressPercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-label="Run progress"
                    >
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${run.progressPercent}%` }}
                      />
                    </div>
                  )}

                  <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted-foreground">
                    <div>
                      <dt className="inline">Considered: </dt>
                      <dd className="inline font-medium text-foreground">
                        {run.visitsConsidered}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Scheduled: </dt>
                      <dd className="inline font-medium text-foreground">
                        {run.visitsScheduled}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline">Unassigned: </dt>
                      <dd className="inline font-medium text-foreground">
                        {run.visitsUnassigned}
                      </dd>
                    </div>
                  </dl>

                  {run.status === "FAILED" && run.errorMessage && (
                    <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
                      {run.errorMessage}
                    </p>
                  )}

                  {run.supersededByRunId && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Superseded by a later published run.
                    </p>
                  )}

                  {(canCancel || canPublish) && (
                    <div className="mt-3 flex gap-2">
                      {canCancel && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleCancel(run)}
                          disabled={busyRunId === run.id}
                        >
                          <Ban className="h-3.5 w-3.5" aria-hidden="true" />
                          Cancel
                        </Button>
                      )}
                      {canPublish && (
                        <Button type="button" size="sm" onClick={() => openPublish(run)}>
                          <Rocket className="h-3.5 w-3.5" aria-hidden="true" />
                          Publish
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <Dialog open={publishTarget !== null} onOpenChange={(open) => !open && setPublishTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish this schedule?</DialogTitle>
            <DialogDescription>
              This freezes the run — its assignments become what the crews are told, and neither
              they nor this run can be edited afterwards. Anything published earlier for the same
              visits is superseded, never deleted.
            </DialogDescription>
          </DialogHeader>

          {publishTarget && publishTarget.visitsUnassigned > 0 && (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              {publishTarget.visitsUnassigned}{" "}
              {publishTarget.visitsUnassigned === 1 ? "visit" : "visits"} in this range could not
              be staffed and will remain in the Unassigned queue after publishing.
            </p>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="publish-reason">Reason (optional)</Label>
            <Textarea
              id="publish-reason"
              value={publishReason}
              onChange={(event) => setPublishReason(event.target.value)}
              placeholder="Why is this being published now?"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishTarget(null)}>
              Cancel
            </Button>
            <Button onClick={confirmPublish} disabled={isPublishing}>
              {isPublishing ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
