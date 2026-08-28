import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AgreementStatus,
  DayRuleKind,
  Prisma,
  Weekday,
} from '@prisma/client';

import { AuditService, PrismaLike } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  AgreementWithRelations,
  sortWeekdays,
  toAgreementDto,
} from './catalog.mapper';
import {
  ChangeAgreementStatusDto,
  CreateServiceAgreementDto,
  UpdateServiceAgreementDto,
} from './dto/agreement.dto';
import {
  SchedulePreviewQueryDto,
  ServiceAgreementQueryDto,
} from './dto/query.dto';
import {
  SchedulePreview,
  computeSchedulePreview,
  parseDateOnly,
} from './schedule-preview';

const AGREEMENT_INCLUDE = {
  customer: { select: { id: true, name: true } },
  serviceSite: { select: { id: true, name: true } },
  jobType: { select: { id: true, name: true } },
  dayRules: true,
  requiredSkills: true,
} satisfies Prisma.ServiceAgreementInclude;

@Injectable()
export class AgreementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: ServiceAgreementQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    const where: Prisma.ServiceAgreementWhereInput = {
      // Archived agreements are kept so past visits stay explainable, but they
      // are not what a manager is looking at day to day.
      ...(query.status
        ? { status: query.status }
        : { status: { in: [AgreementStatus.ACTIVE, AgreementStatus.PAUSED] } }),
      ...(query.branch ? { branchCode: query.branch } : {}),
      ...(query.customerId ? { customerId: query.customerId } : {}),
      ...(query.serviceSiteId ? { serviceSiteId: query.serviceSiteId } : {}),
      ...(query.jobTypeId ? { jobTypeId: query.jobTypeId } : {}),
      ...(query.frequencyUnit ? { frequencyUnit: query.frequencyUnit } : {}),
      ...(query.activeOn
        ? {
            startDate: { lte: parseDateOnly(query.activeOn) },
            OR: [{ endDate: null }, { endDate: { gte: parseDateOnly(query.activeOn) } }],
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { customer: { name: { contains: query.search, mode: 'insensitive' } } },
              { serviceSite: { name: { contains: query.search, mode: 'insensitive' } } },
              { jobType: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.serviceAgreement.count({ where }),
      this.prisma.serviceAgreement.findMany({
        where,
        include: AGREEMENT_INCLUDE,
        orderBy: [{ startDate: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: items.map((agreement) =>
        toAgreementDto(agreement as AgreementWithRelations),
      ),
      total,
      page,
      pageSize,
    };
  }

  async get(id: string) {
    return toAgreementDto(await this.load(id));
  }

  async create(dto: CreateServiceAgreementDto, actor: AuthenticatedUser) {
    const site = await this.loadSiteForAgreement(dto.serviceSiteId);
    const jobType = await this.loadJobType(dto.jobTypeId);

    const allowedDays = sortWeekdays(dto.allowedDays);
    const preferredDays = sortWeekdays(dto.preferredDays ?? []);
    assertDayRules(allowedDays, preferredDays);

    const crewSize = dto.crewSize ?? jobType.defaultCrewSize;
    const durationMinutes = dto.durationMinutes ?? jobType.defaultDurationMinutes;

    assertServiceWindow(dto.serviceWindowStartMinute, dto.serviceWindowEndMinute);
    assertDateRange(dto.startDate, dto.endDate ?? null);

    // Refuse an agreement that could never produce its first visit. Catching it
    // here beats discovering it in ULK-C04, where the only options left are a
    // silently short schedule or an unexplained gap.
    this.assertSatisfiable({
      allowedDays,
      preferredDays,
      frequencyCount: dto.frequencyCount,
      frequencyUnit: dto.frequencyUnit,
      startDate: dto.startDate,
      endDate: dto.endDate ?? null,
      durationMinutes,
      site,
      serviceWindowStartMinute: dto.serviceWindowStartMinute ?? null,
      serviceWindowEndMinute: dto.serviceWindowEndMinute ?? null,
    });

    const created = await this.prisma.$transaction(async (tx) => {
      const agreement = await tx.serviceAgreement.create({
        data: {
          customerId: site.customerId,
          serviceSiteId: site.id,
          jobTypeId: jobType.id,
          branchId: site.branchId,
          branchCode: site.branchCode,
          frequencyCount: dto.frequencyCount,
          frequencyUnit: dto.frequencyUnit,
          crewSize,
          durationMinutes,
          serviceWindowStartMinute: dto.serviceWindowStartMinute ?? null,
          serviceWindowEndMinute: dto.serviceWindowEndMinute ?? null,
          startDate: parseDateOnly(dto.startDate),
          endDate: dto.endDate ? parseDateOnly(dto.endDate) : null,
          notes: dto.notes?.trim() || null,
          dayRules: { create: toDayRuleRows(allowedDays, preferredDays) },
          requiredSkills: {
            create: (dto.requiredSkillCodes ?? []).map((skillCode) => ({
              skillCode: skillCode.trim().toUpperCase(),
            })),
          },
        },
        include: AGREEMENT_INCLUDE,
      });

      await this.writeVersion(tx, agreement as AgreementWithRelations, actor, 'Created');

      await this.audit.record(
        {
          entityType: 'ServiceAgreement',
          entityId: agreement.id,
          action: 'service_agreement.created',
          actor,
          after: agreement,
        },
        tx,
      );

      return agreement;
    });

    return toAgreementDto(created as AgreementWithRelations);
  }

  async update(
    id: string,
    dto: UpdateServiceAgreementDto,
    actor: AuthenticatedUser,
  ) {
    const before = await this.load(id);

    if (before.status === AgreementStatus.ARCHIVED) {
      throw new AppException(
        'AGREEMENT_ARCHIVED',
        'This agreement is archived and cannot be edited. Past visits reference it as it stands. Create a new agreement instead.',
        HttpStatus.CONFLICT,
        { serviceAgreementId: id },
      );
    }

    const site = dto.serviceSiteId
      ? await this.loadSiteForAgreement(dto.serviceSiteId)
      : await this.loadSiteForAgreement(before.serviceSiteId);
    const jobType = dto.jobTypeId
      ? await this.loadJobType(dto.jobTypeId)
      : await this.loadJobType(before.jobTypeId);

    const allowedDays = dto.allowedDays
      ? sortWeekdays(dto.allowedDays)
      : sortWeekdays(
          before.dayRules
            .filter((rule) => rule.kind === DayRuleKind.ALLOWED)
            .map((rule) => rule.weekday),
        );
    const preferredDays = dto.preferredDays
      ? sortWeekdays(dto.preferredDays)
      : sortWeekdays(
          before.dayRules
            .filter((rule) => rule.kind === DayRuleKind.PREFERRED)
            .map((rule) => rule.weekday),
        );
    assertDayRules(allowedDays, preferredDays);

    const startMinute =
      dto.serviceWindowStartMinute !== undefined
        ? dto.serviceWindowStartMinute
        : before.serviceWindowStartMinute;
    const endMinute =
      dto.serviceWindowEndMinute !== undefined
        ? dto.serviceWindowEndMinute
        : before.serviceWindowEndMinute;
    assertServiceWindow(startMinute, endMinute);

    const startDate = dto.startDate ?? toDateOnly(before.startDate);
    const endDate =
      dto.endDate !== undefined
        ? dto.endDate
        : before.endDate
          ? toDateOnly(before.endDate)
          : null;
    assertDateRange(startDate, endDate);

    const crewSize = dto.crewSize ?? before.crewSize;
    const durationMinutes = dto.durationMinutes ?? before.durationMinutes;

    this.assertSatisfiable({
      allowedDays,
      preferredDays,
      frequencyCount: dto.frequencyCount ?? before.frequencyCount,
      frequencyUnit: dto.frequencyUnit ?? before.frequencyUnit,
      startDate,
      endDate,
      durationMinutes,
      site,
      serviceWindowStartMinute: startMinute,
      serviceWindowEndMinute: endMinute,
    });

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.allowedDays || dto.preferredDays) {
        await tx.serviceAgreementDayRule.deleteMany({
          where: { serviceAgreementId: id },
        });
      }
      if (dto.requiredSkillCodes) {
        await tx.serviceAgreementRequiredSkill.deleteMany({
          where: { serviceAgreementId: id },
        });
      }

      const agreement = await tx.serviceAgreement.update({
        where: { id },
        data: {
          ...(dto.serviceSiteId
            ? {
                serviceSiteId: site.id,
                customerId: site.customerId,
                branchId: site.branchId,
                branchCode: site.branchCode,
              }
            : {}),
          ...(dto.jobTypeId ? { jobTypeId: jobType.id } : {}),
          ...(dto.frequencyCount !== undefined
            ? { frequencyCount: dto.frequencyCount }
            : {}),
          ...(dto.frequencyUnit ? { frequencyUnit: dto.frequencyUnit } : {}),
          crewSize,
          durationMinutes,
          serviceWindowStartMinute: startMinute,
          serviceWindowEndMinute: endMinute,
          startDate: parseDateOnly(startDate),
          endDate: endDate ? parseDateOnly(endDate) : null,
          ...(dto.notes !== undefined ? { notes: dto.notes?.trim() || null } : {}),
          currentVersion: { increment: 1 },
          ...(dto.allowedDays || dto.preferredDays
            ? { dayRules: { create: toDayRuleRows(allowedDays, preferredDays) } }
            : {}),
          ...(dto.requiredSkillCodes
            ? {
                requiredSkills: {
                  create: dto.requiredSkillCodes.map((skillCode) => ({
                    skillCode: skillCode.trim().toUpperCase(),
                  })),
                },
              }
            : {}),
        },
        include: AGREEMENT_INCLUDE,
      });

      await this.writeVersion(tx, agreement as AgreementWithRelations, actor, 'Updated');

      await this.audit.record(
        {
          entityType: 'ServiceAgreement',
          entityId: id,
          action: 'service_agreement.updated',
          actor,
          before,
          after: agreement,
        },
        tx,
      );

      return agreement;
    });

    return toAgreementDto(updated as AgreementWithRelations);
  }

  /**
   * Moves an agreement through its lifecycle.
   *
   * Archiving is one-way. An archived agreement is the historical record that
   * explains visits already generated from it, so letting it come back to life
   * and change would make those visits unexplainable.
   */
  async changeStatus(
    id: string,
    dto: ChangeAgreementStatusDto,
    actor: AuthenticatedUser,
  ) {
    const before = await this.load(id);

    if (
      before.status === AgreementStatus.ARCHIVED &&
      dto.status !== AgreementStatus.ARCHIVED
    ) {
      throw new AppException(
        'AGREEMENT_ARCHIVED',
        'This agreement is archived. Archiving is final, because past visits are explained by it. Create a new agreement instead of reviving this one.',
        HttpStatus.CONFLICT,
        { serviceAgreementId: id, requestedStatus: dto.status },
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const agreement = await tx.serviceAgreement.update({
        where: { id },
        data: {
          status: dto.status,
          ...(before.status === dto.status ? {} : { currentVersion: { increment: 1 } }),
        },
        include: AGREEMENT_INCLUDE,
      });

      if (before.status !== dto.status) {
        await this.writeVersion(
          tx,
          agreement as AgreementWithRelations,
          actor,
          dto.reason?.trim() || `Status changed to ${dto.status}`,
        );
      }

      await this.audit.record(
        {
          entityType: 'ServiceAgreement',
          entityId: id,
          action: `service_agreement.${dto.status.toLowerCase()}`,
          actor,
          before,
          after: agreement,
        },
        tx,
      );

      return agreement;
    });

    return toAgreementDto(updated as AgreementWithRelations);
  }

  async listVersions(id: string) {
    await this.load(id);

    const versions = await this.prisma.serviceAgreementVersion.findMany({
      where: { serviceAgreementId: id },
      orderBy: { versionNumber: 'desc' },
    });

    return versions.map((version) => ({
      id: version.id,
      versionNumber: version.versionNumber,
      changedByLabel: version.changedByLabel,
      changeSummary: version.changeSummary,
      snapshot: version.snapshot as Record<string, unknown>,
      createdAt: version.createdAt.toISOString(),
    }));
  }

  /** What this agreement asks for, and anything it cannot deliver. */
  async preview(id: string, query: SchedulePreviewQueryDto): Promise<SchedulePreview> {
    const agreement = await this.load(id);
    const site = await this.loadSiteForAgreement(agreement.serviceSiteId);

    return computeSchedulePreview({
      frequencyCount: agreement.frequencyCount,
      frequencyUnit: agreement.frequencyUnit,
      allowedDays: agreement.dayRules
        .filter((rule) => rule.kind === DayRuleKind.ALLOWED)
        .map((rule) => rule.weekday),
      preferredDays: agreement.dayRules
        .filter((rule) => rule.kind === DayRuleKind.PREFERRED)
        .map((rule) => rule.weekday),
      startDate: toDateOnly(agreement.startDate),
      endDate: agreement.endDate ? toDateOnly(agreement.endDate) : null,
      siteWindows: site.operatingHours.map((hours) => ({
        weekday: hours.weekday,
        startMinute: hours.opensAtMinute,
        endMinute: hours.closesAtMinute,
      })),
      agreementWindowStartMinute: agreement.serviceWindowStartMinute,
      agreementWindowEndMinute: agreement.serviceWindowEndMinute,
      durationMinutes: agreement.durationMinutes,
      horizonWeeks: query.horizonWeeks,
      from: query.from,
    });
  }

  // --- Internals -----------------------------------------------------------

  private assertSatisfiable(input: {
    allowedDays: Weekday[];
    preferredDays: Weekday[];
    frequencyCount: number;
    frequencyUnit: Prisma.ServiceAgreementCreateInput['frequencyUnit'];
    startDate: string;
    endDate: string | null;
    durationMinutes: number;
    site: { operatingHours: { weekday: Weekday; opensAtMinute: number; closesAtMinute: number }[] };
    serviceWindowStartMinute: number | null;
    serviceWindowEndMinute: number | null;
  }): void {
    const preview = computeSchedulePreview({
      frequencyCount: input.frequencyCount,
      frequencyUnit: input.frequencyUnit,
      allowedDays: input.allowedDays,
      preferredDays: input.preferredDays,
      startDate: input.startDate,
      endDate: input.endDate,
      siteWindows: input.site.operatingHours.map((hours) => ({
        weekday: hours.weekday,
        startMinute: hours.opensAtMinute,
        endMinute: hours.closesAtMinute,
      })),
      agreementWindowStartMinute: input.serviceWindowStartMinute,
      agreementWindowEndMinute: input.serviceWindowEndMinute,
      durationMinutes: input.durationMinutes,
      horizonWeeks: 4,
    });

    if (preview.visits.length > 0) return;

    const shortfall = preview.shortfalls[0];
    throw new AppException(
      'AGREEMENT_UNSATISFIABLE',
      shortfall?.message ??
        'This agreement cannot produce a single visit in the four weeks after it starts. Check the allowed days against the site opening hours.',
      HttpStatus.UNPROCESSABLE_ENTITY,
      {
        reason: shortfall?.reason ?? 'NOT_ENOUGH_ALLOWED_DAYS',
        shortfalls: preview.shortfalls,
      },
    );
  }

  private async writeVersion(
    tx: PrismaLike,
    agreement: AgreementWithRelations,
    actor: AuthenticatedUser,
    changeSummary: string,
  ): Promise<void> {
    await tx.serviceAgreementVersion.create({
      data: {
        serviceAgreementId: agreement.id,
        versionNumber: agreement.currentVersion,
        changedByUserId: actor?.id ?? null,
        changedByLabel: actor ? `${actor.fullName} <${actor.email}>` : null,
        changeSummary,
        snapshot: toSnapshot(agreement),
      },
    });
  }

  private async load(id: string): Promise<AgreementWithRelations> {
    const agreement = await this.prisma.serviceAgreement.findUnique({
      where: { id },
      include: AGREEMENT_INCLUDE,
    });

    if (!agreement) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Service agreement "${id}" was not found. Refresh the list — it may have been removed.`,
        HttpStatus.NOT_FOUND,
        { serviceAgreementId: id },
      );
    }

    return agreement as AgreementWithRelations;
  }

  private async loadSiteForAgreement(siteId: string) {
    const site = await this.prisma.serviceSite.findUnique({
      where: { id: siteId },
      include: { operatingHours: true, customer: { select: { name: true, isActive: true } } },
    });

    if (!site) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Service site "${siteId}" was not found. Refresh the list — it may have been removed.`,
        HttpStatus.NOT_FOUND,
        { serviceSiteId: siteId },
      );
    }

    if (!site.isActive) {
      throw new AppException(
        'SITE_INACTIVE',
        `${site.name} is deactivated, so no agreement can be written against it. Reactivate the site first.`,
        HttpStatus.CONFLICT,
        { serviceSiteId: siteId },
      );
    }

    return site;
  }

  private async loadJobType(jobTypeId: string) {
    const jobType = await this.prisma.jobType.findUnique({ where: { id: jobTypeId } });

    if (!jobType) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Job type "${jobTypeId}" was not found. Refresh the list — it may have been removed.`,
        HttpStatus.NOT_FOUND,
        { jobTypeId },
      );
    }

    if (!jobType.isActive) {
      throw new AppException(
        'JOB_TYPE_INACTIVE',
        `Job type "${jobType.name}" is deactivated, so no new agreement can use it. Reactivate it, or pick another.`,
        HttpStatus.CONFLICT,
        { jobTypeId },
      );
    }

    return jobType;
  }
}

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function toDayRuleRows(
  allowedDays: Weekday[],
  preferredDays: Weekday[],
): { weekday: Weekday; kind: DayRuleKind }[] {
  return [
    ...allowedDays.map((weekday) => ({ weekday, kind: DayRuleKind.ALLOWED })),
    ...preferredDays.map((weekday) => ({ weekday, kind: DayRuleKind.PREFERRED })),
  ];
}

/** The scheduling-relevant shape of an agreement, frozen for one version. */
function toSnapshot(agreement: AgreementWithRelations): Prisma.InputJsonValue {
  return {
    serviceSiteId: agreement.serviceSiteId,
    jobTypeId: agreement.jobTypeId,
    branchCode: agreement.branchCode,
    frequencyCount: agreement.frequencyCount,
    frequencyUnit: agreement.frequencyUnit,
    crewSize: agreement.crewSize,
    durationMinutes: agreement.durationMinutes,
    serviceWindowStartMinute: agreement.serviceWindowStartMinute,
    serviceWindowEndMinute: agreement.serviceWindowEndMinute,
    startDate: toDateOnly(agreement.startDate),
    endDate: agreement.endDate ? toDateOnly(agreement.endDate) : null,
    status: agreement.status,
    allowedDays: agreement.dayRules
      .filter((rule) => rule.kind === DayRuleKind.ALLOWED)
      .map((rule) => rule.weekday),
    preferredDays: agreement.dayRules
      .filter((rule) => rule.kind === DayRuleKind.PREFERRED)
      .map((rule) => rule.weekday),
    requiredSkillCodes: agreement.requiredSkills.map((skill) => skill.skillCode),
  };
}

/**
 * Preferred days must be a subset of allowed days.
 *
 * A preferred day outside the allowed set is not a harmless contradiction: the
 * scheduler would rank a day it is forbidden to use, so the preference would
 * silently do nothing and the manager would never learn why.
 */
export function assertDayRules(
  allowedDays: Weekday[],
  preferredDays: Weekday[],
): void {
  if (allowedDays.length === 0) {
    throw new AppException(
      'ALLOWED_DAYS_REQUIRED',
      'Choose at least one allowed weekday. Without one there is no day a visit could ever be placed on.',
      HttpStatus.BAD_REQUEST,
    );
  }

  const allowed = new Set(allowedDays);
  const strays = preferredDays.filter((day) => !allowed.has(day));

  if (strays.length > 0) {
    throw new AppException(
      'PREFERRED_DAYS_NOT_ALLOWED',
      `${strays.join(', ')} ${strays.length === 1 ? 'is a preferred day but not' : 'are preferred days but not'} an allowed day. Preferred days rank the days you already allow — add ${strays.length === 1 ? 'it' : 'them'} to the allowed days, or remove the preference.`,
      HttpStatus.BAD_REQUEST,
      { strays, allowedDays },
    );
  }
}

export function assertServiceWindow(
  startMinute: number | null | undefined,
  endMinute: number | null | undefined,
): void {
  if (startMinute == null || endMinute == null) return;

  if (endMinute <= startMinute) {
    throw new AppException(
      'SERVICE_WINDOW_INVALID',
      `The service window ends at ${formatMinute(endMinute)}, which is not after it starts at ${formatMinute(startMinute)}. A window must end after it starts.`,
      HttpStatus.BAD_REQUEST,
      { startMinute, endMinute },
    );
  }
}

export function assertDateRange(startDate: string, endDate: string | null): void {
  if (!endDate) return;

  if (endDate < startDate) {
    throw new AppException(
      'AGREEMENT_DATES_INVALID',
      `The agreement ends on ${endDate}, before it starts on ${startDate}. Check the dates.`,
      HttpStatus.BAD_REQUEST,
      { startDate, endDate },
    );
  }
}

function formatMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  const rest = minute % 60;
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
