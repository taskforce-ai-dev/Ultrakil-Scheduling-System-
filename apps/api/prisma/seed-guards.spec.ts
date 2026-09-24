import { PrismaClient } from '@prisma/client';
import { seedAdminUser, seedReferenceData } from './reference-data';
import { assertDemoSeedAllowed, assertProductionSeedCredentials } from './seed-guards';

describe('production seed guards', () => {
  it.each([
    [{ NODE_ENV: 'production' }, 'SEED_ADMIN_EMAIL'],
    [{ NODE_ENV: 'production', SEED_ADMIN_EMAIL: '  ' }, 'SEED_ADMIN_EMAIL'],
    [{ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'replace-with-admin@example.invalid' }, 'SEED_ADMIN_EMAIL'],
    [{ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'not-an-email' }, 'SEED_ADMIN_EMAIL'],
    [{ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'owner@example.test' }, 'SEED_ADMIN_PASSWORD'],
    [{ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'owner@example.test', SEED_ADMIN_PASSWORD: 'ultrakil-change-me' }, 'SEED_ADMIN_PASSWORD'],
    [{ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'owner@example.test', SEED_ADMIN_PASSWORD: ' ultrakil-change-me ' }, 'SEED_ADMIN_PASSWORD'],
    [{ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'owner@example.test', SEED_ADMIN_PASSWORD: '  ' }, 'SEED_ADMIN_PASSWORD'],
    [{ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'owner@example.test', SEED_ADMIN_PASSWORD: 'short-password' }, 'SEED_ADMIN_PASSWORD'],
    [{ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'owner@example.test', SEED_ADMIN_PASSWORD: 'ultrakil-change-me-but-longer' }, 'SEED_ADMIN_PASSWORD'],
    [{ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'owner@example.test', SEED_ADMIN_PASSWORD: 'replace-with-a-long-random-admin-password' }, 'SEED_ADMIN_PASSWORD'],
  ])('rejects missing or default production credentials', (env, expected) => {
    expect(() => assertProductionSeedCredentials(env)).toThrow(expected);
  });

  it('allows explicit production credentials and local development seeds', () => {
    expect(() => assertProductionSeedCredentials({ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'owner@example.test', SEED_ADMIN_PASSWORD: 'a-distinct-password-with-entropy' })).not.toThrow();
    expect(() => assertProductionSeedCredentials({ NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'admin@taskforceai.tech', SEED_ADMIN_PASSWORD: 'a-distinct-password-with-entropy' })).not.toThrow();
    expect(() => assertProductionSeedCredentials({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('leaves existing production accounts untouched without requiring seed credentials', async () => {
    const previous = process.env;
    process.env = { ...previous, NODE_ENV: 'production', SEED_ADMIN_EMAIL: '', SEED_ADMIN_PASSWORD: '' };
    const prisma = { user: { count: jest.fn().mockResolvedValue(1), create: jest.fn() } };
    try {
      await expect(seedAdminUser(prisma as unknown as PrismaClient)).resolves.toBeUndefined();
      expect(prisma.user.create).not.toHaveBeenCalled();
    } finally {
      process.env = previous;
    }
  });

  it('allows production reference re-import when users already exist', async () => {
    const previous = process.env;
    process.env = { ...previous, NODE_ENV: 'production', SEED_ADMIN_EMAIL: '', SEED_ADMIN_PASSWORD: '' };
    const prisma = { branch: { upsert: jest.fn() }, user: { count: jest.fn().mockResolvedValue(1), create: jest.fn() } };
    try {
      await expect(seedReferenceData(prisma as unknown as PrismaClient)).resolves.toBeUndefined();
      expect(prisma.branch.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.user.create).not.toHaveBeenCalled();
    } finally {
      process.env = previous;
    }
  });

  it('rejects default credentials before creating the first production account', async () => {
    const previous = process.env;
    process.env = { ...previous, NODE_ENV: 'production', SEED_ADMIN_EMAIL: 'admin@taskforceai.tech', SEED_ADMIN_PASSWORD: 'ultrakil-change-me' };
    const prisma = { user: { count: jest.fn().mockResolvedValue(0), create: jest.fn() } };
    try {
      await expect(seedAdminUser(prisma as unknown as PrismaClient)).rejects.toThrow('SEED_ADMIN_PASSWORD');
      expect(prisma.user.create).not.toHaveBeenCalled();
    } finally {
      process.env = previous;
    }
  });

  it('refuses demo data in production regardless of force or credentials', () => {
    expect(() => assertDemoSeedAllowed({ NODE_ENV: 'production' })).toThrow('DEMO_SEED_FORBIDDEN_IN_PRODUCTION');
  });
});
