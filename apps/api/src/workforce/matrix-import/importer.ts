import { BranchCode, DeploymentType, PrismaClient } from '@prisma/client';
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

      const vehicleIds = new Map<string, string>();
      for (const vehicle of parsed.vehicles) {
        const existing = await tx.vehicle.findUnique({
          where: { code: vehicle.code },
          select: { id: true },
        });

        const record = await tx.vehicle.upsert({
          where: { code: vehicle.code },
          create: {
            code: vehicle.code,
            label: vehicle.label,
            seatCapacity: vehicle.seatCapacity,
          },
          update: {
            label: vehicle.label,
            seatCapacity: vehicle.seatCapacity,
          },
        });

        vehicleIds.set(vehicle.code, record.id);
        if (existing) summary.vehiclesUpdated += 1;
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
    { timeout: 120_000 },
  );

  return summary;
}
