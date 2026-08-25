import Link from "next/link";

import { EmptyState } from "@/components/shared/empty-state";
import { BranchBadge, ActiveStatusBadge, PmsBadge } from "@/components/shared/workforce-badges";
import { mockEmployees, mockVehicles } from "@/lib/mock-data";

export default async function VehicleDetailPage({
  params,
}: {
  params: Promise<{ vehicleId: string }>;
}) {
  const { vehicleId } = await params;
  const vehicle = mockVehicles.find((candidate) => candidate.id === vehicleId);

  if (!vehicle) {
    return (
      <EmptyState
        title="Vehicle not found"
        description={`No vehicle matches ID "${vehicleId}". It may have been removed.`}
      />
    );
  }

  const authorizedDrivers = mockEmployees.filter((employee) =>
    employee.authorizedVehicleIds.includes(vehicle.id)
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{vehicle.label}</h1>
        <p className="text-sm text-muted-foreground">Vehicle code: {vehicle.code}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <BranchBadge branchCode={vehicle.branchCode} />
        <ActiveStatusBadge isActive={vehicle.isActive} />
      </div>

      <section className="space-y-2 rounded-lg border p-4">
        <h2 className="text-sm font-medium text-muted-foreground">Seat capacity</h2>
        <p className="text-lg">{vehicle.seatCapacity ?? "Not recorded"}</p>
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <h2 className="text-sm font-medium text-muted-foreground">Authorized drivers</h2>
        <p className="text-sm text-muted-foreground">
          Every employee listed here is authorized to drive this vehicle — this is not an ownership or
          primary-driver assignment.
        </p>
        {authorizedDrivers.length === 0 ? (
          <EmptyState
            title="No authorized drivers"
            description="No employee is currently authorized to drive this vehicle."
          />
        ) : (
          <ul className="space-y-2">
            {authorizedDrivers.map((employee) => (
              <li key={employee.id} className="flex items-center justify-between rounded-md border p-3">
                <div>
                  <Link
                    href={`/workforce/${employee.id}`}
                    className="font-medium underline-offset-4 hover:underline"
                  >
                    {employee.fullName}
                  </Link>
                  <p className="text-sm text-muted-foreground">Authorized to drive</p>
                </div>
                <div className="flex items-center gap-2">
                  <PmsBadge isPmsGrade={employee.isPmsGrade} />
                  <BranchBadge branchCode={employee.branchCode} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
