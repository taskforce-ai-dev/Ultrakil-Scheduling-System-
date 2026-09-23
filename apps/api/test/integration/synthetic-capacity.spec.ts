import {
  AgreementStatus,
  AssignmentStatus,
  BranchCode,
  CrewRole,
  FrequencyUnit,
  PrismaClient,
  VisitStatus,
} from '@prisma/client';

import {
  executeSyntheticCapacity,
  SYNTHETIC_CAPACITY_MARKER,
  SYNTHETIC_SOURCE_PREFIX,
  SYNTHETIC_VEHICLE_PREFIX,
} from '../../prisma/synthetic-capacity';
import { lockScheduleResources } from '../../src/scheduling/optimizer/schedule-visit-lock';

const prisma = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 10);
const asOf = new Date('2034-01-01T00:00:00.000Z');
const sourcePrefix = `${SYNTHETIC_SOURCE_PREFIX}${BranchCode.KANDY}:`;
const vehiclePrefix = `${SYNTHETIC_VEHICLE_PREFIX}${BranchCode.KANDY}-`;

let branchId: string;
let agreementId: string;
let customerId: string;
let siteId: string;
let jobTypeId: string;
let inactiveCustomerId: string;
let isolatedAgreementIds: string[] = [];

async function clearAssignmentsAndSynthetic(): Promise<void> {
  const employees = await prisma.employee.findMany({
    where: { OR: [{ sourceKey: { startsWith: sourcePrefix } }, { employeeCode: { startsWith: vehiclePrefix } }] },
    select: { id: true },
  });
  const vehicles = await prisma.vehicle.findMany({
    where: { code: { startsWith: vehiclePrefix } },
    select: { id: true },
  });
  const employeeIds = employees.map(({ id }) => id);
  const vehicleIds = vehicles.map(({ id }) => id);
  const assignments = await prisma.assignment.findMany({
    where: {
      OR: [
        { crewMembers: { some: { employeeId: { in: employeeIds } } } },
        { vehicles: { some: { vehicleId: { in: vehicleIds } } } },
      ],
    },
    select: { id: true, generatedVisitId: true },
  });
  if (assignments.length) {
    await prisma.assignment.deleteMany({ where: { id: { in: assignments.map(({ id }) => id) } } });
    await prisma.generatedVisit.deleteMany({
      where: { id: { in: assignments.map(({ generatedVisitId }) => generatedVisitId) } },
    });
  }
  await prisma.employee.deleteMany({ where: { id: { in: employeeIds } } });
  await prisma.vehicle.deleteMany({ where: { id: { in: vehicleIds } } });
}

beforeAll(async () => {
  await prisma.$connect();
  const branch = await prisma.branch.upsert({
    where: { code: BranchCode.KANDY },
    create: { code: BranchCode.KANDY, name: 'Kandy Branch' },
    update: {},
  });
  branchId = branch.id;
  // Other integration suites intentionally leave imported agreements behind.
  // Suspend only that pre-existing capacity so this suite measures its own
  // fixtures, then restore it in afterAll; the shared database remains intact.
  const existingActiveAgreements = await prisma.serviceAgreement.findMany({
    where: { branchId, status: AgreementStatus.ACTIVE },
    select: { id: true },
  });
  isolatedAgreementIds = existingActiveAgreements.map(({ id }) => id);
  if (isolatedAgreementIds.length) {
    await prisma.serviceAgreement.updateMany({
      where: { id: { in: isolatedAgreementIds } },
      data: { status: AgreementStatus.PAUSED },
    });
  }
  await clearAssignmentsAndSynthetic();
  const customer = await prisma.customer.create({
    data: {
      name: `Synthetic Capacity Customer ${suffix}`,
      customerCode: `SYN-CUST-${suffix}`,
      branchId,
      branchCode: BranchCode.KANDY,
    },
  });
  customerId = customer.id;
  const site = await prisma.serviceSite.create({
    data: {
      customerId,
      name: `Synthetic Capacity Site ${suffix}`,
      branchId,
      branchCode: BranchCode.KANDY,
    },
  });
  siteId = site.id;
  const jobType = await prisma.jobType.create({
    data: {
      code: `SYN_CAP_${suffix.toUpperCase()}`,
      name: `Synthetic Capacity Job ${suffix}`,
      defaultCrewSize: 2,
      defaultDurationMinutes: 60,
    },
  });
  jobTypeId = jobType.id;
  const agreement = await prisma.serviceAgreement.create({
    data: {
      customerId,
      serviceSiteId: siteId,
      jobTypeId,
      branchId,
      branchCode: BranchCode.KANDY,
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.WEEK,
      crewSize: 4,
      durationMinutes: 60,
      startDate: new Date('2030-01-01T00:00:00.000Z'),
      status: AgreementStatus.ACTIVE,
      requiredSkills: { create: [{ skillCode: 'FUMIGATION' }, { skillCode: 'GPC' }] },
    },
  });
  agreementId = agreement.id;

  const inactiveCustomer = await prisma.customer.create({
    data: {
      name: `Inactive Synthetic Capacity Customer ${suffix}`,
      customerCode: `SYN-INACTIVE-${suffix}`,
      branchId,
      branchCode: BranchCode.KANDY,
      isActive: false,
    },
  });
  inactiveCustomerId = inactiveCustomer.id;
  const inactiveCustomerSite = await prisma.serviceSite.create({
    data: {
      customerId: inactiveCustomer.id,
      name: `Inactive Customer Site ${suffix}`,
      branchId,
      branchCode: BranchCode.KANDY,
    },
  });
  const inactiveSite = await prisma.serviceSite.create({
    data: {
      customerId,
      name: `Inactive Synthetic Capacity Site ${suffix}`,
      branchId,
      branchCode: BranchCode.KANDY,
      isActive: false,
    },
  });
  // None of these records may inflate crew or skill requirements.
  await prisma.serviceAgreement.create({
    data: {
      customerId,
      serviceSiteId: siteId,
      jobTypeId,
      branchId,
      branchCode: BranchCode.KANDY,
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.MONTH,
      crewSize: 9,
      durationMinutes: 60,
      startDate: new Date('2030-01-01T00:00:00.000Z'),
      status: AgreementStatus.ARCHIVED,
      requiredSkills: { create: [{ skillCode: 'ARCHIVED_ONLY' }] },
    },
  });
  for (const [customer, serviceSite, skillCode, dates] of [
    [inactiveCustomer.id, inactiveCustomerSite.id, 'INACTIVE_CUSTOMER_ONLY', {}],
    [customerId, inactiveSite.id, 'INACTIVE_SITE_ONLY', {}],
    [customerId, siteId, 'EXPIRED_ONLY', { endDate: new Date('2033-12-31T00:00:00.000Z') }],
    [customerId, siteId, 'FUTURE_ONLY', { startDate: new Date('2035-01-01T00:00:00.000Z') }],
  ] as const) {
    await prisma.serviceAgreement.create({
      data: {
        customerId: customer,
        serviceSiteId: serviceSite,
        jobTypeId,
        branchId,
        branchCode: BranchCode.KANDY,
        frequencyCount: 1,
        frequencyUnit: FrequencyUnit.MONTH,
        crewSize: 9,
        durationMinutes: 60,
        startDate: dates.startDate ?? new Date('2030-01-01T00:00:00.000Z'),
        endDate: dates.endDate,
        status: AgreementStatus.ACTIVE,
        requiredSkills: { create: [{ skillCode }] },
      },
    });
  }
});

beforeEach(clearAssignmentsAndSynthetic);

afterAll(async () => {
  try {
    await clearAssignmentsAndSynthetic();
    await prisma.serviceAgreement.deleteMany({
      where: { customerId: { in: [customerId, inactiveCustomerId] } },
    });
    await prisma.serviceSite.deleteMany({
      where: { customerId: { in: [customerId, inactiveCustomerId] } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: [customerId, inactiveCustomerId] } } });
    await prisma.jobType.delete({ where: { id: jobTypeId } });
  } finally {
    try {
      if (isolatedAgreementIds.length) {
        await prisma.serviceAgreement.updateMany({
          where: { id: { in: isolatedAgreementIds } },
          data: { status: AgreementStatus.ACTIVE },
        });
      }
    } finally {
      await prisma.$disconnect();
    }
  }
});

const apply = (teams: number, options: Parameters<typeof executeSyntheticCapacity>[2] = {}) =>
  executeSyntheticCapacity(
    prisma,
    { branchCode: BranchCode.KANDY, teams, mode: 'apply' },
    { asOf, ...options },
  );

async function waitForContendingTransaction(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*) AS waiting FROM pg_stat_activity
      WHERE datname = current_database()
        AND wait_event_type = 'Lock'
        AND pid <> pg_backend_pid()
    `;
    if (row.waiting > 0n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Second synthetic-capacity transaction did not contend');
}

it('serializes two first applies before either synthetic row exists', async () => {
  let firstReachedEmployeeWrites!: () => void;
  let releaseFirst!: () => void;
  const reachedEmployeeWrites = new Promise<void>((resolve) => { firstReachedEmployeeWrites = resolve; });
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondClient = new PrismaClient();
  await secondClient.$connect();

  try {
    const first = apply(1, {
      hooks: { afterEmployeeWrites: async () => {
        firstReachedEmployeeWrites();
        await holdFirst;
      } },
    });
    await reachedEmployeeWrites;
    const second = executeSyntheticCapacity(
      secondClient,
      { branchCode: BranchCode.KANDY, teams: 1, mode: 'apply' },
      { asOf },
    );
    try {
      await waitForContendingTransaction();
    } finally {
      releaseFirst();
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.employees.created).toBe(4);
    expect(secondResult.employees.unchanged).toBe(4);
    expect(await prisma.employee.count({ where: { sourceKey: { startsWith: sourcePrefix } } })).toBe(4);
    expect(await prisma.vehicle.count({ where: { code: { startsWith: vehiclePrefix } } })).toBe(1);
  } finally {
    await secondClient.$disconnect();
  }
});

it('applies a concurrent deactivate after the first create commits', async () => {
  let firstReachedEmployeeWrites!: () => void;
  let releaseFirst!: () => void;
  const reachedEmployeeWrites = new Promise<void>((resolve) => { firstReachedEmployeeWrites = resolve; });
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondClient = new PrismaClient();
  await secondClient.$connect();

  try {
    const first = apply(1, {
      hooks: { afterEmployeeWrites: async () => {
        firstReachedEmployeeWrites();
        await holdFirst;
      } },
    });
    await reachedEmployeeWrites;
    const deactivate = executeSyntheticCapacity(
      secondClient,
      { branchCode: BranchCode.KANDY, teams: 0, mode: 'deactivate' },
      { asOf },
    );
    let contentionError: unknown;
    try {
      await waitForContendingTransaction();
    } catch (error) {
      contentionError = error;
    } finally {
      releaseFirst();
    }
    const [, deactivation] = await Promise.all([first, deactivate]);
    if (contentionError) throw contentionError;
    expect(deactivation.employees.deactivated).toBe(4);
    expect(deactivation.vehicles.deactivated).toBe(1);
    expect(await prisma.employee.count({ where: { sourceKey: { startsWith: sourcePrefix }, isActive: true } })).toBe(0);
    expect(await prisma.vehicle.count({ where: { code: { startsWith: vehiclePrefix }, isActive: true } })).toBe(0);
  } finally {
    await secondClient.$disconnect();
  }
});

it('keeps the default dry run count-only and write-free', async () => {
  const result = await executeSyntheticCapacity(
    prisma,
    { branchCode: BranchCode.KANDY, teams: 1, mode: 'dry-run' },
    { asOf },
  );

  expect(result).toMatchObject({ mode: 'dry-run', teams: 1, teamSize: 4, skillCount: 2 });
  expect(result.employees).toMatchObject({ created: 4, reactivated: 0, unchanged: 0 });
  expect(result.vehicles).toMatchObject({ created: 1, reactivated: 0, unchanged: 0 });
  expect(await prisma.employee.count({ where: { sourceKey: { startsWith: sourcePrefix } } })).toBe(0);
  expect(await prisma.vehicle.count({ where: { code: { startsWith: vehiclePrefix } } })).toBe(0);
});

it('includes an agreement throughout its inclusive final effective date', async () => {
  const finalDayAgreement = await prisma.serviceAgreement.create({
    data: {
      customerId,
      serviceSiteId: siteId,
      jobTypeId,
      branchId,
      branchCode: BranchCode.KANDY,
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.WEEK,
      crewSize: 6,
      durationMinutes: 60,
      startDate: new Date('2030-01-01T00:00:00.000Z'),
      endDate: new Date('2034-01-01T00:00:00.000Z'),
      status: AgreementStatus.ACTIVE,
      requiredSkills: { create: [{ skillCode: 'FINAL_DAY_SKILL' }] },
    },
  });
  try {
    const result = await executeSyntheticCapacity(
      prisma,
      { branchCode: BranchCode.KANDY, teams: 1, mode: 'dry-run' },
      { asOf: new Date('2034-01-01T15:30:00.000Z') },
    );

    expect(result.teamSize).toBe(6);
    expect(result.skillCount).toBe(3);
  } finally {
    await prisma.serviceAgreement.delete({ where: { id: finalDayAgreement.id } });
  }
});

it('rolls back the whole transaction after an injected mid-write failure', async () => {
  await expect(apply(1, {
    hooks: { afterEmployeeWrites: () => { throw new Error('INJECTED_SYNTHETIC_FAILURE'); } },
  })).rejects.toThrow('INJECTED_SYNTHETIC_FAILURE');

  expect(await prisma.employee.count({ where: { sourceKey: { startsWith: sourcePrefix } } })).toBe(0);
  expect(await prisma.vehicle.count({ where: { code: { startsWith: vehiclePrefix } } })).toBe(0);
});

it('creates exact capacity and relations idempotently, then reactivates exact matches', async () => {
  const first = await apply(1);
  expect(first).toMatchObject({ teams: 1, teamSize: 4, skillCount: 2 });
  expect(first.employees.created).toBe(4);
  expect(first.vehicles.created).toBe(1);

  const employees = await prisma.employee.findMany({
    where: { sourceKey: { startsWith: sourcePrefix } },
    include: { skills: true, vehicleAuthorizations: true },
    orderBy: { sourceKey: 'asc' },
  });
  const [vehicle] = await prisma.vehicle.findMany({ where: { code: { startsWith: vehiclePrefix } } });
  expect(employees).toHaveLength(4);
  expect(employees.filter(({ isPmsGrade }) => isPmsGrade)).toHaveLength(1);
  expect(employees.every(({ skills }) => skills.map(({ skillCode }) => skillCode).sort().join(',') === 'FUMIGATION,GPC')).toBe(true);
  expect(employees.reduce((count, row) => count + row.vehicleAuthorizations.length, 0)).toBe(2);
  expect(vehicle).toMatchObject({ seatCapacity: 4, branchId, ownershipGroup: SYNTHETIC_CAPACITY_MARKER });

  const second = await apply(1);
  expect(second.employees.unchanged).toBe(4);
  expect(second.vehicles.unchanged).toBe(1);
  expect(await prisma.employeeSkill.count({ where: { employeeId: { in: employees.map(({ id }) => id) } } })).toBe(8);
  expect(await prisma.vehicleAuthorization.count({ where: { vehicleId: vehicle.id } })).toBe(2);

  const rerunPreview = await executeSyntheticCapacity(
    prisma,
    { branchCode: BranchCode.KANDY, teams: 1, mode: 'dry-run' },
    { asOf },
  );
  expect(rerunPreview.employees).toMatchObject({ created: 0, reactivated: 0, unchanged: 4 });
  expect(rerunPreview.vehicles).toMatchObject({ created: 0, reactivated: 0, unchanged: 1 });

  await prisma.employee.update({ where: { id: employees[0].id }, data: { isActive: false } });
  await prisma.vehicle.update({ where: { id: vehicle.id }, data: { isActive: false } });
  const reactivationPreview = await executeSyntheticCapacity(
    prisma,
    { branchCode: BranchCode.KANDY, teams: 1, mode: 'dry-run' },
    { asOf },
  );
  expect(reactivationPreview.employees).toMatchObject({ reactivated: 1, unchanged: 3 });
  expect(reactivationPreview.vehicles).toMatchObject({ reactivated: 1, unchanged: 0 });
  const reactivated = await apply(1);
  expect(reactivated.employees.reactivated).toBe(1);
  expect(reactivated.vehicles.reactivated).toBe(1);

  const deactivated = await executeSyntheticCapacity(
    prisma,
    { branchCode: BranchCode.KANDY, teams: 0, mode: 'deactivate' },
    { asOf },
  );
  expect(deactivated.employees.deactivated).toBe(4);
  expect(deactivated.vehicles.deactivated).toBe(1);
  const restored = await apply(1);
  expect(restored.employees.reactivated).toBe(4);
  expect(restored.vehicles.reactivated).toBe(1);
});

it('shrinks surplus teams without deleting their relationships or history', async () => {
  await apply(2);
  const teamTwoEmployees = await prisma.employee.findMany({
    where: { sourceKey: { startsWith: `${sourcePrefix}team:02:` } },
    select: { id: true },
  });
  const teamTwoVehicle = await prisma.vehicle.findUniqueOrThrow({
    where: { code: `${vehiclePrefix}02` },
  });
  const relationCounts = {
    skills: await prisma.employeeSkill.count({ where: { employeeId: { in: teamTwoEmployees.map(({ id }) => id) } } }),
    authorizations: await prisma.vehicleAuthorization.count({ where: { vehicleId: teamTwoVehicle.id } }),
  };

  const shrinkPreview = await executeSyntheticCapacity(
    prisma,
    { branchCode: BranchCode.KANDY, teams: 1, mode: 'dry-run' },
    { asOf },
  );
  expect(shrinkPreview.employees.deactivated).toBe(4);
  expect(shrinkPreview.vehicles.deactivated).toBe(1);
  expect(await prisma.employee.count({
    where: { id: { in: teamTwoEmployees.map(({ id }) => id) }, isActive: true },
  })).toBe(4);
  expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: teamTwoVehicle.id } })).isActive).toBe(true);

  const shrunk = await apply(1);
  expect(shrunk.employees.deactivated).toBe(4);
  expect(shrunk.vehicles.deactivated).toBe(1);
  expect(await prisma.employee.count({ where: { id: { in: teamTwoEmployees.map(({ id }) => id) }, isActive: false } })).toBe(4);
  expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: teamTwoVehicle.id } })).isActive).toBe(false);
  expect(await prisma.employeeSkill.count({
    where: { employeeId: { in: teamTwoEmployees.map(({ id }) => id) } },
  })).toBe(relationCounts.skills);
  expect(await prisma.vehicleAuthorization.count({ where: { vehicleId: teamTwoVehicle.id } })).toBe(relationCounts.authorizations);

  await prisma.serviceAgreement.update({ where: { id: agreementId }, data: { crewSize: 2 } });
  try {
    const resized = await apply(1);
    expect(resized.teamSize).toBe(2);
    expect(resized.employees.deactivated).toBe(2);
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { code: `${vehiclePrefix}01` } })).seatCapacity).toBe(2);
    expect(await prisma.employee.count({
      where: { sourceKey: { startsWith: `${sourcePrefix}team:01:` }, isActive: true },
    })).toBe(2);
  } finally {
    await prisma.serviceAgreement.update({ where: { id: agreementId }, data: { crewSize: 4 } });
  }
});

it('refuses a reserved vehicle identity collision and rolls back would-be employees', async () => {
  await prisma.vehicle.create({
    data: {
      code: `${vehiclePrefix}01`,
      label: 'Real vehicle using a reserved code',
      ownershipGroup: 'COMPANY',
      branchId,
      seatCapacity: 4,
    },
  });

  await expect(executeSyntheticCapacity(
    prisma,
    { branchCode: BranchCode.KANDY, teams: 1, mode: 'dry-run' },
    { asOf },
  )).rejects.toThrow('SYNTHETIC_VEHICLE_IDENTITY_COLLISION');
  await expect(apply(1)).rejects.toThrow('SYNTHETIC_VEHICLE_IDENTITY_COLLISION');
  expect(await prisma.employee.count({ where: { sourceKey: { startsWith: sourcePrefix } } })).toBe(0);
});

it('serializes with an assignment writer and keeps the entire live-referenced surplus team active', async () => {
  await apply(2);
  const teamTwoEmployees = await prisma.employee.findMany({
    where: { sourceKey: { startsWith: `${sourcePrefix}team:02:` } },
    orderBy: { sourceKey: 'asc' },
  });
  const teamTwoVehicle = await prisma.vehicle.findUniqueOrThrow({ where: { code: `${vehiclePrefix}02` } });
  const visit = await prisma.generatedVisit.create({
    data: {
      serviceAgreementId: agreementId,
      branchId,
      branchCode: BranchCode.KANDY,
      visitDate: new Date('2035-01-02T00:00:00.000Z'),
      windowStartMinute: 480,
      windowEndMinute: 540,
      durationMinutes: 60,
      requiredCrewSize: 4,
      status: VisitStatus.PENDING,
    },
  });

  let locked!: () => void;
  let release!: () => void;
  const lockedPromise = new Promise<void>((resolve) => { locked = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const writerClient = new PrismaClient();
  await writerClient.$connect();
  const writer = writerClient.$transaction(async (tx) => {
    await lockScheduleResources(
      tx,
      teamTwoEmployees.map(({ id }) => id),
      [teamTwoVehicle.id],
    );
    locked();
    await releasePromise;
    return tx.assignment.create({
      data: {
        generatedVisitId: visit.id,
        branchId,
        branchCode: BranchCode.KANDY,
        status: AssignmentStatus.PUBLISHED,
        plannedStart: new Date('2035-01-02T08:00:00.000Z'),
        plannedEnd: new Date('2035-01-02T09:00:00.000Z'),
        crewMembers: {
          create: teamTwoEmployees.map((employee, index) => ({
            employeeId: employee.id,
            role: index === 0 ? CrewRole.SUPERVISOR : CrewRole.TECHNICIAN,
            isPmsSupervisor: index === 0,
          })),
        },
        vehicles: {
          create: { vehicleId: teamTwoVehicle.id, driverEmployeeId: teamTwoEmployees[0].id },
        },
      },
    });
  }, { timeout: 20_000 });
  await lockedPromise;
  const shrink = apply(1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  await writer;
  await writerClient.$disconnect();

  const result = await shrink;
  expect(result.employees.blockedLive).toBe(4);
  expect(result.vehicles.blockedLive).toBe(1);
  expect(await prisma.employee.count({ where: { id: { in: teamTwoEmployees.map(({ id }) => id) }, isActive: true } })).toBe(4);
  expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: teamTwoVehicle.id } })).isActive).toBe(true);
});

it('does not narrow skills, seats, or members beneath an overdue live assignment', async () => {
  await apply(1);
  const employees = await prisma.employee.findMany({
    where: { sourceKey: { startsWith: `${sourcePrefix}team:01:` } },
    orderBy: { sourceKey: 'asc' },
  });
  const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { code: `${vehiclePrefix}01` } });
  const visit = await prisma.generatedVisit.create({
    data: {
      serviceAgreementId: agreementId,
      branchId,
      branchCode: BranchCode.KANDY,
      visitDate: new Date('2033-12-02T00:00:00.000Z'),
      windowStartMinute: 480,
      windowEndMinute: 540,
      durationMinutes: 60,
      requiredCrewSize: 4,
      status: VisitStatus.PENDING,
    },
  });
  const assignment = await prisma.assignment.create({
    data: {
      generatedVisitId: visit.id,
      branchId,
      branchCode: BranchCode.KANDY,
      status: AssignmentStatus.PUBLISHED,
      plannedStart: new Date('2033-12-02T08:00:00.000Z'),
      plannedEnd: new Date('2033-12-02T09:00:00.000Z'),
      crewMembers: {
        create: employees.map((employee, index) => ({
          employeeId: employee.id,
          role: index === 0 ? CrewRole.SUPERVISOR : CrewRole.TECHNICIAN,
          isPmsSupervisor: index === 0,
        })),
      },
      vehicles: {
        create: { vehicleId: vehicle.id, driverEmployeeId: employees[0].id },
      },
    },
  });

  await prisma.$transaction([
    prisma.serviceAgreement.update({ where: { id: agreementId }, data: { crewSize: 2 } }),
    prisma.serviceAgreementRequiredSkill.deleteMany({
      where: { serviceAgreementId: agreementId, skillCode: 'GPC' },
    }),
  ]);
  try {
    for (const status of [
      AssignmentStatus.PUBLISHED,
      AssignmentStatus.ACKNOWLEDGED,
      AssignmentStatus.IN_PROGRESS,
    ]) {
      await prisma.assignment.update({ where: { id: assignment.id }, data: { status } });
      const preview = await executeSyntheticCapacity(
        prisma,
        { branchCode: BranchCode.KANDY, teams: 1, mode: 'dry-run' },
        { asOf },
      );
      expect(preview.teamSize).toBe(2);
      expect(preview.employees.blockedLive).toBe(2);

      const protectedResult = await apply(1);
      expect(protectedResult.teamSize).toBe(2);
      expect(protectedResult.employees.blockedLive).toBe(2);
      expect(await prisma.employee.count({
        where: { id: { in: employees.map(({ id }) => id) }, isActive: true },
      })).toBe(4);
      expect(await prisma.employeeSkill.count({
        where: {
          employeeId: { in: employees.map(({ id }) => id) },
          skillCode: 'GPC',
        },
      })).toBe(4);
      expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).seatCapacity).toBe(4);
    }

    await prisma.assignment.update({
      where: { id: assignment.id },
      data: { status: AssignmentStatus.COMPLETED },
    });
    const narrowed = await apply(1);
    expect(narrowed.employees.deactivated).toBe(2);
    expect(await prisma.employeeSkill.count({
      where: {
        employeeId: { in: employees.slice(0, 2).map(({ id }) => id) },
        skillCode: 'GPC',
      },
    })).toBe(0);
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).seatCapacity).toBe(2);
  } finally {
    await prisma.$transaction([
      prisma.serviceAgreement.update({ where: { id: agreementId }, data: { crewSize: 4 } }),
      prisma.serviceAgreementRequiredSkill.upsert({
        where: { serviceAgreementId_skillCode: { serviceAgreementId: agreementId, skillCode: 'GPC' } },
        create: { serviceAgreementId: agreementId, skillCode: 'GPC' },
        update: {},
      }),
    ]);
  }
});
