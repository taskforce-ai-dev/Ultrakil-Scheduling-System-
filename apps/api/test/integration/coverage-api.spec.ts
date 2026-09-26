import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BranchCode, FrequencyUnit } from '@prisma/client';
import request from 'supertest';

import { CoverageController } from '../../src/scheduling/coverage-status/coverage.controller';
import {
  COVERAGE_SWEEP_READER,
  CoverageService,
  UnavailableCoverageSweepReader,
} from '../../src/scheduling/coverage-status/coverage.service';
import { PrismaService } from '../../src/prisma/prisma.service';

let app: INestApplication;
let http: string;
let prisma: PrismaService;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [CoverageController],
    providers: [
      PrismaService,
      CoverageService,
      { provide: COVERAGE_SWEEP_READER, useClass: UnavailableCoverageSweepReader },
    ],
  }).compile();
  prisma = moduleRef.get(PrismaService);
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.init();
  await app.listen(0);
  http = (await app.getUrl()).replace('[::1]', '127.0.0.1');
});

afterAll(async () => { await app?.close(); });

describe('coverage API against isolated PostgreSQL', () => {
  it('does not infer coverage from an empty generated-visits table', async () => {
    const response = await request(http).get('/api/scheduling/coverage')
      .query({ from: '2031-09-26', to: '2031-10-25' });
    expect(response.status).toBe(200);
    expect(response.body.days).toHaveLength(30);
    expect(response.body.coveredThrough).toBeNull();
    expect(response.body.boundaryDay).toMatchObject({
      date: '2031-10-25', state: 'UNCHECKED', visitsDue: 0,
    });
  });

  it('reads one due visit from PostgreSQL without disclosing client identity', async () => {
    const branch = await prisma.branch.upsert({
      where: { code: BranchCode.COLOMBO },
      create: { code: BranchCode.COLOMBO, name: 'Colombo' }, update: {},
    });
    const suffix = Math.random().toString(36).slice(2);
    const jobType = await prisma.jobType.create({
      data: { code: `COVERAGE_${suffix}`, name: 'Synthetic test job' },
    });
    const customer = await prisma.customer.create({
      data: { name: `SYNTHETIC-PRIVATE-${suffix}`, branchId: branch.id,
        branchCode: BranchCode.COLOMBO,
        serviceSites: { create: { name: 'Synthetic site', branchId: branch.id,
          branchCode: BranchCode.COLOMBO } } },
      include: { serviceSites: true },
    });
    try {
      const agreement = await prisma.serviceAgreement.create({
        data: {
          customerId: customer.id, serviceSiteId: customer.serviceSites[0].id,
          jobTypeId: jobType.id, branchId: branch.id, branchCode: BranchCode.COLOMBO,
          frequencyCount: 1, frequencyUnit: FrequencyUnit.WEEK,
          crewSize: 2, durationMinutes: 60, startDate: new Date('2031-10-01T00:00:00Z'),
        },
      });
      await prisma.generatedVisit.create({
        data: {
          serviceAgreementId: agreement.id, branchId: branch.id, branchCode: BranchCode.COLOMBO,
          visitDate: new Date('2031-10-01T00:00:00Z'),
          windowStartMinute: 480, windowEndMinute: 1020, durationMinutes: 60,
          requiredCrewSize: 2,
        },
      });
      const response = await request(http).get('/api/scheduling/coverage')
        .query({ from: '2031-10-01', to: '2031-10-01', branchCode: 'COLOMBO' });
      expect(response.status).toBe(200);
      expect(response.body.boundaryDay).toMatchObject({
        state: 'UNCHECKED', visitsDue: 1, visitsPublished: 0, visitsPrepared: 0,
      });
      expect(JSON.stringify(response.body)).not.toContain(`SYNTHETIC-PRIVATE-${suffix}`);
    } finally {
      await prisma.customer.delete({ where: { id: customer.id } });
      await prisma.jobType.delete({ where: { id: jobType.id } });
    }
  });

  it.each([
    { from: '2031-10-25', to: '2031-09-26' },
    { from: '2031-09-26', to: '2031-10-27' },
    { from: '2031-09-26oops', to: '2031-10-25' },
  ])('rejects invalid range %#', async (range) => {
    const response = await request(http).get('/api/scheduling/coverage').query(range);
    expect(response.status).toBe(400);
  });
});
