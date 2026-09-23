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
    await prisma.$disconnect();
  }
});

const apply = (teams: number, options: Parameters<typeof executeSyntheticCapacity>[2] = {}) =>
  executeSyntheticCapacity(
    prisma,
    { branchCode: BranchCode.KANDY, teams, mode: 'apply' },
    { asOf, ...options },
  );

it('keeps the default dry run count-only and write-free', async () => {
  const result = await executeSyntheticCapacity(
    prisma,
    { branchCode: BranchCode.KANDY, teams: 1, mode: 'dry-run' },
    { asOf },
  );

  expect(result).toMatchObject({ mode: 'dry-run', teams: 1, teamSize: 4, skillCount: 2 });
  expect(await prisma.employee.count({ where: { sourceKey: { startsWith: sourcePrefix } } })).toBe(0);
  expect(await prisma.vehicle.count({ where: { code: { startsWith: vehiclePrefix } } })).toBe(0);
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

  await prisma.employee.update({ where: { id: employees[0].id }, data: { isActive: false } });
  await prisma.vehicle.update({ where: { id: vehicle.id }, data: { isActive: false } });
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
