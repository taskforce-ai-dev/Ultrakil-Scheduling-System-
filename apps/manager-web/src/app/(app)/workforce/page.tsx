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
import {
  BranchBadge,
  PmsBadge,
  PermanentBadge,
  ActiveStatusBadge,
  VehicleAuthCount,
} from "@/components/shared/workforce-badges";
import {
  ApiError,
  fetchEmployees,
  fetchVehicles,
  type Employee,
  type Vehicle,
} from "@/lib/api-client";

type BranchCode = Employee["branchCode"];
type TriState = "ALL" | "YES" | "NO";

/**
 * Live workforce from the API.
 *
 * Filtering stays client-side over the loaded page: there are 37 employees,
 * so a round trip per keystroke would be slower and no more correct. It is
 * display convenience only and never decides what is schedulable — every
 * scheduling rule, `isPmsGrade` included, is the API's answer, not the UI's.
 */
export default function WorkforcePage() {
  const [employees, setEmployees] = React.useState<Employee[]>([]);
  const [vehicles, setVehicles] = React.useState<Vehicle[]>([]);
  const [isLoading, setIsLoading] = React.useState(true);
  const [error, setError] = React.useState<ApiError | null>(null);

  const [search, setSearch] = React.useState("");
  const [branch, setBranch] = React.useState<BranchCode | "ALL">("ALL");
  const [pmsOnly, setPmsOnly] = React.useState<TriState>("ALL");
  const [permanentOnly, setPermanentOnly] = React.useState<TriState>("ALL");
  const [skillCode, setSkillCode] = React.useState<string>("ALL");
  const [vehicleId, setVehicleId] = React.useState<string>("ALL");

  const load = React.useCallback(() => {
    setIsLoading(true);
    setError(null);
    // pageSize covers the whole workforce in one call; the API caps it at 200
    // and there are 37 people. Revisit if UltraKIL grows past that.
    Promise.all([
      fetchEmployees({ pageSize: 200 }),
      fetchVehicles({ pageSize: 200 }),
    ])
      .then(([employeePage, vehiclePage]) => {
        setEmployees(employeePage.items);
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
  }, []);

  React.useEffect(() => {
    // Fetching from the API on mount — an external system, which is what
    // effects are for.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const skillOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const employee of employees) {
      for (const skill of employee.skills) {
        seen.set(skill.skillCode, skill.skillLabel);
      }
    }
    return Array.from(seen, ([code, label]) => ({ code, label })).sort((a, b) =>
      a.label.localeCompare(b.label)
    );
  }, [employees]);

  const filteredEmployees = React.useMemo(() => {
    const query = search.trim().toLowerCase();

    return employees.filter((employee) => {
      if (query && !employee.fullName.toLowerCase().includes(query)) return false;
      if (branch !== "ALL" && employee.branchCode !== branch) return false;
      if (pmsOnly === "YES" && !employee.isPmsGrade) return false;
      if (pmsOnly === "NO" && employee.isPmsGrade) return false;
      if (permanentOnly === "YES" && employee.deploymentType !== "PERMANENTLY_STATIONED") return false;
      if (permanentOnly === "NO" && employee.deploymentType === "PERMANENTLY_STATIONED") return false;
      if (skillCode !== "ALL" && !employee.skills.some((skill) => skill.skillCode === skillCode)) return false;
      if (vehicleId !== "ALL" && !employee.authorizedVehicleIds.includes(vehicleId)) return false;
      return true;
    });
  }, [employees, search, branch, pmsOnly, permanentOnly, skillCode, vehicleId]);

  const hasActiveFilters =
    search !== "" || branch !== "ALL" || pmsOnly !== "ALL" || permanentOnly !== "ALL" || skillCode !== "ALL" || vehicleId !== "ALL";

  function clearFilters() {
    setSearch("");
    setBranch("ALL");
    setPmsOnly("ALL");
    setPermanentOnly("ALL");
    setSkillCode("ALL");
    setVehicleId("ALL");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Workforce</h1>
        <p className="text-muted-foreground">
          Employees, branch assignment, PMS grade and vehicle authorizations.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4 rounded-lg border p-4">
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="workforce-search">Search</Label>
          <Input
            id="workforce-search"
            placeholder="Search by name"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="workforce-branch">Branch</Label>
          <Select value={branch} onValueChange={(value) => setBranch(value as BranchCode | "ALL")}>
            <SelectTrigger id="workforce-branch" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All branches</SelectItem>
              <SelectItem value="COLOMBO">Colombo</SelectItem>
              <SelectItem value="KANDY">Kandy</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="workforce-pms">PMS grade</Label>
          <Select value={pmsOnly} onValueChange={(value) => setPmsOnly(value as TriState)}>
            <SelectTrigger id="workforce-pms" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All employees</SelectItem>
              <SelectItem value="YES">PMS-grade only</SelectItem>
              <SelectItem value="NO">Not PMS-grade</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="workforce-permanent">Permanent status</Label>
          <Select value={permanentOnly} onValueChange={(value) => setPermanentOnly(value as TriState)}>
            <SelectTrigger id="workforce-permanent" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All employees</SelectItem>
              <SelectItem value="YES">Permanently stationed only</SelectItem>
              <SelectItem value="NO">Mobile only</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="workforce-skill">Skill</Label>
          <Select value={skillCode} onValueChange={(value) => setSkillCode(value ?? "ALL")}>
            <SelectTrigger id="workforce-skill" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">All skills</SelectItem>
              {skillOptions.map((skill) => (
                <SelectItem key={skill.code} value={skill.code}>
                  {skill.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="workforce-vehicle">Authorized for vehicle</Label>
          <Select value={vehicleId} onValueChange={(value) => setVehicleId(value ?? "ALL")}>
            <SelectTrigger id="workforce-vehicle" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">Any vehicle</SelectItem>
              {vehicles.map((vehicle) => (
                <SelectItem key={vehicle.id} value={vehicle.id}>
                  {vehicle.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <LoadingState rows={6} />
      ) : error ? (
        <ErrorState
          title="Couldn't load the workforce"
          description={error.message}
          code={error.code}
          onRetry={load}
        />
      ) : filteredEmployees.length === 0 ? (
        <EmptyState
          title="No employees match these filters"
          description="Try clearing a filter or searching a different name."
          actionLabel={hasActiveFilters ? "Clear filters" : undefined}
          onAction={hasActiveFilters ? clearFilters : undefined}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Branch</TableHead>
              <TableHead>Grade</TableHead>
              <TableHead>PMS eligibility</TableHead>
              <TableHead>Permanent status</TableHead>
              <TableHead>Vehicles</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredEmployees.map((employee) => (
              <TableRow key={employee.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/workforce/${employee.id}`}
                    className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  >
                    {employee.fullName}
                  </Link>
                </TableCell>
                <TableCell>
                  <BranchBadge branchCode={employee.branchCode} />
                </TableCell>
                <TableCell>{employee.gradeLabel}</TableCell>
                <TableCell>
                  <PmsBadge isPmsGrade={employee.isPmsGrade} />
                </TableCell>
                <TableCell>
                  {employee.deploymentType === "PERMANENTLY_STATIONED" ? (
                    <PermanentBadge deploymentType={employee.deploymentType} />
                  ) : (
                    <span className="text-sm text-muted-foreground">Mobile</span>
                  )}
                </TableCell>
                <TableCell>
                  <VehicleAuthCount count={employee.authorizedVehicleIds.length} />
                </TableCell>
                <TableCell>
                  <ActiveStatusBadge isActive={employee.isActive} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
