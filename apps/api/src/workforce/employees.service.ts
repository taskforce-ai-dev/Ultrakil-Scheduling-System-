import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import {
  AvailabilityKind,
  BranchCode,
  DeploymentType,
  Prisma,
} from '@prisma/client';
import { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { isPmsGradeLabel } from './pms-grade';
import { buildSourceKey } from './matrix-import/parser';
import {
  CreateAvailabilityDto,
  CreateEmployeeDto,
  SkillAssignmentDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';
import { EmployeeQueryDto } from './dto/query.dto';

/** Everything a manager needs about one employee, in one round trip. */
const EMPLOYEE_INCLUDE = {
  branch: { select: { id: true, code: true, name: true } },
  skills: { orderBy: { skillCode: 'asc' } },
  availability: { orderBy: { startDate: 'asc' } },
  vehicleAuthorizations: {
    include: {
      vehicle: {
        select: { id: true, code: true, label: true, seatCapacity: true, isActive: true },
      },
    },
  },
} satisfies Prisma.EmployeeInclude;

@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(query: EmployeeQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    const where: Prisma.EmployeeWhereInput = {
      ...(query.active === undefined ? { isActive: true } : { isActive: query.active }),
      ...(query.branch ? { branchCode: query.branch } : {}),
      ...(query.pmsGrade === undefined ? {} : { isPmsGrade: query.pmsGrade }),
      ...(query.deployment ? { deploymentType: query.deployment } : {}),
      ...(query.canUsePublicTransport === undefined
        ? {}
        : { canUsePublicTransport: query.canUsePublicTransport }),
      ...(query.skill ? { skills: { some: { skillCode: query.skill } } } : {}),
      ...(query.vehicleId
        ? { vehicleAuthorizations: { some: { vehicleId: query.vehicleId } } }
        : {}),
      ...(query.search
        ? {
            OR: [
              { fullName: { contains: query.search, mode: 'insensitive' } },
              { gradeLabel: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      // Available on a date means: no recorded absence covering it. Staff are
      // available by default, so this is an absence of absences.
      ...(query.availableOn
        ? {
            availability: {
              none: {
                startDate: { lte: new Date(query.availableOn) },
                endDate: { gte: new Date(query.availableOn) },
              },
            },
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.employee.count({ where }),
      this.prisma.employee.findMany({
        where,
        include: EMPLOYEE_INCLUDE,
        orderBy: [{ branchCode: 'asc' }, { fullName: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items, total, page, pageSize };
  }

  async findOne(id: string) {
    const employee = await this.prisma.employee.findUnique({
      where: { id },
      include: EMPLOYEE_INCLUDE,
    });
    if (!employee) throw notFound('Employee', id);
    return employee;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async create(dto: CreateEmployeeDto, actor: AuthenticatedUser) {
    const deploymentType = dto.deploymentType ?? DeploymentType.MOBILE;
    this.assertPermanentHasSite(deploymentType, dto.permanentSiteLabel ?? null);

    const branch = await this.requireBranch(dto.branchCode);
    const sourceKey = buildSourceKey(dto.fullName, dto.branchCode);

    if (await this.prisma.employee.findUnique({ where: { sourceKey } })) {
      throw new AppException(
        'RESOURCE_CONFLICT',
        `"${dto.fullName}" already exists in the ${dto.branchCode} branch. Two people with the same name in one branch cannot be told apart — add a distinguishing initial.`,
        HttpStatus.CONFLICT,
        { fullName: dto.fullName, branchCode: dto.branchCode },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.employee.create({
        data: {
          sourceKey,
          fullName: dto.fullName.trim(),
          gradeLabel: dto.gradeLabel.trim(),
          // Derived here, never taken from the client: the frontend must not
          // decide who counts as a supervisor.
          isPmsGrade: isPmsGradeLabel(dto.gradeLabel),
          branchId: branch.id,
          branchCode: dto.branchCode,
          deploymentType,
          permanentSiteLabel: dto.permanentSiteLabel?.trim() || null,
          canUsePublicTransport: dto.canUsePublicTransport ?? false,
          skills: dto.skillCodes?.length
            ? {
                create: dto.skillCodes.map((code) => ({
                  skillCode: code,
                  skillLabel: code,
                })),
              }
            : undefined,
        },
        include: EMPLOYEE_INCLUDE,
      });

      await this.audit.record(
        { entityType: 'Employee', entityId: created.id, action: 'employee.created', actor, after: created },
        tx,
      );
      return created;
    });
  }

  async update(id: string, dto: UpdateEmployeeDto, actor: AuthenticatedUser) {
    const before = await this.findOne(id);

    const deploymentType = dto.deploymentType ?? before.deploymentType;
    const permanentSiteLabel =
      dto.permanentSiteLabel === undefined
        ? before.permanentSiteLabel
        : dto.permanentSiteLabel?.trim() || null;

    this.assertPermanentHasSite(deploymentType, permanentSiteLabel);

    // A permanently stationed employee belongs to their site. Moving them to
    // the other branch would mean the site moved, which it did not.
    if (
      dto.branchCode &&
      dto.branchCode !== before.branchCode &&
      before.deploymentType === DeploymentType.PERMANENTLY_STATIONED &&
      deploymentType === DeploymentType.PERMANENTLY_STATIONED
    ) {
      throw new AppException(
        'PERMANENT_EMPLOYEE_CANNOT_CHANGE_BRANCH',
        `${before.fullName} is permanently stationed at ${before.permanentSiteLabel ?? 'a site'} and cannot be moved to ${dto.branchCode}. Make them mobile first, or change the site.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        {
          employeeId: id,
          currentBranch: before.branchCode,
          requestedBranch: dto.branchCode,
          permanentSite: before.permanentSiteLabel,
        },
      );
    }

    const branch = dto.branchCode ? await this.requireBranch(dto.branchCode) : null;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({
        where: { id },
        data: {
          ...(dto.fullName ? { fullName: dto.fullName.trim() } : {}),
          ...(dto.gradeLabel
            ? {
                gradeLabel: dto.gradeLabel.trim(),
                isPmsGrade: isPmsGradeLabel(dto.gradeLabel),
              }
            : {}),
          ...(branch && dto.branchCode
            ? { branchId: branch.id, branchCode: dto.branchCode }
            : {}),
          ...(dto.deploymentType ? { deploymentType: dto.deploymentType } : {}),
          ...(dto.permanentSiteLabel === undefined ? {} : { permanentSiteLabel }),
          ...(dto.canUsePublicTransport === undefined
            ? {}
            : { canUsePublicTransport: dto.canUsePublicTransport }),
        },
        include: EMPLOYEE_INCLUDE,
      });

      await this.audit.record(
        { entityType: 'Employee', entityId: id, action: 'employee.updated', actor, before, after: updated },
        tx,
      );
      return updated;
    });
  }

  /**
   * Deactivates rather than deletes. Completed assignments reference employees,
   * and history that silently loses its crew is worse than a disabled record.
   */
  async setActive(id: string, isActive: boolean, actor: AuthenticatedUser) {
    const before = await this.findOne(id);
    if (before.isActive === isActive) return before;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({
        where: { id },
        data: { isActive },
        include: EMPLOYEE_INCLUDE,
      });

      await this.audit.record(
        {
          entityType: 'Employee',
          entityId: id,
          action: isActive ? 'employee.reactivated' : 'employee.deactivated',
          actor,
          before,
          after: updated,
        },
        tx,
      );
      return updated;
    });
  }

  async setPermanentAssignment(
    id: string,
    siteLabel: string | null,
    actor: AuthenticatedUser,
  ) {
    const before = await this.findOne(id);
    const trimmed = siteLabel?.trim() || null;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.employee.update({
        where: { id },
        data: {
          permanentSiteLabel: trimmed,
          deploymentType: trimmed
            ? DeploymentType.PERMANENTLY_STATIONED
            : DeploymentType.MOBILE,
        },
        include: EMPLOYEE_INCLUDE,
      });

      await this.audit.record(
        {
          entityType: 'Employee',
          entityId: id,
          action: trimmed
            ? 'employee.permanent_assignment_set'
            : 'employee.permanent_assignment_cleared',
          actor,
          before,
          after: updated,
        },
        tx,
      );
      return updated;
    });
  }

  async replaceSkills(
    id: string,
    skills: SkillAssignmentDto[],
    actor: AuthenticatedUser,
  ) {
    const before = await this.findOne(id);

    return this.prisma.$transaction(async (tx) => {
      await tx.employeeSkill.deleteMany({ where: { employeeId: id } });
      if (skills.length) {
        await tx.employeeSkill.createMany({
          data: skills.map((s) => ({
            employeeId: id,
            skillCode: s.skillCode,
            skillLabel: s.skillLabel ?? s.skillCode,
          })),
        });
      }

      const after = await tx.employee.findUniqueOrThrow({
        where: { id },
        include: EMPLOYEE_INCLUDE,
      });

      await this.audit.record(
        { entityType: 'Employee', entityId: id, action: 'employee.skills_replaced', actor, before, after },
        tx,
      );
      return after;
    });
  }

  // -------------------------------------------------------------------------
  // Vehicle authorizations
  // -------------------------------------------------------------------------

  async authorizeVehicle(id: string, vehicleId: string, actor: AuthenticatedUser) {
    const employee = await this.findOne(id);
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) throw notFound('Vehicle', vehicleId);

    if (!employee.isActive) {
      throw new AppException(
        'EMPLOYEE_INACTIVE',
        `${employee.fullName} is deactivated and cannot be given new driving authorizations. Reactivate them first.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { employeeId: id },
      );
    }
    if (!vehicle.isActive) {
      throw new AppException(
        'VEHICLE_INACTIVE',
        `Vehicle ${vehicle.code} is deactivated and cannot have new drivers authorised.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        { vehicleId },
      );
    }

    const existing = await this.prisma.vehicleAuthorization.findUnique({
      where: { employeeId_vehicleId: { employeeId: id, vehicleId } },
    });
    if (existing) {
      throw new AppException(
        'AUTHORIZATION_ALREADY_EXISTS',
        `${employee.fullName} is already authorised to drive ${vehicle.code}.`,
        HttpStatus.CONFLICT,
        { employeeId: id, vehicleId },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.vehicleAuthorization.create({
        data: { employeeId: id, vehicleId },
        include: { vehicle: true },
      });

      await this.audit.record(
        {
          entityType: 'VehicleAuthorization',
          entityId: created.id,
          action: 'vehicle_authorization.granted',
          actor,
          after: { employeeId: id, employee: employee.fullName, vehicleId, vehicle: vehicle.code },
        },
        tx,
      );
      return created;
    });
  }

  async revokeVehicle(id: string, vehicleId: string, actor: AuthenticatedUser) {
    const existing = await this.prisma.vehicleAuthorization.findUnique({
      where: { employeeId_vehicleId: { employeeId: id, vehicleId } },
      include: { employee: true, vehicle: true },
    });

    if (!existing) {
      throw new AppException(
        'AUTHORIZATION_NOT_FOUND',
        'That driving authorization does not exist, so there is nothing to remove.',
        HttpStatus.NOT_FOUND,
        { employeeId: id, vehicleId },
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleAuthorization.delete({ where: { id: existing.id } });
      await this.audit.record(
        {
          entityType: 'VehicleAuthorization',
          entityId: existing.id,
          action: 'vehicle_authorization.revoked',
          actor,
          before: {
            employeeId: id,
            employee: existing.employee.fullName,
            vehicleId,
            vehicle: existing.vehicle.code,
          },
        },
        tx,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  async addAvailability(
    id: string,
    dto: CreateAvailabilityDto,
    actor: AuthenticatedUser,
  ) {
    await this.findOne(id);

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    if (endDate < startDate) {
      throw new AppException(
        'AVAILABILITY_RANGE_INVALID',
        'The end date is before the start date. For a single day off, use the same date for both.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { startDate: dto.startDate, endDate: dto.endDate },
      );
    }

    // Two absences covering the same day would double-count, and the scheduler
    // would have to guess which reason applies.
    const clash = await this.prisma.employeeAvailability.findFirst({
      where: { employeeId: id, startDate: { lte: endDate }, endDate: { gte: startDate } },
    });
    if (clash) {
      throw new AppException(
        'AVAILABILITY_OVERLAPS',
        `This overlaps an absence already recorded from ${iso(clash.startDate)} to ${iso(clash.endDate)}. Edit that one instead of adding a second.`,
        HttpStatus.CONFLICT,
        {
          conflictingId: clash.id,
          conflictingStart: iso(clash.startDate),
          conflictingEnd: iso(clash.endDate),
        },
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.employeeAvailability.create({
        data: {
          employeeId: id,
          startDate,
          endDate,
          kind: dto.kind ?? AvailabilityKind.LEAVE,
          reason: dto.reason?.trim() || null,
        },
      });

      await this.audit.record(
        {
          entityType: 'EmployeeAvailability',
          entityId: created.id,
          action: 'availability.created',
          actor,
          after: created,
        },
        tx,
      );
      return created;
    });
  }

  async removeAvailability(id: string, availabilityId: string, actor: AuthenticatedUser) {
    const existing = await this.prisma.employeeAvailability.findFirst({
      where: { id: availabilityId, employeeId: id },
    });
    if (!existing) throw notFound('Availability record', availabilityId);

    await this.prisma.$transaction(async (tx) => {
      await tx.employeeAvailability.delete({ where: { id: availabilityId } });
      await this.audit.record(
        {
          entityType: 'EmployeeAvailability',
          entityId: availabilityId,
          action: 'availability.deleted',
          actor,
          before: existing,
        },
        tx,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Shared validation
  // -------------------------------------------------------------------------

  private assertPermanentHasSite(
    deploymentType: DeploymentType,
    siteLabel: string | null,
  ): void {
    if (deploymentType === DeploymentType.PERMANENTLY_STATIONED && !siteLabel) {
      throw new AppException(
        'PERMANENT_SITE_REQUIRED',
        'A permanently stationed employee must name the site they are stationed at. Give a site, or set them to MOBILE.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  private async requireBranch(code: BranchCode) {
    const branch = await this.prisma.branch.findUnique({ where: { code } });
    if (!branch) throw notFound('Branch', code);
    return branch;
  }
}

function notFound(resource: string, id: string): NotFoundException {
  return new NotFoundException({
    code: 'RESOURCE_NOT_FOUND',
    message: `${resource} "${id}" was not found. Refresh the list — it may have been removed.`,
    details: { resource, id },
  });
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
