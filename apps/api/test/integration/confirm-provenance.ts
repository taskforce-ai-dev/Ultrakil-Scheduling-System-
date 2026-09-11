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
