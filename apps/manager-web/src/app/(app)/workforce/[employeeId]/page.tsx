"use client";

import * as React from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import {
  ApiError,
  fetchEmployee,
  fetchVehicles,
  type Employee,
  type Vehicle,
} from "@/lib/api-client";
import { EmployeeDetailView } from "./employee-detail-view";

/**
 * A client component, not a server one: the access token lives in the
 * browser's storage, so the server has no way to make an authenticated call on
 * the visitor's behalf.
 */
export default function EmployeeDetailPage({
  params,
}: {
  params: Promise<{ employeeId: string }>;
}) {
  const { employeeId } = React.use(params);

  const [employee, setEmployee] = React.useState<Employee | null>(null);
  const [vehicles, setVehicles] = React.useState<Vehicle[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    Promise.all([fetchEmployee(employeeId), fetchVehicles({ pageSize: 200 })])
      .then(([loadedEmployee, vehiclePage]) => {
        setEmployee(loadedEmployee);
        setVehicles(vehiclePage.items);
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
  }, [employeeId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (isLoading) return <LoadingState rows={6} />;

  if (error) {
    // A missing employee is a normal outcome worth its own wording; anything
    // else is a failure the manager may be able to retry.
    return error.code === "RESOURCE_NOT_FOUND" ? (
      <EmptyState
        title="Employee not found"
        description={`No employee matches ID "${employeeId}". It may have been removed.`}
      />
    ) : (
      <ErrorState
        title="Couldn't load this employee"
        description={error.message}
        code={error.code}
        onRetry={load}
      />
    );
  }

  if (!employee) {
    return (
      <EmptyState
        title="Employee not found"
        description={`No employee matches ID "${employeeId}".`}
      />
    );
  }

  return <EmployeeDetailView employee={employee} vehicles={vehicles} />;
}
