import { CrewRole, DeploymentType } from '@prisma/client';

import { Conflict, sortConflicts } from './conflict-codes';

/**
 * The eligibility engine.
 *
 * A pure function over plain data: the same input always yields the same
 * result, which is the acceptance criterion for ULK-C05 and the reason none of
 * this touches Prisma. Loading the facts is `eligibility.service.ts`'s job;
 * judging them is here, where it can be tested exhaustively without a database.
 *
 * Two principles run through every rule.
 *
 * It reports *all* conflicts, never the first. A manager who fixes the branch
 * only to be told the crew is too small, then that a skill is missing, will
 * stop trusting the screen. One pass, everything wrong with it.
 *
 * And it never softens a rule to make a schedule look complete. Work that
 * cannot be staffed legally goes to the Unassigned queue with its reasons —
 * that is a working outcome, not a failure.
 */

export interface VisitFacts {
  id: string;
  branchCode: string;
  /** YYYY-MM-DD. */
  visitDate: string;
  windowStartMinute: number;
  windowEndMinute: number;
  durationMinutes: number;
  requiredCrewSize: number;
  serviceSiteId: string;
  siteName: string;
  customerName: string;
  requiredSkillCodes: string[];
  /** A completed or cancelled visit is history and cannot be staffed. */
  status: string;
}

/** A booking that already exists, used to catch double-booking. */
export interface BusyPeriod {
  assignmentId: string;
  /** Minutes from midnight on the visit's own date. */
  startMinute: number;
  endMinute: number;
}

export interface EmployeeFacts {
  id: string;
  fullName: string;
  branchCode: string;
  isActive: boolean;
  isPmsGrade: boolean;
  deploymentType: DeploymentType;
  /** Sites this employee is permanently stationed at on the visit date. */
  permanentSiteIds: string[];
  skillCodes: string[];
  authorizedVehicleIds: string[];
  /** Leave, sickness or training covering the visit date. */
  unavailableReason: string | null;
  /** Other visits already assigned to this person on this date. */
  busy: BusyPeriod[];
}

export interface VehicleFacts {
  id: string;
  label: string;
  /** Null when the workforce matrix never said which branch keeps this van. */
  branchCode: string | null;
  isActive: boolean;
  /** Null when the source does not record how many the vehicle seats. */
  seatCapacity: number | null;
  busy: BusyPeriod[];
}

export interface ProposedCrewMember {
  employeeId: string;
  role: CrewRole;
}

export interface ProposedVehicle {
  vehicleId: string;
  driverEmployeeId: string | null;
}

export interface AssignmentProposal {
  plannedStartMinute: number;
  plannedEndMinute: number;
  crew: ProposedCrewMember[];
  vehicles: ProposedVehicle[];
}

export interface EligibilityContext {
  visit: VisitFacts;
  employees: EmployeeFacts[];
  vehicles: VehicleFacts[];
  /**
   * Whether the visit's branch employs any PMS-grade supervisor at all.
   *
   * Kandy currently employs none, so "no supervisor in this crew" and "this
   * branch has nobody who could ever be that supervisor" are different
   * problems with different answers, and the task asks for the second to be
   * named explicitly.
   */
  branchHasPmsSupervisor: boolean;
  /** An existing manager lock on this visit's assignment, if any. */
  existingLock: { assignmentId: string; scope: string; reason: string | null } | null;
}

export interface EligibilityResult {
  isEligible: boolean;
  conflicts: Conflict[];
}

function formatMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  return `${String(hour).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  // Touching is not overlapping: a crew finishing at 12:00 can start at 12:00.
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Judges one proposed crew and vehicle set against one visit.
 *
 * Returns every applicable conflict, in a stable order.
 */
export function evaluateAssignment(
  proposal: AssignmentProposal,
  context: EligibilityContext,
): EligibilityResult {
  const conflicts: Conflict[] = [];
  const { visit } = context;

  const byId = new Map(context.employees.map((employee) => [employee.id, employee]));
  const vehicleById = new Map(context.vehicles.map((vehicle) => [vehicle.id, vehicle]));

  // --- The visit itself ----------------------------------------------------

  if (visit.status === 'COMPLETED' || visit.status === 'CANCELLED') {
    conflicts.push({
      code: 'VISIT_NOT_SCHEDULABLE',
      message: `This visit is ${visit.status.toLowerCase()} and is a record of what happened, so it cannot be staffed.`,
      remediation: 'Generate a new visit if the work needs doing again.',
      resources: { visitId: visit.id },
    });
  }

  if (context.existingLock) {
    conflicts.push({
      code: 'ASSIGNMENT_LOCKED',
      message: `A manager has pinned the crew for this visit${
        context.existingLock.reason ? ` — "${context.existingLock.reason}"` : ''
      }, so it will not be reassigned.`,
      remediation: 'Release the lock on the dispatch board before changing this crew.',
      resources: { visitId: visit.id, assignmentIds: [context.existingLock.assignmentId] },
    });
  }

  // --- The time ------------------------------------------------------------

  const { plannedStartMinute: start, plannedEndMinute: end } = proposal;

  if (end - start < visit.durationMinutes) {
    conflicts.push({
      code: 'WINDOW_TOO_SHORT',
      message: `The crew is booked for ${end - start} minutes but the job takes ${visit.durationMinutes}.`,
      remediation: `Book at least ${visit.durationMinutes} minutes, or shorten the job on the agreement.`,
      resources: { visitId: visit.id },
    });
  }

  if (start < visit.windowStartMinute || end > visit.windowEndMinute) {
    conflicts.push({
      code: 'OUTSIDE_SERVICE_HOURS',
      message: `${visit.customerName} accepts visits between ${formatMinute(visit.windowStartMinute)} and ${formatMinute(visit.windowEndMinute)} at ${visit.siteName}, but this crew is booked ${formatMinute(start)} to ${formatMinute(end)}.`,
      remediation: 'Move the crew inside the site’s hours, or widen the visit window.',
      resources: { visitId: visit.id, serviceSiteId: visit.serviceSiteId },
    });
  }

  // --- The crew ------------------------------------------------------------

  const seen = new Set<string>();
  for (const member of proposal.crew) {
    if (seen.has(member.employeeId)) {
      conflicts.push({
        code: 'DUPLICATE_CREW_MEMBER',
        message: `${byId.get(member.employeeId)?.fullName ?? 'This employee'} appears twice in the crew.`,
        remediation: 'Remove the duplicate.',
        resources: { visitId: visit.id, employeeIds: [member.employeeId] },
      });
    }
    seen.add(member.employeeId);
  }

  const crew = [...seen]
    .map((id) => byId.get(id))
    .filter((employee): employee is EmployeeFacts => employee !== undefined);

  if (crew.length < visit.requiredCrewSize) {
    conflicts.push({
      code: 'CREW_TOO_SMALL',
      message: `${visit.customerName} — ${visit.siteName} needs ${visit.requiredCrewSize} on site; ${crew.length} ${crew.length === 1 ? 'is' : 'are'} assigned.`,
      remediation: `Add ${visit.requiredCrewSize - crew.length} more, or reduce the crew size on the agreement if the job really is smaller.`,
      resources: { visitId: visit.id },
    });
  }

  for (const employee of crew) {
    if (!employee.isActive) {
      conflicts.push({
        code: 'EMPLOYEE_INACTIVE',
        message: `${employee.fullName} is no longer active and cannot be assigned.`,
        remediation: 'Pick someone else, or reactivate them on the Workforce page.',
        resources: { visitId: visit.id, employeeIds: [employee.id] },
      });
    }

    if (employee.branchCode !== visit.branchCode) {
      conflicts.push({
        code: 'BRANCH_MISMATCH',
        message: `${employee.fullName} works out of ${employee.branchCode} and this visit is ${visit.branchCode} work.`,
        remediation: `Assign someone from ${visit.branchCode}. Branches are never mixed.`,
        resources: { visitId: visit.id, employeeIds: [employee.id] },
      });
    }

    if (employee.unavailableReason) {
      conflicts.push({
        code: 'EMPLOYEE_UNAVAILABLE',
        message: `${employee.fullName} is on ${employee.unavailableReason.toLowerCase()} on ${visit.visitDate}.`,
        remediation: 'Assign someone else, or move the visit to another date.',
        resources: { visitId: visit.id, employeeIds: [employee.id] },
      });
    }

    if (
      employee.deploymentType === DeploymentType.PERMANENTLY_STATIONED &&
      !employee.permanentSiteIds.includes(visit.serviceSiteId)
    ) {
      conflicts.push({
        code: 'EMPLOYEE_PERMANENTLY_STATIONED',
        message: `${employee.fullName} is permanently stationed elsewhere and cannot be sent to ${visit.siteName}.`,
        remediation: 'Assign a mobile crew member instead.',
        resources: {
          visitId: visit.id,
          employeeIds: [employee.id],
          serviceSiteId: visit.serviceSiteId,
        },
      });
    }

    const clash = employee.busy.find((period) =>
      overlaps(start, end, period.startMinute, period.endMinute),
    );
    if (clash) {
      conflicts.push({
        code: 'EMPLOYEE_DOUBLE_BOOKED',
        message: `${employee.fullName} is already on another job from ${formatMinute(clash.startMinute)} to ${formatMinute(clash.endMinute)} on ${visit.visitDate}.`,
        remediation: 'Assign someone else, or move one of the two visits.',
        resources: {
          visitId: visit.id,
          employeeIds: [employee.id],
          assignmentIds: [clash.assignmentId],
        },
      });
    }
  }

  // --- Supervision ---------------------------------------------------------
  //
  // The hard rule is one PMS-grade supervisor per job. When the branch employs
  // none at all, saying "add a supervisor" is useless advice, so that case gets
  // its own code and its own answer.

  if (!crew.some((employee) => employee.isPmsGrade)) {
    if (context.branchHasPmsSupervisor) {
      conflicts.push({
        code: 'NO_PMS_SUPERVISOR_AVAILABLE',
        message: `Every job needs a PMS-grade supervisor on site, and nobody in this crew is one.`,
        remediation: `Add a Senior PMS, PMS, Assistant PMS, SPMS or APMS from ${visit.branchCode}.`,
        resources: { visitId: visit.id },
      });
    } else {
      conflicts.push({
        code: 'BRANCH_HAS_NO_PMS_SUPERVISOR',
        message: `${visit.branchCode} employs no PMS-grade supervisor, so no crew from this branch can legally take the job.`,
        remediation: `UltraKIL needs to station or promote a PMS-grade supervisor in ${visit.branchCode}. Until then this work cannot be staffed — it is not a scheduling error.`,
        resources: { visitId: visit.id },
      });
    }
  }

  // --- Skills --------------------------------------------------------------

  const crewSkills = new Set(crew.flatMap((employee) => employee.skillCodes));
  const missing = visit.requiredSkillCodes.filter((code) => !crewSkills.has(code)).sort();
  if (missing.length > 0) {
    conflicts.push({
      code: 'SKILL_NOT_HELD',
      message: `This job needs ${missing.join(', ')} and nobody in the crew holds ${missing.length === 1 ? 'it' : 'them'}.`,
      remediation: 'Add someone qualified, or correct the required skills on the agreement.',
      resources: { visitId: visit.id, skillCodes: missing },
    });
  }

  // --- Vehicles ------------------------------------------------------------
  //
  // A vehicle is optional: a crew that can use public transport needs none. But
  // a vehicle that is brought must be drivable by somebody actually going.

  for (const proposed of proposal.vehicles) {
    const vehicle = vehicleById.get(proposed.vehicleId);
    if (!vehicle) continue;

    if (!vehicle.isActive) {
      conflicts.push({
        code: 'VEHICLE_INACTIVE',
        message: `${vehicle.label} is off the road and cannot be assigned.`,
        remediation: 'Pick another vehicle, or return this one to service.',
        resources: { visitId: visit.id, vehicleIds: [vehicle.id] },
      });
    }

    // A vehicle with no recorded branch is unknown, not wrong. Refusing it
    // would invent a fact the matrix never stated.
    if (vehicle.branchCode !== null && vehicle.branchCode !== visit.branchCode) {
      conflicts.push({
        code: 'VEHICLE_BRANCH_MISMATCH',
        message: `${vehicle.label} belongs to ${vehicle.branchCode} and this is ${visit.branchCode} work.`,
        remediation: `Use a ${visit.branchCode} vehicle.`,
        resources: { visitId: visit.id, vehicleIds: [vehicle.id] },
      });
    }

    const clash = vehicle.busy.find((period) =>
      overlaps(start, end, period.startMinute, period.endMinute),
    );
    if (clash) {
      conflicts.push({
        code: 'VEHICLE_DOUBLE_BOOKED',
        message: `${vehicle.label} is already out on another job from ${formatMinute(clash.startMinute)} to ${formatMinute(clash.endMinute)} on ${visit.visitDate}.`,
        remediation: 'Use another vehicle, or move one of the two visits.',
        resources: {
          visitId: visit.id,
          vehicleIds: [vehicle.id],
          assignmentIds: [clash.assignmentId],
        },
      });
    }

    if (vehicle.seatCapacity !== null && crew.length > vehicle.seatCapacity) {
      conflicts.push({
        code: 'VEHICLE_CAPACITY_EXCEEDED',
        message: `${vehicle.label} seats ${vehicle.seatCapacity} and the crew is ${crew.length}.`,
        remediation: 'Use a larger vehicle, or add a second one.',
        resources: { visitId: visit.id, vehicleIds: [vehicle.id] },
      });
    }

    // The driver must be going, and be authorised. A checkmark in the matrix
    // means authorised to drive — nothing about ownership or a usual driver.
    const driver = proposed.driverEmployeeId
      ? crew.find((employee) => employee.id === proposed.driverEmployeeId)
      : undefined;
    const driverIsAuthorized =
      driver !== undefined && driver.authorizedVehicleIds.includes(vehicle.id);

    if (!driverIsAuthorized) {
      const anyAuthorized = crew.filter((employee) =>
        employee.authorizedVehicleIds.includes(vehicle.id),
      );
      conflicts.push({
        code: 'NO_AUTHORIZED_DRIVER',
        message: driver
          ? `${driver.fullName} is not authorized to drive ${vehicle.label}.`
          : `${vehicle.label} has no authorized driver in this crew.`,
        remediation:
          anyAuthorized.length > 0
            ? `${anyAuthorized.map((employee) => employee.fullName).join(' or ')} in this crew ${anyAuthorized.length === 1 ? 'is' : 'are'} authorized — name one of them as the driver.`
            : 'Add someone authorized for this vehicle to the crew, or use a vehicle the crew can drive.',
        resources: {
          visitId: visit.id,
          vehicleIds: [vehicle.id],
          employeeIds: driver ? [driver.id] : [],
        },
      });
    }
  }

  return { isEligible: conflicts.length === 0, conflicts: sortConflicts(conflicts) };
}
