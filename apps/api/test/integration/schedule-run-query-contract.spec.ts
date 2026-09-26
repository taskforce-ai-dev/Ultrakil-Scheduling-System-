/**
 * `GET /api/schedule-runs?ids=...` against a real HTTP request, not just the
 * DTO in isolation.
 *
 * Express/Nest parse a single `?ids=x` as the bare string `"x"`, and only
 * `?ids=x&ids=y` as an array — `ScheduleRunQueryDto.ids` carried `@IsArray()`
 * with nothing to coerce the single-value case, so filtering by exactly one
 * run id was rejected with a 400 the portal had no way to predict, because
 * the generated contract did not document `ids` (or `page`, `pageSize`,
 * `status`) as query parameters at all — `parameters: { query?: never }` —
 * for the same reason `workforce/dto/query.swagger.ts` already explains:
 * NestJS cannot introspect a `@Query()` class without the Swagger CLI
 * plugin, which the OpenAPI generation script does not run.
 *
 * `ScheduleRunQueryDto.ids` now normalizes a bare value into a one-element
 * array before validation, and `ApiScheduleRunQuery` declares the query
 * parameters explicitly, the same way the visits and workforce endpoints
 * already do.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchCode, PrismaClient, UserRole } from '@prisma/client';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { AuthService } from '../../src/auth/auth.service';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ScheduleRunProcessor } from '../../src/scheduling/optimizer/schedule-run.processor';

const prisma = new PrismaClient();
const suffix = Math.random().toString(36).slice(2, 8);
const ADMIN = {
  email: `query-contract-${suffix}@ultrakil.test`,
  password: 'query-contract-password',
};
const WEEK = { from: '2029-04-02', to: '2029-04-08' };
const at = (date: string) => new Date(`${date}T00:00:00.000Z`);

let app: INestApplication;
let http: string;
let token: string;
const auth = () => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ScheduleRunProcessor)
    .useValue({})
    .compile();
  app = moduleRef.createNestApplication();
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
  await prisma.user.upsert({
    where: { email: ADMIN.email },
    create: {
      email: ADMIN.email,
      fullName: 'Query Contract Admin',
      role: UserRole.ADMIN,
      passwordHash: await AuthService.hashPassword(ADMIN.password),
    },
    update: { role: UserRole.ADMIN, isActive: true },
  });
  const login = await request(http)
    .post('/api/auth/login')
    .send({ email: ADMIN.email, password: ADMIN.password });
  token = login.body.accessToken as string;
}, 120_000);

afterAll(async () => {
  await prisma.scheduleRun.deleteMany({
    where: { rangeStart: at(WEEK.from), rangeEnd: at(WEEK.to) },
  });
  await prisma.user.deleteMany({ where: { email: ADMIN.email } });
  await prisma.$disconnect();
  await app.close();
}, 60_000);

it('accepts one id the same way it accepts several', async () => {
  const first = await prisma.scheduleRun.create({
    data: {
      status: 'SUCCEEDED',
      branchCode: BranchCode.COLOMBO,
      rangeStart: at(WEEK.from),
      rangeEnd: at(WEEK.to),
    },
  });
  const second = await prisma.scheduleRun.create({
    data: {
      status: 'SUCCEEDED',
      branchCode: BranchCode.COLOMBO,
      rangeStart: at(WEEK.from),
      rangeEnd: at(WEEK.to),
    },
  });

  const one = await request(http)
    .get('/api/schedule-runs')
    .query({ ids: first.id })
    .set(auth());
  expect(one.status).toBe(200);
  expect(one.body.items.map((run: { id: string }) => run.id)).toEqual([first.id]);

  const both = await request(http)
    .get('/api/schedule-runs')
    .query({ ids: [first.id, second.id] })
    .set(auth());
  expect(both.status).toBe(200);
  expect(new Set(both.body.items.map((run: { id: string }) => run.id))).toEqual(
    new Set([first.id, second.id]),
  );

  // The manager portal's own query builder does `String(value)` on whatever
  // it is handed, and `String([a, b])` joins with commas rather than
  // repeating the parameter — this is the shape a real request from it takes.
  const commaJoined = await request(http)
    .get('/api/schedule-runs')
    .query(`ids=${first.id},${second.id}`)
    .set(auth());
  expect(commaJoined.status).toBe(200);
  expect(new Set(commaJoined.body.items.map((run: { id: string }) => run.id))).toEqual(
    new Set([first.id, second.id]),
  );
}, 60_000);

it('finds the published run covering a day even after more than 50 newer generation runs', async () => {
  const live = await prisma.scheduleRun.create({
    data: {
      status: 'SUCCEEDED', branchCode: BranchCode.COLOMBO,
      rangeStart: at(WEEK.from), rangeEnd: at(WEEK.to),
      createdAt: new Date('2028-04-01T00:00:00Z'),
      publishedAt: new Date('2028-04-02T00:00:00Z'),
      visitsScheduled: 6,
    },
  });
  await prisma.scheduleRun.createMany({
    data: Array.from({ length: 60 }, (_, index) => ({
      status: 'SUCCEEDED' as const, branchCode: BranchCode.COLOMBO,
      rangeStart: at(WEEK.from), rangeEnd: at(WEEK.to),
      createdAt: new Date(Date.UTC(2030, 0, 1, 0, index)),
    })),
  });

  const recent = await request(http).get('/api/schedule-runs')
    .query({ pageSize: 50 }).set(auth());
  expect(recent.status).toBe(200);
  expect(recent.body.items.some((run: { id: string }) => run.id === live.id)).toBe(false);

  const current = await request(http).get('/api/schedule-runs')
    .query({ currentOn: '2029-04-05', pageSize: 1 }).set(auth());
  expect(current.status).toBe(200);
  expect(current.body.items.map((run: { id: string }) => run.id)).toEqual([live.id]);
  expect(current.body.total).toBe(1);

  const invalid = await request(http).get('/api/schedule-runs')
    .query({ currentOn: '2029-04-05garbage', pageSize: 1 }).set(auth());
  expect(invalid.status).toBe(400);
}, 60_000);
