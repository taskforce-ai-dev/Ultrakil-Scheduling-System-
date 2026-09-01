import Link from "next/link";
import {
  Anchor,
  Ban,
  Car,
  CarFront,
  Clock,
  ExternalLink,
  GraduationCap,
  HelpCircle,
  MapPinOff,
  ShieldAlert,
  Users,
  UsersRound,
  type LucideIcon,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Conflict } from "@/lib/api-client";
import { CONFLICT_GROUP_LABEL, conflictGroup, type ConflictGroup } from "@/lib/conflict-groups";

const GROUP_ICON: Record<ConflictGroup, LucideIcon> = {
  MISSING_PMS: ShieldAlert,
  INSUFFICIENT_CREW: Users,
  MISSING_SKILL: GraduationCap,
  NO_AUTHORIZED_DRIVER: CarFront,
  UNAVAILABLE_VEHICLE: Ban,
  BRANCH_RESTRICTION: MapPinOff,
  PERMANENT_STAFF_RESTRICTION: Anchor,
  SERVICE_WINDOW_CONFLICT: Clock,
  EMPLOYEE_OVERLAP: UsersRound,
  VEHICLE_OVERLAP: Car,
  OTHER: HelpCircle,
};

/**
 * Every conflict on a visit, in full — never truncated to the first one.
 * Identified by icon + group label + the raw stable code + the written
 * message, so nothing here depends on color alone.
 */
export function ConflictList({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <ul className="space-y-2">
      {conflicts.map((conflict, index) => {
        const group = conflictGroup(conflict.code);
        const Icon = GROUP_ICON[group];
        const employeeIds = conflict.resources.employeeIds;
        const vehicleIds = conflict.resources.vehicleIds;

        return (
          <li
            key={`${conflict.code}-${index}`}
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3"
          >
            <div className="flex items-start gap-2.5">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
              <div className="flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{CONFLICT_GROUP_LABEL[group]}</Badge>
                  <code className="text-xs text-muted-foreground">{conflict.code}</code>
                </div>
                <p className="text-sm">{conflict.message}</p>
                <p className="text-sm text-muted-foreground">
                  <span className="font-medium text-foreground">What to do: </span>
                  {conflict.remediation}
                </p>

                {(employeeIds.length > 0 || vehicleIds.length > 0) && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {employeeIds.map((id) => (
                      <Button
                        key={id}
                        type="button"
                        variant="outline"
                        size="xs"
                        nativeButton={false}
                        render={<Link href={`/workforce/${id}`} />}
                      >
                        View employee
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </Button>
                    ))}
                    {vehicleIds.map((id) => (
                      <Button
                        key={id}
                        type="button"
                        variant="outline"
                        size="xs"
                        nativeButton={false}
                        render={<Link href={`/vehicles/${id}`} />}
                      >
                        View vehicle
                        <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A quick-scan strip of just the group badges, for a collapsed list row. */
export function ConflictBadgeStrip({ conflicts }: { conflicts: Conflict[] }) {
  const groups = Array.from(new Set(conflicts.map((conflict) => conflictGroup(conflict.code))));
  return (
    <div className="flex flex-wrap gap-1.5">
      {groups.map((group) => {
        const Icon = GROUP_ICON[group];
        return (
          <Badge key={group} variant="destructive">
            <Icon aria-hidden="true" />
            {CONFLICT_GROUP_LABEL[group]}
          </Badge>
        );
      })}
    </div>
  );
}
