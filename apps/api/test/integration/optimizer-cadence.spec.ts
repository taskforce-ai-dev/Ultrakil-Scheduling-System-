import { BranchCode, CrewRole, DataProvenance, DayRuleKind, FrequencyUnit, LockScope, PrismaClient, VisitPlacement, Weekday } from '@prisma/client';

import { AuditService } from '../../src/audit/audit.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { EligibilityService } from '../../src/scheduling/eligibility/eligibility.service';
import { BranchDayCapacityService } from '../../src/scheduling/visit-generation/branch-day-capacity.service';
import { ScheduleRunService } from '../../src/scheduling/optimizer/schedule-run.service';
import { SchedulerClient, SolveRequest, SolveResponse } from '../../src/scheduling/optimizer/scheduler.client';

const prisma = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 10);
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

let branchId: string;
let customerId: string;
let siteId: string;
let jobTypeId: string;
let employeeId: string;
let secondEmployeeId: string;
let vehicleId: string;
const agreements: string[] = [];
const runs: string[] = [];

beforeAll(async () => {
  await prisma.$connect();
  const branch = await prisma.branch.upsert({
    where: { code: BranchCode.COLOMBO },
    create: { code: BranchCode.COLOMBO, name: 'Colombo' },
    update: {},
  });
  branchId = branch.id;
  const customer = await prisma.customer.create({
    data: { name: `Cadence fixture ${suffix}`, branchId, branchCode: BranchCode.COLOMBO },
  });
  customerId = customer.id;
  const site = await prisma.serviceSite.create({
    data: { name: `Cadence site ${suffix}`, customerId, branchId, branchCode: BranchCode.COLOMBO },
  });
  siteId = site.id;
  const jobType = await prisma.jobType.create({
    data: { code: `CADENCE_${suffix}`, name: 'Cadence fixture', defaultCrewSize: 1 },
  });
  jobTypeId = jobType.id;
  const employee = await prisma.employee.create({
    data: {
      sourceKey: `cadence-${suffix}`,
      fullName: 'Fixture Supervisor',
      gradeLabel: 'PMS',
      isPmsGrade: true,
      branchId,
      branchCode: BranchCode.COLOMBO,
      canUsePublicTransport: true,
    },
  });
  employeeId = employee.id;
  secondEmployeeId = (await prisma.employee.create({ data: {
    sourceKey: `cadence-second-${suffix}`, fullName: 'Second Fixture Supervisor',
    gradeLabel: 'PMS', isPmsGrade: true, branchId, branchCode: BranchCode.COLOMBO,
    canUsePublicTransport: true,
  } })).id;
  vehicleId = (await prisma.vehicle.create({ data: {
    code: `CADENCE_VAN_${suffix}`, label: 'Cadence fixture van', branchId, seatCapacity: 2,
  } })).id;
  await prisma.vehicleAuthorization.createMany({ data: [
    { employeeId, vehicleId }, { employeeId: secondEmployeeId, vehicleId },
  ] });
});

afterEach(async () => {
  await prisma.serviceAgreement.deleteMany({ where: { id: { in: agreements } } });
  await prisma.scheduleRun.deleteMany({ where: { id: { in: runs } } });
  await prisma.siteOperatingHours.deleteMany({ where: { serviceSiteId: siteId } });
  agreements.length = 0;
  runs.length = 0;
});

afterAll(async () => {
  if (vehicleId) await prisma.vehicle.delete({ where: { id: vehicleId } });
  if (secondEmployeeId) await prisma.employee.delete({ where: { id: secondEmployeeId } });
  if (employeeId) await prisma.employee.delete({ where: { id: employeeId } });
  if (customerId) await prisma.customer.delete({ where: { id: customerId } });
  if (jobTypeId) await prisma.jobType.delete({ where: { id: jobTypeId } });
  await prisma.$disconnect();
});

async function fixture(options: {
  placement?: VisitPlacement;
  frequencyUnit?: FrequencyUnit;
  allowedDays: Weekday[];
  endDate?: string;
  runEnd: string;
  solverDate: string;
  timeLockReleasedAt?: string | null;
}) {
  const agreement = await prisma.serviceAgreement.create({
    data: {
      customerId,
      serviceSiteId: siteId,
      jobTypeId,
      branchId,
      branchCode: BranchCode.COLOMBO,
      frequencyCount: 1,
      frequencyUnit: options.frequencyUnit ?? FrequencyUnit.WEEK,
      frequencyInterval: 1,
      crewSize: 1,
      durationMinutes: 90,
      startDate: date('2027-03-01'),
      endDate: options.endDate ? date(options.endDate) : null,
      dayRules: {
        create: options.allowedDays.map((weekday) => ({ weekday, kind: DayRuleKind.ALLOWED })),
      },
      ...(options.placement === VisitPlacement.BOOKED
        ? { bookings: { create: { bookedDate: date('2027-03-03'), provenance: DataProvenance.SOURCE } } }
        : {}),
    },
  });
  agreements.push(agreement.id);
  const visit = await prisma.generatedVisit.create({
    data: {
      serviceAgreementId: agreement.id,
      branchId,
      branchCode: BranchCode.COLOMBO,
      visitDate: date('2027-03-03'),
      windowStartMinute: 540,
      windowEndMinute: 1020,
      durationMinutes: 90,
      requiredCrewSize: 1,
      placement: options.placement ?? VisitPlacement.ANCHORED,
    },
  });
  if (options.timeLockReleasedAt !== undefined) {
    await prisma.assignment.create({
      data: {
        generatedVisitId: visit.id,
        branchId,
        branchCode: BranchCode.COLOMBO,
        plannedStart: new Date('2027-03-03T10:00:00.000Z'),
        plannedEnd: new Date('2027-03-03T11:30:00.000Z'),
        locks: {
          create: {
            scope: LockScope.TIME,
            releasedAt: options.timeLockReleasedAt
              ? date(options.timeLockReleasedAt)
              : null,
          },
        },
      },
    });
  }
  const run = await prisma.scheduleRun.create({
    data: {
      status: 'QUEUED',
      rangeStart: date('2027-03-01'),
      rangeEnd: date(options.runEnd),
      branchCode: BranchCode.COLOMBO,
    },
  });
  runs.push(run.id);
  const responseFor = (request: SolveRequest): SolveResponse => ({
    run_id: request.run_id,
    status: 'OPTIMAL',
    assignments: [{
      visit_id: visit.id,
      employee_ids: [employeeId],
      vehicles: [],
      start_minute: 600,
      scheduled_date: options.solverDate,
    }],
    unassigned: [],
    solve_seconds: 0,
    objective_value: 0,
    visits_considered: 1,
  });
  const solve = jest.fn(async (request: SolveRequest) => responseFor(request));
  const service = new ScheduleRunService(
    prisma as unknown as PrismaService,
    { solve } as unknown as SchedulerClient,
    new EligibilityService(prisma as unknown as PrismaService),
    {} as AuditService,
    new BranchDayCapacityService(
      prisma as unknown as PrismaService,
      { get: () => undefined } as never,
    ),
  );
  return { agreement, visit, run, service, solve, responseFor };
}

describe('optimizer cadence persistence against PostgreSQL', () => {
  it('composes TIME, CREW, and SUPERVISOR locks against a real PostgreSQL replacement', async () => {
    const f = await fixture({
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY], runEnd: '2027-03-07',
      solverDate: '2027-03-03', timeLockReleasedAt: null,
    });
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { generatedVisitId: f.visit.id } });
    await prisma.assignmentCrewMember.create({ data: {
      assignmentId: assignment.id, employeeId, role: CrewRole.SUPERVISOR, isPmsSupervisor: true,
    } });
    await prisma.assignmentLock.create({ data: { assignmentId: assignment.id, scope: LockScope.CREW } });
    await prisma.assignmentLock.create({ data: { assignmentId: assignment.id, scope: LockScope.SUPERVISOR } });
    const changed = f.responseFor as (request: SolveRequest) => SolveResponse;
    f.solve.mockImplementation(async (request: SolveRequest) => ({
      ...changed(request), assignments: [{
        visit_id: f.visit.id, employee_ids: [secondEmployeeId], vehicles: [],
        start_minute: 600, scheduled_date: '2027-03-03',
      }],
    }));

    await expect(f.service.execute(f.run.id)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.solve.mock.calls[0][0].locks.map((lock) => lock.scope)).toEqual(['CREW', 'SUPERVISOR', 'TIME']);
    expect(await prisma.assignment.count({ where: { scheduleRunId: f.run.id } })).toBe(0);
  });

  it.each([
    { releasedAt: null, shouldAccept: false },
    { releasedAt: '2027-02-02', shouldAccept: true },
  ])('handles a $releasedAt SUPERVISOR pin without converting it into a full crew pin', async ({ releasedAt, shouldAccept }) => {
    const f = await fixture({
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY], runEnd: '2027-03-07',
      solverDate: '2027-03-03', timeLockReleasedAt: releasedAt,
    });
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { generatedVisitId: f.visit.id } });
    await prisma.assignmentLock.updateMany({ where: { assignmentId: assignment.id }, data: { scope: LockScope.SUPERVISOR } });
    await prisma.assignmentCrewMember.create({ data: {
      assignmentId: assignment.id, employeeId, role: CrewRole.SUPERVISOR, isPmsSupervisor: true,
    } });
    f.solve.mockImplementation(async (request: SolveRequest) => ({
      ...f.responseFor(request), assignments: [{
        visit_id: f.visit.id, employee_ids: [secondEmployeeId], vehicles: [],
        start_minute: 600, scheduled_date: '2027-03-03',
      }],
    }));

    if (shouldAccept) {
      await expect(f.service.execute(f.run.id)).resolves.toMatchObject({ scheduled: 1 });
      expect(f.solve.mock.calls[0][0].locks).toEqual([]);
    } else {
      await expect(f.service.execute(f.run.id)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect(f.solve.mock.calls[0][0].locks).toMatchObject([{ scope: 'SUPERVISOR', employee_ids: [employeeId] }]);
    }
  });

  it('preserves a VEHICLE lock exact driver against a real PostgreSQL replacement', async () => {
    const f = await fixture({
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY], runEnd: '2027-03-07',
      solverDate: '2027-03-03', timeLockReleasedAt: null,
    });
    const assignment = await prisma.assignment.findFirstOrThrow({ where: { generatedVisitId: f.visit.id } });
    await prisma.assignmentLock.updateMany({ where: { assignmentId: assignment.id }, data: { scope: LockScope.VEHICLE } });
    await prisma.serviceAgreement.update({ where: { id: f.agreement.id }, data: { crewSize: 2 } });
    await prisma.generatedVisit.update({ where: { id: f.visit.id }, data: { requiredCrewSize: 2 } });
    await prisma.assignmentCrewMember.createMany({ data: [
      { assignmentId: assignment.id, employeeId, role: CrewRole.SUPERVISOR, isPmsSupervisor: true },
      { assignmentId: assignment.id, employeeId: secondEmployeeId, role: CrewRole.TECHNICIAN, isPmsSupervisor: true },
    ] });
    await prisma.assignmentVehicle.create({ data: { assignmentId: assignment.id, vehicleId, driverEmployeeId: employeeId } });
    f.solve.mockImplementation(async (request: SolveRequest) => ({
      ...f.responseFor(request), assignments: [{
        visit_id: f.visit.id, employee_ids: [employeeId, secondEmployeeId],
        vehicles: [{ vehicle_id: vehicleId, driver_employee_id: secondEmployeeId }],
        start_minute: 600, scheduled_date: '2027-03-03',
      }],
    }));

    await expect(f.service.execute(f.run.id)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(f.solve.mock.calls[0][0].locks).toMatchObject([{
      scope: 'VEHICLE', vehicle_drivers: [{ vehicle_id: vehicleId, driver_employee_id: employeeId }],
    }]);
    expect(await prisma.assignment.count({ where: { scheduleRunId: f.run.id } })).toBe(0);
  });

  it.each([
    { releasedAt: null, shouldMove: false },
    { releasedAt: '2027-02-02', shouldMove: true },
  ])('honors a $releasedAt TIME lock at the persistence boundary', async ({ releasedAt, shouldMove }) => {
    const f = await fixture({
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
      runEnd: '2027-03-07',
      solverDate: '2027-03-04',
      timeLockReleasedAt: releasedAt,
    });

    if (shouldMove) {
      await expect(f.service.execute(f.run.id)).resolves.toMatchObject({ scheduled: 1 });
      expect((await prisma.generatedVisit.findUniqueOrThrow({ where: { id: f.visit.id } })).visitDate)
        .toEqual(date('2027-03-04'));
    } else {
      await expect(f.service.execute(f.run.id)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
      expect((await prisma.generatedVisit.findUniqueOrThrow({ where: { id: f.visit.id } })).visitDate)
        .toEqual(date('2027-03-03'));
    }
  });

  it.each([
    {
      name: 'workbook BOOKED date', placement: VisitPlacement.BOOKED,
      frequencyUnit: FrequencyUnit.WEEK, allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
      runEnd: '2027-03-07', solverDate: '2027-03-04',
    },
    {
      name: 'next ISO week', frequencyUnit: FrequencyUnit.WEEK,
      allowedDays: [Weekday.WEDNESDAY, Weekday.MONDAY],
      runEnd: '2027-03-14', solverDate: '2027-03-08',
    },
    {
      name: 'next calendar month', frequencyUnit: FrequencyUnit.MONTH,
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
      runEnd: '2027-04-04', solverDate: '2027-04-01',
    },
    {
      name: 'past the agreement end', frequencyUnit: FrequencyUnit.WEEK,
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY], endDate: '2027-03-03',
      runEnd: '2027-03-07', solverDate: '2027-03-04',
    },
    {
      name: 'outside the current run range', frequencyUnit: FrequencyUnit.WEEK,
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
      runEnd: '2027-03-03', solverDate: '2027-03-04',
    },
  ])('rejects a solver move to the $name without any write', async (options) => {
    const f = await fixture(options);
    if (options.endDate) expect(f.agreement.endDate).toEqual(date(options.endDate));
    await expect(f.service.execute(f.run.id)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    const submitted = f.solve.mock.calls[0][0];
    expect(submitted.visits.find((visit) => visit.id === f.visit.id)?.candidate_slots.map((slot) => slot.date))
      .not.toContain(options.solverDate);
    expect(await prisma.assignment.count({ where: { scheduleRunId: f.run.id } })).toBe(0);
    expect((await prisma.generatedVisit.findUniqueOrThrow({ where: { id: f.visit.id } })).visitDate)
      .toEqual(date('2027-03-03'));
  });

  it('commits a legal move inside the monthly occurrence', async () => {
    const f = await fixture({
      frequencyUnit: FrequencyUnit.MONTH,
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
      runEnd: '2027-04-04',
      solverDate: '2027-03-04',
    });
    expect(await f.service.execute(f.run.id)).toMatchObject({ scheduled: 1 });
    expect(f.solve.mock.calls[0][0].visits.find((visit) => visit.id === f.visit.id)?.candidate_slots.map((slot) => slot.date))
      .toContain('2027-03-04');
    expect((await prisma.generatedVisit.findUniqueOrThrow({ where: { id: f.visit.id } })).visitDate)
      .toEqual(date('2027-03-04'));
    expect(await prisma.assignment.count({ where: { scheduleRunId: f.run.id } })).toBe(1);
  });

  it('rejects a solver time outside the site window before writing', async () => {
    const f = await fixture({
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
      runEnd: '2027-03-07',
      solverDate: '2027-03-04',
    });
    await prisma.siteOperatingHours.createMany({ data: [
      { serviceSiteId: siteId, weekday: Weekday.WEDNESDAY, opensAtMinute: 540, closesAtMinute: 1020 },
      { serviceSiteId: siteId, weekday: Weekday.THURSDAY, opensAtMinute: 540, closesAtMinute: 630 },
    ] });

    await expect(f.service.execute(f.run.id)).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(await prisma.assignment.count({ where: { scheduleRunId: f.run.id } })).toBe(0);
  });

  it('rechecks current agreement rules after a solver has started', async () => {
    const f = await fixture({
      allowedDays: [Weekday.WEDNESDAY, Weekday.THURSDAY],
      runEnd: '2027-03-07',
      solverDate: '2027-03-04',
    });
    let signalStarted!: () => void;
    let release!: (response: SolveResponse) => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const held = new Promise<SolveResponse>((resolve) => { release = resolve; });
    f.solve.mockImplementationOnce(async () => {
      signalStarted();
      return held;
    });
    const pending = f.service.execute(f.run.id);
    await started;
    const request = f.solve.mock.calls[0][0];
    expect(request.visits[0].candidate_slots.map((slot) => slot.date)).toContain('2027-03-04');
    await prisma.serviceAgreementDayRule.deleteMany({
      where: { serviceAgreementId: f.agreement.id, weekday: Weekday.THURSDAY, kind: DayRuleKind.ALLOWED },
    });
    release(f.responseFor(request));

    await expect(pending).rejects.toMatchObject({ code: 'RESOURCE_CONFLICT' });
    expect(await prisma.assignment.count({ where: { scheduleRunId: f.run.id } })).toBe(0);
  });
});
