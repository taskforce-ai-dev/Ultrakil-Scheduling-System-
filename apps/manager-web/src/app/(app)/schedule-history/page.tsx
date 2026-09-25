"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Ban,
  CalendarPlus,
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
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Pagination } from "@/components/shared/pagination";
import {
  ApiError,
  cancelScheduleRun,
  fetchScheduleRuns,
  publishScheduleRun,
  startScheduleRun,
  type ScheduleRun,
} from "@/lib/api-client";
import { addDays, todayIso } from "@/lib/calendar";
import { BRANCH_FILTER_LABELS, type BranchFilter } from "@/lib/branches";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";


const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);

/** How often the run list is re-fetched while anything is queued or running. */
const POLL_INTERVAL_MS = 3000;

/**
 * Runs per page. The list used to ask for the most recent 50 and say so, which
 * was honest but left every earlier run unreachable — including one a
 * `?run=<id>` deep link pointed at, which highlighted nothing and scrolled
 * nowhere. Paging reaches them; the exact-ID fetch below reaches the linked one
 * directly, whichever page it is really on.
 */
const RUNS_PAGE_SIZE = 50;

/** True for the record a confirmed "Generate visits" leaves behind. */
function isGeneration(run: ScheduleRun): boolean {
  return run.kind === "VISIT_GENERATION";
}

function StatusBadge({ run }: { run: ScheduleRun }) {
  // Generation creates visits, never assignments. Judging it by the solver's
  // yardstick badged every single one "Draft — no dispatchable assignments",
  // which reads as a schedule that failed — sitting directly above the real
  // optimiser run, where it does the most damage.
  if (isGeneration(run)) {
    return (
      <Badge variant="secondary">
        <CalendarPlus className="h-3 w-3" aria-hidden="true" />
        Visit generation
      </Badge>
    );
  }
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
        Post
      </Badge>
    );
  }
  if (run.visitsScheduled === 0) {
    return (
      <Badge variant="outline">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        Draft — no dispatchable assignments
      </Badge>
    );
  }
  if (run.visitsUnassigned > 0) {
    return (
      <Badge variant="outline">
        <AlertTriangle className="h-3 w-3" aria-hidden="true" />
        <span>Draft — ready to publish</span>
        <span className="font-normal">· {run.visitsUnassigned} unassigned</span>
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

function canPublishRun(run: ScheduleRun): boolean {
  return (
    !isGeneration(run) &&
    run.status === "SUCCEEDED" &&
    !run.isPublished &&
    run.visitsScheduled > 0
  );
}

/**
 * Imported workbook data carries assumptions, not facts: hours defaulted to
 * 08:00–17:00, a site branch guessed from an address, a crew size or duration
 * filled in because the source was silent. Publishing turns a proposal into
 * what the crews are told, so accepting those assumptions is a decision a
 * person makes and signs, never a side effect of clicking Publish.
 *
 * The list is advisory — the API recalculates it under the publication locks
 * and refuses anything the manager did not actually acknowledge.
 */
function unconfirmedSourceWarnings(run: ScheduleRun | null) {
  return run?.publishReadiness?.provenanceWarnings ?? [];
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
/**
 * Which run is actually in force today, and whether something newer is waiting.
 *
 * The page listed every run a range had ever had — published, draft and failed
 * together, newest first — which answers "what has happened" and not "what are
 * my crews doing on Tuesday". A manager looking at a published run staffing 11
 * of 17, with a later draft staffing 17 of 17 sitting above it and a failed
 * attempt above that, has no way to tell which one the crews were given.
 *
 * "In force" is a question about today, not about recency. Taking simply the
 * most recently published run meant that publishing a November week made the
 * September week the crews were working disappear from the panel on the day
 * they were working it. So: the published run whose range covers today, and
 * where several do, the one published last — a later publication over the same
 * dates is what supersedes an earlier one. When none covers today the panel
 * says so rather than naming a week nobody is working.
 *
 * `pending` is a draft a manager could actually act on, which is the same
 * question the row's own Publish button asks. Without that it offered a
 * visit-generation run — "0 of 0 staffed", because generation staffs nobody by
 * definition — and hid the real staffed draft below it.
 */
function currentSchedule(
  runs: ScheduleRun[],
  today: string,
): {
  live: ScheduleRun | null;
  pending: ScheduleRun | null;
} {
  const covering = runs.filter(
    (run) => run.isPublished && run.rangeStart <= today && today <= run.rangeEnd,
  );
  const live =
    covering.reduce<ScheduleRun | null>(
      (latest, run) =>
        latest === null || (run.publishedAt ?? "") > (latest.publishedAt ?? "") ? run : latest,
      null,
    ) ?? null;
  // The API returns newest first, so "newer than the one in force" is the
  // slice above it. With nothing in force, every run is still to be decided.
  const newer = live ? runs.slice(0, runs.indexOf(live)) : runs;
  const pending = newer.find(canPublishRun) ?? null;
  return { live, pending };
}

export default function ScheduleHistoryPage() {
  // The run a link arrived pointing at. The operational visits list names a
  // visit's run by its weeks and links here; landing on fifty rows with
  // nothing picked out leaves a manager to find a date range by eye, which is
  // the job the link was supposed to do.
  const searchParams = useSearchParams();
  const focusRunId = searchParams?.get("run") ?? null;
  const focusRef = React.useRef<HTMLLIElement | null>(null);

  const [runs, setRuns] = React.useState<ScheduleRun[]>([]);
  // Page 1, held separately from whatever page is being browsed — see
  // `loadSummary`. This is what the Current schedule panel reads.
  const [summaryRuns, setSummaryRuns] = React.useState<ScheduleRun[]>([]);
  // Which day it is decides which schedule is in force, so it is read once per
  // render rather than captured when the page mounted — a portal left open
  // overnight would otherwise go on naming yesterday's week.
  const { live, pending } = React.useMemo(
    () => currentSchedule(summaryRuns, todayIso()),
    [summaryRuns],
  );
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);
  // The run this page was linked to, fetched by id when it is not on the page
  // being shown. Held separately so paging away from it does not lose it.
  const [linkedRun, setLinkedRun] = React.useState<ScheduleRun | null>(null);
  // Every load — the manual one, a page change, and the 3s poll — races the
  // others. Without a fence the poll that left before a page change can land
  // after it and repaint the previous page's rows under the new page number.
  const requestGeneration = React.useRef(0);

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
  const [partialAcknowledged, setPartialAcknowledged] = React.useState(false);
  const [provenanceAcknowledged, setProvenanceAcknowledged] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const isPublishingRef = React.useRef(false);

  // Either gate makes the reason mandatory — an acknowledgement with no stated
  // reason records that somebody clicked, not why.
  const publishNeedsReason =
    (publishTarget?.visitsUnassigned ?? 0) > 0 ||
    unconfirmedSourceWarnings(publishTarget).length > 0;

  /**
   * `silent` is for the 3-second poll. A poll must not hold the pager down or
   * blank the list every tick — it is a background refresh of rows already on
   * screen. A page change is the opposite: it is the manager waiting for
   * different rows, and the controls stay disabled until they arrive so a
   * second click cannot skip a page while the old ones are still shown.
   */
  const load = React.useCallback(
    (options?: { silent?: boolean }) => {
    const generation = ++requestGeneration.current;
    if (!options?.silent) setIsLoading(true);
    setError(null);
    return fetchScheduleRuns({ page, pageSize: RUNS_PAGE_SIZE })
      .then((response) => {
        if (generation !== requestGeneration.current) return;
        // Same shrink-under-us case as the customers table: a page past the
        // end of a list that lost rows returns nothing, which reads as "no
        // runs" rather than "you have paged off the end".
        if (response.items.length === 0 && response.total > 0 && page > 1) {
          setPage(1);
          return;
        }
        setRuns(response.items);
        setTotal(response.total);
        // On page 1 the browsing page and the summary source are the same
        // rows, so this costs no extra request.
        if (page === 1) setSummaryRuns(response.items);
      })
      .catch((caught: unknown) => {
        if (generation !== requestGeneration.current) return;
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => {
        if (generation === requestGeneration.current && !options?.silent) setIsLoading(false);
      });
    },
    [page],
  );

  /**
   * The in-force and pending summary, kept independent of whichever history
   * page is being browsed.
   *
   * Which schedule is in force is a fact about the system, not about the rows
   * currently on screen. Deriving it from the browsed page meant that clicking
   * Next — which changes no dispatch truth whatsoever — could make the panel
   * announce that no schedule is in force, or name an older one, purely
   * because the published run covering today had scrolled onto another page.
   *
   * The API returns runs newest-first, so page 1 is the same authoritative
   * window this panel read before the list was paginated. It is re-read
   * separately whenever the browsed page is not page 1.
   */
  const summaryRequest = React.useRef(0);
  const loadSummary = React.useCallback(() => {
    if (page === 1) return Promise.resolve(); // `load` already set it from the same response.
    const generation = ++summaryRequest.current;
    return fetchScheduleRuns({ page: 1, pageSize: RUNS_PAGE_SIZE })
      .then((response) => {
        if (generation === summaryRequest.current) setSummaryRuns(response.items);
      })
      .catch(() => {
        // The browsed page owns the visible error state. Leaving the last known
        // summary standing is better than blanking a panel that says which
        // schedule crews are working to.
      });
  }, [page]);

  React.useEffect(() => {
    // Fetching from the API on mount — an external system, which is what
    // effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    loadSummary();
  }, [load, loadSummary]);

  const runIsOnPage = focusRunId ? runs.some((run) => run.id === focusRunId) : false;

  // A `?run=<id>` link is usually followed from somewhere else in the portal,
  // and the run it names is very often an older one — which is exactly the run
  // that is not on page 1. Rather than make the manager page around hunting
  // for it, ask the API for that one id directly.
  const linkedRequest = React.useRef(0);
  React.useEffect(() => {
    if (!focusRunId || runIsOnPage) return;
    // Before the first page has answered, `runs` is empty and every run looks
    // absent. Asking by id then would spend a request to re-fetch a row that
    // is about to arrive anyway.
    if (isLoading) return;
    if (linkedRun?.id === focusRunId) return;
    const generation = ++linkedRequest.current;
    fetchScheduleRuns({ ids: [focusRunId], pageSize: 1 })
      .then((response) => {
        if (generation !== linkedRequest.current) return;
        setLinkedRun(response.items[0] ?? null);
      })
      .catch(() => {
        // A link to a run that no longer exists, or that this account cannot
        // see, highlights nothing — the same as before. It is not worth
        // replacing the whole list with an error.
        if (generation === linkedRequest.current) setLinkedRun(null);
      });
  }, [focusRunId, runIsOnPage, isLoading, linkedRun?.id]);

  // The linked run rides at the top only while it is genuinely absent from the
  // page being shown. Paging onto its real page drops it from here, so it is
  // never listed twice.
  const displayRuns = React.useMemo(() => {
    // Derived rather than cleared in an effect, so there is no window where a
    // previously linked run is still in state and showing at the top: it is
    // included only while it is both the run being asked for and genuinely
    // absent from the page.
    if (!linkedRun || linkedRun.id !== focusRunId) return runs;
    if (runs.some((run) => run.id === linkedRun.id)) return runs;
    return [linkedRun, ...runs];
  }, [linkedRun, focusRunId, runs]);

  const focusedRun = focusRunId
    ? (displayRuns.find((run) => run.id === focusRunId)?.id ?? null)
    : null;

  React.useEffect(() => {
    // Scrolling the DOM is exactly what a ref and an effect are for. Only
    // once the run is actually on the page — a link to a run older than the
    // fifty loaded here highlights nothing and moves nothing.
    if (!focusedRun) return;
    focusRef.current?.scrollIntoView({ block: "center" });
  }, [focusedRun]);

  // Both sources, so paging away from a queued run does not silently stop its
  // refresh. A newly started run is always on page 1 (the API orders runs
  // newest-first), and the browsed page is checked too in case one is active
  // further back.
  const hasActiveRun = React.useMemo(
    () =>
      summaryRuns.some((run) => ACTIVE_STATUSES.has(run.status)) ||
      runs.some((run) => ACTIVE_STATUSES.has(run.status)),
    [summaryRuns, runs],
  );

  React.useEffect(() => {
    if (!hasActiveRun) return;
    // Poll while anything is queued or running. This is what makes a
    // refresh or a lost connection "just work": the next tick re-asks the
    // API for the truth instead of trusting stale in-memory state. The
    // summary is refreshed alongside the page so progress on a run that is
    // not on screen still reaches the Current schedule panel.
    const timer = setInterval(() => {
      load({ silent: true });
      loadSummary();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [hasActiveRun, load, loadSummary]);

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
      loadSummary();
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
      loadSummary();
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
    setPartialAcknowledged(false);
    setProvenanceAcknowledged(false);
  }

  async function confirmPublish() {
    if (!publishTarget) return;
    const isPartial = publishTarget.visitsUnassigned > 0;
    const isUnconfirmed = unconfirmedSourceWarnings(publishTarget).length > 0;
    const reason = publishReason.trim();
    // Each gate stands on its own: a run can owe both acknowledgements, and
    // either one alone is not enough to publish.
    if (isPartial && !partialAcknowledged) return;
    if (isUnconfirmed && !provenanceAcknowledged) return;
    if ((isPartial || isUnconfirmed) && !reason) return;
    if (isPublishingRef.current) return; // Collapses a double-click into one request.
    isPublishingRef.current = true;
    setIsPublishing(true);
    try {
      await publishScheduleRun(publishTarget.id, {
        ...(isPartial ? { acknowledgePartial: true } : {}),
        ...(isUnconfirmed ? { acknowledgeProvenance: true } : {}),
        ...(reason ? { reason } : {}),
      });
      notify.success("Schedule published.");
      setPublishTarget(null);
      load();
      loadSummary();
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
        <h1 className="text-2xl font-semibold tracking-tight">Assign Crew</h1>
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
              items={BRANCH_FILTER_LABELS}
              value={branch}
              onValueChange={(value) => setBranch((value as BranchFilter) ?? "ALL")}
            >
              <SelectTrigger id="run-branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">{BRANCH_FILTER_LABELS.ALL}</SelectItem>
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

      {/* Only the first load replaces the list. A page change keeps the
          previous runs on screen with the pager disabled, so the control the
          manager just clicked does not unmount under the cursor. */}
      {isLoading && runs.length === 0 ? (
        <LoadingState rows={4} />
      ) : error ? (
        <ErrorState
          title="Couldn't load schedule runs"
          description={error.message}
          code={error.code}
          onRetry={() => load()}
        />
      ) : runs.length === 0 ? (
        <EmptyState
          title="No schedule runs yet"
          description="Start a run above to have the optimizer propose crews and vehicles over a date range."
        />
      ) : (
        <>
          <section
            aria-labelledby="current-schedule"
            className="rounded-xl border bg-card p-4 shadow-sm"
          >
            <h2 id="current-schedule" className="text-sm font-semibold">
              Current schedule
            </h2>
            {live ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Post {new Date(live.publishedAt ?? live.createdAt).toLocaleString()} for{" "}
                {live.rangeStart} – {live.rangeEnd}. {live.visitsScheduled} of{" "}
                {live.visitsScheduled + live.visitsUnassigned} visits have a crew. This is what
                the crews were given.
              </p>
            ) : runs.some((run) => run.isPublished) ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No published schedule covers today, so no schedule is in force. Published runs
                for other weeks are listed below; publish a run covering today and it becomes
                the one the crews work to.
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                Nothing is published yet, so no schedule is in force. Publish a run below and it
                becomes the one the crews work to.
              </p>
            )}

            {pending && (
              <p className="mt-3 rounded-lg border border-dashed p-3 text-sm">
                A newer draft is waiting: <strong>{pending.visitsScheduled}</strong> of{" "}
                {pending.visitsScheduled + pending.visitsUnassigned} staffed for {pending.rangeStart}{" "}
                – {pending.rangeEnd}. Nobody has been told about it until you publish it.
              </p>
            )}
          </section>

          <h2 className="text-sm font-semibold">Earlier runs</h2>
          <Pagination
            page={page}
            pageSize={RUNS_PAGE_SIZE}
            total={total}
            onPageChange={setPage}
            noun="runs"
            disabled={isLoading}
          />
          <ul className="space-y-3">
            {displayRuns.map((run) => {
              const isActive = ACTIVE_STATUSES.has(run.status);
              const canCancel = isActive && !run.cancelRequested;
              const canPublish = canPublishRun(run);

              const isFocused = run.id === focusedRun;

              return (
                <li
                  key={run.id}
                  data-testid={`run-${run.id}`}
                  ref={isFocused ? focusRef : undefined}
                  aria-current={isFocused ? "true" : undefined}
                  className={cn(
                    "rounded-xl border bg-card p-4 shadow-sm",
                    isFocused && "border-primary ring-2 ring-primary/40",
                  )}
                >
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
                          ` · Post ${new Date(run.publishedAt).toLocaleString()}`}
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

                  {isGeneration(run) ? (
                    <p className="mt-3 text-sm text-muted-foreground">
                      {/*
                        * `visitsConsidered` is every visit the run accounted
                        * for — created, changed, removed, protected and
                        * already correct alike — so "visits generated" was
                        * simply untrue of it. A second run over the same range
                        * creates nothing and still carries the same number,
                        * and the page then accounted for twice the work that
                        * exists.
                        */}
                      <span className="font-medium text-foreground">
                        {run.visitsConsidered} visits considered
                      </span>{" "}
                      — every visit in the range, whether this run created it or
                      found it already correct. Nobody is assigned by generation:
                      solve this range to staff them.
                    </p>
                  ) : (
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
                        {/* The run's own word for these was "Unassigned",
                            which on every other screen now names two
                            different things. What this number counts is the
                            work this run tried to staff and could not. */}
                        <dt className="inline">Assignment required: </dt>
                        <dd className="inline font-medium text-foreground">
                          {run.visitsUnassigned}
                        </dd>
                      </div>
                    </dl>
                  )}

                  {run.status === "FAILED" && (
                    <p className="mt-2 rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">
                      This schedule run failed before it produced a dispatchable plan. Review the
                      run status and try again; internal error details are withheld here.
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

          <DialogBody>
            {publishTarget && publishTarget.visitsUnassigned > 0 && (
              <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <p className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {publishTarget.visitsUnassigned}{" "}
                  {publishTarget.visitsUnassigned === 1 ? "visit" : "visits"} in this range could not
                  be staffed and will remain in the Unassigned queue after publishing.
                </p>
                <label htmlFor="partial-publish-ack" className="flex items-start gap-2 font-medium text-foreground">
                  <Checkbox
                    id="partial-publish-ack"
                    checked={partialAcknowledged}
                    onCheckedChange={(checked) => setPartialAcknowledged(checked === true)}
                  />
                  <span>I understand that unassigned visits will not be dispatched.</span>
                </label>
              </div>
            )}

            {unconfirmedSourceWarnings(publishTarget).length > 0 && (
              <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                <p className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Some of this schedule rests on source data nobody has confirmed. Publishing it
                  tells the crews to act on an assumption.
                </p>
                <ul className="ml-6 list-disc space-y-1">
                  {unconfirmedSourceWarnings(publishTarget).map((warning) => (
                    <li key={warning.code}>
                      {warning.message}{" "}
                      <span className="font-medium">
                        {warning.affectedVisitCount}{" "}
                        {warning.affectedVisitCount === 1 ? "visit" : "visits"}
                      </span>
                    </li>
                  ))}
                </ul>
                <label
                  htmlFor="provenance-publish-ack"
                  className="flex items-start gap-2 font-medium text-foreground"
                >
                  <Checkbox
                    id="provenance-publish-ack"
                    checked={provenanceAcknowledged}
                    onCheckedChange={(checked) => setProvenanceAcknowledged(checked === true)}
                  />
                  <span>
                    I understand this schedule uses source data that is not confirmed, and I am
                    publishing it anyway.
                  </span>
                </label>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="publish-reason">
                {publishTarget && publishTarget.visitsUnassigned > 0
                  ? "Reason (required for partial schedules)"
                  : publishNeedsReason
                    ? "Reason (required for unconfirmed source data)"
                    : "Reason (optional)"}
              </Label>
              <Textarea
                id="publish-reason"
                value={publishReason}
                onChange={(event) => setPublishReason(event.target.value)}
                placeholder="Why is this being published now?"
                aria-required={publishNeedsReason}
              />
            </div>
          </DialogBody>

          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={confirmPublish}
              disabled={
                isPublishing ||
                ((publishTarget?.visitsUnassigned ?? 0) > 0 && !partialAcknowledged) ||
                (unconfirmedSourceWarnings(publishTarget).length > 0 &&
                  !provenanceAcknowledged) ||
                (publishNeedsReason && !publishReason.trim())
              }
            >
              {isPublishing ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
