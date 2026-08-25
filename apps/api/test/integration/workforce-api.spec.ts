/**
 * ULK-C02 API tests.
 *
 * Boots the real application against a real PostgreSQL and Redis and drives it
 * over HTTP, because the things this task must guarantee — that an anonymous
 * caller is refused, that a manager cannot do an admin's job, that a hard rule
 * cannot be talked around — all live in guards and pipes that unit tests
 * bypass entirely.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchCode, DeploymentType, PrismaClient, UserRole } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

const prisma = new PrismaClient();

const ADMIN = { email: 'test-admin@ultrakil.test', password: 'test-admin-password' };
const MANAGER = { email: 'test-manager@ultrakil.test', password: 'test-manager-password' };

let app: INestApplication;
let http: string;
let adminToken: string;
let managerToken: string;
let colomboEmployeeId: string;
let stationedEmployeeId: string;
let vehicleId: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function login(email: string, password: string): Promise<string> {
  const res = await request(http).post('/api/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

  app = moduleRef.createNestApplication();
  // Mirror main.ts, or the tests would exercise a differently-configured app.
  app.setGlobalPrefix('api');
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  await app.init();
  await app.listen(0);
  http = await app.getUrl().then((url) => url.replace('[::1]', '127.0.0.1'));

  await prisma.$connect();

  for (const code of [BranchCode.COLOMBO, BranchCode.KANDY]) {
    await prisma.branch.upsert({
      where: { code },
      create: { code, name: `${code} Branch` },
      update: {},
    });
  }

  for (const [creds, role] of [
    [ADMIN, UserRole.ADMIN],
    [MANAGER, UserRole.MANAGER],
  ] as const) {
    await prisma.user.upsert({
      where: { email: creds.email },
      create: {
        email: creds.email,
        fullName: `Test ${role}`,
        role,
        passwordHash: await AuthService.hashPassword(creds.password),
      },
      update: {
        role,
        isActive: true,
        passwordHash: await AuthService.hashPassword(creds.password),
      },
    });
  }

  adminToken = await login(ADMIN.email, ADMIN.password);
  managerToken = await login(MANAGER.email, MANAGER.password);
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { email: { in: [ADMIN.email, MANAGER.email] } },
  });
  await prisma.$disconnect();
  await app.close();
});

// ---------------------------------------------------------------------------

describe('unauthorized API access', () => {
  it.each([
    ['get', '/api/employees'],
    ['get', '/api/vehicles'],
    ['get', '/api/branches'],
    ['get', '/api/skills'],
    ['get', '/api/auth/me'],
  ])('refuses %s %s without a token', async (method, path) => {
    const res = await request(http)[method as 'get'](path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('refuses a token that is not ours', async () => {
    const res = await request(http)
      .get('/api/employees')
      .set(auth('not.a.real.token'));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_TOKEN');
  });

  it('leaves the health probes and /meta open', async () => {
    expect((await request(http).get('/api/health/live')).status).toBe(200);
    expect((await request(http).get('/api/meta')).status).toBe(200);
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await request(http)
      .post('/api/auth/login')
      .send({ email: ADMIN.email, password: 'definitely-not-it' });
    const unknownEmail = await request(http)
      .post('/api/auth/login')
      .send({ email: 'nobody@ultrakil.test', password: 'definitely-not-it' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Different answers here would let someone enumerate real accounts.
    expect(wrongPassword.body.code).toBe('INVALID_CREDENTIALS');
    expect(unknownEmail.body).toEqual(
      expect.objectContaining({ code: wrongPassword.body.code, message: wrongPassword.body.message }),
    );
  });

  it('stops honouring a token once the account is deactivated', async () => {
    const token = await login(MANAGER.email, MANAGER.password);
    await prisma.user.update({
      where: { email: MANAGER.email },
      data: { isActive: false },
    });

    const res = await request(http).get('/api/auth/me').set(auth(token));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_INACTIVE');

    await prisma.user.update({
      where: { email: MANAGER.email },
      data: { isActive: true },
    });
  });
});

describe('role enforcement', () => {
  it('lets a manager read', async () => {
    const res = await request(http).get('/api/employees').set(auth(managerToken));
    expect(res.status).toBe(200);
  });

  it('stops a manager creating an employee', async () => {
    const res = await request(http)
      .post('/api/employees')
      .set(auth(managerToken))
      .send({ fullName: 'Should Not Exist', gradeLabel: 'JPMT', branchCode: 'COLOMBO' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    expect(res.body.details).toEqual({ requiredRoles: ['ADMIN'], yourRole: 'MANAGER' });
  });
});

describe('PMS normalization', () => {
  it.each([
    ['Senoir PMS', true],
    ['Pest Management Supervisor(PMS)', true],
    ['Assistant PMS', true],
    ['SPMS', true],
    ['APMS', true],
    ['Pest Management Executive', false],
    ['Senior Pest Management Teschnician', false],
    ['Junior PMT', false],
  ])('derives isPmsGrade=%s for "%s"', async (gradeLabel, expected) => {
    const res = await request(http)
      .post('/api/employees')
      .set(auth(adminToken))
      .send({
        fullName: `Grade Probe ${gradeLabel}`,
        gradeLabel,
        branchCode: 'COLOMBO',
      });

    expect(res.status).toBe(201);
    expect(res.body.isPmsGrade).toBe(expected);
    // The label is stored exactly as given, typos included.
    expect(res.body.gradeLabel).toBe(gradeLabel);

    await prisma.employee.delete({ where: { id: res.body.id } });
  });

  it('cannot be overridden by the client', async () => {
    const res = await request(http)
      .post('/api/employees')
      .set(auth(adminToken))
      .send({
        fullName: 'Sneaky Claim',
        gradeLabel: 'Junior PMT',
        branchCode: 'COLOMBO',
        isPmsGrade: true,
      });

    // whitelist + forbidNonWhitelisted rejects the unknown property outright.
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('re-derives eligibility when the grade changes', async () => {
    const created = await request(http)
      .post('/api/employees')
      .set(auth(adminToken))
      .send({ fullName: 'Promotion Case', gradeLabel: 'Junior PMT', branchCode: 'COLOMBO' });
    expect(created.body.isPmsGrade).toBe(false);

    const updated = await request(http)
      .patch(`/api/employees/${created.body.id}`)
      .set(auth(adminToken))
      .send({ gradeLabel: 'Assistant PMS' });

    expect(updated.status).toBe(200);
    expect(updated.body.isPmsGrade).toBe(true);

    await prisma.employee.delete({ where: { id: created.body.id } });
  });
});

describe('branch isolation', () => {
  beforeAll(async () => {
    const colombo = await request(http)
      .post('/api/employees')
      .set(auth(adminToken))
      .send({ fullName: 'Branch Colombo Person', gradeLabel: 'SPMS', branchCode: 'COLOMBO' });
    colomboEmployeeId = colombo.body.id;

    await request(http)
      .post('/api/employees')
      .set(auth(adminToken))
      .send({ fullName: 'Branch Kandy Person', gradeLabel: 'Junior PMT', branchCode: 'KANDY' });
  });

  it('returns only the requested branch', async () => {
    const res = await request(http)
      .get('/api/employees?branch=KANDY&pageSize=200')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(
      res.body.items.every((e: { branchCode: string }) => e.branchCode === 'KANDY'),
    ).toBe(true);
  });

  it('gives an employee exactly one branch', async () => {
    const res = await request(http)
      .get(`/api/employees/${colomboEmployeeId}`)
      .set(auth(adminToken));

    expect(res.body.branchCode).toBe('COLOMBO');
    expect(res.body.branch.code).toBe('COLOMBO');
  });

  it('combines the branch and PMS filters', async () => {
    const res = await request(http)
      .get('/api/employees?branch=COLOMBO&pmsGrade=true&pageSize=200')
      .set(auth(adminToken));

    expect(
      res.body.items.every(
        (e: { branchCode: string; isPmsGrade: boolean }) =>
          e.branchCode === 'COLOMBO' && e.isPmsGrade,
      ),
    ).toBe(true);
  });

  it('rejects a branch that does not exist', async () => {
    const res = await request(http)
      .get('/api/employees?branch=GALLE')
      .set(auth(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('permanently stationed employees', () => {
  beforeAll(async () => {
    const res = await request(http)
      .post('/api/employees')
      .set(auth(adminToken))
      .send({
        fullName: 'Stationed Person',
        gradeLabel: 'APMS',
        branchCode: 'COLOMBO',
        deploymentType: DeploymentType.PERMANENTLY_STATIONED,
        permanentSiteLabel: 'Lion Brewery',
      });
    stationedEmployeeId = res.body.id;
  });

  it('refuses to create one without a site', async () => {
    const res = await request(http)
      .post('/api/employees')
      .set(auth(adminToken))
      .send({
        fullName: 'Siteless Person',
        gradeLabel: 'APMS',
        branchCode: 'COLOMBO',
        deploymentType: DeploymentType.PERMANENTLY_STATIONED,
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PERMANENT_SITE_REQUIRED');
  });

  it('shows the permanent site', async () => {
    const res = await request(http)
      .get(`/api/employees/${stationedEmployeeId}`)
      .set(auth(adminToken));

    expect(res.body.deploymentType).toBe('PERMANENTLY_STATIONED');
    expect(res.body.permanentSiteLabel).toBe('Lion Brewery');
  });

  it('prevents moving them to the other branch', async () => {
    const res = await request(http)
      .patch(`/api/employees/${stationedEmployeeId}`)
      .set(auth(adminToken))
      .send({ branchCode: 'KANDY' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PERMANENT_EMPLOYEE_CANNOT_CHANGE_BRANCH');
    expect(res.body.message).toContain('Lion Brewery');
  });

  it('prevents clearing the site while they are still stationed', async () => {
    const res = await request(http)
      .patch(`/api/employees/${stationedEmployeeId}`)
      .set(auth(adminToken))
      .send({ permanentSiteLabel: null });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PERMANENT_SITE_REQUIRED');
  });

  it('allows the move once they are made mobile', async () => {
    const mobile = await request(http)
      .put(`/api/employees/${stationedEmployeeId}/permanent-assignment`)
      .set(auth(adminToken))
      .send({ siteLabel: null });

    expect(mobile.status).toBe(200);
    expect(mobile.body.deploymentType).toBe('MOBILE');

    const moved = await request(http)
      .patch(`/api/employees/${stationedEmployeeId}`)
      .set(auth(adminToken))
      .send({ branchCode: 'KANDY' });
    expect(moved.status).toBe(200);
    expect(moved.body.branchCode).toBe('KANDY');
  });

  it('filters by permanent status', async () => {
    const res = await request(http)
      .get('/api/employees?deployment=PERMANENTLY_STATIONED&pageSize=200')
      .set(auth(adminToken));

    expect(
      res.body.items.every(
        (e: { deploymentType: string; permanentSiteLabel: string | null }) =>
          e.deploymentType === 'PERMANENTLY_STATIONED' && e.permanentSiteLabel,
      ),
    ).toBe(true);
  });
});

describe('availability', () => {
  it('rejects an end date before the start date', async () => {
    const res = await request(http)
      .post(`/api/employees/${colomboEmployeeId}/availability`)
      .set(auth(adminToken))
      .send({ startDate: '2027-03-10', endDate: '2027-03-01' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('AVAILABILITY_RANGE_INVALID');
  });

  it('records an absence and rejects one that overlaps it', async () => {
    const first = await request(http)
      .post(`/api/employees/${colomboEmployeeId}/availability`)
      .set(auth(adminToken))
      .send({ startDate: '2027-04-01', endDate: '2027-04-07', kind: 'LEAVE' });
    expect(first.status).toBe(201);

    const overlapping = await request(http)
      .post(`/api/employees/${colomboEmployeeId}/availability`)
      .set(auth(adminToken))
      .send({ startDate: '2027-04-05', endDate: '2027-04-10' });

    expect(overlapping.status).toBe(409);
    expect(overlapping.body.code).toBe('AVAILABILITY_OVERLAPS');
    expect(overlapping.body.details.conflictingStart).toBe('2027-04-01');
  });

  it('excludes the employee from availableOn inside the absence', async () => {
    const during = await request(http)
      .get('/api/employees?availableOn=2027-04-03&pageSize=200')
      .set(auth(adminToken));
    expect(
      during.body.items.some((e: { id: string }) => e.id === colomboEmployeeId),
    ).toBe(false);

    const after = await request(http)
      .get('/api/employees?availableOn=2027-04-20&pageSize=200')
      .set(auth(adminToken));
    expect(
      after.body.items.some((e: { id: string }) => e.id === colomboEmployeeId),
    ).toBe(true);
  });

  it('frees the date again once the absence is removed', async () => {
    const employee = await request(http)
      .get(`/api/employees/${colomboEmployeeId}`)
      .set(auth(adminToken));
    const absence = employee.body.availability[0];

    const removed = await request(http)
      .delete(`/api/employees/${colomboEmployeeId}/availability/${absence.id}`)
      .set(auth(adminToken));
    expect(removed.status).toBe(204);

    const res = await request(http)
      .get('/api/employees?availableOn=2027-04-03&pageSize=200')
      .set(auth(adminToken));
    expect(res.body.items.some((e: { id: string }) => e.id === colomboEmployeeId)).toBe(true);
  });
});

describe('vehicle authorization', () => {
  beforeAll(async () => {
    const res = await request(http)
      .post('/api/vehicles')
      .set(auth(adminToken))
      .send({ code: 'TEST-0001', label: 'Test Van( 04 People) TEST-0001', seatCapacity: 4 });
    vehicleId = res.body.id;
  });

  afterAll(async () => {
    await prisma.vehicle.deleteMany({ where: { code: 'TEST-0001' } });
  });

  it('starts with nobody authorised', async () => {
    const res = await request(http)
      .get(`/api/vehicles/${vehicleId}/authorized-drivers`)
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  it('authorises a driver and lists them', async () => {
    const granted = await request(http)
      .post(`/api/employees/${colomboEmployeeId}/vehicle-authorizations/${vehicleId}`)
      .set(auth(adminToken));
    expect(granted.status).toBe(201);

    const drivers = await request(http)
      .get(`/api/vehicles/${vehicleId}/authorized-drivers`)
      .set(auth(adminToken));
    expect(drivers.body.total).toBe(1);
    expect(drivers.body.drivers[0].id).toBe(colomboEmployeeId);
  });

  it('filters employees by vehicle authorization', async () => {
    const res = await request(http)
      .get(`/api/employees?vehicleId=${vehicleId}&pageSize=200`)
      .set(auth(adminToken));

    expect(res.body.total).toBe(1);
    expect(res.body.items[0].id).toBe(colomboEmployeeId);
  });

  it('refuses to authorise the same pair twice', async () => {
    const res = await request(http)
      .post(`/api/employees/${colomboEmployeeId}/vehicle-authorizations/${vehicleId}`)
      .set(auth(adminToken));

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('AUTHORIZATION_ALREADY_EXISTS');
  });

  it('refuses to authorise a deactivated vehicle', async () => {
    await request(http).post(`/api/vehicles/${vehicleId}/deactivate`).set(auth(adminToken));

    const other = await request(http)
      .post('/api/employees')
      .set(auth(adminToken))
      .send({ fullName: 'Would Be Driver', gradeLabel: 'JPMT', branchCode: 'COLOMBO' });

    const res = await request(http)
      .post(`/api/employees/${other.body.id}/vehicle-authorizations/${vehicleId}`)
      .set(auth(adminToken));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VEHICLE_INACTIVE');

    await request(http).post(`/api/vehicles/${vehicleId}/reactivate`).set(auth(adminToken));
    await prisma.employee.delete({ where: { id: other.body.id } });
  });

  it('withdraws an authorization', async () => {
    const removed = await request(http)
      .delete(`/api/employees/${colomboEmployeeId}/vehicle-authorizations/${vehicleId}`)
      .set(auth(adminToken));
    expect(removed.status).toBe(204);

    const drivers = await request(http)
      .get(`/api/vehicles/${vehicleId}/authorized-drivers`)
      .set(auth(adminToken));
    expect(drivers.body.total).toBe(0);
  });

  it('reports a missing authorization rather than pretending to remove one', async () => {
    const res = await request(http)
      .delete(`/api/employees/${colomboEmployeeId}/vehicle-authorizations/${vehicleId}`)
      .set(auth(adminToken));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('AUTHORIZATION_NOT_FOUND');
  });
});

describe('deactivation instead of deletion', () => {
  it('hides a deactivated employee by default but keeps the record', async () => {
    const created = await request(http)
      .post('/api/employees')
      .set(auth(adminToken))
      .send({ fullName: 'Leaver Person', gradeLabel: 'JPMT', branchCode: 'COLOMBO' });

    await request(http)
      .post(`/api/employees/${created.body.id}/deactivate`)
      .set(auth(adminToken));

    const active = await request(http)
      .get('/api/employees?pageSize=200')
      .set(auth(adminToken));
    expect(active.body.items.some((e: { id: string }) => e.id === created.body.id)).toBe(false);

    const inactive = await request(http)
      .get('/api/employees?active=false&pageSize=200')
      .set(auth(adminToken));
    expect(inactive.body.items.some((e: { id: string }) => e.id === created.body.id)).toBe(true);

    // Still fetchable directly — history must not dangle.
    const direct = await request(http)
      .get(`/api/employees/${created.body.id}`)
      .set(auth(adminToken));
    expect(direct.status).toBe(200);

    await prisma.employee.delete({ where: { id: created.body.id } });
  });
});

describe('audit trail', () => {
  it('records before and after for an edited imported value', async () => {
    const created = await request(http)
      .post('/api/employees')
      .set(auth(adminToken))
      .send({ fullName: 'Audited Person', gradeLabel: 'Junior PMT', branchCode: 'COLOMBO' });

    await request(http)
      .patch(`/api/employees/${created.body.id}`)
      .set(auth(adminToken))
      .send({ gradeLabel: 'Assistant PMS' });

    const events = await prisma.auditEvent.findMany({
      where: { entityId: created.body.id },
      orderBy: { createdAt: 'asc' },
    });

    expect(events.map((e) => e.action)).toEqual([
      'employee.created',
      'employee.updated',
    ]);

    // A creation has no "before" — that must be SQL NULL, not JSON null, or it
    // cannot be told apart from a previous value that genuinely was null.
    expect(events[0].before).toBeNull();

    const before = events[1].before as Record<string, unknown>;
    const after = events[1].after as Record<string, unknown>;
    expect(before.gradeLabel).toBe('Junior PMT');
    expect(after.gradeLabel).toBe('Assistant PMS');
    expect(events[1].actorLabel).toContain(ADMIN.email);

    await prisma.auditEvent.deleteMany({ where: { entityId: created.body.id } });
    await prisma.employee.delete({ where: { id: created.body.id } });
  });
});
