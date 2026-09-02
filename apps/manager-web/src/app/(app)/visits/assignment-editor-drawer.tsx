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

  const [checkResult, setCheckResult] = React.useState<EligibilityResult | null>(null);
  const [isChecking, setIsChecking] = React.useState(false);
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

  const load = React.useCallback(() => {
    if (!visitId) return;
    setIsLoading(true);
    setLoadError(null);
    setSaveConflicts(null);
    Promise.all([fetchVisit(visitId), fetchVisitAssignment(visitId)])
      .then(([visitDetail, currentAssignment]) => {
        setVisit(visitDetail);
        setAssignment(currentAssignment);
        return fetchEmployees({ branch: visitDetail.branchCode, pageSize: 200 }).then(
          (page) => {
            setEmployees(page.items);
            return fetchVehicles({ branch: visitDetail.branchCode, pageSize: 200 });
          }
        );
      })
      .then((vehiclePage) => setVehicles(vehiclePage.items))
      .catch((caught: unknown) => {
        setLoadError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
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
  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSessionLocks({});
  }, [visitId]);

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
      setStartMinute(visit.windowStartMinute);
      setEndMinute(visit.windowEndMinute);
      setCrewRows([]);
      setVehicleRows([]);
    }
    setReason("");
    setSaveConflicts(null);
  }, [visit, assignment]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Base UI's <SelectValue> renders the raw value unless the root is given a
  // value -> label map, which would show an employee/vehicle's UUID on the
  // trigger instead of its name.
  const employeeLabels = React.useMemo(
    () =>
      Object.fromEntries(
        employees.map((employee) => [
          employee.id,
          employee.isPmsGrade ? `${employee.fullName} (PMS)` : employee.fullName,
        ])
      ),
    [employees]
  );
  const vehicleLabels = React.useMemo(
    () => Object.fromEntries(vehicles.map((vehicle) => [vehicle.id, vehicle.label])),
    [vehicles]
  );

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

  // Live validation: every edit is checked against the real eligibility
  // engine before Save is enabled, debounced so typing doesn't fire a
  // request per keystroke. The "reset while there's nothing to check" and
  // "mark checking" calls are synchronous derived state, not a fetch result.
  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    if (!visitId || !visit || proposal.crew.length === 0) {
      setCheckResult(null);
      return;
    }
    setIsChecking(true);
    const timer = setTimeout(() => {
      checkAssignment(visitId, proposal)
        .then(setCheckResult)
        .catch(() => setCheckResult(null))
        .finally(() => setIsChecking(false));
    }, 400);
    return () => clearTimeout(timer);
  }, [visitId, visit, proposal]);
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
    setVehicleRows((rows) =>
      rows.map((row) => (row.key === key ? { ...row, vehicleId, driverEmployeeId: "" } : row))
    );
    if (vehicleId && !driversByVehicle[vehicleId]) {
      fetchAuthorizedDrivers(vehicleId)
        .then((drivers) =>
          setDriversByVehicle((current) => ({ ...current, [vehicleId]: drivers }))
        )
        .catch(() => {
          /* The driver dropdown just stays empty; the eligibility check still
           * catches an unauthorized driver either way. */
        });
    }
  }

  async function save() {
    if (!visitId) return;
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
      notify.success("Assignment saved.");
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
    if (!visitId) return;
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
    if (!assignment) return;
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

  const isPublished = assignment?.status === "PUBLISHED";
  const canSave =
    !isSaving &&
    !isPublished &&
    reason.trim().length > 0 &&
    proposal.crew.length > 0 &&
    !(checkResult && !checkResult.isEligible);

  return (
    <AppDrawer
      open={visitId !== null}
      onOpenChange={onOpenChange}
      title={visit ? `Edit crew — ${visit.customerName}` : "Edit crew"}
      description={visit ? formatLongDate(visit.visitDate) : undefined}
      footer={
        visit ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            {assignment ? (
              <Button
                type="button"
                variant="outline"
                onClick={removeCrew}
                disabled={isRemoving || isPublished}
              >
                <UserX aria-hidden="true" />
                Remove crew
              </Button>
            ) : (
              <span />
            )}
            <Button type="button" onClick={save} disabled={!canSave}>
              {isSaving ? "Saving…" : "Save assignment"}
            </Button>
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
          {isPublished && (
            <p className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              This visit is on a <strong>published</strong> schedule and cannot be re-crewed by
              hand. Run the scheduler again and publish the new run to replace it — the published
              one is kept as a record.
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
                disabled={isPublished}
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
                disabled={isPublished}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
              />
            </div>
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Supervisor &amp; crew</h3>
              <Button type="button" variant="outline" size="sm" onClick={addCrewRow} disabled={isPublished}>
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
                    disabled={isPublished}
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
              <Button type="button" variant="outline" size="sm" onClick={addVehicleRow} disabled={isPublished}>
                <Plus aria-hidden="true" />
                Add vehicle
              </Button>
            </div>
            {vehicleRows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No vehicle assigned — a crew using public transport needs none.
              </p>
            )}
            <div className="space-y-2">
              {vehicleRows.map((row) => {
                const drivers = row.vehicleId ? driversByVehicle[row.vehicleId] : undefined;
                const driverLabels = Object.fromEntries(
                  (drivers?.drivers ?? []).map((driver) => [driver.id, driver.fullName])
                );
                return (
                  <div key={row.key} className="flex items-center gap-2">
                    <Select
                      items={vehicleLabels}
                      value={row.vehicleId}
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
                      onValueChange={(value) =>
                        setVehicleRows((rows) =>
                          rows.map((entry) =>
                            entry.key === row.key ? { ...entry, driverEmployeeId: value ?? "" } : entry
                          )
                        )
                      }
                    >
                      <SelectTrigger aria-label="Driver" className="w-40">
                        <SelectValue placeholder="Driver" />
                      </SelectTrigger>
                      <SelectContent>
                        {(drivers?.drivers ?? []).map((driver) => (
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
                      disabled={isPublished}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </section>

          <section>
            <Label htmlFor="override-reason">Reason for this change</Label>
            <Textarea
              id="override-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Why is this being changed by hand?"
              disabled={isPublished}
              className="mt-1.5"
            />
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
                      disabled={lockBusyScope !== null}
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
