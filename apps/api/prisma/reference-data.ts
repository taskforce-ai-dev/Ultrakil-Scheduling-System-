import { BranchCode, PrismaClient, UserRole } from '@prisma/client';
import { AuthService } from '../src/auth/auth.service';

type Log = (message: string) => void;
const silent: Log = () => undefined;

export async function seedBranches(prisma: PrismaClient, log: Log = silent): Promise<void> {
  for (const [code, name] of [[BranchCode.COLOMBO, 'Colombo Branch'], [BranchCode.KANDY, 'Kandy Branch']] as const) {
    await prisma.branch.upsert({ where: { code }, create: { code, name }, update: { name } });
  }
  log(`Branches ready: ${Object.values(BranchCode).join(', ')}`);
}

/** Re-import never resets credentials, recreates a deleted user or changes roles. */
export async function seedAdminUser(prisma: PrismaClient, log: Log = silent): Promise<void> {
  const existing = await prisma.user.count();
  if (existing > 0) {
    log(`Users already exist (${existing}) — leaving accounts untouched.`);
    return;
  }
  const email = (process.env.SEED_ADMIN_EMAIL ?? 'admin@taskforceai.tech').trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? 'ultrakil-change-me';
  await prisma.user.create({ data: {
    email, fullName: process.env.SEED_ADMIN_NAME ?? 'UltraKIL Administrator', role: UserRole.ADMIN,
    passwordHash: await AuthService.hashPassword(password),
  } });
  log(`Created the first admin account: ${email}`);
  if (password === 'ultrakil-change-me') log('  WARNING: this is the default password. Change SEED_ADMIN_PASSWORD.');
}

export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
  await seedBranches(prisma);
  await seedAdminUser(prisma);
}
