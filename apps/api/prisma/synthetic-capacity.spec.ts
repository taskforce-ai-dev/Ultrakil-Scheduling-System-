import { BranchCode } from '@prisma/client';

import {
  assertSyntheticDatabaseUrl,
  buildSyntheticTeams,
  normalizeAgreementEffectiveDate,
  parseSyntheticCapacityArgs,
  verifyCurrentDatabase,
} from './synthetic-capacity';

describe('synthetic capacity database guard', () => {
  it.each([
    undefined,
    '',
    'not-a-url',
    'mysql://user:pw@localhost/ultrakil_test',
    'postgresql://user:pw@localhost/ultrakil',
    'postgresql://user:pw@localhost/ultrakil_test/extra',
    'postgresql://user:pw@localhost/ultrakil_test%2Fextra',
    'postgresql://user:pw@localhost/ultrakil_test%5Cextra',
  ])('fails closed for an unsafe URL without exposing it: %s', (value) => {
    expect(() => assertSyntheticDatabaseUrl(value)).toThrow(
      'SYNTHETIC_DATABASE_REFUSED',
    );
  });

  it.each([
    ['postgresql://user:pw@localhost:5432/ultrakil_staging?schema=public', 'ultrakil_staging'],
    ['postgres://user:pw@db.example.test/isolated_test', 'isolated_test'],
  ])('returns the decoded database name for %s', (value, expected) => {
    expect(assertSyntheticDatabaseUrl(value)).toEqual({ databaseName: expected });
  });

  it('verifies the connected database name after connection', async () => {
    const matching = { $queryRaw: jest.fn().mockResolvedValue([{ database_name: 'safe_test' }]) };
    const different = { $queryRaw: jest.fn().mockResolvedValue([{ database_name: 'other_test' }]) };

    await expect(verifyCurrentDatabase(matching as never, 'safe_test')).resolves.toBeUndefined();
    await expect(verifyCurrentDatabase(different as never, 'safe_test')).rejects.toThrow(
      'SYNTHETIC_DATABASE_MISMATCH',
    );
  });
});

describe('synthetic capacity arguments', () => {
  it('defaults to a count-only dry run', () => {
    expect(parseSyntheticCapacityArgs(['--branch', 'COLOMBO', '--teams', '2']))
      .toEqual({ branchCode: BranchCode.COLOMBO, teams: 2, mode: 'dry-run' });
  });

  it('requires the exact confirmation flag for every write', () => {
    expect(() =>
      parseSyntheticCapacityArgs(['--branch', 'KANDY', '--teams', '1', '--apply']),
    ).toThrow('SYNTHETIC_CONFIRMATION_REQUIRED');
    expect(() =>
      parseSyntheticCapacityArgs(['--deactivate', '--confirm-staging-synthetic-capacity']),
    ).toThrow('SYNTHETIC_BRANCH_REQUIRED');
    expect(
      parseSyntheticCapacityArgs([
        '--branch',
        'KANDY',
        '--teams',
        '1',
        '--apply',
        '--confirm-staging-synthetic-capacity',
      ]),
    ).toEqual({ branchCode: BranchCode.KANDY, teams: 1, mode: 'apply' });
  });

  it.each([
    ['--branch', 'COLOMBO', '--teams', '0'],
    ['--branch', 'COLOMBO', '--teams', '51'],
    ['--branch', 'COLOMBO', '--teams', '1.5'],
    ['--branch', 'UNKNOWN', '--teams', '1'],
    ['--branch', 'COLOMBO', '--teams', '1', '--wat'],
    ['--branch', 'COLOMBO', '--teams', '1', '--apply', '--deactivate'],
  ])('rejects invalid or ambiguous arguments: %s', (...args) => {
    expect(() => parseSyntheticCapacityArgs(args)).toThrow('SYNTHETIC_ARGUMENTS_REFUSED');
  });
});

describe('agreement effective date', () => {
  it('normalizes a wall-clock instant to the UTC date boundary', () => {
    expect(normalizeAgreementEffectiveDate(new Date('2034-01-01T15:30:45.678Z')))
      .toEqual(new Date('2034-01-01T00:00:00.000Z'));
  });
});

describe('buildSyntheticTeams', () => {
  it('is deterministic, visible, capacity-safe and covers all required skills', () => {
    const input = {
      branchId: '11111111-1111-1111-1111-111111111111',
      branchCode: BranchCode.KANDY,
      teams: 2,
      maximumCrewSize: 4,
      skillCodes: ['FUMIGATION', 'GPC', 'GPC'],
    };
    const first = buildSyntheticTeams(input);
    const second = buildSyntheticTeams(input);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    for (const team of first) {
      expect(team.employees).toHaveLength(4);
      expect(team.employees[0]).toMatchObject({
        isPmsGrade: true,
        skillCodes: ['FUMIGATION', 'GPC'],
      });
      expect(team.employees.every((employee) =>
        employee.fullName.startsWith('SYNTHETIC/TEST '),
      )).toBe(true);
      expect(team.vehicle).toMatchObject({
        branchId: input.branchId,
        seatCapacity: 4,
      });
      expect(team.vehicle.code.startsWith('SYN-TEST-')).toBe(true);
      expect(team.driverSourceKeys).toEqual(
        team.employees.slice(0, 2).map(({ sourceKey }) => sourceKey),
      );
    }
    expect(new Set(first.flatMap(({ employees }) => employees.map(({ sourceKey }) => sourceKey))))
      .toEqual(new Set(second.flatMap(({ employees }) => employees.map(({ sourceKey }) => sourceKey))));
  });

  it('uses a minimum team and vehicle size of two', () => {
    const [team] = buildSyntheticTeams({
      branchId: '22222222-2222-2222-2222-222222222222',
      branchCode: BranchCode.COLOMBO,
      teams: 1,
      maximumCrewSize: 1,
      skillCodes: [],
    });

    expect(team.employees).toHaveLength(2);
    expect(team.vehicle.seatCapacity).toBe(2);
    expect(team.driverSourceKeys).toHaveLength(2);
  });
});
