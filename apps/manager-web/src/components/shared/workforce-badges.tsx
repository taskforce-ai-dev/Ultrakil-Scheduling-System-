import { MapPin, ShieldCheck, Lock, CheckCircle2, XCircle, Car } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { Employee, Vehicle } from "@/lib/api-client";

type BranchCode = NonNullable<Vehicle["branchCode"]>;
type DeploymentType = Employee["deploymentType"];

/**
 * Every badge here pairs an icon with a text label — status is never shown
 * by color alone, so it reads the same for colorblind users and in any
 * screenshot or print-out a manager takes.
 */

export function BranchBadge({ branchCode }: { branchCode: BranchCode | null }) {
  if (!branchCode) {
    return (
      <Badge variant="outline">
        <MapPin aria-hidden="true" />
        Unassigned branch
      </Badge>
    );
  }

  return (
    <Badge variant={branchCode === "COLOMBO" ? "default" : "secondary"}>
      <MapPin aria-hidden="true" />
      {branchCode === "COLOMBO" ? "Colombo" : "Kandy"}
    </Badge>
  );
}

export function PmsBadge({ isPmsGrade }: { isPmsGrade: boolean }) {
  if (!isPmsGrade) {
    return <Badge variant="outline">Not PMS-grade</Badge>;
  }

  return (
    <Badge variant="success">
      <ShieldCheck aria-hidden="true" />
      PMS-grade
    </Badge>
  );
}

export function PermanentBadge({ deploymentType }: { deploymentType: DeploymentType }) {
  if (deploymentType !== "PERMANENTLY_STATIONED") {
    return null;
  }

  return (
    <Badge variant="secondary" className="border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
      <Lock aria-hidden="true" />
      Permanently stationed
    </Badge>
  );
}

export function ActiveStatusBadge({
  isActive,
  activeLabel = "Available",
}: {
  isActive: boolean;
  /** "Available" reads right for an employee/vehicle; customers and sites
   * want "Active" instead. Inactive is always just "Inactive". */
  activeLabel?: string;
}) {
  return (
    <Badge variant={isActive ? "success" : "outline"}>
      {isActive ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
      {isActive ? activeLabel : "Inactive"}
    </Badge>
  );
}

export function VehicleAuthCount({ count }: { count: number }) {
  return (
    <Badge variant="outline">
      <Car aria-hidden="true" />
      {count} {count === 1 ? "vehicle" : "vehicles"}
    </Badge>
  );
}
