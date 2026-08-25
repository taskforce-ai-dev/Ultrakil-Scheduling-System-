"use client";

import * as React from "react";
import Link from "next/link";

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
import { BranchBadge, ActiveStatusBadge } from "@/components/shared/workforce-badges";
import { ApiError, fetchVehicles, type Vehicle } from "@/lib/api-client";

type BranchCode = NonNullable<Vehicle["branchCode"]>;

/** Live fleet from the API. Driver counts come with each vehicle. */
export default function VehiclesPage() {
  const [vehicles, setVehicles] = React.useState<Vehicle[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  const [search, setSearch] = React.useState("");
  const [branch, setBranch] = React.useState<BranchCode | "ALL">("ALL");

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    fetchVehicles({ pageSize: 200 })
      .then((page) => setVehicles(page.items))
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught
            : new ApiError({ code: "UNKNOWN_ERROR", message: "Something went wrong." })
        );
      })
      .finally(() => setIsLoading(false));
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const filteredVehicles = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return vehicles.filter((vehicle) => {
      if (query && !vehicle.label.toLowerCase().includes(query) && !vehicle.code.toLowerCase().includes(query)) {
        return false;
      }
      if (branch !== "ALL" && vehicle.branchCode !== branch) return false;
      return true;
    });
  }, [vehicles, search, branch]);

  const hasActiveFilters = search !== "" || branch !== "ALL";

  function clearFilters() {
    setSearch("");
    setBranch("ALL");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Vehicles</h1>
        <p className="text-muted-foreground">
          Fleet vehicles and which employees are authorized to drive them.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-lg border p-4">
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="vehicles-search">Search</Label>
          <Input
            id="vehicles-search"
            placeholder="Search by code or label"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="vehicles-branch">Branch</Label>
          <Select value={branch} onValueChange={(value) => setBranch(value as BranchCode | "ALL")}>
            <SelectTrigger id="vehicles-branch" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All branches</SelectItem>
              <SelectItem value="COLOMBO">Colombo</SelectItem>
              <SelectItem value="KANDY">Kandy</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <LoadingState rows={6} />
      ) : error ? (
        <ErrorState
          title="Couldn't load vehicles"
          description={error.message}
          code={error.code}
          onRetry={load}
        />
      ) : filteredVehicles.length === 0 ? (
        <EmptyState
          title="No vehicles match these filters"
          description="Try clearing a filter or searching a different code."
          actionLabel={hasActiveFilters ? "Clear filters" : undefined}
          onAction={hasActiveFilters ? clearFilters : undefined}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Vehicle</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Seats</TableHead>
              <TableHead>Authorized drivers</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredVehicles.map((vehicle) => (
              <TableRow key={vehicle.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/vehicles/${vehicle.id}`}
                    className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  >
                    {vehicle.label}
                  </Link>
                </TableCell>
                <TableCell>
                  {/* The contract marks branchCode optional (a vehicle need
                      not be based anywhere), so normalise undefined to null. */}
                  <BranchBadge branchCode={vehicle.branchCode ?? null} />
                </TableCell>
                <TableCell>{vehicle.seatCapacity ?? "—"}</TableCell>
                <TableCell>{vehicle.authorizedDriverCount}</TableCell>
                <TableCell>
                  <ActiveStatusBadge isActive={vehicle.isActive} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
