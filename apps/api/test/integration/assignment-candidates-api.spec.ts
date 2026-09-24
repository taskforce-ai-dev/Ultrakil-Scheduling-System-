/**
 * PostgreSQL evidence for the advisory assignment-candidate read model.
 *
 * The candidate response helps a manager avoid an obviously stale choice, but
 * the assignment mutation remains authoritative. These tests deliberately use
 * the real HTTP boundary and persisted assignments rather than mocked Prisma
 * responses so status, branch and midnight semantics stay aligned.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AgreementStatus,
  AssignmentStatus,
  BranchCode,
  CrewRole,
  FrequencyUnit,
  PrismaClient,
  UserRole,
  VisitStatus,
} from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { cleanupCapturedIds } from '../support/fixture-cleanup';

const prisma = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 10);
const ADMIN = {
  email: `candidate-api-${suffix}@ultrakil.test`,
  password: 'candidate-api-password',
};
const at = (date: string, minute = 0) =>
  new Date(new Date(`${date}T00:00:00.000Z`).getTime() + minute * 60_000);

let app: INestApplication | undefined;
let appInitialized = false;
let prismaConnected = false;
let http: string;
let token: string;
let colomboId: string;
let kandyId: string;
let otherAgreementId: string;
const agreementIds: string[] = [];
const customerIds: string[] = [];
const siteIds: string[] = [];
const jobTypeIds: string[] = [];
const userIds: string[] = [];
const employeeIds: string[] = [];
const vehicleIds: string[] = [];
const visitIds: string[] = [];

const auth = () => ({ Authorization: `Bearer ${token}` });

async function employee(label: string, isPmsGrade = true) {
  const row = await prisma.employee.create({
    data: {
      sourceKey: `candidate-api-${label}-${suffix}`,
      fullName: `Candidate ${label} ${suffix}`,
      gradeLabel: isPmsGrade ? 'PMS' : 'PMT',
      isPmsGrade,
      branchId: colomboId,
      branchCode: BranchCode.COLOMBO,
      canUsePublicTransport: true,
    },
  });
  employeeIds.push(row.id);
  return row;
}

async function vehicle(label: string, branchId: string | null = colomboId) {
  const row = await prisma.vehicle.create({
    data: {
      code: `CAND-${label.toUpperCase()}-${suffix}`,
      label: `Candidate ${label} ${suffix}`,
      seatCapacity: 4,
      branchId,
    },
  });
  vehicleIds.push(row.id);
  return row;
}

async function visit(
  date: string,
  windowStartMinute: number,
  agreementId = agreementIds[0],
) {
  if (!agreementId) throw new Error('Candidate fixture agreement was not created.');
  const row = await prisma.generatedVisit.create({
    data: {
      serviceAgreementId: agreementId,
      branchId: colomboId,
      branchCode: BranchCode.COLOMBO,
      visitDate: at(date),
      windowStartMinute,
      windowEndMinute: 1440,
      durationMinutes: 60,
      requiredCrewSize: 1,
      status: VisitStatus.PENDING,
    },
  });
  visitIds.push(row.id);
  return row;
}

async function reservation(options: {
  visitId: string;
  date: string;
  start: number;
  end: number;
  employeeId: string;
  vehicleId?: string;
  status?: AssignmentStatus;
}) {
  return prisma.assignment.create({
    data: {
      generatedVisitId: options.visitId,
      branchId: colomboId,
      branchCode: BranchCode.COLOMBO,
      status: options.status ?? AssignmentStatus.PUBLISHED,
      plannedStart: at(options.date, options.start),
      plannedEnd: at(options.date, options.end),
      crewMembers: {
        create: {
          employeeId: options.employeeId,
          role: CrewRole.SUPERVISOR,
          isPmsSupervisor: true,
        },
      },
      ...(options.vehicleId
        ? {
            vehicles: {
              create: {
                vehicleId: options.vehicleId,
                driverEmployeeId: options.employeeId,
              },
            },
          }
        : {}),
    },
  });
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const createdApp = moduleRef.createNestApplication();
  app = createdApp;
  createdApp.setGlobalPrefix('api');
  createdApp.useGlobalFilters(new AllExceptionsFilter());
  createdApp.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await createdApp.init();
  appInitialized = true;
  await createdApp.listen(0);
  http = await createdApp.getUrl().then((url) => url.replace('[::1]', '127.0.0.1'));
  await prisma.$connect();
  prismaConnected = true;

  const [colombo, kandy] = await Promise.all(
    [BranchCode.COLOMBO, BranchCode.KANDY].map((code) =>
      prisma.branch.upsert({
        where: { code },
        create: { code, name: `${code} Branch` },
        update: {},
      }),
    ),
  );
  colomboId = colombo.id;
  kandyId = kandy.id;

  const user = await prisma.user.create({
    data: {
      email: ADMIN.email,
      fullName: `Candidate API Admin ${suffix}`,
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
  });
  userIds.push(user.id);
  const login = await request(http).post('/api/auth/login').send(ADMIN);
  expect(login.status).toBe(200);
  token = login.body.accessToken as string;

  const customer = await prisma.customer.create({
    data: {
      name: `Candidate Customer ${suffix}`,
      branchId: colomboId,
      branchCode: BranchCode.COLOMBO,
    },
  });
  customerIds.push(customer.id);
  const site = await prisma.serviceSite.create({
    data: {
      customerId: customer.id,
      name: `Candidate Site ${suffix}`,
      branchId: colomboId,
      branchCode: BranchCode.COLOMBO,
    },
  });
  siteIds.push(site.id);
  const jobType = await prisma.jobType.create({
    data: {
      code: `CANDIDATE_${suffix.toUpperCase()}`,
      name: `Candidate Job ${suffix}`,
      defaultDurationMinutes: 60,
      defaultCrewSize: 1,
    },
  });
  jobTypeIds.push(jobType.id);
  const agreement = await prisma.serviceAgreement.create({
    data: {
      customerId: customer.id,
      serviceSiteId: site.id,
      jobTypeId: jobType.id,
      branchId: colomboId,
      branchCode: BranchCode.COLOMBO,
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.WEEK,
      crewSize: 1,
      durationMinutes: 60,
      serviceWindowStartMinute: 0,
      serviceWindowEndMinute: 1440,
      startDate: at('2034-02-01'),
      status: AgreementStatus.ACTIVE,
    },
  });
  agreementIds.push(agreement.id);

  const otherSite = await prisma.serviceSite.create({
    data: {
      customerId: customer.id,
      name: `Candidate Other Site ${suffix}`,
      branchId: colomboId,
      branchCode: BranchCode.COLOMBO,
    },
  });
  siteIds.push(otherSite.id);
  const otherAgreement = await prisma.serviceAgreement.create({
    data: {
      customerId: customer.id,
      serviceSiteId: otherSite.id,
      jobTypeId: jobType.id,
      branchId: colomboId,
      branchCode: BranchCode.COLOMBO,
      frequencyCount: 1,
      frequencyUnit: FrequencyUnit.WEEK,
      crewSize: 1,
      durationMinutes: 60,
      serviceWindowStartMinute: 0,
      serviceWindowEndMinute: 1440,
      startDate: at('2034-02-01'),
      status: AgreementStatus.ACTIVE,
    },
  });
  otherAgreementId = otherAgreement.id;
  agreementIds.push(otherAgreement.id);
});

afterAll(async () => {
  try {
    if (prismaConnected) {
      await cleanupCapturedIds(visitIds, (ids) =>
        prisma.assignment.deleteMany({ where: { generatedVisitId: { in: ids } } }),
      );
      await cleanupCapturedIds(visitIds, (ids) =>
        prisma.generatedVisit.deleteMany({ where: { id: { in: ids } } }),
      );
      await cleanupCapturedIds(agreementIds, (ids) =>
        prisma.serviceAgreement.deleteMany({ where: { id: { in: ids } } }),
      );
      await cleanupCapturedIds(siteIds, (ids) =>
        prisma.serviceSite.deleteMany({ where: { id: { in: ids } } }),
      );
      await cleanupCapturedIds(customerIds, (ids) =>
        prisma.customer.deleteMany({ where: { id: { in: ids } } }),
      );
      await cleanupCapturedIds(jobTypeIds, (ids) =>
        prisma.jobType.deleteMany({ where: { id: { in: ids } } }),
      );
      await cleanupCapturedIds(vehicleIds, (ids) =>
        prisma.vehicle.deleteMany({ where: { id: { in: ids } } }),
      );
      await cleanupCapturedIds(employeeIds, (ids) =>
        prisma.employee.deleteMany({ where: { id: { in: ids } } }),
      );
      await cleanupCapturedIds(userIds, (ids) =>
        prisma.user.deleteMany({ where: { id: { in: ids } } }),
      );
    }
  } finally {
    if (prismaConnected) await prisma.$disconnect();
    if (appInitialized && app) await app.close();
  }
});

it('returns persisted live reservations as unavailable, ignores history and self, and scopes vehicles', async () => {
  const date = '2034-02-01';
  const [target, liveVisit, historicalVisit] = await Promise.all([
    visit(date, 1),
    visit(date, 2),
    visit(date, 3),
  ]);
  const [busyEmployee, historicalEmployee, selfEmployee] = await Promise.all([
    employee('busy'),
    employee('historical'),
    employee('self'),
  ]);
  const [busyVehicle, historicalVehicle, selfVehicle, sameBranchVehicle, branchlessVehicle, otherBranchVehicle] =
    await Promise.all([
      vehicle('busy'),
      vehicle('historical'),
      vehicle('self'),
      vehicle('same-branch'),
      vehicle('branchless', null),
      vehicle('other-branch', kandyId),
    ]);

  await Promise.all([
    reservation({
      visitId: liveVisit.id,
      date,
      start: 540,
      end: 660,
      employeeId: busyEmployee.id,
      vehicleId: busyVehicle.id,
    }),
    reservation({
      visitId: historicalVisit.id,
      date,
      start: 540,
      end: 660,
      employeeId: historicalEmployee.id,
      vehicleId: historicalVehicle.id,
      status: AssignmentStatus.COMPLETED,
    }),
    reservation({
      visitId: target.id,
      date,
      start: 540,
      end: 660,
      employeeId: selfEmployee.id,
      vehicleId: selfVehicle.id,
      status: AssignmentStatus.DRAFT,
    }),
  ]);

  const response = await request(http)
    .post(`/api/visits/${target.id}/assignment/candidates`)
    .set(auth())
    .send({ plannedStartMinute: 570, plannedEndMinute: 630 });

  expect(response.status).toBe(200);
  const employees = new Map(
    response.body.employees.map((row: { id: string }) => [row.id, row]),
  );
  const vehicles = new Map(
    response.body.vehicles.map((row: { id: string }) => [row.id, row]),
  );
  expect(employees.get(busyEmployee.id)).toMatchObject({
    isAvailable: false,
    unavailableReason: {
      code: 'EMPLOYEE_DOUBLE_BOOKED',
      message: 'Booked 09:00–11:00',
    },
  });
  expect(employees.get(historicalEmployee.id)).toMatchObject({
    isAvailable: true,
    unavailableReason: null,
  });
  expect(employees.get(selfEmployee.id)).toMatchObject({
    isAvailable: true,
    unavailableReason: null,
  });
  expect(vehicles.get(busyVehicle.id)).toMatchObject({
    isAvailable: false,
    unavailableReason: {
      code: 'VEHICLE_DOUBLE_BOOKED',
      message: 'Booked 09:00–11:00',
    },
  });
  expect(vehicles.get(historicalVehicle.id)).toMatchObject({ isAvailable: true });
  expect(vehicles.get(selfVehicle.id)).toMatchObject({ isAvailable: true });
  expect(vehicles.has(sameBranchVehicle.id)).toBe(true);
  expect(vehicles.has(branchlessVehicle.id)).toBe(true);
  expect(vehicles.has(otherBranchVehicle.id)).toBe(false);
});

it('preserves next-midnight overlap in both candidates and the authoritative assignment path', async () => {
  const date = '2034-02-02';
  const [reservedVisit, overlapVisit, adjacentVisit] = await Promise.all([
    visit(date, 10),
    visit(date, 11),
    visit(date, 12),
  ]);
  const worker = await employee('midnight');
  const van = await vehicle('midnight');
  await prisma.vehicleAuthorization.create({
    data: { employeeId: worker.id, vehicleId: van.id },
  });
  await reservation({
    visitId: reservedVisit.id,
    date,
    start: 22 * 60,
    end: 24 * 60,
    employeeId: worker.id,
    vehicleId: van.id,
  });

  const candidates = await request(http)
    .post(`/api/visits/${overlapVisit.id}/assignment/candidates`)
    .set(auth())
    .send({ plannedStartMinute: 23 * 60, plannedEndMinute: 24 * 60 });
  expect(candidates.status).toBe(200);
  expect(candidates.body.employees.find((row: { id: string }) => row.id === worker.id))
    .toMatchObject({ isAvailable: false });
  expect(candidates.body.vehicles.find((row: { id: string }) => row.id === van.id))
    .toMatchObject({ isAvailable: false });

  const overlap = await request(http)
    .put(`/api/visits/${overlapVisit.id}/assignment`)
    .set(auth())
    .send({
      plannedStartMinute: 23 * 60,
      plannedEndMinute: 24 * 60,
      crew: [{ employeeId: worker.id, role: CrewRole.SUPERVISOR }],
      vehicles: [{ vehicleId: van.id, driverEmployeeId: worker.id }],
    });
  expect(overlap.status).toBe(409);
  expect(overlap.body.details.conflicts.map((row: { code: string }) => row.code))
    .toEqual(expect.arrayContaining(['EMPLOYEE_DOUBLE_BOOKED', 'VEHICLE_DOUBLE_BOOKED']));

  const adjacent = await request(http)
    .put(`/api/visits/${adjacentVisit.id}/assignment`)
    .set(auth())
    .send({
      plannedStartMinute: 20 * 60,
      plannedEndMinute: 22 * 60,
      crew: [{ employeeId: worker.id, role: CrewRole.SUPERVISOR }],
      vehicles: [{ vehicleId: van.id, driverEmployeeId: worker.id }],
    });
  expect(adjacent.status).toBe(200);
});

it('revalidates authoritatively when a resource is booked after the advisory read', async () => {
  const date = '2034-02-03';
  const [target, competingVisit] = await Promise.all([
    visit(date, 20),
    visit(date, 21),
  ]);
  const worker = await employee('post-read-race');

  const candidates = await request(http)
    .post(`/api/visits/${target.id}/assignment/candidates`)
    .set(auth())
    .send({ plannedStartMinute: 9 * 60, plannedEndMinute: 10 * 60 });
  expect(candidates.status).toBe(200);
  expect(candidates.body.employees.find((row: { id: string }) => row.id === worker.id))
    .toMatchObject({ isAvailable: true, unavailableReason: null });

  await reservation({
    visitId: competingVisit.id,
    date,
    start: 9 * 60,
    end: 10 * 60,
    employeeId: worker.id,
  });

  const assignment = await request(http)
    .put(`/api/visits/${target.id}/assignment`)
    .set(auth())
    .send({
      plannedStartMinute: 9 * 60,
      plannedEndMinute: 10 * 60,
      crew: [{ employeeId: worker.id, role: CrewRole.SUPERVISOR }],
    });
  expect(assignment.status).toBe(409);
  expect(assignment.body.details.conflicts.map((row: { code: string }) => row.code))
    .toContain('EMPLOYEE_DOUBLE_BOOKED');
  expect(await prisma.assignment.count({ where: { generatedVisitId: target.id } })).toBe(0);
});

it('requires sixty minutes between different sites in candidates and authoritative assignment', async () => {
  const date = '2034-02-04';
  const [target, reservedVisit] = await Promise.all([
    visit(date, 30),
    visit(date, 31, otherAgreementId),
  ]);
  const worker = await employee('travel-gap');
  const van = await vehicle('travel-gap');
  await prisma.vehicleAuthorization.create({
    data: { employeeId: worker.id, vehicleId: van.id },
  });
  await reservation({
    visitId: reservedVisit.id,
    date,
    start: 9 * 60,
    end: 10 * 60,
    employeeId: worker.id,
    vehicleId: van.id,
  });

  const candidates = await request(http)
    .post(`/api/visits/${target.id}/assignment/candidates`)
    .set(auth())
    .send({ plannedStartMinute: 10 * 60, plannedEndMinute: 11 * 60 });
  expect(candidates.status).toBe(200);
  expect(candidates.body.employees.find((row: { id: string }) => row.id === worker.id))
    .toMatchObject({
      isAvailable: false,
      unavailableReason: { code: 'EMPLOYEE_TRAVEL_GAP_TOO_SHORT' },
    });
  expect(candidates.body.vehicles.find((row: { id: string }) => row.id === van.id))
    .toMatchObject({
      isAvailable: false,
      unavailableReason: { code: 'VEHICLE_TRAVEL_GAP_TOO_SHORT' },
    });

  const refused = await request(http)
    .put(`/api/visits/${target.id}/assignment`)
    .set(auth())
    .send({
      plannedStartMinute: 10 * 60,
      plannedEndMinute: 11 * 60,
      crew: [{ employeeId: worker.id, role: CrewRole.SUPERVISOR }],
      vehicles: [{ vehicleId: van.id, driverEmployeeId: worker.id }],
    });
  expect(refused.status).toBe(409);
  expect(refused.body.details.conflicts.map((row: { code: string }) => row.code))
    .toEqual(expect.arrayContaining([
      'EMPLOYEE_TRAVEL_GAP_TOO_SHORT',
      'VEHICLE_TRAVEL_GAP_TOO_SHORT',
    ]));

  const allowed = await request(http)
    .put(`/api/visits/${target.id}/assignment`)
    .set(auth())
    .send({
      plannedStartMinute: 11 * 60,
      plannedEndMinute: 12 * 60,
      crew: [{ employeeId: worker.id, role: CrewRole.SUPERVISOR }],
      vehicles: [{ vehicleId: van.id, driverEmployeeId: worker.id }],
    });
  expect(allowed.status).toBe(200);
});

it('carries the different-site travel guard across midnight', async () => {
  const previousDate = '2034-02-05';
  const targetDate = '2034-02-06';
  const [target, reservedVisit] = await Promise.all([
    visit(targetDate, 40),
    visit(previousDate, 41, otherAgreementId),
  ]);
  const worker = await employee('travel-midnight');
  await reservation({
    visitId: reservedVisit.id,
    date: previousDate,
    start: 23 * 60,
    end: 24 * 60,
    employeeId: worker.id,
  });

  const candidates = await request(http)
    .post(`/api/visits/${target.id}/assignment/candidates`)
    .set(auth())
    .send({ plannedStartMinute: 0, plannedEndMinute: 60 });

  expect(candidates.status).toBe(200);
  expect(candidates.body.employees.find((row: { id: string }) => row.id === worker.id))
    .toMatchObject({
      isAvailable: false,
      unavailableReason: { code: 'EMPLOYEE_TRAVEL_GAP_TOO_SHORT' },
    });
});
