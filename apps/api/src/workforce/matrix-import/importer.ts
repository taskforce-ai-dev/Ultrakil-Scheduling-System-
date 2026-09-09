import { BranchCode, DeploymentType, Prisma, PrismaClient } from '@prisma/client';
import { normalizeHeader } from './mapping';
import { ParsedMatrix } from './types';

export interface ImportSummary {
  branchesEnsured: number;
  vehiclesCreated: number;
  vehiclesUpdated: number;
  employeesCreated: number;
  employeesUpdated: number;
  skillsLinked: number;
  skillsRemoved: number;
  authorizationsLinked: number;
  authorizationsRemoved: number;
  pmsSupervisors: number;
  permanentlyStationed: number;
  publicTransportUsers: number;
}

const BRANCH_NAMES: Record<BranchCode, string> = {
  [BranchCode.COLOMBO]: 'Colombo Branch',
  [BranchCode.KANDY]: 'Kandy Branch',
};

function vehicleIdentity(code: string): string {
  return normalizeHeader(code).replace(/ /g, '');
}

async function mergeVehicleAliases(
  tx: Prisma.TransactionClient,
  canonicalVehicleId: string,
  aliasVehicleIds: string[],
): Promise<number> {
  if (!aliasVehicleIds.length) return 0;
  let authorizationsRemoved = 0;
  const vehicleIds = [canonicalVehicleId, ...aliasVehicleIds];
  const assignmentLinks = await tx.assignmentVehicle.findMany({
    where: { vehicleId: { in: vehicleIds } },
    select: { assignmentId: true },
  });
  const linksByAssignment = new Map<string, number>();
  for (const { assignmentId } of assignmentLinks) {
    const count = (linksByAssignment.get(assignmentId) ?? 0) + 1;
    if (count > 1) throw new Error('MATRIX_VEHICLE_ASSIGNMENT_COLLISION');
    linksByAssignment.set(assignmentId, count);
  }

  const authorizations = await tx.vehicleAuthorization.findMany({
    where: { vehicleId: { in: vehicleIds } },
    select: { id: true, employeeId: true, vehicleId: true },
  });
  const authorizationsByEmployee = new Map<string, typeof authorizations>();
  for (const authorization of authorizations) {
    const group = authorizationsByEmployee.get(authorization.employeeId) ?? [];
    group.push(authorization);
    authorizationsByEmployee.set(authorization.employeeId, group);
  }
  for (const group of authorizationsByEmployee.values()) {
    const survivor =
      group.find(({ vehicleId }) => vehicleId === canonicalVehicleId) ?? group[0];
    if (survivor.vehicleId !== canonicalVehicleId) {
      await tx.vehicleAuthorization.update({
        where: { id: survivor.id },
        data: { vehicleId: canonicalVehicleId },
      });
    }
    for (const duplicate of group.filter(({ id }) => id !== survivor.id)) {
      await tx.vehicleAuthorization.delete({ where: { id: duplicate.id } });
      authorizationsRemoved += 1;
    }
  }

  await tx.assignmentVehicle.updateMany({
    where: { vehicleId: { in: aliasVehicleIds } },
    data: { vehicleId: canonicalVehicleId },
  });
  await tx.vehicle.deleteMany({ where: { id: { in: aliasVehicleIds } } });
  return authorizationsRemoved;
}

/**
 * Writes a parsed matrix into the database.
 *
 * Every write is an upsert on a natural key, and each employee's skills and
 * vehicle authorizations are reconciled — rows no longer check-marked in the
 * workbook are removed. That is what makes re-running the seed safe: import
 * twice and you get one copy of everyone, with the workbook as the source of
 * truth rather than an ever-growing pile of history.
 *
 * The whole import runs in one transaction. A half-applied workforce is worse
 * than none: the scheduler would build crews from staff that only partly exist.
 */
export async function importMatrix(
  prisma: PrismaClient,
  parsed: ParsedMatrix,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    branchesEnsured: 0,
    vehiclesCreated: 0,
    vehiclesUpdated: 0,
    employeesCreated: 0,
    employeesUpdated: 0,
    skillsLinked: 0,
    skillsRemoved: 0,
    authorizationsLinked: 0,
    authorizationsRemoved: 0,
    pmsSupervisors: 0,
    permanentlyStationed: 0,
    publicTransportUsers: 0,
  };

  await prisma.$transaction(
    async (tx) => {
      const branchIds = new Map<BranchCode, string>();
      for (const code of Object.values(BranchCode)) {
        const branch = await tx.branch.upsert({
          where: { code },
          create: { code, name: BRANCH_NAMES[code] },
          update: { name: BRANCH_NAMES[code] },
        });
        branchIds.set(code, branch.id);
        summary.branchesEnsured += 1;
      }

      const existingVehicles = await tx.vehicle.findMany({
        select: { id: true, code: true },
      });
      const vehiclesByIdentity = new Map<string, typeof existingVehicles>();
      for (const existing of existingVehicles) {
        const identity = vehicleIdentity(existing.code);
        const group = vehiclesByIdentity.get(identity) ?? [];
        group.push(existing);
        vehiclesByIdentity.set(identity, group);
      }
      const parsedCodesByIdentity = new Map<string, string>();
      for (const vehicle of parsed.vehicles) {
        const identity = vehicleIdentity(vehicle.code);
        const previous = parsedCodesByIdentity.get(identity);
        if (previous && previous !== vehicle.code) {
          throw new Error('MATRIX_VEHICLE_IDENTITY_DUPLICATE');
        }
        parsedCodesByIdentity.set(identity, vehicle.code);
      }

      const vehicleIds = new Map<string, string>();
      for (const vehicle of parsed.vehicles) {
        const identity = vehicleIdentity(vehicle.code);
        const matches = [...(vehiclesByIdentity.get(identity) ?? [])].sort(
          (left, right) => left.code.localeCompare(right.code) || left.id.localeCompare(right.id),
        );
        const exact = matches.find(({ code }) => code === vehicle.code);
        const survivor = exact ?? matches[0];
        const record = survivor
          ? await tx.vehicle.update({
              where: { id: survivor.id },
              data: {
                code: vehicle.code,
                label: vehicle.label,
                seatCapacity: vehicle.seatCapacity,
              },
            })
          : await tx.vehicle.create({
              data: {
                code: vehicle.code,
                label: vehicle.label,
                seatCapacity: vehicle.seatCapacity,
              },
            });
        summary.authorizationsRemoved += await mergeVehicleAliases(
          tx,
          record.id,
          matches.filter(({ id }) => id !== record.id).map(({ id }) => id),
        );

        vehicleIds.set(vehicle.code, record.id);
        if (survivor) summary.vehiclesUpdated += 1;
        else summary.vehiclesCreated += 1;
      }

      for (const employee of parsed.employees) {
        const branchId = branchIds.get(employee.branchCode);
        if (!branchId) continue;

        const existing = await tx.employee.findUnique({
          where: { sourceKey: employee.sourceKey },
          select: { id: true },
        });

        const deploymentType = employee.isPermanentlyStationed
          ? DeploymentType.PERMANENTLY_STATIONED
          : DeploymentType.MOBILE;

        const record = await tx.employee.upsert({
          where: { sourceKey: employee.sourceKey },
          create: {
            sourceKey: employee.sourceKey,
            fullName: employee.fullName,
            gradeLabel: employee.gradeLabel,
            isPmsGrade: employee.isPmsGrade,
            branchId,
            branchCode: employee.branchCode,
            deploymentType,
            permanentSiteLabel: employee.permanentSiteName,
            canUsePublicTransport: employee.canUsePublicTransport,
            isActive: true,
            sourceRow: employee.sourceRow,
          },
          update: {
            fullName: employee.fullName,
            gradeLabel: employee.gradeLabel,
            isPmsGrade: employee.isPmsGrade,
            branchId,
            branchCode: employee.branchCode,
            deploymentType,
            permanentSiteLabel: employee.permanentSiteName,
            canUsePublicTransport: employee.canUsePublicTransport,
            isActive: true,
            sourceRow: employee.sourceRow,
          },
        });

        if (existing) summary.employeesUpdated += 1;
        else summary.employeesCreated += 1;
        if (employee.isPmsGrade) summary.pmsSupervisors += 1;
        if (employee.isPermanentlyStationed) summary.permanentlyStationed += 1;
        if (employee.canUsePublicTransport) summary.publicTransportUsers += 1;

        // --- Skills -------------------------------------------------------
        const wantedSkillCodes = employee.skills.map((s) => s.skillCode);

        for (const skill of employee.skills) {
          await tx.employeeSkill.upsert({
            where: {
              employeeId_skillCode: {
                employeeId: record.id,
                skillCode: skill.skillCode,
              },
            },
            create: {
              employeeId: record.id,
              skillCode: skill.skillCode,
              skillLabel: skill.skillLabel,
            },
            update: { skillLabel: skill.skillLabel },
          });
          summary.skillsLinked += 1;
        }

        const removedSkills = await tx.employeeSkill.deleteMany({
          where: {
            employeeId: record.id,
            skillCode: { notIn: wantedSkillCodes.length ? wantedSkillCodes : ['__none__'] },
          },
        });
        summary.skillsRemoved += removedSkills.count;

        // --- Vehicle authorizations ---------------------------------------
        const wantedVehicleIds = employee.vehicles
          .map((v) => vehicleIds.get(v.vehicleCode))
          .filter((id): id is string => Boolean(id));

        for (const vehicleId of wantedVehicleIds) {
          await tx.vehicleAuthorization.upsert({
            where: {
              employeeId_vehicleId: { employeeId: record.id, vehicleId },
            },
            create: { employeeId: record.id, vehicleId },
            update: {},
          });
          summary.authorizationsLinked += 1;
        }

        const removedAuths = await tx.vehicleAuthorization.deleteMany({
          where: {
            employeeId: record.id,
            vehicleId: {
              notIn: wantedVehicleIds.length
                ? wantedVehicleIds
                : ['00000000-0000-0000-0000-000000000000'],
            },
          },
        });
        summary.authorizationsRemoved += removedAuths.count;
      }
    },
    // The supported operator workflow imports into an external PostgreSQL
    // service. Keep the workforce atomic while allowing for cross-region
    // latency across the hundreds of reconciliation queries above.
    { timeout: 600_000 },
  );

  return summary;
}
