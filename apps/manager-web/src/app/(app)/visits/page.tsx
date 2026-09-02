"use client";

import * as React from "react";
import { CalendarPlus, ChevronLeft, ChevronRight, Move } from "lucide-react";

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
import { Badge } from "@/components/ui/badge";
import {
  adjustVisit,
  ApiError,
  fetchCustomers,
  fetchJobTypes,
  fetchVisits,
  type Customer,
  type JobType,
  type Visit,
  type VisitStatus,
} from "@/lib/api-client";
import {
  addDays,
  addMonths,
  daysInView,
  formatMinuteOfDay,
  formatLongDate,
  formatMonthYear,
  formatWeekRange,
  isSameMonth,
  rangeForView,
  todayIso,
  WEEKDAY_INITIALS,
  type CalendarView,
} from "@/lib/calendar";
import { cn } from "@/lib/utils";
import { notify } from "@/lib/notify";
import { VisitDetailDrawer } from "./visit-detail-drawer";
import { GenerationImpactDrawer } from "./generation-impact-drawer";

/** A visit chip requested a move, either by drag-and-drop or the accessible button. */
interface MoveRequest {
  visit: Visit;
  targetDate: string;
}

type BranchFilter = "ALL" | "COLOMBO" | "KANDY";
type StateFilter = "ALL" | VisitStatus | "LOCKED" | "MANUALLY_ADJUSTED" | "GENERATED";

const STATE_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: "ALL", label: "All states" },
  { value: "GENERATED", label: "Generated (untouched)" },
  { value: "MANUALLY_ADJUSTED", label: "Manually modified" },
  { value: "LOCKED", label: "Locked" },
  { value: "UNASSIGNED", label: "Unassigned" },
  { value: "SCHEDULED", label: "Crew assigned" },
  { value: "COMPLETED", label: "Completed" },
  { value: "CANCELLED", label: "Cancelled" },
];

const BRANCH_LABELS: Record<BranchFilter, string> = {
  ALL: "Both branches",
  COLOMBO: "Colombo",
  KANDY: "Kandy",
};

const STATE_LABELS = Object.fromEntries(
  STATE_OPTIONS.map((option) => [option.value, option.label])
);

/**
 * A month cell shows at most this many visits.
 *
 * Without a cap one busy day stretches the whole grid — on real data a single
 * site can take dozens of visits in a month, and the calendar stopped being
 * scannable long before it stopped rendering. The overflow is a link into the
 * week view for that day, so nothing is hidden without a way to reach it.
 */
const MAX_CHIPS_PER_MONTH_CELL = 3;

/**
 * One visit as it appears inside a day cell.
 *
 * Draggable to another day for a quick reschedule, but dragging is never the
 * only way: the small "Move" button opens the same confirmation dialog for
 * anyone who can't (or would rather not) drag — keyboard users, screen
 * readers, touch devices without a drag gesture.
 */
function VisitChip({
  visit,
  onOpen,
  onMoveRequested,
}: {
  visit: Visit;
  onOpen: () => void;
  onMoveRequested: () => void;
}) {
  // Colour carries stage, never staffing: an unstaffed visit must not read as
  // ready. The dot is the ownership marker, so a locked or hand-edited visit
  // is identifiable at a glance without opening it.
  const tone =
    visit.status === "CANCELLED"
      ? "border-destructive/40 bg-destructive/5 text-destructive"
      : visit.status === "COMPLETED"
        ? "border-border bg-muted text-muted-foreground"
        : visit.status === "SCHEDULED"
          ? "border-primary/40 bg-primary/10"
          : "border-border bg-background";

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", visit.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      className={cn(
        "flex w-full items-stretch gap-0.5 rounded border text-xs transition-colors",
        "hover:border-ring",
        tone
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={`${visit.customerName} at ${formatMinuteOfDay(visit.windowStartMinute)} on ${visit.visitDate}${
          visit.hoursUnconfirmed ? ", opening hours unconfirmed" : ""
        }`}
        className="min-w-0 flex-1 truncate px-1.5 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-1">
          {visit.isLocked && (
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          )}
          {!visit.isLocked && visit.isManuallyAdjusted && (
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-secondary-foreground/60" />
          )}
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatMinuteOfDay(visit.windowStartMinute)}
          </span>
          <span className="truncate">{visit.customerName}</span>
          {visit.hoursUnconfirmed && (
            <span aria-hidden="true" className="shrink-0 text-destructive" title="Opening hours unconfirmed">
              ⟡
            </span>
          )}
        </span>
      </button>
      <button
        type="button"
        onClick={onMoveRequested}
        aria-label={`Move ${visit.customerName}'s visit to a different date`}
        className="shrink-0 px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Move className="h-3 w-3" aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * The generated calendar.
 *
 * Filters and the anchor date live here, above the drawers, so opening a visit
 * and closing it again lands the manager back on the same month with the same
 * filters. Losing that on every click is what makes a calendar unusable for
 * the "walk the month and check it" job this screen exists for.
 *
 * The date range and branch go to the API, because they decide which rows are
 * worth fetching at all. Customer, job type and state are applied client-side
 * over the fetched range: they narrow what is already loaded, and a round trip
 * per dropdown change would only add latency.
 */
export default function VisitsPage() {
  const [view, setView] = React.useState<CalendarView>("month");
  const [anchor, setAnchor] = React.useState<string>(todayIso);

  const [branch, setBranch] = React.useState<BranchFilter>("ALL");
  const [customerId, setCustomerId] = React.useState<string>("ALL");
  const [jobTypeId, setJobTypeId] = React.useState<string>("ALL");
  const [state, setState] = React.useState<StateFilter>("ALL");

  const [visits, setVisits] = React.useState<Visit[]>([]);
  const [totalInRange, setTotalInRange] = React.useState(0);
  const [customers, setCustomers] = React.useState<Customer[]>([]);
  const [jobTypes, setJobTypes] = React.useState<JobType[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  // When the visible range is empty, where the work actually is. Opening on
  // today's month and showing a blank grid reads as "broken" rather than
  // "look in September", which is the single most confusing thing this screen
  // can do on first use.
  const [nearest, setNearest] = React.useState<{ date: string; total: number } | null>(
    null
  );

  const [openVisitId, setOpenVisitId] = React.useState<string | null>(null);
  const [generateOpen, setGenerateOpen] = React.useState(false);

  const [moveRequest, setMoveRequest] = React.useState<MoveRequest | null>(null);
  const [moveReason, setMoveReason] = React.useState("");
  const [isMoving, setIsMoving] = React.useState(false);
  // A ref alongside the state: two clicks fired in the same tick (a fast
  // double-click) both close over the same pre-update `isMoving`, so the
  // state check alone can't stop the second one.
  const isMovingRef = React.useRef(false);

  const { from, to } = rangeForView(anchor, view);

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    Promise.all([
      fetchVisits({
        from,
        to,
        pageSize: 500,
        ...(branch === "ALL" ? {} : { branchCode: branch }),
      }),
      fetchCustomers({ pageSize: 200 }),
      fetchJobTypes(),
    ])
      .then(([visitPage, customerPage, jobTypeList]) => {
        setVisits(visitPage.items);
        setTotalInRange(visitPage.total);
        setCustomers(customerPage.items);
        setJobTypes(jobTypeList);
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
  }, [from, to, branch]);

  React.useEffect(() => {
    // Fetching from the API on mount and whenever the range moves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const findNearest = React.useCallback(() => {
    if (isLoading || visits.length > 0) return;
    // Results come back in date order, so the first row is the earliest visit
    // anywhere. Deliberately unfiltered — this is a "where is the work?" hint.
    fetchVisits({ pageSize: 1 })
      .then((page) => {
        setNearest(
          page.total === 0 || !page.items[0]
            ? { date: "", total: 0 }
            : { date: page.items[0].visitDate, total: page.total }
        );
      })
      .catch(() => setNearest(null));
  }, [isLoading, visits.length]);

  React.useEffect(() => {
    findNearest();
  }, [findNearest]);

  const visible = React.useMemo(() => {
    return visits.filter((visit) => {
      if (customerId !== "ALL") {
        const customer = customers.find((candidate) => candidate.id === customerId);
        if (!customer || customer.name !== visit.customerName) return false;
      }
      if (jobTypeId !== "ALL") {
        const jobType = jobTypes.find((candidate) => candidate.id === jobTypeId);
        if (!jobType || jobType.name !== visit.jobTypeName) return false;
      }
      if (state === "ALL") return true;
      if (state === "LOCKED") return visit.isLocked;
      if (state === "MANUALLY_ADJUSTED") return visit.isManuallyAdjusted;
      if (state === "GENERATED") return !visit.isLocked && !visit.isManuallyAdjusted;
      return visit.status === state;
    });
  }, [visits, customers, jobTypes, customerId, jobTypeId, state]);

  const byDay = React.useMemo(() => {
    const grouped = new Map<string, Visit[]>();
    for (const visit of visible) {
      const bucket = grouped.get(visit.visitDate);
      if (bucket) bucket.push(visit);
      else grouped.set(visit.visitDate, [visit]);
    }
    for (const bucket of grouped.values()) {
      bucket.sort((left, right) => left.windowStartMinute - right.windowStartMinute);
    }
    return grouped;
  }, [visible]);

  // Base UI's <SelectValue> renders the raw value unless the root is given a
  // value -> label map, which would show a customer's UUID on the trigger.
  const customerLabels = React.useMemo(
    () => ({
      ALL: "All customers",
      ...Object.fromEntries(customers.map((customer) => [customer.id, customer.name])),
    }),
    [customers]
  );
  const jobTypeLabels = React.useMemo(
    () => ({
      ALL: "All treatments",
      ...Object.fromEntries(jobTypes.map((jobType) => [jobType.id, jobType.name])),
    }),
    [jobTypes]
  );

  const days = daysInView(anchor, view);
  const today = todayIso();

  function step(direction: -1 | 1) {
    setAnchor(view === "month" ? addMonths(anchor, direction) : addDays(anchor, direction * 7));
  }

  function handleDrop(day: string, event: React.DragEvent) {
    event.preventDefault();
    const visitId = event.dataTransfer.getData("text/plain");
    const visit = visible.find((candidate) => candidate.id === visitId);
    if (!visit || visit.visitDate === day) return;
    setMoveRequest({ visit, targetDate: day });
    setMoveReason("");
  }

  async function confirmMove() {
    if (!moveRequest) return;
    if (!moveReason.trim()) {
      notify.error("A reason is required to move a visit by hand.");
      return;
    }
    if (isMovingRef.current) return; // Collapses a double-click into one request.
    isMovingRef.current = true;
    setIsMoving(true);
    try {
      await adjustVisit(moveRequest.visit.id, {
        visitDate: moveRequest.targetDate,
        reason: moveReason.trim(),
      });
      notify.success("Visit moved.");
      setMoveRequest(null);
      load();
    } catch (caught) {
      notify.error(caught instanceof ApiError ? caught.message : "Could not move this visit.");
    } finally {
      isMovingRef.current = false;
      setIsMoving(false);
    }
  }

  const lockedCount = visible.filter((visit) => visit.isLocked).length;
  const adjustedCount = visible.filter((visit) => visit.isManuallyAdjusted).length;
  const unstaffedCount = visible.filter((visit) => visit.assignmentCount === 0).length;
  const unconfirmedHoursCount = visible.filter((visit) => visit.hoursUnconfirmed).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Visit Calendar</h1>
          <p className="text-muted-foreground">
            Recurring work generated from service agreements. Nobody is assigned here.
          </p>
        </div>
        <Button onClick={() => setGenerateOpen(true)}>
          <CalendarPlus className="h-4 w-4" />
          Generate visits
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Previous" onClick={() => step(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" onClick={() => setAnchor(todayIso())}>
            Today
          </Button>
          <Button variant="outline" size="icon" aria-label="Next" onClick={() => step(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <p className="min-w-56 text-lg font-semibold" data-testid="calendar-range">
          {view === "month" ? formatMonthYear(anchor) : formatWeekRange(anchor)}
        </p>

        <div className="flex items-center gap-1" role="group" aria-label="Calendar view">
          <Button
            variant={view === "month" ? "default" : "outline"}
            aria-pressed={view === "month"}
            onClick={() => setView("month")}
          >
            Month
          </Button>
          <Button
            variant={view === "week" ? "default" : "outline"}
            aria-pressed={view === "week"}
            onClick={() => setView("week")}
          >
            Week
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="branch-filter">Branch</Label>
          <Select
            items={BRANCH_LABELS}
            value={branch}
            onValueChange={(value) => setBranch((value ?? "ALL") as BranchFilter)}
          >
            <SelectTrigger id="branch-filter">
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
          <Label htmlFor="customer-filter">Customer</Label>
          <Select
            items={customerLabels}
            value={customerId}
            onValueChange={(value) => setCustomerId(value ?? "ALL")}
          >
            <SelectTrigger id="customer-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All customers</SelectItem>
              {customers.map((customer) => (
                <SelectItem key={customer.id} value={customer.id}>
                  {customer.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="job-type-filter">Treatment</Label>
          <Select
            items={jobTypeLabels}
            value={jobTypeId}
            onValueChange={(value) => setJobTypeId(value ?? "ALL")}
          >
            <SelectTrigger id="job-type-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All treatments</SelectItem>
              {jobTypes.map((jobType) => (
                <SelectItem key={jobType.id} value={jobType.id}>
                  {jobType.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="state-filter">Visit state</Label>
          <Select
            items={STATE_LABELS}
            value={state}
            onValueChange={(value) => setState((value ?? "ALL") as StateFilter)}
          >
            <SelectTrigger id="state-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <LoadingState rows={6} />
      ) : error ? (
        <ErrorState
          title="Couldn't load the calendar"
          description={error.message}
          code={error.code}
          onRetry={load}
        />
      ) : (
        <>
          {totalInRange > visits.length && (
            <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              This range holds {totalInRange} visits and only the first {visits.length} are
              shown. Narrow the dates or pick one branch — a calendar that quietly hides work
              is worse than one that says so.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline">{visible.length} visits</Badge>
            {lockedCount > 0 && <Badge variant="default">{lockedCount} locked</Badge>}
            {adjustedCount > 0 && (
              <Badge variant="secondary">{adjustedCount} manually modified</Badge>
            )}
            {unconfirmedHoursCount > 0 && (
              <Badge variant="destructive">
                {unconfirmedHoursCount} with opening hours unconfirmed
              </Badge>
            )}
            {unstaffedCount > 0 && (
              <span className="text-muted-foreground">
                {unstaffedCount} with no crew assigned yet
              </span>
            )}
          </div>

          {visible.length === 0 ? (
            visits.length > 0 ? (
              <EmptyState
                title="Nothing matches these filters"
                description={`${visits.length} visits fall in this range, but the filters exclude all of them.`}
                actionLabel="Clear the filters"
                onAction={() => {
                  setCustomerId("ALL");
                  setJobTypeId("ALL");
                  setState("ALL");
                  setBranch("ALL");
                }}
              />
            ) : nearest && nearest.total > 0 ? (
              <EmptyState
                title={`No visits in ${view === "month" ? formatMonthYear(anchor) : formatWeekRange(anchor)}`}
                description={`${nearest.total} visits have been generated. The earliest is ${formatLongDate(nearest.date)}.`}
                actionLabel="Go to the first visit"
                onAction={() => setAnchor(nearest.date)}
              />
            ) : (
              <EmptyState
                title="No visits have been generated yet"
                description="Service agreements say what work is due; generation turns that into dated visits. Nothing is written until you confirm."
                actionLabel="See what the agreements ask for"
                onAction={() => setGenerateOpen(true)}
              />
            )
          ) : (
            <div
              className="overflow-x-auto rounded-lg border border-border"
              role="grid"
              aria-label={view === "month" ? "Month calendar" : "Week calendar"}
            >
              <div className="grid min-w-3xl grid-cols-7 border-b border-border bg-muted/40">
                {WEEKDAY_INITIALS.map((day) => (
                  <div
                    key={day}
                    className="px-2 py-1.5 text-center text-xs font-medium text-muted-foreground"
                  >
                    {day}
                  </div>
                ))}
              </div>
              <div className="grid min-w-3xl grid-cols-7">
                {days.map((day) => {
                  const dayVisits = byDay.get(day) ?? [];
                  const outsideMonth = view === "month" && !isSameMonth(day, anchor);
                  const shownVisits =
                    view === "month" ? dayVisits.slice(0, MAX_CHIPS_PER_MONTH_CELL) : dayVisits;
                  const hiddenCount = dayVisits.length - shownVisits.length;

                  return (
                    <div
                      key={day}
                      role="gridcell"
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => handleDrop(day, event)}
                      className={cn(
                        "min-h-28 space-y-1 border-b border-r border-border p-1.5",
                        outsideMonth && "bg-muted/30",
                        day === today && "bg-primary/5"
                      )}
                    >
                      <div className="flex items-baseline justify-between">
                        <span
                          className={cn(
                            "text-xs tabular-nums",
                            outsideMonth ? "text-muted-foreground/60" : "text-muted-foreground",
                            day === today && "font-semibold text-primary"
                          )}
                        >
                          {Number(day.slice(8, 10))}
                        </span>
                        {dayVisits.length > 1 && (
                          <span className="text-[10px] text-muted-foreground">
                            {dayVisits.length}
                          </span>
                        )}
                      </div>
                      {shownVisits.map((visit) => (
                        <VisitChip
                          key={visit.id}
                          visit={visit}
                          onOpen={() => setOpenVisitId(visit.id)}
                          onMoveRequested={() => {
                            setMoveRequest({ visit, targetDate: visit.visitDate });
                            setMoveReason("");
                          }}
                        />
                      ))}
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setAnchor(day);
                            setView("week");
                          }}
                          className="w-full rounded px-1.5 py-0.5 text-left text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          + {hiddenCount} more
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}

      <VisitDetailDrawer
        visitId={openVisitId}
        onOpenChange={(open) => {
          if (!open) setOpenVisitId(null);
        }}
        onChanged={load}
      />

      <GenerationImpactDrawer
        open={generateOpen}
        onOpenChange={setGenerateOpen}
        from={from}
        to={to}
        branchCode={branch === "ALL" ? undefined : branch}
        onConfirmed={load}
      />

      <Dialog open={moveRequest !== null} onOpenChange={(open) => !open && setMoveRequest(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move this visit?</DialogTitle>
            <DialogDescription>
              {moveRequest &&
                `${moveRequest.visit.customerName} — currently ${formatLongDate(moveRequest.visit.visitDate)}.`}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="move-date">New date</Label>
            <Input
              id="move-date"
              type="date"
              value={moveRequest?.targetDate ?? ""}
              onChange={(event) =>
                event.target.value &&
                setMoveRequest((current) =>
                  current ? { ...current, targetDate: event.target.value } : current
                )
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="move-reason">Reason</Label>
            <Textarea
              id="move-reason"
              value={moveReason}
              onChange={(event) => setMoveReason(event.target.value)}
              placeholder="Why is this visit moving?"
            />
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveRequest(null)}>
              Cancel
            </Button>
            <Button onClick={confirmMove} disabled={isMoving}>
              {isMoving ? "Moving…" : "Move visit"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
