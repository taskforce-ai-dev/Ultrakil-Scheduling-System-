"use client";

import * as React from "react";
import Link from "next/link";
import {
  AlertTriangle,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Footprints,
  ShieldAlert,
  UserCog,
  UserX,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import { VisitStatusBadge, VisitOwnershipBadges } from "@/components/shared/visit-badges";
import {
  ApiError,
  fetchVisitAssignment,
  fetchVisits,
  type Assignment,
  type Visit,
} from "@/lib/api-client";
import { addDays, formatLongDate, formatMinuteOfDay, todayIso } from "@/lib/calendar";
import { CalendarBoard } from "../calendar/calendar-board";
import { AssignmentEditorDrawer } from "../visits/assignment-editor-drawer";
import { VisitDetailDrawer } from "../visits/visit-detail-drawer";

type BranchFilter = "ALL" | "COLOMBO" | "KANDY";

const BRANCH_LABELS: Record<BranchFilter, string> = {
  ALL: "Both branches",
  COLOMBO: "Colombo",
  KANDY: "Kandy",
};

/**
 * Who is on each visit today, with a direct path to change it: "Edit crew"
 * opens the same override workflow the Unassigned queue uses (ULK-O06),
 * validated against the eligibility engine before anything is saved.
 *
 * Nothing on this board may suggest a visit is staffed before an assignment
 * exists: every row states its supervisor/crew/vehicle explicitly, including
 * "none" — never blank, which would read as fine.
 */
export default function DispatchBoardPage() {
  const [date, setDate] = React.useState(todayIso());
  const [branch, setBranch] = React.useState<BranchFilter>("ALL");
  const [visits, setVisits] = React.useState<Visit[]>([]);
  const [assignments, setAssignments] = React.useState<Record<string, Assignment | null>>({});
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [selectedVisitId, setSelectedVisitId] = React.useState<string | null>(null);
  const [editVisitId, setEditVisitId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    fetchVisits({
      from: date,
      to: date,
      pageSize: 200,
      ...(branch === "ALL" ? {} : { branchCode: branch }),
    })
      .then(async (page) => {
        setVisits(page.items);
        // Only visits the API already says have a live assignment are worth a
        // round trip — assignmentCount === 0 already tells us the answer.
        const toFetch = page.items.filter((visit) => visit.assignmentCount > 0);
        const pairs = await Promise.all(
          toFetch.map(async (visit) => [visit.id, await fetchVisitAssignment(visit.id)] as const)
        );
        setAssignments(Object.fromEntries(pairs));
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
  }, [date, branch]);

  React.useEffect(() => {
    // Fetching from the API — an external system, which is what effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Two ways of reading the same work: the list answers "what is happening
  // today, in order", the calendar answers "how does the week sit together".
  // Managers want both, and switching pages to get one loses the day they were
  // looking at.
  const [view, setView] = React.useState<"list" | "calendar">("list");

  const sorted = React.useMemo(
    () =>
      [...visits].sort(
        (a, b) =>
          (assignments[a.id]?.plannedStartMinute ?? a.windowStartMinute) -
          (assignments[b.id]?.plannedStartMinute ?? b.windowStartMinute),
      ),
    [visits, assignments]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dispatch Board</h1>
          <p className="text-muted-foreground">
            Who is on each scheduled visit. Nobody is assigned here — see Unassigned Visits for
            work that still needs a crew.
          </p>
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="View">
          <Button
            type="button"
            variant={view === "list" ? "default" : "outline"}
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <ClipboardList className="h-4 w-4" aria-hidden="true" />
            List
          </Button>
          <Button
            type="button"
            variant={view === "calendar" ? "default" : "outline"}
            aria-pressed={view === "calendar"}
            onClick={() => setView("calendar")}
          >
            <CalendarDays className="h-4 w-4" aria-hidden="true" />
            Calendar
          </Button>
        </div>
      </div>

      {view === "calendar" && <CalendarBoard />}

      {view === "list" && (
        <>
        <div className="flex flex-wrap items-end gap-4 rounded-xl border bg-card p-4 shadow-sm">
          <div className="flex items-end gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Previous day"
              onClick={() => setDate((current) => addDays(current, -1))}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <div className="space-y-1.5">
              <Label htmlFor="dispatch-date">Date</Label>
              <Input
                id="dispatch-date"
                type="date"
                value={date}
                onChange={(event) => event.target.value && setDate(event.target.value)}
                className="w-40"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Next day"
              onClick={() => setDate((current) => addDays(current, 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setDate(todayIso())}>
              Today
            </Button>
          </div>
  
          <div className="space-y-1.5">
            <Label htmlFor="dispatch-branch">Branch</Label>
            <Select
              items={BRANCH_LABELS}
              value={branch}
              onValueChange={(value) => setBranch((value as BranchFilter) ?? "ALL")}
            >
              <SelectTrigger id="dispatch-branch" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">Both branches</SelectItem>
                <SelectItem value="COLOMBO">Colombo</SelectItem>
                <SelectItem value="KANDY">Kandy</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
  
        <p className="text-sm text-muted-foreground">{formatLongDate(date)}</p>
  
        {isLoading ? (
          <LoadingState rows={4} />
        ) : error ? (
          <ErrorState
            title="Couldn't load the dispatch board"
            description={error.message}
            code={error.code}
            onRetry={load}
          />
        ) : sorted.length === 0 ? (
          <EmptyState
            title="Nothing scheduled for this date"
            description="Generate visits from Service Agreements, or try a different date or branch."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer / Site</TableHead>
                <TableHead>Booked</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Supervisor</TableHead>
                <TableHead>Crew</TableHead>
                <TableHead>Vehicle</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="sr-only">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((visit) => {
                const assignment = assignments[visit.id];
                const supervisor = assignment?.crew.find((member) => member.isPmsSupervisor);
  
                return (
                  <TableRow key={visit.id}>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => setSelectedVisitId(visit.id)}
                        className="text-left font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      >
                        {visit.customerName}
                      </button>
                      <p className="text-xs text-muted-foreground">
                        {visit.siteName} · {visit.jobTypeName}
                      </p>
                    </TableCell>
                    <TableCell>
                      {assignment ? (
                        // The slot the crew is actually booked into. The window
                        // is when the customer is open — showing only that told
                        // a manager "08:00-17:00, 60 min" and left them to
                        // guess which hour anybody is turning up.
                        <>
                          <span className="font-medium tabular-nums">
                            {formatMinuteOfDay(assignment.plannedStartMinute)}–
                            {formatMinuteOfDay(assignment.plannedEndMinute)}
                          </span>
                          <span className="block text-xs text-muted-foreground">
                            open {formatMinuteOfDay(visit.windowStartMinute)}–
                            {formatMinuteOfDay(visit.windowEndMinute)}
                          </span>
                        </>
                      ) : (
                        <>
                          <span className="text-muted-foreground">Not booked yet</span>
                          <span className="block text-xs text-muted-foreground">
                            open {formatMinuteOfDay(visit.windowStartMinute)}–
                            {formatMinuteOfDay(visit.windowEndMinute)}
                          </span>
                        </>
                      )}
                    </TableCell>
                    <TableCell>{visit.durationMinutes} min</TableCell>
                    <TableCell>
                      {supervisor ? (
                        <span>{supervisor.fullName}</span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-sm text-destructive">
                          <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
                          No PMS supervisor
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {assignment && assignment.crew.length > 0 ? (
                        <span className="text-sm">
                          {assignment.crew.map((member) => member.fullName).join(", ")}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                          <UserX className="h-3.5 w-3.5" aria-hidden="true" />
                          No crew yet
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {assignment && assignment.vehicles.length > 0 ? (
                        <span className="text-sm">
                          {assignment.vehicles
                            .map((vehicle) =>
                              vehicle.driverName
                                ? `${vehicle.label} (${vehicle.driverName})`
                                : vehicle.label
                            )
                            .join(", ")}
                        </span>
                      ) : assignment ? (
                        // A crew that is going but has no vehicle travels by
                        // public transport — that is a plan, and saying so is
                        // useful. Only when a crew exists, though: printing it
                        // against a visit nobody is assigned to would announce
                        // travel arrangements for a job that is not happening.
                        <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                          <Footprints className="h-3.5 w-3.5" aria-hidden="true" />
                          Public transport
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">No vehicle</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <VisitStatusBadge status={visit.status} />
                        <VisitOwnershipBadges visit={visit} />
                        {!assignment && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            nativeButton={false}
                            // Carries the visit, so the queue opens on this one
                            // rather than at the top of several hundred rows with
                            // the manager left to find it again by name.
                            render={<Link href={`/unassigned-visits?visit=${visit.id}`} />}
                          >
                            <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                            Why?
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => setEditVisitId(visit.id)}
                      >
                        <UserCog className="h-3 w-3" aria-hidden="true" />
                        Edit crew
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        </>
      )}

      <VisitDetailDrawer
        visitId={selectedVisitId}
        onOpenChange={(open) => !open && setSelectedVisitId(null)}
        onChanged={load}
      />

      <AssignmentEditorDrawer
        visitId={editVisitId}
        onOpenChange={(open) => !open && setEditVisitId(null)}
        onChanged={load}
      />
    </div>
  );
}
