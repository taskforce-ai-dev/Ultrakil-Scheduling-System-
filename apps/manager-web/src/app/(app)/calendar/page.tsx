"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight, Car, Users, Crown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import {
  ApiError,
  fetchCalendar,
  type CalendarEntry,
} from "@/lib/api-client";
import {
  addDays,
  addMonths,
  daysInView,
  formatLongDate,
  formatMinuteOfDay,
  formatMonthYear,
  formatWeekRange,
  isSameMonth,
  rangeForView,
  todayIso,
  WEEKDAY_INITIALS,
  type CalendarView,
} from "@/lib/calendar";
import { cn } from "@/lib/utils";

type BranchFilter = "ALL" | "COLOMBO" | "KANDY";
type StageFilter = "ALL" | "UNASSIGNED" | "DRAFT" | "PUBLISHED" | "DONE";

const BRANCH_LABELS: Record<BranchFilter, string> = {
  ALL: "Both branches",
  COLOMBO: "Colombo",
  KANDY: "Kandy",
};

const STAGE_LABELS: Record<StageFilter, string> = {
  ALL: "Every stage",
  UNASSIGNED: "Needs a crew",
  DRAFT: "Proposed, not published",
  PUBLISHED: "Published to the crew",
  DONE: "Completed or cancelled",
};

const MAX_CHIPS_PER_MONTH_CELL = 3;

/** One glance at a row's stage: colour is the whole point of this screen. */
function stageOf(entry: CalendarEntry): Exclude<StageFilter, "ALL"> {
  if (entry.visitStatus === "COMPLETED" || entry.visitStatus === "CANCELLED") return "DONE";
  if (!entry.assignment) return "UNASSIGNED";
  if (entry.assignment.status === "DRAFT" || entry.assignment.status === "PROPOSED")
    return "DRAFT";
  return "PUBLISHED";
}

/**
 * Colour carries stage — never anything else — so a manager scanning a busy
 * month can tell "needs a crew" from "crew told" without opening a single
 * visit. Branch gets its own dot rather than sharing the colour channel,
 * because collapsing two different facts onto one colour is how a calendar
 * stops being scannable.
 */
const STAGE_STYLES: Record<
  Exclude<StageFilter, "ALL">,
  { chip: string; dot: string; badge: string; label: string }
> = {
  UNASSIGNED: {
    chip: "border-rose-300 bg-rose-50 text-rose-900 hover:border-rose-400 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200",
    dot: "bg-rose-500",
    badge: "border-transparent bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
    label: "Needs a crew",
  },
  DRAFT: {
    chip: "border-amber-300 bg-amber-50 text-amber-900 hover:border-amber-400 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
    dot: "bg-amber-500",
    badge: "border-transparent bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    label: "Proposed",
  },
  PUBLISHED: {
    chip: "border-emerald-300 bg-emerald-50 text-emerald-900 hover:border-emerald-400 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
    dot: "bg-emerald-500",
    badge: "border-transparent bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    label: "Published",
  },
  DONE: {
    chip: "border-slate-300 bg-slate-50 text-slate-600 hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400",
    dot: "bg-slate-400",
    badge: "border-transparent bg-slate-100 text-slate-600 dark:bg-slate-900 dark:text-slate-400",
    label: "Completed / cancelled",
  },
};

const BRANCH_DOT: Record<"COLOMBO" | "KANDY", string> = {
  COLOMBO: "bg-sky-500",
  KANDY: "bg-violet-500",
};

function EntryChip({ entry, onOpen }: { entry: CalendarEntry; onOpen: () => void }) {
  const stage = stageOf(entry);
  const style = STAGE_STYLES[stage];
  const crewCount = entry.assignment?.crew.length ?? 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${entry.customerName} at ${formatMinuteOfDay(entry.windowStartMinute)} on ${entry.visitDate}, ${style.label.toLowerCase()}`}
      className={cn(
        "flex w-full items-center gap-1 rounded border px-1.5 py-1 text-left text-xs transition-colors",
        style.chip
      )}
    >
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", BRANCH_DOT[entry.branchCode])}
      />
      <span className="shrink-0 tabular-nums opacity-80">
        {formatMinuteOfDay(entry.windowStartMinute)}
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{entry.customerName}</span>
      {crewCount > 0 && (
        <span className="flex shrink-0 items-center gap-0.5 opacity-80">
          <Users className="h-3 w-3" aria-hidden="true" />
          {crewCount}
        </span>
      )}
      {(entry.assignment?.vehicles.length ?? 0) > 0 && (
        <Car className="h-3 w-3 shrink-0 opacity-80" aria-hidden="true" />
      )}
    </button>
  );
}

function DetailDialog({
  entry,
  onOpenChange,
}: {
  entry: CalendarEntry | null;
  onOpenChange: (open: boolean) => void;
}) {
  const stage = entry ? stageOf(entry) : null;
  const style = stage ? STAGE_STYLES[stage] : null;

  return (
    <Dialog open={entry !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {entry && style && (
          <>
            <DialogHeader>
              <DialogTitle>{entry.customerName}</DialogTitle>
              <DialogDescription>
                {entry.siteName} — {formatLongDate(entry.visitDate)},{" "}
                {formatMinuteOfDay(entry.windowStartMinute)}–
                {formatMinuteOfDay(entry.windowEndMinute)}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge className={style.badge}>{style.label}</Badge>
              <Badge variant="outline">{entry.branchCode}</Badge>
              <Badge variant="outline">{entry.jobTypeName}</Badge>
              {entry.assignment?.publishedAt && (
                <Badge variant="outline">
                  Published {new Date(entry.assignment.publishedAt).toLocaleString()}
                </Badge>
              )}
            </div>

            {entry.instructions && (
              <div className="rounded-md border border-border bg-muted/40 p-2.5 text-sm">
                {entry.instructions}
              </div>
            )}

            {entry.assignment ? (
              <div className="space-y-3 border-t border-border pt-3">
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Crew</p>
                  <ul className="space-y-1">
                    {entry.assignment.crew.map((member) => (
                      <li
                        key={member.employeeId}
                        className="flex items-center gap-1.5 text-sm"
                      >
                        {member.isPmsSupervisor && (
                          <Crown
                            className="h-3.5 w-3.5 shrink-0 text-amber-500"
                            aria-label="PMS supervisor"
                          />
                        )}
                        <span className="min-w-0 flex-1 truncate">{member.fullName}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {member.role}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                {entry.assignment.vehicles.length > 0 && (
                  <div>
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                      Vehicle
                    </p>
                    <ul className="space-y-1">
                      {entry.assignment.vehicles.map((vehicle) => (
                        <li key={vehicle.vehicleId} className="flex items-center gap-1.5 text-sm">
                          <Car className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span>{vehicle.label}</span>
                          {vehicle.driverName && (
                            <span className="text-xs text-muted-foreground">
                              — driven by {vehicle.driverName}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="text-xs text-muted-foreground">
                  {entry.assignment.acknowledgedAt
                    ? `Acknowledged ${new Date(entry.assignment.acknowledgedAt).toLocaleString()}`
                    : "Not yet acknowledged — the worker app is Phase 2."}
                </div>
              </div>
            ) : (
              <div className="border-t border-border pt-3 text-sm text-muted-foreground">
                No crew on this visit yet. It belongs in the Unassigned Visits queue.
              </div>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * The unified calendar (ULK-C07).
 *
 * Where the Visit Calendar, Dispatch Board and Schedule History pages each
 * show one slice of a job, this is the one screen meant to answer "what is
 * happening, when, with whom, in what vehicle" without clicking into
 * anything — reading `GET /schedule/calendar`, which already joins visit,
 * crew and vehicle server-side for exactly this purpose.
 */
export default function CalendarPage() {
  const [view, setView] = React.useState<CalendarView>("month");
  const [anchor, setAnchor] = React.useState<string>(todayIso);
  const [branch, setBranch] = React.useState<BranchFilter>("ALL");
  const [stage, setStage] = React.useState<StageFilter>("ALL");

  const [entries, setEntries] = React.useState<CalendarEntry[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [openEntry, setOpenEntry] = React.useState<CalendarEntry | null>(null);

  const { from, to } = rangeForView(anchor, view);

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    fetchCalendar({ from, to, ...(branch === "ALL" ? {} : { branchCode: branch }) })
      .then((response) => setEntries(response.items))
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const visible = React.useMemo(
    () => (stage === "ALL" ? entries : entries.filter((entry) => stageOf(entry) === stage)),
    [entries, stage]
  );

  const byDay = React.useMemo(() => {
    const grouped = new Map<string, CalendarEntry[]>();
    for (const entry of visible) {
      const bucket = grouped.get(entry.visitDate);
      if (bucket) bucket.push(entry);
      else grouped.set(entry.visitDate, [entry]);
    }
    for (const bucket of grouped.values()) {
      bucket.sort((left, right) => left.windowStartMinute - right.windowStartMinute);
    }
    return grouped;
  }, [visible]);

  const days = daysInView(anchor, view);
  const today = todayIso();

  function step(direction: -1 | 1) {
    setAnchor(view === "month" ? addMonths(anchor, direction) : addDays(anchor, direction * 7));
  }

  const counts = React.useMemo(() => {
    const result: Record<Exclude<StageFilter, "ALL">, number> = {
      UNASSIGNED: 0,
      DRAFT: 0,
      PUBLISHED: 0,
      DONE: 0,
    };
    for (const entry of visible) result[stageOf(entry)] += 1;
    return result;
  }, [visible]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Calendar</h1>
        <p className="text-muted-foreground">
          Every visit for a day in one place — date, time, crew and vehicle, colour-coded by
          stage.
        </p>
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

        <p className="min-w-56 text-lg font-semibold">
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

        <div className="ml-auto flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="branch-filter">Branch</Label>
            <Select
              items={BRANCH_LABELS}
              value={branch}
              onValueChange={(value) => setBranch((value ?? "ALL") as BranchFilter)}
            >
              <SelectTrigger id="branch-filter" className="w-44">
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
            <Label htmlFor="stage-filter">Stage</Label>
            <Select
              items={STAGE_LABELS}
              value={stage}
              onValueChange={(value) => setStage((value ?? "ALL") as StageFilter)}
            >
              <SelectTrigger id="stage-filter" className="w-52">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(STAGE_LABELS) as StageFilter[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {STAGE_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Legend — colour is doing real work on this screen, so it is spelled out once. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {(Object.keys(STAGE_STYLES) as Exclude<StageFilter, "ALL">[]).map((key) => (
          <span key={key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full", STAGE_STYLES[key].dot)} />
            {STAGE_STYLES[key].label} ({counts[key]})
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full", BRANCH_DOT.COLOMBO)} />
          Colombo
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className={cn("h-2.5 w-2.5 rounded-full", BRANCH_DOT.KANDY)} />
          Kandy
        </span>
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
      ) : visible.length === 0 ? (
        <EmptyState
          title="Nothing in this range"
          description={
            entries.length > 0
              ? "Visits exist here, but the stage filter excludes all of them."
              : "No visits fall in this range yet."
          }
        />
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
              const dayEntries = byDay.get(day) ?? [];
              const outsideMonth = view === "month" && !isSameMonth(day, anchor);
              const shown =
                view === "month" ? dayEntries.slice(0, MAX_CHIPS_PER_MONTH_CELL) : dayEntries;
              const hiddenCount = dayEntries.length - shown.length;

              return (
                <div
                  key={day}
                  role="gridcell"
                  className={cn(
                    "min-h-28 space-y-1 border-b border-r border-border p-1.5",
                    outsideMonth && "bg-muted/30",
                    day === today && "bg-primary/5"
                  )}
                >
                  <span
                    className={cn(
                      "block text-xs tabular-nums",
                      outsideMonth ? "text-muted-foreground/60" : "text-muted-foreground",
                      day === today && "font-semibold text-primary"
                    )}
                  >
                    {Number(day.slice(8, 10))}
                  </span>
                  {shown.map((entry) => (
                    <EntryChip key={entry.visitId} entry={entry} onOpen={() => setOpenEntry(entry)} />
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

      <DetailDialog entry={openEntry} onOpenChange={(open) => !open && setOpenEntry(null)} />
    </div>
  );
}
