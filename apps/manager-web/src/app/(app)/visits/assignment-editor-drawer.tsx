"use client";

import * as React from "react";
import { Pin, PinOff, Plus, Trash2, UserX } from "lucide-react";

import { AppDrawer } from "@/components/shared/app-drawer";
import { ConflictList } from "@/components/shared/conflict-list";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  assignCrew,
  checkAssignment,
  fetchAuthorizedDrivers,
  fetchEmployees,
  fetchVehicles,
  fetchVisit,
  fetchVisitAssignment,
  lockAssignment,
  unassignVisit,
  unlockAssignment,
  type Assignment,
  type AssignmentLock,
  type AuthorizedDrivers,
  type Conflict,
  type CrewRole,
  type Employee,
  type EligibilityResult,
  type LockScope,
  type Vehicle,
  type VisitDetail,
} from "@/lib/api-client";
import { formatLongDate } from "@/lib/calendar";
import { notify } from "@/lib/notify";

interface AssignmentEditorDrawerProps {
  visitId: string | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a save, removal or lock change, so the page behind can refresh. */
  onChanged: () => void;
}

const ROLE_LABELS: Record<CrewRole, string> = {
  SUPERVISOR: "Supervisor",
  TECHNICIAN: "Technician",
  DRIVER: "Driver",
  HELPER: "Helper",
};

const LOCK_SCOPES: { scope: LockScope; label: string; help: string }[] = [
  { scope: "TIME", label: "Date & time", help: "The next schedule run will not move this visit's window." },
  { scope: "SUPERVISOR", label: "Supervisor", help: "The next schedule run will not replace the supervisor." },
  { scope: "CREW", label: "Crew", help: "The next schedule run will not change who's on the crew." },
  { scope: "VEHICLE", label: "Vehicle", help: "The next schedule run will not swap the vehicle." },
  { scope: "FULL", label: "Everything", help: "The next schedule run will leave this assignment exactly as it is." },
];

// Keep this aligned with PUBLISHED_HISTORY in the API's schedule-visit-lock.
// Those assignments are audit history, not an editable scheduling draft.
const PUBLICATION_HISTORY_STATUSES = new Set([
  "PUBLISHED",
  "ACKNOWLEDGED",
  "IN_PROGRESS",
  "COMPLETED",
  "SUPERSEDED",
]);

let rowKeySeq = 0;
function nextKey(): string {
  rowKeySeq += 1;
  return `row-${rowKeySeq}`;
}

interface CrewRow {
  key: string;
  employeeId: string;
  role: CrewRole;
}

interface VehicleRow {
  key: string;
  vehicleId: string;
  driverEmployeeId: string;
}

function minuteToTimeInput(minute: number): string {
  const hours = Math.floor(minute / 60)
    .toString()
    .padStart(2, "0");
  const mins = (minute % 60).toString().padStart(2, "0");
  return `${hours}:${mins}`;
}

function timeInputToMinute(value: string): number {
  const [hoursText, minsText] = value.split(":");
  const hours = Number(hoursText);
  const mins = Number(minsText);
  if (Number.isNaN(hours) || Number.isNaN(mins)) return 0;
  return hours * 60 + mins;
}

/**
 * Manual crew, supervisor, vehicle and time overrides for one visit — the
 * "replacement workflows" ULK-O06 asks for, all backed by the one endpoint
 * the API actually offers (`PUT /visits/:id/assignment` replaces the whole
 * crew and vehicle list, there's no per-field patch). Editing just the
 * supervisor row, just the rest of the crew, or just the vehicle list are
 * three different entry points into this one form, not three endpoints.
 *
 * Every edit is validated live against the real eligibility engine
 * (`POST .../assignment/check`, a dry run) before Save is enabled, so a
 * manager sees every rejection reason — not just the first — before
 * committing anything.
 */
export function AssignmentEditorDrawer({
  visitId,
  onOpenChange,
  onChanged,
}: AssignmentEditorDrawerProps) {
  const [visit, setVisit] = React.useState<VisitDetail | null>(null);
  const [assignment, setAssignment] = React.useState<Assignment | null>(null);
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [vehicles, setVehicles] = React.useState<Vehicle[]>([]);
  const [driversByVehicle, setDriversByVehicle] = React.useState<
    Record<string, AuthorizedDrivers>
  >({});
  const [isLoading, setIsLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState<ApiError | null>(null);

  const [startMinute, setStartMinute] = React.useState(0);
  const [endMinute, setEndMinute] = React.useState(0);
  const [crewRows, setCrewRows] = React.useState<CrewRow[]>([]);
  const [vehicleRows, setVehicleRows] = React.useState<VehicleRow[]>([]);
  const [reason, setReason] = React.useState("");
  // Focused when a manager presses a Save that is only waiting for these words.
  const reasonRef = React.useRef<HTMLTextAreaElement>(null);

  const [checkResult, setCheckResult] = React.useState<EligibilityResult | null>(null);
  const [isChecking, setIsChecking] = React.useState(false);
  const eligibilityRequestGenerationRef = React.useRef(0);
  const [isSaving, setIsSaving] = React.useState(false);
  // A ref alongside each busy state below: two clicks fired in the same tick
  // (a fast double-click) both close over the same pre-update state, so the
  // state check alone can't stop the second one. The ref updates
  // synchronously, before React has scheduled a re-render.
  const isSavingRef = React.useRef(false);
  const [isRemoving, setIsRemoving] = React.useState(false);
  const isRemovingRef = React.useRef(false);
  const [saveConflicts, setSaveConflicts] = React.useState<Conflict[] | null>(null);

  const [lockBusyScope, setLockBusyScope] = React.useState<LockScope | null>(null);
  const lockBusyScopeRef = React.useRef<LockScope | null>(null);
  // What this browser session has itself locked/unlocked, by scope. The API
  // has no way to read back *which* scopes are locked on an existing
  // assignment (see the note on `lockAssignment` in api-client.ts) — this is
  // the honest subset of that answer: accurate for anything changed in this
  // session, unknown for anything set before the drawer was opened.
  const [sessionLocks, setSessionLocks] = React.useState<
    Partial<Record<LockScope, AssignmentLock | null>>
  >({});

  // A slow response for a previous visit must not repopulate the drawer once
  // a different visit is open — the picker would then offer another branch's
  // vehicles and employees for this one.
  const loadGenerationRef = React.useRef(0);

  const load = React.useCallback(() => {
    if (!visitId) return;
    const generation = ++loadGenerationRef.current;
    const current = () => generation === loadGenerationRef.current;
    setIsLoading(true);
    setLoadError(null);
    setSaveConflicts(null);
    Promise.all([fetchVisit(visitId), fetchVisitAssignment(visitId)])
      .then(([visitDetail, currentAssignment]) => {
        if (!current()) return undefined;
        setVisit(visitDetail);
        setAssignment(currentAssignment);
        return fetchEmployees({ branch: visitDetail.branchCode, pageSize: 200 }).then(
          (page) => {
            if (!current()) return undefined;
            setEmployees(page.items);
            // The engine treats a vehicle with no recorded branch as unknown,
            // not wrong (the Technician Matrix never states one). Asking only
            // for vehicles *of* this branch returned none on real data and left
            // an enabled picker that opened onto nothing.
            return fetchVehicles({ servesBranch: visitDetail.branchCode, pageSize: 200 });
          }
        );
      })
      .then((vehiclePage) => {
        if (vehiclePage && current()) setVehicles(vehiclePage.items);
      })
      .catch((caught: unknown) => {
        if (!current()) return;
        setLoadError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => {
        if (current()) setIsLoading(false);
      });
  }, [visitId]);

  React.useEffect(() => {
    // Fetching from the API — an external system, which is what effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Reset only when a *different* visit is opened — not on every `load()`
  // refresh within the same visit, which would erase the one honest record
  // this drawer has of which scopes it locked/unlocked this session (see the
  // note above `sessionLocks`) the moment it saves its own change.
  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    setSessionLocks({});
    // The reason belongs to the change a manager is composing, not to whatever
    // the last fetch returned. Resetting it with the form prefill below meant
    // any refresh of the same visit erased what they were typing; a successful
    // save clears it explicitly instead, once the reason has been recorded.
    setReason("");
  }, [visitId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Pre-fill the form from the current assignment (or the visit's own window,
  // for a visit that has none yet) whenever a fresh visit/assignment loads.
  // Several fields reset together as one unit, so this stays an effect on
  // [visit, assignment] rather than several derived-state calculations.
  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    if (!visit) return;
    if (assignment) {
      setStartMinute(assignment.plannedStartMinute);
      setEndMinute(assignment.plannedEndMinute);
      setCrewRows(
        assignment.crew.map((member) => ({
          key: nextKey(),
          employeeId: member.employeeId,
          role: member.role,
        }))
      );
      setVehicleRows(
        assignment.vehicles.map((entry) => ({
          key: nextKey(),
          vehicleId: entry.vehicleId,
          driverEmployeeId: entry.driverEmployeeId ?? "",
        }))
      );
    } else {
      // The visit's own planned window, not the site's whole day. The service
      // window is the span the work has to fall *inside* — 08:00-17:00 for an
      // all-day site — and offering its far end as the default "Leaves by"
      // booked a crew out for nine hours on a 60-minute job for anyone who
      // pressed Save without editing it. Clamped to the window, so the
      // default never proposes a crew still on site after it closes.
      setStartMinute(visit.windowStartMinute);
      setEndMinute(
        Math.min(visit.windowEndMinute, visit.windowStartMinute + visit.durationMinutes)
      );
      setCrewRows([]);
      setVehicleRows([]);
    }
    setSaveConflicts(null);
  }, [visit, assignment]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Base UI's <SelectValue> renders the raw value unless the root is given a
  // value -> label map, which would show an employee/vehicle's UUID on the
  // trigger instead of its name.
  // Displayable is wider than selectable. The assignment read model names
  // every vehicle it references, and a published or historical assignment may
  // reference one the branch-serving list no longer offers. Its name still
  // belongs on screen; it does not become an option.
  // Nothing to choose from once loading is done. Rows an assignment already
  // has still render (their names come from the assignment), but no new one
  // can be added and no picker is offered that would open onto nothing.
  const noVehicleCanServe = !isLoading && visit !== null && vehicles.length === 0;

  // Same rule for people: the assignment names its own crew and drivers, and
  // a published assignment may name someone the branch list or the authorized
  // list no longer returns. Their names still belong on screen.
  const employeeLabels = React.useMemo(
    () =>
      Object.fromEntries([
        ...(assignment?.crew ?? []).map((member) => [
          member.employeeId,
          member.isPmsSupervisor ? `${member.fullName} (PMS)` : member.fullName,
        ]),
        ...employees.map((employee) => [
          employee.id,
          employee.isPmsGrade ? `${employee.fullName} (PMS)` : employee.fullName,
        ]),
      ]),
    [assignment, employees]
  );
  const assignedDriverLabels = React.useMemo(
    () =>
      Object.fromEntries(
        (assignment?.vehicles ?? [])
          .filter((entry) => entry.driverEmployeeId && entry.driverName)
          .map((entry) => [entry.driverEmployeeId as string, entry.driverName as string])
      ),
    [assignment]
  );

  const vehicleLabels = React.useMemo(
    () =>
      Object.fromEntries([
        ...(assignment?.vehicles ?? []).map((entry) => [entry.vehicleId, entry.label]),
        ...vehicles.map((vehicle) => [vehicle.id, vehicle.label]),
      ]),
    [assignment, vehicles]
  );

  // Every employee currently on the crew, regardless of the role they're
  // listed under — a supervisor or technician can just as well be the
  // vehicle's driver. This is the "checked crew member" half of the ULK-O09
  // rule: a driver must be authorized for the vehicle (driversByVehicle,
  // below) *and* actually on this visit's crew.
  const crewEmployeeIds = React.useMemo(
    () => new Set(crewRows.map((row) => row.employeeId).filter(Boolean)),
    [crewRows]
  );

  // Fetch (and cache) authorized drivers for every vehicle currently on the
  // form — not just one freshly chosen via onVehicleChosen below, so a
  // vehicle row hydrated from an existing assignment gets its driver options
  // too, without waiting for the manager to reselect it.
  React.useEffect(() => {
    for (const row of vehicleRows) {
      if (row.vehicleId && !driversByVehicle[row.vehicleId]) {
        fetchAuthorizedDrivers(row.vehicleId)
          .then((drivers) =>
            setDriversByVehicle((current) => ({ ...current, [row.vehicleId]: drivers }))
          )
          .catch(() => {
            /* The driver dropdown just stays empty; the eligibility check
             * still catches an unauthorized driver either way. */
          });
      }
    }
  }, [vehicleRows, driversByVehicle]);

  // If the crew changes — someone is removed, or a row's employee is swapped
  // — any vehicle row whose driver is no longer on the crew has to be
  // cleared. Otherwise a manager could save a driver who a moment ago was
  // valid (on the crew) but silently no longer is, which the driver <Select>
  // below would still show as selected even though it's no longer offered.
  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    setVehicleRows((rows) => {
      const needsClearing = rows.some(
        (row) => row.driverEmployeeId && !crewEmployeeIds.has(row.driverEmployeeId)
      );
      if (!needsClearing) return rows;
      return rows.map((row) =>
        row.driverEmployeeId && !crewEmployeeIds.has(row.driverEmployeeId)
          ? { ...row, driverEmployeeId: "" }
          : row
      );
    });
  }, [crewEmployeeIds]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const proposal = React.useMemo(
    () => ({
      plannedStartMinute: startMinute,
      plannedEndMinute: endMinute,
      crew: crewRows
        .filter((row) => row.employeeId)
        .map((row) => ({ employeeId: row.employeeId, role: row.role })),
      vehicles: vehicleRows
        .filter((row) => row.vehicleId)
        .map((row) => ({
          vehicleId: row.vehicleId,
          ...(row.driverEmployeeId ? { driverEmployeeId: row.driverEmployeeId } : {}),
        })),
    }),
    [startMinute, endMinute, crewRows, vehicleRows]
  );

  const isPublicationHistory =
    assignment !== null && PUBLICATION_HISTORY_STATUSES.has(assignment.status);
  // Only an editable assignment is told nothing can serve it; history is
  // read-only and the advice would be about a record nobody can act on here.
  const vehiclePickerBlocked = noVehicleCanServe && !isPublicationHistory;

  // Live validation: every edit is checked against the real eligibility
  // engine before Save is enabled, debounced so typing doesn't fire a
  // request per keystroke. A generation fence makes a completed response
  // authoritative only for the exact proposal that started it.
  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    const generation = eligibilityRequestGenerationRef.current + 1;
    eligibilityRequestGenerationRef.current = generation;
    if (!visitId || !visit || isPublicationHistory || proposal.crew.length === 0) {
      setCheckResult(null);
      setIsChecking(false);
      return;
    }
    setCheckResult(null);
    setIsChecking(true);
    const timer = setTimeout(() => {
      checkAssignment(visitId, proposal)
        .then((result) => {
          if (eligibilityRequestGenerationRef.current === generation) setCheckResult(result);
        })
        .catch(() => {
          if (eligibilityRequestGenerationRef.current === generation) setCheckResult(null);
        })
        .finally(() => {
          if (eligibilityRequestGenerationRef.current === generation) setIsChecking(false);
        });
    }, 400);
    return () => {
      clearTimeout(timer);
      if (eligibilityRequestGenerationRef.current === generation) {
        eligibilityRequestGenerationRef.current += 1;
      }
    };
  }, [visitId, visit, isPublicationHistory, proposal]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function addCrewRow() {
    setCrewRows((rows) => [
      ...rows,
      { key: nextKey(), employeeId: "", role: "TECHNICIAN" as CrewRole },
    ]);
  }

  function removeCrewRow(key: string) {
    setCrewRows((rows) => rows.filter((row) => row.key !== key));
  }

  function addVehicleRow() {
    setVehicleRows((rows) => [...rows, { key: nextKey(), vehicleId: "", driverEmployeeId: "" }]);
  }

  function removeVehicleRow(key: string) {
    setVehicleRows((rows) => rows.filter((row) => row.key !== key));
  }

  function onVehicleChosen(key: string, vehicleId: string) {
    // Driver eligibility is vehicle-specific, so switching vehicles always
    // clears the driver — the authorized-drivers fetch itself is handled by
    // the effect above, which watches vehicleRows.
    setVehicleRows((rows) =>
      rows.map((row) => (row.key === key ? { ...row, vehicleId, driverEmployeeId: "" } : row))
    );
  }

  async function save() {
    if (!visitId || isPublicationHistory) return;
    if (!reason.trim()) {
      notify.error("A reason is required for a manual override.");
      return;
    }
    if (isSavingRef.current) return; // Collapses a double-click into one request.
    isSavingRef.current = true;
    setIsSaving(true);
    setSaveConflicts(null);
    try {
      await assignCrew(visitId, { ...proposal, reason: reason.trim() });
      notify.success("Assignment saved. The reason is on this visit's history.");
      // The reason has been recorded; the next change needs its own. Cleared
      // here rather than as a side effect of the reload, so a refusal — which
      // does not reload — leaves the words a manager already typed in place.
      setReason("");
      load();
      onChanged();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const conflicts = (caught.details?.conflicts as Conflict[] | undefined) ?? null;
        if (conflicts) setSaveConflicts(conflicts);
        notify.error(caught.message);
      } else {
        notify.error("Could not save this assignment.");
      }
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }

  async function removeCrew() {
    if (!visitId || isPublicationHistory) return;
    if (isRemovingRef.current) return; // Collapses a double-click into one request.
    isRemovingRef.current = true;
    setIsRemoving(true);
    try {
      await unassignVisit(visitId);
      notify.success("Crew removed. The visit is back in the Unassigned queue.");
      load();
      onChanged();
    } catch (caught) {
      notify.error(caught instanceof ApiError ? caught.message : "Could not remove the crew.");
    } finally {
      isRemovingRef.current = false;
      setIsRemoving(false);
    }
  }

  async function toggleLock(scope: LockScope) {
    if (!assignment || isPublicationHistory) return;
    if (lockBusyScopeRef.current) return; // Collapses a double-click into one request.
    lockBusyScopeRef.current = scope;
    const currentlyLocked = sessionLocks[scope] !== undefined ? sessionLocks[scope] !== null : null;
    setLockBusyScope(scope);
    try {
      if (currentlyLocked) {
        await unlockAssignment(assignment.id, scope);
        setSessionLocks((current) => ({ ...current, [scope]: null }));
        notify.success(`${LOCK_SCOPES.find((entry) => entry.scope === scope)?.label} released.`);
      } else {
        const lockReason = window.prompt(
          `Why pin the ${LOCK_SCOPES.find((entry) => entry.scope === scope)?.label.toLowerCase()}? (optional)`
        );
        if (lockReason === null) return; // Cancelled the prompt.
        const lock = await lockAssignment(assignment.id, {
          scope,
          ...(lockReason.trim() ? { reason: lockReason.trim() } : {}),
        });
        setSessionLocks((current) => ({ ...current, [scope]: lock }));
        notify.success(`${LOCK_SCOPES.find((entry) => entry.scope === scope)?.label} pinned.`);
      }
      load();
      onChanged();
    } catch (caught) {
      notify.error(caught instanceof ApiError ? caught.message : "Could not change this lock.");
    } finally {
      lockBusyScopeRef.current = null;
      setLockBusyScope(null);
    }
  }

  /**
   * What Save is waiting for, in the words of the step that is missing.
   *
   * A greyed-out button with nothing marked required and no explanation is
   * indistinguishable from a broken one: a coordinator trialling the portal
   * read "This crew is eligible to take the visit", found Save dead, and said
   * they would have concluded the system was broken and phoned someone. The
   * blocker was the reason box, which `save()` requires and which said nothing
   * about itself.
   *
   * Named in the order the drawer is filled in, so the answer is always the
   * next thing to do rather than the last thing checked.
   */
  const saveBlockedReason: string | null = isSaving
    ? null // Already under way; the button says "Saving…" for itself.
    : isPublicationHistory
      ? "Published history cannot be edited here."
      : proposal.crew.length === 0
        ? "Add at least one crew member before saving."
        : isChecking
          ? "Waiting for the eligibility check to finish."
          : checkResult?.isEligible !== true
            ? "This crew cannot take the visit yet — see Validation below."
            : reason.trim().length === 0
              ? "Add a reason for this change before saving."
              : null;

  /**
   * Clicking a blocked Save explains itself rather than doing nothing.
   *
   * The button is aria-disabled, not natively disabled, for the reason already
   * established for the vehicle picker below: a natively disabled button
   * leaves the tab order, so its explanation could never be read by the people
   * it is meant for.
   */
  function attemptSave() {
    if (!saveBlockedReason) {
      void save();
      return;
    }
    if (reason.trim().length === 0 && checkResult?.isEligible === true) {
      notify.error("A reason is required for a manual override.");
      reasonRef.current?.focus();
      return;
    }
    notify.error(saveBlockedReason);
  }

  return (
    <AppDrawer
      open={visitId !== null}
      onOpenChange={onOpenChange}
      title={visit ? `Edit crew — ${visit.customerName}` : "Edit crew"}
      description={visit ? formatLongDate(visit.visitDate) : undefined}
      contentTabIndex={isPublicationHistory}
      footer={
        visit ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            {assignment ? (
              <Button
                type="button"
                variant="outline"
                onClick={removeCrew}
                disabled={isRemoving || isPublicationHistory}
              >
                <UserX aria-hidden="true" />
                Remove crew
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-col items-end gap-1">
              <Button
                type="button"
                onClick={attemptSave}
                disabled={isSaving || isPublicationHistory}
                aria-disabled={saveBlockedReason !== null || undefined}
                aria-describedby={saveBlockedReason ? "save-blocked" : undefined}
              >
                {isSaving ? "Saving…" : "Save assignment"}
              </Button>
              {/* Not a live region: it is the button's own accessible
                  description, announced with the button, and the drawer
                  already has one polite region (Validation) that a second
                  would compete with. */}
              {saveBlockedReason && (
                <p id="save-blocked" className="text-xs text-muted-foreground">
                  {saveBlockedReason}
                </p>
              )}
            </div>
          </div>
        ) : undefined
      }
    >
      {isLoading ? (
        <LoadingState rows={6} />
      ) : loadError ? (
        <ErrorState
          title="Couldn't load this visit"
          description={loadError.message}
          code={loadError.code}
          onRetry={load}
        />
      ) : visit ? (
        <div className="space-y-6 pb-4">
          {isPublicationHistory && (
            <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              This visit is part of <strong>publication history</strong> and cannot be re-crewed by
              hand. Run the scheduler again and publish the new run to replace it — the existing
              schedule is kept as a record.
            </p>
          )}

          <section className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="assignment-start">Arrives</Label>
              <input
                id="assignment-start"
                type="time"
                value={minuteToTimeInput(startMinute)}
                onChange={(event) => setStartMinute(timeInputToMinute(event.target.value))}
                disabled={isPublicationHistory}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="assignment-end">Leaves by</Label>
              <input
                id="assignment-end"
                type="time"
                value={minuteToTimeInput(endMinute)}
                onChange={(event) => setEndMinute(timeInputToMinute(event.target.value))}
                disabled={isPublicationHistory}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              />
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Supervisor &amp; crew</h3>
              <Button type="button" variant="outline" size="sm" onClick={addCrewRow} disabled={isPublicationHistory}>
                <Plus aria-hidden="true" />
                Add crew member
              </Button>
            </div>
            {crewRows.length === 0 && (
              <p className="text-sm text-muted-foreground">No crew proposed yet.</p>
            )}
            <div className="space-y-2">
              {crewRows.map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <Select
                    items={employeeLabels}
                    value={row.employeeId}
                    disabled={isPublicationHistory}
                    onValueChange={(value) =>
                      setCrewRows((rows) =>
                        rows.map((entry) =>
                          entry.key === row.key ? { ...entry, employeeId: value ?? "" } : entry
                        )
                      )
                    }
                  >
                    <SelectTrigger aria-label="Employee" className="flex-1">
                      <SelectValue placeholder="Choose an employee" />
                    </SelectTrigger>
                    <SelectContent>
                      {employees.map((employee) => (
                        <SelectItem key={employee.id} value={employee.id}>
                          {employee.fullName}
                          {employee.isPmsGrade ? " (PMS)" : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    items={ROLE_LABELS}
                    value={row.role}
                    disabled={isPublicationHistory}
                    onValueChange={(value) =>
                      setCrewRows((rows) =>
                        rows.map((entry) =>
                          entry.key === row.key ? { ...entry, role: (value ?? "TECHNICIAN") as CrewRole } : entry
                        )
                      )
                    }
                  >
                    <SelectTrigger aria-label="Role" className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(ROLE_LABELS) as CrewRole[]).map((role) => (
                        <SelectItem key={role} value={role}>
                          {ROLE_LABELS[role]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label="Remove crew member"
                    onClick={() => removeCrewRow(row.key)}
                    disabled={isPublicationHistory}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Vehicles</h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (!vehiclePickerBlocked) addVehicleRow();
                }}
                disabled={isPublicationHistory}
                // aria-disabled rather than disabled: a natively disabled
                // button leaves the tab order, so its reason could never be
                // read by the people it is meant for.
                aria-disabled={vehiclePickerBlocked || undefined}
                aria-describedby={vehiclePickerBlocked ? "no-vehicle-can-serve" : undefined}
              >
                <Plus aria-hidden="true" />
                Add vehicle
              </Button>
            </div>
            {vehiclePickerBlocked && (
              // An enabled picker that opens onto nothing looks broken and
              // explains nothing. Say what is missing and where to fix it.
              <p id="no-vehicle-can-serve" role="status" className="text-sm text-muted-foreground">
                No active vehicle can serve {visit?.branchCode ?? "this branch's"} work: none is
                recorded for this branch or without a branch.{" "}
                {vehicleRows.length > 0
                  ? "The vehicle already on this assignment is shown by name and cannot be changed here; remove it, or record vehicle branches under Vehicles."
                  : "Record vehicle branches under Vehicles, or dispatch a crew that can use public transport."}
              </p>
            )}
            {!vehiclePickerBlocked && vehicleRows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No vehicle assigned — a crew using public transport needs none.
              </p>
            )}
            <div className="space-y-2">
              {vehicleRows.map((row) => {
                const drivers = row.vehicleId ? driversByVehicle[row.vehicleId] : undefined;
                // ULK-O09: offer a driver only if they're both authorized
                // for this vehicle (a checkmark, per the workforce matrix)
                // and actually on this visit's crew. Never just "authorized
                // for the vehicle" — that would let a manager assign someone
                // who isn't part of this visit at all.
                const eligibleDrivers = (drivers?.drivers ?? []).filter((driver) =>
                  crewEmployeeIds.has(driver.id)
                );
                const driverLabels = {
                  ...assignedDriverLabels,
                  ...Object.fromEntries(
                    eligibleDrivers.map((driver) => [driver.id, driver.fullName])
                  ),
                };
                return (
                  <div key={row.key} className="flex items-center gap-2">
                    <Select
                      items={vehicleLabels}
                      value={row.vehicleId}
                      // With nothing to choose from, the trigger still names
                      // the vehicle this row holds but never opens onto an
                      // empty list.
                      disabled={isPublicationHistory || noVehicleCanServe}
                      onValueChange={(value) => onVehicleChosen(row.key, value ?? "")}
                    >
                      <SelectTrigger aria-label="Vehicle" className="flex-1">
                        <SelectValue placeholder="Choose a vehicle" />
                      </SelectTrigger>
                      <SelectContent>
                        {vehicles.map((vehicle) => (
                          <SelectItem key={vehicle.id} value={vehicle.id}>
                            {vehicle.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      items={driverLabels}
                      value={row.driverEmployeeId}
                      disabled={isPublicationHistory}
                      onValueChange={(value) =>
                        setVehicleRows((rows) =>
                          rows.map((entry) =>
                            entry.key === row.key ? { ...entry, driverEmployeeId: value ?? "" } : entry
                          )
                        )
                      }
                    >
                      <SelectTrigger aria-label="Driver" className="w-40">
                        <SelectValue
                          placeholder={
                            row.vehicleId && drivers && eligibleDrivers.length === 0
                              ? "No crew member is authorized"
                              : "Driver"
                          }
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {eligibleDrivers.map((driver) => (
                          <SelectItem key={driver.id} value={driver.id}>
                            {driver.fullName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove vehicle"
                      onClick={() => removeVehicleRow(row.key)}
                      disabled={isPublicationHistory}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            {/* "Required" sits beside the label rather than inside it: the
                label is this field's accessible name, and a name that drifts
                is a name no test and no screen reader can rely on. The
                textarea carries `required` for the same fact in markup. */}
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="override-reason">Reason for this change</Label>
              <span className="text-xs font-medium text-muted-foreground">Required</span>
            </div>
            <Textarea
              id="override-reason"
              ref={reasonRef}
              required
              aria-describedby="override-reason-hint"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this being changed by hand?"
              disabled={isPublicationHistory}
              className="mt-1.5"
            />
            <p id="override-reason-hint" className="mt-1 text-xs text-muted-foreground">
              Every hand-made change is kept on the visit&apos;s history with the reason given.
            </p>
          </section>

          <section aria-live="polite">
            <h3 className="mb-2 text-sm font-semibold">Validation</h3>
            {isChecking ? (
              <p className="text-sm text-muted-foreground">Checking against the eligibility rules…</p>
            ) : proposal.crew.length === 0 ? (
              <p className="text-sm text-muted-foreground">Add a crew member to validate.</p>
            ) : checkResult?.isEligible ? (
              <p className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                This crew is eligible to take the visit.
              </p>
            ) : checkResult ? (
              <ConflictList conflicts={checkResult.conflicts} />
            ) : null}
            {saveConflicts && (
              <div className="mt-2">
                <p className="mb-1 text-sm font-medium text-destructive">
                  The save was refused for these reasons:
                </p>
                <ConflictList conflicts={saveConflicts} />
              </div>
            )}
          </section>

          {assignment && (
            <section>
              <h3 className="mb-1 text-sm font-semibold">Pin parts of this assignment</h3>
              <p className="mb-2 text-xs text-muted-foreground">
                A pinned part is kept exactly as it is the next time the scheduler runs.
                {assignment.isLocked && (
                  <>
                    {" "}
                    This assignment currently has a pin somewhere — which part, we can only tell
                    you for changes made in this session (below); anything pinned earlier isn&apos;t
                    reported back by the API yet.
                  </>
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {LOCK_SCOPES.map(({ scope, label, help }) => {
                  const known = sessionLocks[scope];
                  const isLockedHere = known !== undefined && known !== null;
                  return (
                    <Button
                      key={scope}
                      type="button"
                      variant={isLockedHere ? "default" : "outline"}
                      size="sm"
                      title={help}
                      onClick={() => toggleLock(scope)}
                      disabled={lockBusyScope !== null || isPublicationHistory}
                    >
                      {isLockedHere ? (
                        <PinOff aria-hidden="true" />
                      ) : (
                        <Pin aria-hidden="true" />
                      )}
                      {label}
                    </Button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      ) : null}
    </AppDrawer>
  );
}
