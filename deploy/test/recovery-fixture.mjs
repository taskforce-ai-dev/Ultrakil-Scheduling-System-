// Fabricated data only, used by recovery.postgres.test.py on its newly created DB.
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
const url = new URL(process.env.DATABASE_URL);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !/^\/ultrakil_backup_[0-9a-f]+_test$/.test(url.pathname)) {
  throw new Error('Synthetic recovery fixture requires a fresh local recovery test database');
}
const db = new PrismaClient({ log: [] });
try {
  if (await db.branch.count() !== 0) throw new Error('Recovery fixture refuses populated databases');
  await db.$transaction(async (tx) => {
    const completedRun = await tx.scheduleRun.create({ data: {
      status: 'SUCCEEDED', trigger: 'MANUAL',
      rangeStart: new Date('2024-06-01T00:00:00Z'), rangeEnd: new Date('2024-06-01T00:00:00Z'),
      visitsConsidered: 1, visitsScheduled: 1, progressPercent: 100,
      startedAt: new Date('2024-06-01T03:29:00Z'), finishedAt: new Date('2024-06-01T04:30:00Z'),
      executionAttempt: 1,
    } });
    await tx.scheduleRunDispatchOutbox.create({ data: {
      scheduleRunId: completedRun.id, provider: 'QSTASH', status: 'PUBLISHED',
      messageId: 'msg_recovery_synthetic', attempts: 1,
      lastAttemptAt: new Date('2024-06-01T03:29:00Z'),
    } });
    const branch = await tx.branch.create({ data: { code: 'COLOMBO', name: 'Synthetic recovery branch' } });
    const workers = [];
    for (let index = 0; index < 2; index++) {
      workers.push(await tx.employee.create({ data: {
        sourceKey: `recovery-synthetic-${index}`, fullName: `Fabricated technician ${index}`,
        gradeLabel: 'PMS', isPmsGrade: true, branchId: branch.id, branchCode: branch.code,
      } }));
    }
    const vehicle = await tx.vehicle.create({ data: { code: 'SYN-0001', label: 'Synthetic vehicle', branchId: branch.id } });
    await tx.vehicleAuthorization.createMany({ data: workers.map((worker) => ({ employeeId: worker.id, vehicleId: vehicle.id })) });
    const customer = await tx.customer.create({ data: {
      name: 'Synthetic inactive customer', branchId: branch.id, branchCode: branch.code,
      isActive: false, importedInactiveAt: new Date('2025-01-01T00:00:00Z'),
    } });
    const reactivated = await tx.customer.create({ data: {
      name: 'Synthetic manually reactivated customer', branchId: branch.id, branchCode: branch.code,
      isActive: false, importedInactiveAt: new Date('2025-01-01T00:00:00Z'),
    } });
    // Match the authorized CustomersService.setActive behavior: its deliberate
    // activation changes isActive and records an audit event, retaining provenance.
    await tx.customer.update({ where: { id: reactivated.id }, data: { isActive: true } });
    await tx.auditEvent.create({ data: {
      entityType: 'Customer', entityId: reactivated.id, action: 'customer.reactivated', actorLabel: 'Synthetic authorized operator',
    } });
    const site = await tx.serviceSite.create({ data: {
      name: 'Synthetic inactive site', customerId: customer.id, branchId: branch.id, branchCode: branch.code,
      isActive: false, importedInactiveAt: new Date('2025-01-01T00:00:00Z'),
    } });
    const jobType = await tx.jobType.create({ data: { code: 'RECOVERY', name: 'Synthetic recovery service' } });
    const agreement = await tx.serviceAgreement.create({ data: {
      customerId: customer.id, serviceSiteId: site.id, jobTypeId: jobType.id,
      branchId: branch.id, branchCode: branch.code, frequencyCount: 1, frequencyUnit: 'MONTH',
      crewSize: 2, durationMinutes: 60, startDate: new Date('2024-01-01T00:00:00Z'), status: 'ARCHIVED',
    } });
    const version = await tx.serviceAgreementVersion.create({ data: {
      serviceAgreementId: agreement.id, versionNumber: 1, snapshot: { synthetic: true },
    } });
    const visit = await tx.generatedVisit.create({ data: {
      serviceAgreementId: agreement.id, agreementVersionId: version.id, branchId: branch.id, branchCode: branch.code,
      visitDate: new Date('2024-06-01T00:00:00Z'), windowStartMinute: 480, windowEndMinute: 1020,
      durationMinutes: 60, requiredCrewSize: 2, status: 'COMPLETED',
    } });
    const assignment = await tx.assignment.create({ data: {
      generatedVisitId: visit.id, branchId: branch.id, branchCode: branch.code, status: 'COMPLETED',
      plannedStart: new Date('2024-06-01T03:30:00Z'), plannedEnd: new Date('2024-06-01T04:30:00Z'),
      publishedAt: new Date('2024-05-31T00:00:00Z'), completedAt: new Date('2024-06-01T04:30:00Z'),
    } });
    await tx.assignmentCrewMember.createMany({ data: workers.map((worker) => ({ assignmentId: assignment.id, employeeId: worker.id, isPmsSupervisor: true })) });
    await tx.assignmentVehicle.create({ data: { assignmentId: assignment.id, vehicleId: vehicle.id, driverEmployeeId: workers[1].id } });
    await tx.assignmentNotificationOutbox.create({ data: {
      assignmentId: assignment.id, employeeId: workers[1].id, eventType: 'assignment.published', payload: { synthetic: true },
    } });
    await tx.auditEvent.create({ data: { entityType: 'Assignment', entityId: assignment.id, action: 'assignment.published' } });
  });
} finally {
  await db.$disconnect();
}
