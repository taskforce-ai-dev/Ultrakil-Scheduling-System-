import { HttpStatus, Injectable } from '@nestjs/common';
import { AssignmentStatus, Prisma } from '@prisma/client';

import { parseDateOnly, toDateOnly } from '../../catalog/schedule-preview';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../prisma/prisma.service';
import { CalendarEntryDto, CalendarQueryDto } from './dto';

const MAX_RANGE_DAYS = 120;

/** Assignment states worth showing on the calendar — a superseded or cancelled
 * one is history, not today's board. */
const LIVE_STATUSES: AssignmentStatus[] = [
  AssignmentStatus.DRAFT,
  AssignmentStatus.PROPOSED,
  AssignmentStatus.PUBLISHED,
  AssignmentStatus.ACKNOWLEDGED,
  AssignmentStatus.IN_PROGRESS,
];

const CALENDAR_INCLUDE = {
  serviceAgreement: {
    include: {
      customer: { select: { name: true } },
      serviceSite: { select: { name: true } },
      jobType: { select: { name: true } },
    },
  },
  assignments: {
    where: { status: { in: LIVE_STATUSES } },
    include: {
      crewMembers: { include: { employee: { select: { fullName: true } } } },
      vehicles: {
        include: {
          vehicle: { select: { label: true } },
          driverEmployee: { select: { fullName: true } },
        },
      },
    },
  },
} satisfies Prisma.GeneratedVisitInclude;

type VisitWithCalendarRelations = Prisma.GeneratedVisitGetPayload<{
  include: typeof CALENDAR_INCLUDE;
}>;

/**
 * The unified schedule read model: one row per visit with the date, time,
 * crew and vehicle a manager needs, joined server-side so the manager portal
 * never assembles it from several screens. This is also the Phase
 * 2-compatible read model ULK-C07 asks for — supervisor employee id, crew
 * roster, visit instructions, assignment status and published schedule
 * version all live on the same row a PMS tablet or worker app could read
 * later.
 */
@Injectable()
export class CalendarService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: CalendarQueryDto): Promise<{ items: CalendarEntryDto[]; total: number }> {
    const from = parseDateOnly(query.from);
    const to = parseDateOnly(query.to);

    if (to.getTime() < from.getTime()) {
      throw new AppException(
        'VALIDATION_FAILED',
        '"to" must be on or after "from".',
        HttpStatus.BAD_REQUEST,
        { from: query.from, to: query.to },
      );
    }

    const rangeDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (rangeDays > MAX_RANGE_DAYS) {
      throw new AppException(
        'VALIDATION_FAILED',
        `The calendar covers at most ${MAX_RANGE_DAYS} days at a time; this range is ${rangeDays}. Narrow it, or page through the visits endpoint instead.`,
        HttpStatus.BAD_REQUEST,
        { from: query.from, to: query.to, rangeDays, maxRangeDays: MAX_RANGE_DAYS },
      );
    }

    const where: Prisma.GeneratedVisitWhereInput = {
      visitDate: { gte: from, lte: to },
      ...(query.branchCode ? { branchCode: query.branchCode } : {}),
    };

    const [total, visits] = await Promise.all([
      this.prisma.generatedVisit.count({ where }),
      this.prisma.generatedVisit.findMany({
        where,
        include: CALENDAR_INCLUDE,
        orderBy: [{ visitDate: 'asc' }, { windowStartMinute: 'asc' }],
      }),
    ]);

    return { items: visits.map(toCalendarEntry), total };
  }
}

function toCalendarEntry(visit: VisitWithCalendarRelations): CalendarEntryDto {
  const agreement = visit.serviceAgreement;
  const assignment = visit.assignments[0] ?? null;
  const notes = agreement.notes?.trim();

  return {
    visitId: visit.id,
    visitDate: toDateOnly(visit.visitDate),
    windowStartMinute: visit.windowStartMinute,
    windowEndMinute: visit.windowEndMinute,
    durationMinutes: visit.durationMinutes,
    visitStatus: visit.status,
    branchCode: visit.branchCode,
    serviceAgreementId: agreement.id,
    customerName: agreement.customer.name,
    siteName: agreement.serviceSite.name,
    jobTypeName: agreement.jobType.name,
    instructions: notes && notes.length > 0 ? notes : null,
    assignment: assignment
      ? {
          id: assignment.id,
          status: assignment.status,
          supervisorEmployeeId:
            assignment.crewMembers.find((member) => member.isPmsSupervisor)?.employeeId ?? null,
          supervisorName:
            assignment.crewMembers.find((member) => member.isPmsSupervisor)?.employee.fullName ??
            null,
          crew: assignment.crewMembers
            .map((member) => ({
              employeeId: member.employeeId,
              fullName: member.employee.fullName,
              role: member.role,
              isPmsSupervisor: member.isPmsSupervisor,
            }))
            .sort((left, right) => left.fullName.localeCompare(right.fullName)),
          vehicles: assignment.vehicles.map((entry) => ({
            vehicleId: entry.vehicleId,
            label: entry.vehicle.label,
            driverName: entry.driverEmployee?.fullName ?? null,
          })),
          scheduleRunId: assignment.scheduleRunId,
          publishedAt: assignment.publishedAt?.toISOString() ?? null,
          acknowledgedAt: assignment.acknowledgedAt?.toISOString() ?? null,
          startedAt: assignment.startedAt?.toISOString() ?? null,
          completedAt: assignment.completedAt?.toISOString() ?? null,
        }
      : null,
  };
}
