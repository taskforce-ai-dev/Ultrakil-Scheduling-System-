import {
  DataProvenance,
  PrismaClient,
  SiteBranchConfidence,
  SiteBranchSource,
} from '@prisma/client';

/**
 * Publication refuses to turn an unconfirmed assumption into dispatch truth
 * without an explicit acknowledgement and reason
 * (`scheduling/optimizer/publish-readiness.ts`). A fixture built by an API call
 * inherits the importer's cautious defaults — unknown provenance, a fallback
 * site branch — which is correct for imported data and wrong for a suite whose
 * subject is publication mechanics rather than provenance.
 *
 * This states the fixture graph as confirmed fact, once, so those suites
 * publish the way they always did. A suite that is about the gate itself
 * leaves its data unconfirmed instead.
 */
export async function confirmAgreementProvenance(
  prisma: PrismaClient,
  agreementId: string,
): Promise<void> {
  const agreement = await prisma.serviceAgreement.update({
    where: { id: agreementId },
    data: {
      crewSizeProvenance: DataProvenance.MANAGER_CONFIRMED,
      durationProvenance: DataProvenance.MANAGER_CONFIRMED,
      dayRuleProvenance: DataProvenance.MANAGER_CONFIRMED,
    },
    select: { serviceSiteId: true },
  });

  await prisma.serviceSite.update({
    where: { id: agreement.serviceSiteId },
    data: {
      branchConfidence: SiteBranchConfidence.CONFIRMED,
      branchSource: SiteBranchSource.MANAGER_CONFIRMED,
    },
  });

  await prisma.generatedVisit.updateMany({
    where: { serviceAgreementId: agreementId },
    data: { windowProvenance: DataProvenance.MANAGER_CONFIRMED },
  });
}

/**
 * The solver picks vehicles from the whole database, and this database is
 * shared with suites whose fixtures deliberately carry no vehicle branch —
 * which is realistic, because the Technician Matrix does not state one. A run
 * that happens to be given such a vehicle would then fail the publication gate
 * for a reason the suite is not about.
 *
 * This confirms a branch only for the vehicles the given run actually uses,
 * taking it from the assignment that uses them. Scoping it to the run keeps
 * the gate honest: a vehicle nothing published still counts as unconfirmed.
 */
export async function confirmRunVehicleBranches(
  prisma: PrismaClient,
  runId: string,
): Promise<void> {
  const assignments = await prisma.assignment.findMany({
    where: { scheduleRunId: runId },
    select: {
      branchId: true,
      vehicles: {
        select: { vehicleId: true, vehicle: { select: { branchId: true } } },
      },
    },
  });

  for (const assignment of assignments) {
    for (const entry of assignment.vehicles) {
      if (entry.vehicle.branchId !== null) continue;
      await prisma.vehicle.update({
        where: { id: entry.vehicleId },
        data: { branchId: assignment.branchId },
      });
    }
  }
}
