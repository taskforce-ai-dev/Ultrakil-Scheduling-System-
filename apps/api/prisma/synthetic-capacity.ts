import {
  AgreementStatus,
  AssignmentStatus,
  BranchCode,
  DeploymentType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import { lockScheduleResources } from '../src/scheduling/optimizer/schedule-visit-lock';

export const SYNTHETIC_CAPACITY_MARKER = '__syntheticCapacity__';
export const SYNTHETIC_SOURCE_PREFIX = 'synthetic-capacity:';
export const SYNTHETIC_VEHICLE_PREFIX = 'SYN-TEST-';
export const SYNTHETIC_VISIBLE_PREFIX = 'SYNTHETIC/TEST ';

const MAX_SYNTHETIC_TEAMS = 50;
const LIVE_ASSIGNMENT_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.DRAFT,
  AssignmentStatus.PROPOSED,
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
];

export type SyntheticCapacityMode = 'dry-run' | 'apply' | 'deactivate';

export interface SyntheticCapacityArgs {
  branchCode: BranchCode;
  teams: number;
  mode: SyntheticCapacityMode;
}

export interface SyntheticEmployeeDefinition {
  sourceKey: string;
  employeeCode: string;
  fullName: string;
  gradeLabel: string;
  isPmsGrade: boolean;
  branchId: string;
  branchCode: BranchCode;
  teamNumber: number;
  memberNumber: number;
  skillCodes: string[];
  sourceRow: Record<string, string | number | boolean>;
}

export interface SyntheticVehicleDefinition {
  code: string;
  label: string;
  ownershipGroup: string;
  branchId: string;
  seatCapacity: number;
  teamNumber: number;
}

export interface SyntheticTeamDefinition {
  teamNumber: number;
  employees: SyntheticEmployeeDefinition[];
  vehicle: SyntheticVehicleDefinition;
  driverSourceKeys: string[];
}

export interface SyntheticCapacityPlan {
  branchId: string;
  branchCode: BranchCode;
  teamSize: number;
  skillCount: number;
  teams: SyntheticTeamDefinition[];
}

export interface SyntheticMutationCounts {
  created: number;
  reactivated: number;
  unchanged: number;
  blockedLive: number;
  deactivated: number;
}

export interface SyntheticCapacityResult {
  mode: SyntheticCapacityMode;
  teams: number;
  teamSize: number;
  skillCount: number;
  employees: SyntheticMutationCounts;
  vehicles: SyntheticMutationCounts;
}

export interface SyntheticCapacityHooks {
  /** Integration-test-only fault injection used to prove transaction rollback. */
  afterEmployeeWrites?: () => void | Promise<void>;
}

function refused(code: string): Error {
  return new Error(code);
}

export function assertSyntheticDatabaseUrl(
  value: string | undefined,
): { databaseName: string } {
  try {
    if (!value || /%(?:2f|5c)/i.test(value)) throw refused('unsafe');
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) {
      throw refused('unsafe');
    }
    const rawPath = url.pathname;
    if (!/^\/[^/]+$/.test(rawPath)) throw refused('unsafe');
    const databaseName = decodeURIComponent(rawPath.slice(1));
    if (
      !/^[A-Za-z0-9_-]+_(?:staging|test)$/.test(databaseName) ||
      databaseName.includes('/') ||
      databaseName.includes('\\')
    ) {
      throw refused('unsafe');
    }
    return { databaseName };
  } catch {
    // This generic code is intentionally the only observable error. Never put
    // the supplied URL, host, user or password in a refusal.
    throw refused('SYNTHETIC_DATABASE_REFUSED');
  }
}

export function parseSyntheticCapacityArgs(argv: string[]): SyntheticCapacityArgs {
  let branch: string | undefined;
  let teamsRaw: string | undefined;
  let apply = false;
  let deactivate = false;
  let confirmed = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--branch' && index + 1 < argv.length) branch = argv[++index];
    else if (argument === '--teams' && index + 1 < argv.length) teamsRaw = argv[++index];
    else if (argument === '--apply') apply = true;
    else if (argument === '--deactivate') deactivate = true;
    else if (argument === '--confirm-staging-synthetic-capacity') confirmed = true;
    else throw refused('SYNTHETIC_ARGUMENTS_REFUSED');
  }

  if (!branch) throw refused('SYNTHETIC_BRANCH_REQUIRED');
  if (!Object.values(BranchCode).includes(branch as BranchCode)) {
    throw refused('SYNTHETIC_ARGUMENTS_REFUSED');
  }
  if (apply && deactivate) throw refused('SYNTHETIC_ARGUMENTS_REFUSED');
  const mode: SyntheticCapacityMode = apply ? 'apply' : deactivate ? 'deactivate' : 'dry-run';
  if (mode !== 'deactivate') {
    const teams = Number(teamsRaw);
    if (!Number.isInteger(teams) || teams < 1 || teams > MAX_SYNTHETIC_TEAMS) {
      throw refused('SYNTHETIC_ARGUMENTS_REFUSED');
    }
    if (mode !== 'dry-run' && !confirmed) {
      throw refused('SYNTHETIC_CONFIRMATION_REQUIRED');
    }
    return { branchCode: branch as BranchCode, teams, mode };
  }
  if (teamsRaw !== undefined) throw refused('SYNTHETIC_ARGUMENTS_REFUSED');
  if (!confirmed) throw refused('SYNTHETIC_CONFIRMATION_REQUIRED');
  return { branchCode: branch as BranchCode, teams: 0, mode };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function buildSyntheticTeams(input: {
  branchId: string;
  branchCode: BranchCode;
  teams: number;
  maximumCrewSize: number;
  skillCodes: string[];
}): SyntheticTeamDefinition[] {
  const teamSize = Math.max(2, input.maximumCrewSize);
  const skillCodes = [...new Set(input.skillCodes.map((code) => code.trim()).filter(Boolean))]
    .sort();

  return Array.from({ length: input.teams }, (_, teamIndex) => {
    const teamNumber = teamIndex + 1;
    const employeePrefix = `${SYNTHETIC_SOURCE_PREFIX}${input.branchCode}:team:${pad(teamNumber)}`;
    const employees = Array.from({ length: teamSize }, (_unused, memberIndex) => {
      const memberNumber = memberIndex + 1;
      const sourceKey = `${employeePrefix}:employee:${pad(memberNumber)}`;
      const isPmsGrade = memberNumber === 1;
      return {
        sourceKey,
        employeeCode: `${SYNTHETIC_VEHICLE_PREFIX}${input.branchCode}-${pad(teamNumber)}-${pad(memberNumber)}`,
        fullName: `${SYNTHETIC_VISIBLE_PREFIX}${input.branchCode} Team ${pad(teamNumber)} Member ${pad(memberNumber)}`,
        gradeLabel: isPmsGrade ? 'SYNTHETIC/TEST PMS' : 'SYNTHETIC/TEST TECHNICIAN',
        isPmsGrade,
        branchId: input.branchId,
        branchCode: input.branchCode,
        teamNumber,
        memberNumber,
        // Giving every member the requirement union makes any compliant crew
        // subset safe while remaining visibly synthetic.
        skillCodes,
        sourceRow: {
          [SYNTHETIC_CAPACITY_MARKER]: true,
          branchId: input.branchId,
          branchCode: input.branchCode,
          teamNumber,
          memberNumber,
          sourceKey,
        },
      };
    });
    const vehicle: SyntheticVehicleDefinition = {
      code: `${SYNTHETIC_VEHICLE_PREFIX}${input.branchCode}-${pad(teamNumber)}`,
      label: `${SYNTHETIC_VISIBLE_PREFIX}${input.branchCode} Team ${pad(teamNumber)} Vehicle`,
      ownershipGroup: SYNTHETIC_CAPACITY_MARKER,
      branchId: input.branchId,
      seatCapacity: teamSize,
      teamNumber,
    };
    return {
      teamNumber,
      employees,
      vehicle,
      driverSourceKeys: employees.slice(0, 2).map(({ sourceKey }) => sourceKey),
    };
  });
}

function emptyCounts(): SyntheticMutationCounts {
  return { created: 0, reactivated: 0, unchanged: 0, blockedLive: 0, deactivated: 0 };
}

function syntheticMarkerMatches(
  sourceRow: Prisma.JsonValue | null,
  expected: SyntheticEmployeeDefinition,
): boolean {
  if (!sourceRow || Array.isArray(sourceRow) || typeof sourceRow !== 'object') return false;
  const marker = sourceRow as Record<string, Prisma.JsonValue>;
  const expectedKeys = [
    SYNTHETIC_CAPACITY_MARKER,
    'branchId',
    'branchCode',
    'teamNumber',
    'memberNumber',
    'sourceKey',
  ].sort();
  return JSON.stringify(Object.keys(marker).sort()) === JSON.stringify(expectedKeys) &&
    marker[SYNTHETIC_CAPACITY_MARKER] === true &&
    marker.branchId === expected.branchId &&
    marker.branchCode === expected.branchCode &&
    marker.teamNumber === expected.teamNumber &&
    marker.memberNumber === expected.memberNumber &&
    marker.sourceKey === expected.sourceKey;
}

function vehicleMarkerMatches(
  vehicle: { code: string; label: string; ownershipGroup: string | null; branchId: string | null },
  expected: SyntheticVehicleDefinition,
): boolean {
  return vehicle.code === expected.code &&
    vehicle.label === expected.label &&
    vehicle.ownershipGroup === expected.ownershipGroup &&
    vehicle.branchId === expected.branchId;
}

export function assertNoReservedSyntheticVehicles(
  vehicles: Array<{ code: string; label: string; ownershipGroup: string | null }>,
): void {
  if (vehicles.some((vehicle) =>
    vehicle.code.startsWith(SYNTHETIC_VEHICLE_PREFIX) ||
    vehicle.label.startsWith(SYNTHETIC_VISIBLE_PREFIX) ||
    vehicle.ownershipGroup === SYNTHETIC_CAPACITY_MARKER,
  )) {
    throw refused('MATRIX_RESERVED_SYNTHETIC_VEHICLE_IDENTITY');
  }
}

export async function verifyCurrentDatabase(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  expectedDatabaseName: string,
): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ database_name: string }>>(
    Prisma.sql`SELECT current_database() AS database_name`,
  );
  if (rows.length !== 1 || rows[0].database_name !== expectedDatabaseName) {
    throw refused('SYNTHETIC_DATABASE_MISMATCH');
  }
}

async function buildPlan(
  prisma: PrismaClient | Prisma.TransactionClient,
  branchCode: BranchCode,
  teams: number,
  asOf: Date,
): Promise<SyntheticCapacityPlan> {
  const branch = await prisma.branch.findUnique({ where: { code: branchCode } });
  if (!branch) throw refused('SYNTHETIC_BRANCH_NOT_FOUND');
  const agreements = await prisma.serviceAgreement.findMany({
    where: {
      branchId: branch.id,
      branchCode,
      status: AgreementStatus.ACTIVE,
      startDate: { lte: asOf },
      OR: [{ endDate: null }, { endDate: { gte: asOf } }],
      customer: { isActive: true },
      serviceSite: { isActive: true },
    },
    select: { crewSize: true, requiredSkills: { select: { skillCode: true } } },
  });
  const maximumCrewSize = agreements.reduce(
    (maximum, agreement) => Math.max(maximum, agreement.crewSize),
    2,
  );
  const skillCodes = agreements.flatMap((agreement) =>
    agreement.requiredSkills.map(({ skillCode }) => skillCode),
  );
  const builtTeams = buildSyntheticTeams({
    branchId: branch.id,
    branchCode,
    teams,
    maximumCrewSize,
    skillCodes,
  });
  return {
    branchId: branch.id,
    branchCode,
    teamSize: Math.max(2, maximumCrewSize),
    skillCount: new Set(skillCodes).size,
    teams: builtTeams,
  };
}

async function findSyntheticResources(
  tx: PrismaClient | Prisma.TransactionClient,
  branchId: string,
  branchCode: BranchCode,
) {
  const sourcePrefix = `${SYNTHETIC_SOURCE_PREFIX}${branchCode}:`;
  const resourcePrefix = `${SYNTHETIC_VEHICLE_PREFIX}${branchCode}-`;
  const [employees, vehicles] = await Promise.all([
    tx.employee.findMany({
      where: {
        OR: [
          { sourceKey: { startsWith: sourcePrefix } },
          { employeeCode: { startsWith: resourcePrefix } },
        ],
      },
      include: { skills: true },
      orderBy: { sourceKey: 'asc' },
    }),
    tx.vehicle.findMany({
      where: { code: { startsWith: resourcePrefix } },
      orderBy: { code: 'asc' },
    }),
  ]);
  return { employees, vehicles };
}

async function liveReferencedIds(
  tx: PrismaClient | Prisma.TransactionClient,
  employeeIds: string[],
  vehicleIds: string[],
  asOf: Date,
): Promise<{ employees: Set<string>; vehicles: Set<string> }> {
  if (employeeIds.length === 0 && vehicleIds.length === 0) {
    return { employees: new Set(), vehicles: new Set() };
  }
  const assignments = await tx.assignment.findMany({
    where: {
      status: { in: LIVE_ASSIGNMENT_STATUSES },
      plannedEnd: { gte: asOf },
      OR: [
        { crewMembers: { some: { employeeId: { in: employeeIds } } } },
        { vehicles: { some: { vehicleId: { in: vehicleIds } } } },
        { vehicles: { some: { driverEmployeeId: { in: employeeIds } } } },
      ],
    },
    select: {
      crewMembers: { select: { employeeId: true } },
      vehicles: { select: { vehicleId: true, driverEmployeeId: true } },
    },
  });
  const employees = new Set<string>();
  const vehicles = new Set<string>();
  for (const assignment of assignments) {
    for (const member of assignment.crewMembers) employees.add(member.employeeId);
    for (const vehicle of assignment.vehicles) {
      vehicles.add(vehicle.vehicleId);
      if (vehicle.driverEmployeeId) employees.add(vehicle.driverEmployeeId);
    }
  }
  return { employees, vehicles };
}

function teamNumberFromIdentity(value: string): number | null {
  const match = value.match(/:team:(\d+):employee:\d+$/) ??
    value.match(/^SYN-TEST-[A-Z]+-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function memberNumberFromSourceKey(value: string): number | null {
  const match = value.match(/:employee:(\d+)$/);
  return match ? Number(match[1]) : null;
}

function expectedExistingEmployee(
  employee: Awaited<ReturnType<typeof findSyntheticResources>>['employees'][number],
  plan: SyntheticCapacityPlan,
): SyntheticEmployeeDefinition {
  const teamNumber = teamNumberFromIdentity(employee.sourceKey) ?? -1;
  const memberNumber = memberNumberFromSourceKey(employee.sourceKey) ?? -1;
  return {
    sourceKey: employee.sourceKey,
    employeeCode: `${SYNTHETIC_VEHICLE_PREFIX}${plan.branchCode}-${pad(teamNumber)}-${pad(memberNumber)}`,
    fullName: employee.fullName,
    gradeLabel: employee.gradeLabel,
    isPmsGrade: employee.isPmsGrade,
    branchId: plan.branchId,
    branchCode: plan.branchCode,
    teamNumber,
    memberNumber,
    skillCodes: employee.skills.map(({ skillCode }) => skillCode),
    sourceRow: {},
  };
}

function assertSyntheticResourceIdentities(
  resources: Awaited<ReturnType<typeof findSyntheticResources>>,
  plan: SyntheticCapacityPlan,
  expectedEmployees: Map<string, SyntheticEmployeeDefinition>,
  expectedVehicles: Map<string, SyntheticVehicleDefinition>,
): void {
  for (const employee of resources.employees) {
    const expected = expectedEmployees.get(employee.sourceKey) ??
      expectedExistingEmployee(employee, plan);
    if (
      !syntheticMarkerMatches(employee.sourceRow, expected) ||
      employee.employeeCode !== expected.employeeCode ||
      employee.branchId !== plan.branchId
    ) {
      throw refused('SYNTHETIC_EMPLOYEE_IDENTITY_COLLISION');
    }
  }
  for (const vehicle of resources.vehicles) {
    const expected = expectedVehicles.get(vehicle.code) ?? {
      code: vehicle.code,
      label: `${SYNTHETIC_VISIBLE_PREFIX}${plan.branchCode} Team ${pad(teamNumberFromIdentity(vehicle.code) ?? -1)} Vehicle`,
      ownershipGroup: SYNTHETIC_CAPACITY_MARKER,
      branchId: plan.branchId,
      seatCapacity: vehicle.seatCapacity ?? 0,
      teamNumber: teamNumberFromIdentity(vehicle.code) ?? -1,
    };
    if (!vehicleMarkerMatches(vehicle, expected)) {
      throw refused('SYNTHETIC_VEHICLE_IDENTITY_COLLISION');
    }
  }
}

async function deactivateResources(
  tx: Prisma.TransactionClient,
  resources: Awaited<ReturnType<typeof findSyntheticResources>>,
  desiredEmployeeSourceKeys: Set<string>,
  desiredVehicleCodes: Set<string>,
  counts: { employees: SyntheticMutationCounts; vehicles: SyntheticMutationCounts },
  asOf: Date,
): Promise<void> {
  const employees = resources.employees.filter(
    ({ sourceKey }) => !desiredEmployeeSourceKeys.has(sourceKey),
  );
  const vehicles = resources.vehicles.filter(
    ({ code }) => !desiredVehicleCodes.has(code),
  );
  const references = await liveReferencedIds(
    tx,
    employees.map(({ id }) => id),
    vehicles.map(({ id }) => id),
    asOf,
  );
  const blockedTeams = new Set<number>();
  for (const employee of employees) {
    if (references.employees.has(employee.id)) {
      const team = teamNumberFromIdentity(employee.sourceKey);
      if (team) blockedTeams.add(team);
    }
  }
  for (const vehicle of vehicles) {
    if (references.vehicles.has(vehicle.id)) {
      const team = teamNumberFromIdentity(vehicle.code);
      if (team) blockedTeams.add(team);
    }
  }
  for (const employee of employees) {
    const team = teamNumberFromIdentity(employee.sourceKey);
    if (team && blockedTeams.has(team)) {
      counts.employees.blockedLive += 1;
    } else if (employee.isActive) {
      await tx.employee.update({ where: { id: employee.id }, data: { isActive: false } });
      counts.employees.deactivated += 1;
    } else counts.employees.unchanged += 1;
  }
  for (const vehicle of vehicles) {
    const team = teamNumberFromIdentity(vehicle.code);
    if (team && blockedTeams.has(team)) {
      counts.vehicles.blockedLive += 1;
    } else if (vehicle.isActive) {
      await tx.vehicle.update({ where: { id: vehicle.id }, data: { isActive: false } });
      counts.vehicles.deactivated += 1;
    } else counts.vehicles.unchanged += 1;
  }
}

async function mutateSyntheticCapacity(
  tx: Prisma.TransactionClient,
  plan: SyntheticCapacityPlan,
  mode: Exclude<SyntheticCapacityMode, 'dry-run'>,
  asOf: Date,
  hooks: SyntheticCapacityHooks,
): Promise<SyntheticCapacityResult> {
  const counts = { employees: emptyCounts(), vehicles: emptyCounts() };
  const resources = await findSyntheticResources(tx, plan.branchId, plan.branchCode);
  await lockScheduleResources(
    tx,
    resources.employees.map(({ id }) => id),
    resources.vehicles.map(({ id }) => id),
  );
  // Snapshot live references only after acquiring the same employee→vehicle
  // row locks used by assignment writers. Retained resources must not lose a
  // skill or seat that an already-live assignment still relies on merely
  // because the source agreement's future requirement became smaller.
  const liveReferences = await liveReferencedIds(
    tx,
    resources.employees.map(({ id }) => id),
    resources.vehicles.map(({ id }) => id),
    asOf,
  );

  const expectedEmployees = new Map(
    plan.teams.flatMap(({ employees }) => employees).map((row) => [row.sourceKey, row]),
  );
  const expectedVehicles = new Map(plan.teams.map(({ vehicle }) => [vehicle.code, vehicle]));
  assertSyntheticResourceIdentities(resources, plan, expectedEmployees, expectedVehicles);

  if (mode === 'deactivate') {
    await deactivateResources(tx, resources, new Set(), new Set(), counts, asOf);
  } else {
    const employeesBySource = new Map(resources.employees.map((row) => [row.sourceKey, row]));
    const vehiclesByCode = new Map(resources.vehicles.map((row) => [row.code, row]));
    const employeeIdsBySource = new Map<string, string>();

    for (const team of plan.teams) {
      for (const employee of team.employees) {
        const existing = employeesBySource.get(employee.sourceKey);
        const record = existing
          ? await tx.employee.update({
              where: { id: existing.id },
              data: {
                employeeCode: employee.employeeCode,
                fullName: employee.fullName,
                gradeLabel: employee.gradeLabel,
                isPmsGrade: employee.isPmsGrade,
                branchId: employee.branchId,
                branchCode: employee.branchCode,
                deploymentType: DeploymentType.MOBILE,
                canUsePublicTransport: false,
                permanentSiteLabel: null,
                isActive: true,
                sourceRow: employee.sourceRow,
              },
            })
          : await tx.employee.create({
              data: {
                sourceKey: employee.sourceKey,
                employeeCode: employee.employeeCode,
                fullName: employee.fullName,
                gradeLabel: employee.gradeLabel,
                isPmsGrade: employee.isPmsGrade,
                branchId: employee.branchId,
                branchCode: employee.branchCode,
                deploymentType: DeploymentType.MOBILE,
                canUsePublicTransport: false,
                isActive: true,
                sourceRow: employee.sourceRow,
              },
            });
        employeeIdsBySource.set(employee.sourceKey, record.id);
        if (!existing) counts.employees.created += 1;
        else if (!existing.isActive) counts.employees.reactivated += 1;
        else counts.employees.unchanged += 1;

        if (!liveReferences.employees.has(record.id)) {
          await tx.employeeSkill.deleteMany({
            where: { employeeId: record.id, skillCode: { notIn: employee.skillCodes.length ? employee.skillCodes : ['__none__'] } },
          });
        }
        for (const skillCode of employee.skillCodes) {
          await tx.employeeSkill.upsert({
            where: { employeeId_skillCode: { employeeId: record.id, skillCode } },
            create: { employeeId: record.id, skillCode, skillLabel: `SYNTHETIC/TEST ${skillCode}` },
            update: { skillLabel: `SYNTHETIC/TEST ${skillCode}` },
          });
        }
      }
    }
    await hooks.afterEmployeeWrites?.();

    for (const team of plan.teams) {
      const existing = vehiclesByCode.get(team.vehicle.code);
      const vehicle = existing
        ? await tx.vehicle.update({
            where: { id: existing.id },
            data: {
              label: team.vehicle.label,
              branchId: team.vehicle.branchId,
              seatCapacity: liveReferences.vehicles.has(existing.id)
                ? Math.max(existing.seatCapacity ?? 0, team.vehicle.seatCapacity)
                : team.vehicle.seatCapacity,
              ownershipGroup: team.vehicle.ownershipGroup,
              isActive: true,
            },
          })
        : await tx.vehicle.create({
            data: {
              code: team.vehicle.code,
              label: team.vehicle.label,
              branchId: team.vehicle.branchId,
              seatCapacity: team.vehicle.seatCapacity,
              ownershipGroup: team.vehicle.ownershipGroup,
              isActive: true,
            },
          });
      if (!existing) counts.vehicles.created += 1;
      else if (!existing.isActive) counts.vehicles.reactivated += 1;
      else counts.vehicles.unchanged += 1;
      for (const sourceKey of team.driverSourceKeys) {
        const employeeId = employeeIdsBySource.get(sourceKey);
        if (!employeeId) throw refused('SYNTHETIC_DRIVER_MISSING');
        await tx.vehicleAuthorization.upsert({
          where: { employeeId_vehicleId: { employeeId, vehicleId: vehicle.id } },
          create: { employeeId, vehicleId: vehicle.id },
          update: {},
        });
      }
    }
    await deactivateResources(
      tx,
      resources,
      new Set(expectedEmployees.keys()),
      new Set(expectedVehicles.keys()),
      counts,
      asOf,
    );
  }
  return {
    mode,
    teams: plan.teams.length,
    teamSize: plan.teamSize,
    skillCount: plan.skillCount,
    ...counts,
  };
}

export async function executeSyntheticCapacity(
  prisma: PrismaClient,
  args: SyntheticCapacityArgs,
  options: { asOf?: Date; hooks?: SyntheticCapacityHooks } = {},
): Promise<SyntheticCapacityResult> {
  const asOf = options.asOf ?? new Date();
  const plan = await buildPlan(prisma, args.branchCode, args.teams, asOf);
  if (args.mode === 'dry-run') {
    return {
      mode: args.mode,
      teams: plan.teams.length,
      teamSize: plan.teamSize,
      skillCount: plan.skillCount,
      employees: { ...emptyCounts(), created: plan.teams.length * plan.teamSize },
      vehicles: { ...emptyCounts(), created: plan.teams.length },
    };
  }
  const mode = args.mode;
  return prisma.$transaction(
    (tx) => mutateSyntheticCapacity(tx, plan, mode, asOf, options.hooks ?? {}),
    { timeout: 60_000 },
  );
}
