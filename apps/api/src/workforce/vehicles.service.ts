import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import { CreateVehicleDto, UpdateVehicleDto } from './dto/vehicle.dto';
import { VehicleQueryDto } from './dto/query.dto';

@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: VehicleQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    const where: Prisma.VehicleWhereInput = {
      ...(query.active === undefined ? { isActive: true } : { isActive: query.active }),
      ...(query.branch ? { branch: { code: query.branch } } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { label: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.vehicle.count({ where }),
      this.prisma.vehicle.findMany({
        where,
        include: {
          branch: { select: { id: true, code: true, name: true } },
          _count: { select: { authorizations: true } },
        },
        orderBy: { code: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return { items, total, page, pageSize };
  }

  async findOne(id: string) {
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id },
      include: {
        branch: { select: { id: true, code: true, name: true } },
        _count: { select: { authorizations: true } },
      },
    });
    if (!vehicle) throw notFound('Vehicle', id);
    return vehicle;
  }

  /**
   * Every employee check-marked against this vehicle in the workforce matrix.
   *
   * Authorization only. There is deliberately no notion of who owns the vehicle
   * or who normally drives it — the matrix does not record that, and inventing
   * it would put a rule into the scheduler that the client never asked for.
   */
  async authorizedDrivers(id: string, includeInactive = false) {
    const vehicle = await this.findOne(id);

    const authorizations = await this.prisma.vehicleAuthorization.findMany({
      where: {
        vehicleId: id,
        ...(includeInactive ? {} : { employee: { isActive: true } }),
      },
      include: {
        employee: {
          select: {
            id: true,
            fullName: true,
            gradeLabel: true,
            isPmsGrade: true,
            branchCode: true,
            deploymentType: true,
            isActive: true,
          },
        },
      },
      orderBy: { employee: { fullName: 'asc' } },
    });

    return {
      vehicle: {
        id: vehicle.id,
        code: vehicle.code,
        label: vehicle.label,
        seatCapacity: vehicle.seatCapacity,
      },
      drivers: authorizations.map((a) => a.employee),
      total: authorizations.length,
    };
  }

  async create(dto: CreateVehicleDto, actor: AuthenticatedUser) {
    const code = dto.code.trim();
    if (await this.prisma.vehicle.findUnique({ where: { code } })) {
      throw new AppException(
        'VEHICLE_CODE_TAKEN',
        `A vehicle with registration "${code}" already exists.`,
        HttpStatus.CONFLICT,
        { code },
      );
    }

    const branchId = dto.branchCode ? await this.branchId(dto.branchCode) : null;

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.vehicle.create({
        data: {
          code,
          label: dto.label.trim(),
          seatCapacity: dto.seatCapacity ?? null,
          branchId,
        },
      });
      await this.audit.record(
        { entityType: 'Vehicle', entityId: created.id, action: 'vehicle.created', actor, after: created },
        tx,
      );
      return created;
    });
  }

  async update(id: string, dto: UpdateVehicleDto, actor: AuthenticatedUser) {
    const before = await this.findOne(id);

    if (dto.code && dto.code.trim() !== before.code) {
      const clash = await this.prisma.vehicle.findUnique({
        where: { code: dto.code.trim() },
      });
      if (clash) {
        throw new AppException(
          'VEHICLE_CODE_TAKEN',
          `A vehicle with registration "${dto.code.trim()}" already exists.`,
          HttpStatus.CONFLICT,
          { code: dto.code.trim() },
        );
      }
    }

    const branchId =
      dto.branchCode === undefined
        ? undefined
        : dto.branchCode === null
          ? null
          : await this.branchId(dto.branchCode);

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.vehicle.update({
        where: { id },
        data: {
          ...(dto.code ? { code: dto.code.trim() } : {}),
          ...(dto.label ? { label: dto.label.trim() } : {}),
          ...(dto.seatCapacity === undefined ? {} : { seatCapacity: dto.seatCapacity }),
          ...(branchId === undefined ? {} : { branchId }),
        },
      });
      await this.audit.record(
        { entityType: 'Vehicle', entityId: id, action: 'vehicle.updated', actor, before, after: updated },
        tx,
      );
      return updated;
    });
  }

  /** Deactivates. Published assignments reference vehicles; history must survive. */
  async setActive(id: string, isActive: boolean, actor: AuthenticatedUser) {
    const before = await this.findOne(id);
    if (before.isActive === isActive) return before;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.vehicle.update({ where: { id }, data: { isActive } });
      await this.audit.record(
        {
          entityType: 'Vehicle',
          entityId: id,
          action: isActive ? 'vehicle.reactivated' : 'vehicle.deactivated',
          actor,
          before,
          after: updated,
        },
        tx,
      );
      return updated;
    });
  }

  private async branchId(code: NonNullable<CreateVehicleDto['branchCode']>) {
    const branch = await this.prisma.branch.findUnique({ where: { code } });
    if (!branch) throw notFound('Branch', code);
    return branch.id;
  }
}

function notFound(resource: string, id: string): NotFoundException {
  return new NotFoundException({
    code: 'RESOURCE_NOT_FOUND',
    message: `${resource} "${id}" was not found. Refresh the list — it may have been removed.`,
    details: { resource, id },
  });
}
