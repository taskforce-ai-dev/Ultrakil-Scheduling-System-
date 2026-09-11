"use client";

import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, ChevronLeft, ChevronRight, CircleDashed, SearchX, ShieldAlert, UserCog } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { ConflictList } from "@/components/shared/conflict-list";
import {
  ApiError,
  fetchUnassignedVisits,
  type UnassignedOperationState,
  type UnassignedVisit,
  type UnassignedVisitsQuery,
} from "@/lib/api-client";
import { formatLongDate, todayIso } from "@/lib/calendar";
import {
  CONFLICT_GROUPS,
  CONFLICT_GROUP_LABEL,
  type ConflictGroup,
} from "@/lib/conflict-groups";
import { AssignmentEditorDrawer } from "../visits/assignment-editor-drawer";
import { VisitDetailDrawer } from "../visits/visit-detail-drawer";

type BranchFilter = "ALL" | "COLOMBO" | "KANDY";
type GroupFilter = "ALL" | ConflictGroup;
/**
 * The server's two operation states, plus "no preference". Both names come
 * from the API (`operationState` on every row and on the filter), so the page
 * asks the same question the server answers rather than inventing a `status`
 * of its own — which the API, validating with `forbidNonWhitelisted`, refused.
 */
type StateFilter = "ALL" | UnassignedOperationState;

const KANDY_PMS_CODES = new Set(["NO_PMS_SUPERVISOR_AVAILABLE", "BRANCH_HAS_NO_PMS_SUPERVISOR"]);
const PAGE_SIZE = 25;

const BRANCH_LABELS: Record<BranchFilter, string> = {
  ALL: "Both branches",
  COLOMBO: "Colombo",
  KANDY: "Kandy",
};

// Base UI's <SelectValue> renders the raw value unless the root is given a
// value -> label map, which would show the raw group code on the trigger.
const GROUP_LABELS: Record<GroupFilter, string> = {
  ALL: "All conflict types",
  ...CONFLICT_GROUP_LABEL,
};

/**
 * Every visit that still needs a crew — not just ones the engine has already
 * refused. The server's `operationState` distinguishes the two: UNASSIGNED
 * means nobody has proposed a crew yet, so an empty conflict list is silence,
 * not a pass; EXCEPTION means a crew was judged and refused.
 * Every conflict a checked visit does have is shown in full (never
 * truncated), with a direct path from each one to the employee/vehicle/visit
 * record it's about — per ULK-O05.
 */
export default function UnassignedVisitsPage() {
  // Set when a manager arrived from a specific visit's "Why?" — the queue then
  // opens on that one visit instead of at the top of several hundred rows.
  // Optional chaining is not defensive clutter: this hook returns null when the
  // component renders outside a router — which is exactly how it is unit
  // tested — and a page that only works inside one is a page that cannot be
  // tested.
  const searchParams = useSearchParams();
  const focusVisitId = searchParams?.get("visit") ?? null;

  const [branch, setBranch] = React.useState<BranchFilter>("ALL");
  const [group, setGroup] = React.useState<GroupFilter>("ALL");
  const [date, setDate] = React.useState(todayIso());
  const [status, setStatus] = React.useState<StateFilter>("ALL");
  const [page, setPage] = React.useState(1);
  const [items, setItems] = React.useState<UnassignedVisit[]>([]);
  const [total, setTotal] = React.useState(0);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [selectedVisitId, setSelectedVisitId] = React.useState<string | null>(null);
  const [assignVisitId, setAssignVisitId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    // Every filter goes to the server, which is the only place the list, the
    // total and the paging can be made to agree. Typing the query as the
    // contract's own makes the API's filter vocabulary a compile-time
    // requirement, so a parameter it would refuse cannot be sent from here
    // again.
    //
    // A visit asked for by name is asked for by name: `visitId` goes to the
    // server *instead of* the filters, not alongside them. The queue's own
    // defaults are today and page 1, so a request that carried the id but
    // kept them found the visit only when it happened to be today's and in
    // the first 25 rows — and otherwise handed back unrelated rows that a
    // browser-side lookup then quietly displayed. The server answers with
    // that visit or with nothing; there is no page here to search.
    const query: UnassignedVisitsQuery = focusVisitId
      ? { visitId: focusVisitId }
      : {
          page,
          pageSize: PAGE_SIZE,
          from: date,
          to: date,
          ...(branch === "ALL" ? {} : { branchCode: branch }),
          ...(status === "ALL" ? {} : { operationState: status }),
          ...(group === "ALL" ? {} : { conflictGroup: group }),
        };
    fetchUnassignedVisits(query)
      .then((page) => {
        setItems(page.items);
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
  }, [branch, date, focusVisitId, group, page, status]);

  React.useEffect(() => {
    // Fetching from the API — an external system, which is what effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // The named visit was asked for and is not here.
  //
  // Nothing narrows the list any more. A visit asked for by name still wins
  // over every filter, but it wins on the server, which is the only place
  // that can see past today's first page to find it. Picking the row out of
  // whatever list came back was the defect: when the visit was not in that
  // list — another date, or past row 25 — the lookup fell through and the
  // page displayed the list it did get as though it were the answer.
  //
  // So there are three ways to be told it is not here, and they mean the same
  // thing to a manager. The server answered about that visit alone and
  // returned nothing — an unknown id, or a visit since staffed, completed or
  // cancelled. Or it refused the id outright, which for a focused request can
  // only mean the link carried something that is not a visit id at all, since
  // the id is the only parameter sent; reporting that as "couldn't load the
  // queue" would make a bad link look like an outage. Or the response
  // contradicts the contract by carrying some other visit — and that last
  // check is not the browser-side lookup this replaced: it never searches a
  // list for the visit and can only ever show less, refusing the whole
  // response, because a row that is not the visit that was asked for is not
  // an answer to it and must never be displayed as one.
  const focusNotFound =
    focusVisitId !== null &&
    (error
      ? error.code === "VALIDATION_FAILED"
      : items.length === 0 ||
        items.some((visit) => visit.visitId !== focusVisitId));

  const kandyPmsShortage = React.useMemo(
    () =>
      items.some(
        (visit) =>
          visit.branchCode === "KANDY" &&
          visit.conflicts.some((c) => KANDY_PMS_CODES.has(c.code))
      ),
    [items]
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Unassigned Visits</h1>
        <p className="text-muted-foreground">
          Every visit that still needs a crew — including work nobody has tried to staff yet.
          Nothing here is ready to dispatch: a blank conflict list means it hasn&apos;t been
          checked, not that it&apos;s fine.
        </p>
      </div>

      {kandyPmsShortage && (
        <div className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
          <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            <p className="font-medium text-destructive">Kandy has no PMS supervisor available</p>
            <p className="text-sm text-muted-foreground">
              One or more Kandy visits below are blocked because no eligible PMS-grade supervisor
              can be assigned. This will keep recurring until a Kandy PMS supervisor is added or
              becomes available.
            </p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-4 rounded-xl border bg-card p-4 shadow-sm">
        <div className="space-y-1.5">
          <Label htmlFor="unassigned-branch">Branch</Label>
          <Select
            items={BRANCH_LABELS}
            value={branch}
            onValueChange={(value) => {
              setBranch((value as BranchFilter) ?? "ALL");
              setPage(1);
            }}
          >
            <SelectTrigger id="unassigned-branch" className="w-44">
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
          <Label htmlFor="unassigned-date">Date</Label>
          <input
            id="unassigned-date"
            type="date"
            value={date}
            onChange={(event) => { if (event.target.value) { setDate(event.target.value); setPage(1); } }}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="unassigned-status">Status</Label>
          <Select value={status} onValueChange={(value) => { setStatus((value as typeof status) ?? "ALL"); setPage(1); }}>
            <SelectTrigger id="unassigned-status" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All unresolved</SelectItem>
              <SelectItem value="UNASSIGNED">Unassigned</SelectItem>
              <SelectItem value="EXCEPTION">Exceptions</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="unassigned-conflict-type">Conflict type</Label>
          <Select
            items={GROUP_LABELS}
            value={group}
            onValueChange={(value) => { setGroup((value as GroupFilter) ?? "ALL"); setPage(1); }}
          >
            <SelectTrigger id="unassigned-conflict-type" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All conflict types</SelectItem>
              {CONFLICT_GROUPS.map((g) => (
                <SelectItem key={g} value={g}>
                  {CONFLICT_GROUP_LABEL[g]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <LoadingState rows={4} />
      ) : focusNotFound ? (
        // Said plainly, and on its own. With `visitId` the server answers
        // about one visit and no other, so there is nothing else to show —
        // and showing something else is exactly the failure this replaces.
        <div className="space-y-3">
          <EmptyState
            icon={SearchX}
            title="That visit isn't in the unassigned queue"
            description="It may already have a crew, or have been completed or cancelled — or the link may name a visit that no longer exists. Nothing else is shown here, because nothing else would be an answer to it."
          />
          <p className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              nativeButton={false}
              render={<Link href="/unassigned-visits" />}
            >
              Show all unassigned visits
            </Button>
          </p>
        </div>
      ) : error ? (
        <ErrorState
          title="Couldn't load unassigned visits"
          description={error.message}
          code={error.code}
          onRetry={load}
        />
      ) : items.length === 0 ? (
        <EmptyState
          title="Nothing unassigned"
          description="Every visit currently has a valid crew and vehicle assignment."
        />
      ) : (
        <>
          {focusVisitId ? (
            // Says plainly why the list is one row long, and offers the way back.
            // A shortened list with no explanation reads as a broken page.
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              Showing the one visit you asked about.
              <Button
                type="button"
                variant="outline"
                size="xs"
                nativeButton={false}
                render={<Link href="/unassigned-visits" />}
              >
                Show all unassigned visits
              </Button>
            </p>
          ) : (
            total > items.length && (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                Showing {items.length} of {total} unassigned visits. Narrow the branch filter to see
                the rest.
              </p>
            )
          )}

          <ul className="space-y-4">
            {items.map((visit) => (
              <li key={visit.visitId} className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <button
                      type="button"
                      onClick={() => setSelectedVisitId(visit.visitId)}
                      className="text-left font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                    >
                      {visit.customerName}
                    </button>
                    <p className="text-xs text-muted-foreground">
                      {visit.siteName} · {formatLongDate(visit.visitDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline">{visit.branchCode}</Badge>
                    <Badge variant="outline">Needs {visit.requiredCrewSize} crew</Badge>
                    {/* The server's own reading of the row, not a guess made
                        from whichever conflicts happen to be in this page. */}
                    {visit.operationState === "UNASSIGNED" && (
                      <Badge variant="outline">Not yet checked</Badge>
                    )}
                  </div>
                </div>

                <div className="mt-3">
                  {visit.operationState === "EXCEPTION" && visit.conflicts.length > 0 ? (
                    <ConflictList conflicts={visit.conflicts} />
                  ) : (
                    <p className="flex items-center gap-1.5 rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
                      <CircleDashed className="h-4 w-4 shrink-0" aria-hidden="true" />
                      Nobody has proposed a crew for this visit yet — this is not a clean bill of
                      health, it just hasn&apos;t been checked.
                    </p>
                  )}
                </div>

                <div className="mt-3 flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedVisitId(visit.visitId)}
                  >
                    View visit details
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setAssignVisitId(visit.visitId)}
                  >
                    <UserCog className="h-3.5 w-3.5" aria-hidden="true" />
                    Assign crew
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          {total > PAGE_SIZE && (
            <nav className="flex items-center justify-between border-t pt-4" aria-label="Unassigned visit pages">
              <p className="text-sm text-muted-foreground">Page {page} of {Math.max(1, Math.ceil(total / PAGE_SIZE))}</p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setPage((current) => current + 1)} disabled={page >= Math.ceil(total / PAGE_SIZE)}>
                  Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            </nav>
          )}
        </>
      )}

      <VisitDetailDrawer
        visitId={selectedVisitId}
        onOpenChange={(open) => !open && setSelectedVisitId(null)}
        onChanged={load}
      />

      <AssignmentEditorDrawer
        visitId={assignVisitId}
        onOpenChange={(open) => !open && setAssignVisitId(null)}
        onChanged={load}
      />
    </div>
  );
}
