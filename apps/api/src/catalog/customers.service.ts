import { HttpStatus, Injectable } from '@nestjs/common';
import { BranchCode, Prisma, Weekday } from '@prisma/client';

import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../auth/auth.types';
import { AppException } from '../common/errors/app.exception';
import { PrismaService } from '../prisma/prisma.service';
import {
  CustomerWithRelations,
  ServiceSiteWithRelations,
  toCustomerDto,
  toServiceSiteDto,
} from './catalog.mapper';
import {
  CreateCustomerDto,
  CreateServiceSiteDto,
  SiteOperatingHoursDto,
  UpdateCustomerDto,
  UpdateServiceSiteDto,
} from './dto/customer.dto';
import { CustomerQueryDto } from './dto/query.dto';

const CUSTOMER_INCLUDE = {
  serviceSites: {
    include: {
      operatingHours: true,
      _count: { select: { serviceAgreements: true } },
    },
    orderBy: { name: 'asc' },
  },
} satisfies Prisma.CustomerInclude;

const SITE_INCLUDE = {
  operatingHours: true,
  _count: { select: { serviceAgreements: true } },
} satisfies Prisma.ServiceSiteInclude;

@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(query: CustomerQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;

    const where: Prisma.CustomerWhereInput = {
      ...(query.active === undefined ? { isActive: true } : { isActive: query.active }),
      ...(query.branch ? { branchCode: query.branch } : {}),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { customerCode: { contains: query.search, mode: 'insensitive' } },
              {
                serviceSites: {
                  some: { name: { contains: query.search, mode: 'insensitive' } },
                },
              },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.findMany({
        where,
        include: CUSTOMER_INCLUDE,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: items.map((customer) => toCustomerDto(customer as CustomerWithRelations)),
      total,
      page,
      pageSize,
    };
  }

  async get(id: string) {
    return toCustomerDto(await this.loadCustomer(id));
  }

  async create(dto: CreateCustomerDto, actor: AuthenticatedUser) {
    const branch = await this.branchFor(dto.branchCode);
    await this.assertCustomerCodeFree(dto.customerCode ?? null, null);

    const created = await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          name: dto.name.trim(),
          customerCode: dto.customerCode?.trim() || null,
          branchId: branch.id,
          branchCode: dto.branchCode,
          contactName: dto.contactName?.trim() || null,
          contactPhone: dto.contactPhone?.trim() || null,
          contactEmail: dto.contactEmail?.trim().toLowerCase() || null,
        },
        include: CUSTOMER_INCLUDE,
      });

      await this.audit.record(
        {
          entityType: 'Customer',
          entityId: customer.id,
          action: 'customer.created',
          actor,
          after: customer,
        },
        tx,
      );

      return customer;
    });

    return toCustomerDto(created as CustomerWithRelations);
  }

  async update(id: string, dto: UpdateCustomerDto, actor: AuthenticatedUser) {
    const before = await this.loadCustomer(id);

    if (dto.customerCode !== undefined) {
      await this.assertCustomerCodeFree(dto.customerCode, id);
    }

    // A customer's branch is the one it is mainly served from; its sites each
    // carry their own. Moving the customer therefore strands nothing — the
    // sites, which is what the scheduler actually looks at, are untouched.

    const branch = dto.branchCode ? await this.branchFor(dto.branchCode) : null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.customerCode !== undefined
            ? { customerCode: dto.customerCode?.trim() || null }
            : {}),
          ...(branch ? { branchId: branch.id, branchCode: dto.branchCode } : {}),
          ...(dto.contactName !== undefined
            ? { contactName: dto.contactName?.trim() || null }
            : {}),
          ...(dto.contactPhone !== undefined
            ? { contactPhone: dto.contactPhone?.trim() || null }
            : {}),
          ...(dto.contactEmail !== undefined
            ? { contactEmail: dto.contactEmail?.trim().toLowerCase() || null }
            : {}),
        },
        include: CUSTOMER_INCLUDE,
      });

      await this.audit.record(
        {
          entityType: 'Customer',
          entityId: id,
          action: 'customer.updated',
          actor,
          before,
          after: customer,
        },
        tx,
      );

      return customer;
    });

    return toCustomerDto(updated as CustomerWithRelations);
  }

  /**
   * Deactivates rather than deletes.
   *
   * Past visits and assignments reference this customer's agreements, and a
   * schedule that cannot explain itself is worse than a longer list.
   */
  async setActive(id: string, isActive: boolean, actor: AuthenticatedUser) {
    const before = await this.loadCustomer(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      const customer = await tx.customer.update({
        where: { id },
        data: { isActive },
        include: CUSTOMER_INCLUDE,
      });

      await this.audit.record(
        {
          entityType: 'Customer',
          entityId: id,
          action: isActive ? 'customer.reactivated' : 'customer.deactivated',
          actor,
          before,
          after: customer,
        },
        tx,
      );

      return customer;
    });

    return toCustomerDto(updated as CustomerWithRelations);
  }

  // --- Sites ---------------------------------------------------------------

  async listSites(customerId: string) {
    const customer = await this.loadCustomer(customerId);
    return customer.serviceSites.map((site) =>
      toServiceSiteDto(site as ServiceSiteWithRelations),
    );
  }

  async getSite(siteId: string) {
    return toServiceSiteDto(await this.loadSite(siteId));
  }

  async createSite(
    customerId: string,
    dto: CreateServiceSiteDto,
    actor: AuthenticatedUser,
  ) {
    const customer = await this.loadCustomer(customerId);

    if (!customer.isActive) {
      throw new AppException(
        'CUSTOMER_INACTIVE',
        `${customer.name} is deactivated, so no new site can be added. Reactivate the customer first.`,
        HttpStatus.CONFLICT,
        { customerId },
      );
    }

    // Defaults to the customer's branch, but may differ: a nationwide customer
    // genuinely has sites in both branches. Branch isolation is a rule about
    // which crew serves the work, and the work happens at the site.
    const branchCode = dto.branchCode ?? customer.branchCode;

    const hours = normaliseOperatingHours(dto.operatingHours ?? []);
    const branch = await this.branchFor(branchCode);

    const created = await this.prisma.$transaction(async (tx) => {
      const site = await tx.serviceSite.create({
        data: {
          customerId,
          name: dto.name.trim(),
          addressLine: dto.addressLine?.trim() || null,
          city: dto.city?.trim() || null,
          branchId: branch.id,
          branchCode,
          operatingHours: { create: hours },
        },
        include: SITE_INCLUDE,
      });

      await this.audit.record(
        {
          entityType: 'ServiceSite',
          entityId: site.id,
          action: 'service_site.created',
          actor,
          after: site,
        },
        tx,
      );

      return site;
    });

    return toServiceSiteDto(created as ServiceSiteWithRelations);
  }

  async updateSite(
    siteId: string,
    dto: UpdateServiceSiteDto,
    actor: AuthenticatedUser,
  ) {
    const before = await this.loadSite(siteId);

    const branchCode = dto.branchCode ?? before.branchCode;
    const branch = dto.branchCode ? await this.branchFor(dto.branchCode) : null;
    const hours =
      dto.operatingHours === undefined
        ? null
        : normaliseOperatingHours(dto.operatingHours);

    const updated = await this.prisma.$transaction(async (tx) => {
      // Opening hours are replaced wholesale, not merged: the client sends the
      // week it wants, and a weekday it omits means closed. Merging would make
      // "remove Saturday" impossible to express.
      if (hours) {
        await tx.siteOperatingHours.deleteMany({ where: { serviceSiteId: siteId } });
      }

      const site = await tx.serviceSite.update({
        where: { id: siteId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.addressLine !== undefined
            ? { addressLine: dto.addressLine?.trim() || null }
            : {}),
          ...(dto.city !== undefined ? { city: dto.city?.trim() || null } : {}),
          ...(branch ? { branchId: branch.id, branchCode } : {}),
          ...(hours ? { operatingHours: { create: hours } } : {}),
        },
        include: SITE_INCLUDE,
      });

      await this.audit.record(
        {
          entityType: 'ServiceSite',
          entityId: siteId,
          action: 'service_site.updated',
          actor,
          before,
          after: site,
        },
        tx,
      );

      return site;
    });

    return toServiceSiteDto(updated as ServiceSiteWithRelations);
  }

  async setSiteActive(siteId: string, isActive: boolean, actor: AuthenticatedUser) {
    const before = await this.loadSite(siteId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const site = await tx.serviceSite.update({
        where: { id: siteId },
        data: { isActive },
        include: SITE_INCLUDE,
      });

      await this.audit.record(
        {
          entityType: 'ServiceSite',
          entityId: siteId,
          action: isActive ? 'service_site.reactivated' : 'service_site.deactivated',
          actor,
          before,
          after: site,
        },
        tx,
      );

      return site;
    });

    return toServiceSiteDto(updated as ServiceSiteWithRelations);
  }

  // --- Internals -----------------------------------------------------------

  private async loadCustomer(id: string): Promise<CustomerWithRelations> {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      include: CUSTOMER_INCLUDE,
    });

    if (!customer) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Customer "${id}" was not found. Refresh the list — it may have been removed.`,
        HttpStatus.NOT_FOUND,
        { customerId: id },
      );
    }

    return customer as CustomerWithRelations;
  }

  private async loadSite(id: string): Promise<ServiceSiteWithRelations> {
    const site = await this.prisma.serviceSite.findUnique({
      where: { id },
      include: SITE_INCLUDE,
    });

    if (!site) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Service site "${id}" was not found. Refresh the list — it may have been removed.`,
        HttpStatus.NOT_FOUND,
        { serviceSiteId: id },
      );
    }

    return site as ServiceSiteWithRelations;
  }

  private async branchFor(code: BranchCode) {
    const branch = await this.prisma.branch.findUnique({ where: { code } });

    if (!branch) {
      throw new AppException(
        'RESOURCE_NOT_FOUND',
        `Branch "${code}" is not set up. Run the seed to create the branches.`,
        HttpStatus.NOT_FOUND,
        { branchCode: code },
      );
    }

    return branch;
  }

  private async assertCustomerCodeFree(
    code: string | null | undefined,
    exceptId: string | null,
  ): Promise<void> {
    const trimmed = code?.trim();
    if (!trimmed) return;

    const existing = await this.prisma.customer.findUnique({
      where: { customerCode: trimmed },
      select: { id: true, name: true },
    });

    if (existing && existing.id !== exceptId) {
      throw new AppException(
        'CUSTOMER_CODE_TAKEN',
        `Customer code "${trimmed}" already belongs to ${existing.name}. Codes identify one customer, so pick another.`,
        HttpStatus.CONFLICT,
        { customerCode: trimmed, existingCustomerId: existing.id },
      );
    }
  }
}

/**
 * Validates and orders a week of opening hours.
 *
 * Two rules, both of which would otherwise produce a site that silently never
 * gets visited: a window must end after it starts, and windows on the same
 * weekday must not overlap. Overlap matters because the preview treats each
 * window as a separate opportunity — overlapping ones would double-count the
 * same hour and make an impossible frequency look satisfiable.
 */
export function normaliseOperatingHours(
  hours: SiteOperatingHoursDto[],
): { weekday: Weekday; opensAtMinute: number; closesAtMinute: number }[] {
  for (const window of hours) {
    if (window.closesAtMinute <= window.opensAtMinute) {
      throw new AppException(
        'OPERATING_HOURS_INVALID',
        `${window.weekday} closes at ${formatMinute(window.closesAtMinute)}, which is not after it opens at ${formatMinute(window.opensAtMinute)}. A window must end after it starts.`,
        HttpStatus.BAD_REQUEST,
        { ...window },
      );
    }
  }

  const byWeekday = new Map<Weekday, SiteOperatingHoursDto[]>();
  for (const window of hours) {
    const list = byWeekday.get(window.weekday) ?? [];
    list.push(window);
    byWeekday.set(window.weekday, list);
  }

  for (const [weekday, windows] of byWeekday) {
    const sorted = [...windows].sort((a, b) => a.opensAtMinute - b.opensAtMinute);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (current.opensAtMinute < previous.closesAtMinute) {
        throw new AppException(
          'OPERATING_HOURS_OVERLAP',
          `Two ${weekday} windows overlap: ${formatMinute(previous.opensAtMinute)}–${formatMinute(previous.closesAtMinute)} and ${formatMinute(current.opensAtMinute)}–${formatMinute(current.closesAtMinute)}. Merge them, or leave a gap.`,
          HttpStatus.BAD_REQUEST,
          { weekday, first: previous, second: current },
        );
      }
    }
  }

  return hours.map((window) => ({
    weekday: window.weekday,
    opensAtMinute: window.opensAtMinute,
    closesAtMinute: window.closesAtMinute,
  }));
}

function formatMinute(minute: number): string {
  const hour = Math.floor(minute / 60);
  const rest = minute % 60;
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}
