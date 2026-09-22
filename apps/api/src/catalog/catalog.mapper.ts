import { DayRuleKind, Prisma, Weekday } from '@prisma/client';

import { describeFrequency } from '../scheduling/visit-generation/cadence';
import {
  CustomerDto,
  JobTypeDto,
  ServiceAgreementDto,
  ServiceSiteDto,
} from './dto/responses.dto';

export type ServiceSiteWithRelations = Prisma.ServiceSiteGetPayload<{
  include: {
    operatingHours: true;
    _count: { select: { serviceAgreements: true } };
  };
}>;

export type CustomerWithRelations = Prisma.CustomerGetPayload<{
  include: {
    serviceSites: {
      include: {
        operatingHours: true;
        _count: { select: { serviceAgreements: true } };
      };
    };
  };
}>;

export type AgreementWithRelations = Prisma.ServiceAgreementGetPayload<{
  include: {
    customer: { select: { id: true; name: true } };
    serviceSite: { select: { id: true; name: true } };
    jobType: { select: { id: true; name: true } };
    dayRules: true;
    requiredSkills: true;
    bookings: true;
    _count: { select: { generatedVisits: true } };
  };
}>;

/** Dates cross the wire as plain YYYY-MM-DD, matching how they are stored. */
function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

const WEEKDAY_ORDER: Weekday[] = [
  Weekday.MONDAY,
  Weekday.TUESDAY,
  Weekday.WEDNESDAY,
  Weekday.THURSDAY,
  Weekday.FRIDAY,
  Weekday.SATURDAY,
  Weekday.SUNDAY,
];

/** Monday-first, so a weekday list reads the way a week does. */
export function sortWeekdays(days: Weekday[]): Weekday[] {
  return [...days].sort(
    (a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b),
  );
}

export function toServiceSiteDto(site: ServiceSiteWithRelations): ServiceSiteDto {
  return {
    id: site.id,
    customerId: site.customerId,
    name: site.name,
    addressLine: site.addressLine,
    city: site.city,
    branchCode: site.branchCode,
    isActive: site.isActive,
    operatingHours: [...site.operatingHours]
      .sort(
        (a, b) =>
          WEEKDAY_ORDER.indexOf(a.weekday) - WEEKDAY_ORDER.indexOf(b.weekday) ||
          a.opensAtMinute - b.opensAtMinute,
      )
      .map((hours) => ({
        id: hours.id,
        weekday: hours.weekday,
        opensAtMinute: hours.opensAtMinute,
        closesAtMinute: hours.closesAtMinute,
      })),
    serviceAgreementCount: site._count.serviceAgreements,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  };
}

export function toCustomerDto(customer: CustomerWithRelations): CustomerDto {
  return {
    id: customer.id,
    name: customer.name,
    customerCode: customer.customerCode,
    branchCode: customer.branchCode,
    contactName: customer.contactName,
    contactPhone: customer.contactPhone,
    contactEmail: customer.contactEmail,
    isActive: customer.isActive,
    sites: customer.serviceSites.map(toServiceSiteDto),
    createdAt: customer.createdAt.toISOString(),
    updatedAt: customer.updatedAt.toISOString(),
  };
}

export function toJobTypeDto(jobType: {
  id: string;
  code: string;
  name: string;
  defaultDurationMinutes: number;
  defaultCrewSize: number;
  requiresPmsSupervisor: boolean;
  requiredSkillCode: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): JobTypeDto {
  return {
    id: jobType.id,
    code: jobType.code,
    name: jobType.name,
    defaultDurationMinutes: jobType.defaultDurationMinutes,
    defaultCrewSize: jobType.defaultCrewSize,
    requiresPmsSupervisor: jobType.requiresPmsSupervisor,
    requiredSkillCode: jobType.requiredSkillCode,
    isActive: jobType.isActive,
    createdAt: jobType.createdAt.toISOString(),
    updatedAt: jobType.updatedAt.toISOString(),
  };
}

export function toAgreementDto(
  agreement: AgreementWithRelations,
): ServiceAgreementDto {
  const allowedDays = sortWeekdays(
    agreement.dayRules
      .filter((rule) => rule.kind === DayRuleKind.ALLOWED)
      .map((rule) => rule.weekday),
  );
  const preferredDays = sortWeekdays(
    agreement.dayRules
      .filter((rule) => rule.kind === DayRuleKind.PREFERRED)
      .map((rule) => rule.weekday),
  );

  return {
    id: agreement.id,
    customerId: agreement.customerId,
    customerName: agreement.customer.name,
    serviceSiteId: agreement.serviceSiteId,
    siteName: agreement.serviceSite.name,
    jobTypeId: agreement.jobTypeId,
    jobTypeName: agreement.jobType.name,
    branchCode: agreement.branchCode,
    frequencyCount: agreement.frequencyCount,
    frequencyUnit: agreement.frequencyUnit,
    frequencyInterval: agreement.frequencyInterval,
    frequencyLabel: describeFrequency(
      agreement.frequencyCount,
      agreement.frequencyUnit,
      agreement.frequencyInterval,
    ),
    crewSize: agreement.crewSize,
    durationMinutes: agreement.durationMinutes,
    serviceWindowStartMinute: agreement.serviceWindowStartMinute,
    serviceWindowEndMinute: agreement.serviceWindowEndMinute,
    startDate: toDateOnly(agreement.startDate),
    endDate: agreement.endDate ? toDateOnly(agreement.endDate) : null,
    status: agreement.status,
    isActive: agreement.status === 'ACTIVE',
    generatedVisitCount: agreement._count.generatedVisits,
    currentVersion: agreement.currentVersion,
    dayRules: agreement.dayRules.map((rule) => ({
      weekday: rule.weekday,
      kind: rule.kind,
    })),
    allowedDays,
    preferredDays,
    requiredSkillCodes: agreement.requiredSkills
      .map((skill) => skill.skillCode)
      .sort(),
    // Shown, never edited here: these are what the workbook agreed with the
    // customer, and a manager changing one on this screen would be changing
    // the schedule without saying so.
    bookedDates: agreement.bookings
      .map((booking) => toDateOnly(booking.bookedDate))
      .sort(),
    notes: agreement.notes,
    createdAt: agreement.createdAt.toISOString(),
    updatedAt: agreement.updatedAt.toISOString(),
  };
}
