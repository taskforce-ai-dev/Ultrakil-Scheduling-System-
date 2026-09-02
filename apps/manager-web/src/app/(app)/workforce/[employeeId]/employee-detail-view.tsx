"use client";

import * as React from "react";
import Link from "next/link";
import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { AppDrawer } from "@/components/shared/app-drawer";
import { ErrorState } from "@/components/shared/error-state";
import {
  BranchBadge,
  PmsBadge,
  PermanentBadge,
  ActiveStatusBadge,
} from "@/components/shared/workforce-badges";
import { ApiError, type Employee, type Vehicle } from "@/lib/api-client";
import { submitVehicleAuthorizations } from "@/lib/workforce-actions";
import { notify } from "@/lib/notify";

export function EmployeeDetailView({
  employee,
  vehicles,
}: {
  employee: Employee;
  vehicles: Vehicle[];
}) {
  const [authorizedVehicleIds, setAuthorizedVehicleIds] = React.useState(
    employee.authorizedVehicleIds
  );
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [draftVehicleIds, setDraftVehicleIds] = React.useState<string[]>(authorizedVehicleIds);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  // A ref alongside the state: two clicks fired in the same tick (a fast
  // double-click) both close over the same pre-update `isSaving`, so the
  // state check alone can't stop the second one.
  const isSavingRef = React.useRef(false);
  const [saveError, setSaveError] = React.useState<ApiError | null>(null);

  function openDrawer() {
    setDraftVehicleIds(authorizedVehicleIds);
    setSaveError(null);
    setDrawerOpen(true);
  }

  function toggleDraftVehicle(vehicleId: string, checked: boolean) {
    setDraftVehicleIds((current) =>
      checked ? [...current, vehicleId] : current.filter((id) => id !== vehicleId)
    );
  }

  async function confirmSave() {
    if (isSavingRef.current) return; // Collapses a double-click into one request.
    isSavingRef.current = true;
    setConfirmOpen(false);
    setIsSaving(true);
    setSaveError(null);
    try {
      // Trust what comes back rather than the draft: a later call in the
      // sequence may have failed after earlier ones succeeded.
      const saved = await submitVehicleAuthorizations(
        employee.id,
        authorizedVehicleIds,
        draftVehicleIds
      );
      setAuthorizedVehicleIds(saved.authorizedVehicleIds);
      notify.success("Vehicle authorizations updated.");
      setDrawerOpen(false);
    } catch (caught) {
      setSaveError(
        caught instanceof ApiError
          ? caught
          : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
      );
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }

  const authorizedVehicles = vehicles.filter((vehicle) =>
    authorizedVehicleIds.includes(vehicle.id)
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{employee.fullName}</h1>
          {employee.employeeCode && (
            <p className="text-sm text-muted-foreground">Employee code: {employee.employeeCode}</p>
          )}
        </div>
        <Button variant="outline" onClick={openDrawer}>
          <Pencil className="h-4 w-4" />
          Edit vehicle authorizations
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <BranchBadge branchCode={employee.branchCode} />
        <PmsBadge isPmsGrade={employee.isPmsGrade} />
        <ActiveStatusBadge isActive={employee.isActive} />
        <PermanentBadge deploymentType={employee.deploymentType} />
      </div>

      {employee.deploymentType === "PERMANENTLY_STATIONED" && (
        <div className="rounded-lg border border-amber-300/50 bg-amber-50 p-4 text-sm dark:bg-amber-950/20">
          <p className="font-medium">
            Permanently stationed at {employee.permanentSiteLabel ?? "an unrecorded site"}.
          </p>
          <p className="text-muted-foreground">
            Permanently stationed staff cannot be moved to another site, and never count toward mobile crew capacity.
          </p>
        </div>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        <section className="space-y-2 rounded-xl border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-medium text-muted-foreground">Position</h2>
          <p className="text-lg">{employee.gradeLabel}</p>
        </section>

        <section className="space-y-2 rounded-xl border bg-card p-4 shadow-sm">
          <h2 className="text-sm font-medium text-muted-foreground">Skills</h2>
          {employee.skills.length === 0 ? (
            <p className="text-sm text-muted-foreground">No skills on record.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {employee.skills.map((skill) => (
                <Badge key={skill.skillCode} variant="outline">
                  {skill.skillLabel}
                </Badge>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="space-y-3 rounded-xl border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-medium text-muted-foreground">Vehicle authorizations</h2>
        {authorizedVehicles.length === 0 ? (
          <p className="text-sm text-muted-foreground">Not authorized to drive any vehicle yet.</p>
        ) : (
          <ul className="space-y-2">
            {authorizedVehicles.map((vehicle) => (
              <li key={vehicle.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <Link
                    href={`/vehicles/${vehicle.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {vehicle.label}
                  </Link>
                  <p className="text-sm text-muted-foreground">
                    Authorized to drive — not the vehicle&apos;s owner or primary driver.
                  </p>
                </div>
                <BranchBadge branchCode={vehicle.branchCode ?? null} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <AppDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        title="Edit vehicle authorizations"
        description={`Choose which vehicles ${employee.fullName} is authorized to drive. A checkmark means authorization only — it never implies ownership.`}
        footer={
          <Button className="w-full" disabled={isSaving} onClick={() => setConfirmOpen(true)}>
            {isSaving ? "Saving…" : "Save changes"}
          </Button>
        }
      >
        <div className="space-y-4 py-4">
          {saveError && (
            <ErrorState
              title="Couldn't save vehicle authorizations"
              description={saveError.message}
              code={saveError.code}
              onRetry={() => setConfirmOpen(true)}
            />
          )}

          <div className="space-y-3">
            {vehicles.map((vehicle) => {
              const checkboxId = `vehicle-auth-${vehicle.id}`;
              return (
                <div key={vehicle.id} className="flex items-center gap-3">
                  <Checkbox
                    id={checkboxId}
                    checked={draftVehicleIds.includes(vehicle.id)}
                    onCheckedChange={(checked) => toggleDraftVehicle(vehicle.id, checked)}
                  />
                  <Label htmlFor={checkboxId} className="flex-1 font-normal">
                    {vehicle.label}
                  </Label>
                  <BranchBadge branchCode={vehicle.branchCode ?? null} />
                </div>
              );
            })}
          </div>
        </div>
      </AppDrawer>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save vehicle authorizations?</DialogTitle>
            <DialogDescription>
              This updates which vehicles {employee.fullName} is authorized to drive.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button onClick={confirmSave}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
