"use client";

import * as React from "react";
import { AlertTriangle, ShieldAlert } from "lucide-react";

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
import { ApiError, fetchUnassignedVisits, type UnassignedVisit } from "@/lib/api-client";
import { formatLongDate } from "@/lib/calendar";
import {
  CONFLICT_GROUPS,
  CONFLICT_GROUP_LABEL,
  conflictGroup,
  type ConflictGroup,
} from "@/lib/conflict-groups";
import { VisitDetailDrawer } from "../visits/visit-detail-drawer";

type BranchFilter = "ALL" | "COLOMBO" | "KANDY";
type GroupFilter = "ALL" | ConflictGroup;

const KANDY_PMS_CODES = new Set(["NO_PMS_SUPERVISOR_AVAILABLE", "BRANCH_HAS_NO_PMS_SUPERVISOR"]);
const PAGE_SIZE = 200;

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
 * Every visit the eligibility engine could not staff, with every conflict it
 * returned (never truncated) and a direct path from each one to the
 * employee/vehicle/visit record it's about — per ULK-O05.
 */
export default function UnassignedVisitsPage() {
  const [branch, setBranch] = React.useState<BranchFilter>("ALL");
  const [group, setGroup] = React.useState<GroupFilter>("ALL");
  const [items, setItems] = React.useState<UnassignedVisit[]>([]);
  const [total, setTotal] = React.useState(0);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);
  const [selectedVisitId, setSelectedVisitId] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    fetchUnassignedVisits({
      pageSize: PAGE_SIZE,
      ...(branch === "ALL" ? {} : { branchCode: branch }),
    })
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
  }, [branch]);

  React.useEffect(() => {
    // Fetching from the API — an external system, which is what effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const filtered = React.useMemo(() => {
    if (group === "ALL") return items;
    return items.filter((visit) => visit.conflicts.some((c) => conflictGroup(c.code) === group));
  }, [items, group]);

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
          Visits the eligibility engine could not staff, and exactly why. Nothing here is ready
          to dispatch until every conflict below is resolved.
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
            onValueChange={(value) => setBranch((value as BranchFilter) ?? "ALL")}
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
          <Label htmlFor="unassigned-conflict-type">Conflict type</Label>
          <Select
            items={GROUP_LABELS}
            value={group}
            onValueChange={(value) => setGroup((value as GroupFilter) ?? "ALL")}
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
      ) : error ? (
        <ErrorState
          title="Couldn't load unassigned visits"
          description={error.message}
          code={error.code}
          onRetry={load}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          title={items.length === 0 ? "Nothing unassigned" : "No visits match this filter"}
          description={
            items.length === 0
              ? "Every visit currently has a valid crew and vehicle assignment."
              : "Try a different branch or conflict type."
          }
        />
      ) : (
        <>
          {total > items.length && (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              Showing {items.length} of {total} unassigned visits. Narrow the branch filter to see
              the rest.
            </p>
          )}

          <ul className="space-y-4">
            {filtered.map((visit) => (
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
                  </div>
                </div>

                <div className="mt-3">
                  <ConflictList conflicts={visit.conflicts} />
                </div>

                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setSelectedVisitId(visit.visitId)}
                  >
                    View visit details
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <VisitDetailDrawer
        visitId={selectedVisitId}
        onOpenChange={(open) => !open && setSelectedVisitId(null)}
        onChanged={load}
      />
    </div>
  );
}
