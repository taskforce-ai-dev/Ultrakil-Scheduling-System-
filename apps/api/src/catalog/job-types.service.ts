import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { toJobTypeDto } from './catalog.mapper';
import { CreateJobTypeDto, UpdateJobTypeDto } from './dto/agreement.dto';
import { JobTypeQueryDto } from './dto/query.dto';

@Injectable()
export class JobTypesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: JobTypeQueryDto) {
    const where: Prisma.JobTypeWhereInput =
      query.active === undefined ? { isActive: true } : { isActive: query.active };

    const jobTypes = await this.prisma.jobType.findMany({
      where,
      orderBy: { name: 'asc' },
    });

    return jobTypes.map(toJobTypeDto);
  }

  async get(id: string) {
    return toJobTypeDto(await this.load(id));
  }

  async create(dto: CreateJobTypeDto, actor: AuthenticatedUser) {
    const code = normaliseCode(dto.code);
    await this.assertCodeFree(code, null);

    const created = await this.prisma.$transaction(async (tx) => {
      const jobType = await tx.jobType.create({
        data: {
          code,
          name: dto.name.trim(),
          ...(dto.defaultDurationMinutes !== undefined
            ? { defaultDurationMinutes: dto.defaultDurationMinutes }
            : {}),
          ...(dto.defaultCrewSize !== undefined
            ? { defaultCrewSize: dto.defaultCrewSize }
            : {}),
          ...(dto.requiresPmsSupervisor !== undefined
            ? { requiresPmsSupervisor: dto.requiresPmsSupervisor }
            : {}),
          requiredSkillCode: dto.requiredSkillCode?.trim().toUpperCase() || null,
        },
      });

      await this.audit.record(
        {
          entityType: 'JobType',
          entityId: jobType.id,
          action: 'job_type.created',
          actor,
          after: jobType,
        },
        tx,
      );

      return jobType;
    });

    return toJobTypeDto(created);
  }

  async update(id: string, dto: UpdateJobTypeDto, actor: AuthenticatedUser) {
    const before = await this.load(id);
    const code = dto.code === undefined ? undefined : normaliseCode(dto.code);
    if (code !== undefined) await this.assertCodeFree(code, id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const jobType = await tx.jobType.update({
        where: { id },
        data: {
          ...(code !== undefined ? { code } : {}),
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.defaultDurationMinutes !== undefined
            ? { defaultDurationMinutes: dto.defaultDurationMinutes }
            : {}),
          ...(dto.defaultCrewSize !== undefined
            ? { defaultCrewSize: dto.defaultCrewSize }
            : {}),
          ...(dto.requiresPmsSupervisor !== undefined
            ? { requiresPmsSupervisor: dto.requiresPmsSupervisor }
            : {}),
          ...(dto.requiredSkillCode !== undefined
            ? { requiredSkillCode: dto.requiredSkillCode?.trim().toUpperCase() || null }
            : {}),
        },
      });

      await this.audit.record(
        {
          entityType: 'JobType',
          entityId: id,
          action: 'job_type.updated',
          actor,
          before,
          after: jobType,
        },
        tx,
      );

      return jobType;
    });

    return toJobTypeDto(updated);
  }

  /** Deactivated, never deleted — agreements still point at it. */
  async setActive(id: string, isActive: boolean, actor: AuthenticatedUser) {
    const before = await this.load(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const jobType = await tx.jobType.update({ where: { id }, data: { isActive } });

      await this.audit.record(
        {
          entityType: 'JobType',
          entityId: id,
          action: isActive ? 'job_type.reactivated' : 'job_type.deactivated',
          actor,
          before,
          after: jobType,
        },
        tx,
      );

      return jobType;
    });

    return toJobTypeDto(updated);
  }

  private async load(id: string) {
    const jobType = await this.prisma.jobType.findUnique({ where: { id } });

    if (!jobType) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Job type "${id}" was not found. Refresh the list — it may have been removed.`,
        HttpStatus.NOT_FOUND,
        { jobTypeId: id },
      );
    }

    return jobType;
  }

  private async assertCodeFree(code: string, exceptId: string | null): Promise<void> {
    const existing = await this.prisma.jobType.findUnique({
      where: { code },
      select: { id: true, name: true },
    });

    if (existing && existing.id !== exceptId) {
      throw new AppException(
        'JOB_TYPE_CODE_TAKEN',
        `Job type code "${code}" already belongs to ${existing.name}. Codes identify one job type, so pick another.`,
        HttpStatus.CONFLICT,
        { code, existingJobTypeId: existing.id },
      );
    }
  }
}

/** Codes are matched, not displayed — normalise so casing never splits one. */
function normaliseCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]+/g, '_');
}
