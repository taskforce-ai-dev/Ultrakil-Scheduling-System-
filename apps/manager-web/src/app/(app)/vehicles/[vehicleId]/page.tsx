"use client";

import * as React from "react";

import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { LoadingState } from "@/components/shared/loading-state";
import {
  ApiError,
  fetchAuthorizedDrivers,
  fetchVehicle,
  type AuthorizedDrivers,
  type Vehicle,
} from "@/lib/api-client";
import { VehicleDetailView } from "./vehicle-detail-view";

/**
 * A client component, not a server one: the access token lives in the
 * browser's storage, so the server has no way to make an authenticated call
 * on the visitor's behalf. See workforce/[employeeId]/page.tsx for the same
 * pattern.
 */
export default function VehicleDetailPage({
  params,
}: {
  params: Promise<{ vehicleId: string }>;
}) {
  const { vehicleId } = React.use(params);

  const [vehicle, setVehicle] = React.useState<Vehicle | null>(null);
  const [authorized, setAuthorized] = React.useState<AuthorizedDrivers | null>(null);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    Promise.all([fetchVehicle(vehicleId), fetchAuthorizedDrivers(vehicleId)])
      .then(([loadedVehicle, loadedAuthorized]) => {
        setVehicle(loadedVehicle);
        setAuthorized(loadedAuthorized);
      })
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
  }, [vehicleId]);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (isLoading) return <LoadingState rows={5} />;

  if (error) {
    return error.code === "RESOURCE_NOT_FOUND" ? (
      <EmptyState
        title="Vehicle not found"
        description={`No vehicle matches ID "${vehicleId}". It may have been removed.`}
      />
    ) : (
      <ErrorState
        title="Couldn't load this vehicle"
        description={error.message}
        code={error.code}
        onRetry={load}
      />
    );
  }

  if (!vehicle || !authorized) return null;

  return <VehicleDetailView vehicle={vehicle} drivers={authorized.drivers} />;
}
