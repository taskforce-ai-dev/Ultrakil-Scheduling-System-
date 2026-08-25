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
import {
  BranchBadge,
  PmsBadge,
  PermanentBadge,
  ActiveStatusBadge,
  VehicleAuthCount,
} from "@/components/shared/workforce-badges";
import { mockEmployees, mockVehicles } from "@/lib/mock-data";
import type { BranchCode } from "@/lib/mock-data/types";

type TriState = "ALL" | "YES" | "NO";

/**
 * Low-fidelity screen consuming mock data grounded in the real Employee
 * schema (ULK-C02 hasn't published real endpoints yet — see the PR
 * description). Filtering here is pure display convenience, not a
 * business-rule decision: it never decides what's schedulable.
 */
export default function WorkforcePage() {
  const [search, setSearch] = React.useState("");
  const [branch, setBranch] = React.useState<BranchCode | "ALL">("ALL");
  const [pmsOnly, setPmsOnly] = React.useState<TriState>("ALL");
  const [permanentOnly, setPermanentOnly] = React.useState<TriState>("ALL");
  const [skillCode, setSkillCode] = React.useState<string>("ALL");
  const [vehicleId, setVehicleId] = React.useState<string>("ALL");

  const skillOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const employee of mockEmployees) {
      for (const skill of employee.skills) {
        seen.set(skill.skillCode, skill.skillLabel);
      }
    }
    return Array.from(seen, ([code, label]) => ({ code, label }));
  }, []);

  const filteredEmployees = React.useMemo(() => {
    const query = search.trim().toLowerCase();

    return mockEmployees.filter((employee) => {
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
  }, [search, branch, pmsOnly, permanentOnly, skillCode, vehicleId]);

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
              {mockVehicles.map((vehicle) => (
                <SelectItem key={vehicle.id} value={vehicle.id}>
                  {vehicle.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {filteredEmployees.length === 0 ? (
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
