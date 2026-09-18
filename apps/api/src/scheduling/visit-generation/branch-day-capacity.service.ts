import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BranchCode, Prisma } from '@prisma/client';

import {
  DEFAULT_DAILY_CAPACITY_MINUTES,
  DEFAULT_EMPLOYEE_WORKDAY_MINUTES,
} from '../../config/constants';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BranchDayCapacity,
  BranchResourcePool,
  computeBranchDayCapacity,
  factsForDate,
} from './branch-day-capacity';

/**
 * Loads each branch's resource pool once — active employees with their
 * leave windows, and active vehicles with who is authorized to drive them —
 * then derives every requested date's capacity from it in memory. One query
 * pair per distinct branch, however many dates that branch is asked about,
 * which is what makes this safe to call from the same guard a whole
 * generation or repair run already drives.
 */
@Injectable()
export class BranchDayCapacityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private get employeeWorkdayMinutes(): number {
    return (
      this.config.get<number>('visitGeneration.employeeWorkdayMinutes') ??
      DEFAULT_EMPLOYEE_WORKDAY_MINUTES
    );
  }

  /** Used only for a branch with no workforce imported at all — see `computeBranchDayCapacity`. */
  private get fallbackCapacityMinutes(): number {
    return (
      this.config.get<number>('visitGeneration.dailyCapacityMinutes') ??
      DEFAULT_DAILY_CAPACITY_MINUTES
    );
  }

  /**
   * @param branchDays The distinct (branch, date) pairs a caller needs a
   *   capacity figure for. Duplicates are fine — computed once each.
   * @returns Every requested pair's capacity, keyed the same way
   *   `branchDayKey` in `daily-load-ledger.ts` already keys a day's load.
   */
  async capacitiesFor(
    branchDays: { branchCode: BranchCode; date: string }[],
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Map<string, BranchDayCapacity>> {
    const byBranch = new Map<BranchCode, Set<string>>();
    for (const { branchCode, date } of branchDays) {
      const dates = byBranch.get(branchCode) ?? new Set<string>();
      dates.add(date);
      byBranch.set(branchCode, dates);
    }

    const result = new Map<string, BranchDayCapacity>();
    const workdayMinutes = this.employeeWorkdayMinutes;
    const fallbackMinutes = this.fallbackCapacityMinutes;

    await Promise.all(
      [...byBranch.entries()].map(async ([branchCode, dates]) => {
        const pool = await this.loadPool(client, branchCode);
        for (const date of dates) {
          const facts = factsForDate(pool, branchCode, date);
          result.set(
            key(branchCode, date),
            computeBranchDayCapacity(facts, workdayMinutes, fallbackMinutes),
          );
        }
      }),
    );

    return result;
  }

  /** Convenience for a single (branch, date) pair. */
  async capacityFor(
    branchCode: BranchCode,
    date: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<BranchDayCapacity> {
    const capacities = await this.capacitiesFor([{ branchCode, date }], client);
    return capacities.get(key(branchCode, date))!;
  }

  private async loadPool(
    client: Prisma.TransactionClient,
    branchCode: BranchCode,
  ): Promise<BranchResourcePool> {
    const [employees, vehicles] = await Promise.all([
      client.employee.findMany({
        where: { branchCode, isActive: true },
        select: {
          id: true,
          isPmsGrade: true,
          availability: { select: { startDate: true, endDate: true } },
        },
        orderBy: { id: 'asc' },
      }),
      client.vehicle.findMany({
        where: { branch: { code: branchCode }, isActive: true },
        select: {
          id: true,
          authorizations: { select: { employeeId: true } },
        },
        orderBy: { id: 'asc' },
      }),
    ]);

    return {
      employees: employees.map((employee) => ({
        id: employee.id,
        isPmsGrade: employee.isPmsGrade,
      })),
      unavailability: employees.flatMap((employee) =>
        employee.availability.map((period) => ({
          employeeId: employee.id,
          startDate: period.startDate.toISOString().slice(0, 10),
          endDate: period.endDate.toISOString().slice(0, 10),
        })),
      ),
      vehicles: vehicles.map((vehicle) => ({
        id: vehicle.id,
        authorizedEmployeeIds: vehicle.authorizations.map((entry) => entry.employeeId),
      })),
    };
  }
}

function key(branchCode: BranchCode, date: string): string {
  return `${branchCode}|${date}`;
}
