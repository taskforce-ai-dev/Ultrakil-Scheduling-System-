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
import { BranchBadge, ActiveStatusBadge } from "@/components/shared/workforce-badges";
import { mockEmployees, mockVehicles } from "@/lib/mock-data";
import type { BranchCode } from "@/lib/mock-data/types";

export default function VehiclesPage() {
  const [search, setSearch] = React.useState("");
  const [branch, setBranch] = React.useState<BranchCode | "ALL">("ALL");

  const driverCountByVehicle = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const employee of mockEmployees) {
      for (const vehicleId of employee.authorizedVehicleIds) {
        counts.set(vehicleId, (counts.get(vehicleId) ?? 0) + 1);
      }
    }
    return counts;
  }, []);

  const filteredVehicles = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return mockVehicles.filter((vehicle) => {
      if (query && !vehicle.label.toLowerCase().includes(query) && !vehicle.code.toLowerCase().includes(query)) {
        return false;
      }
      if (branch !== "ALL" && vehicle.branchCode !== branch) return false;
      return true;
    });
  }, [search, branch]);

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

      {filteredVehicles.length === 0 ? (
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
                  <BranchBadge branchCode={vehicle.branchCode} />
                </TableCell>
                <TableCell>{vehicle.seatCapacity ?? "—"}</TableCell>
                <TableCell>{driverCountByVehicle.get(vehicle.id) ?? 0}</TableCell>
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
