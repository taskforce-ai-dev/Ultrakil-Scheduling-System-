import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { BranchListItemDto, SkillListItemDto } from './dto/responses.dto';
import { DEFAULT_DAILY_VISIT_CAP } from '../config/constants';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Small read-only lists the portal needs to populate filters and dropdowns.
 */
@ApiTags('workforce')
@ApiBearerAuth('bearer')
@ApiResponse({ status: 401, description: 'Missing or invalid token.' })
@Controller()
export class ReferenceController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Most visits one branch's day is planned to carry.
   *
   * The same number the generator spreads work by. It is branch reference data
   * as much as the supervisor count is: without it the calendar cannot say a
   * day is over the limit, and the only place the limit was ever visible was
   * the generation panel, which closes.
   */
  private get dailyVisitCap(): number {
    return (
      this.config.get<number>('visitGeneration.dailyCap') ?? DEFAULT_DAILY_VISIT_CAP
    );
  }

  @Get('branches')
  @ApiOperation({
    summary: 'Branches',
    description:
      'Colombo and Kandy, with how many active staff each has. Staff may only serve work in their own branch.',
  })
  @ApiResponse({ status: 200, type: [BranchListItemDto] })
  async branches(): Promise<BranchListItemDto[]> {
    const branches = await this.prisma.branch.findMany({
      orderBy: { code: 'asc' },
      include: {
        _count: { select: { employees: true, vehicles: true } },
      },
    });

    // Supervisor counts matter operationally: a branch with none cannot be
    // scheduled at all, because every job needs a PMS-grade supervisor.
    const supervisors = await this.prisma.employee.groupBy({
      by: ['branchCode'],
      where: { isActive: true, isPmsGrade: true },
      _count: { _all: true },
    });

    return branches.map((branch) => ({
      id: branch.id,
      code: branch.code,
      name: branch.name,
      employeeCount: branch._count.employees,
      vehicleCount: branch._count.vehicles,
      pmsSupervisorCount:
        supervisors.find((s) => s.branchCode === branch.code)?._count._all ?? 0,
      dailyVisitCap: this.dailyVisitCap,
    }));
  }

  @Get('skills')
  @ApiOperation({
    summary: 'Skills in use',
    description:
      'Distinct skills held by at least one employee, with how many hold each. Sourced from the workforce matrix column headings.',
  })
  @ApiResponse({ status: 200, type: [SkillListItemDto] })
  async skills(): Promise<SkillListItemDto[]> {
    const grouped = await this.prisma.employeeSkill.groupBy({
      by: ['skillCode', 'skillLabel'],
      _count: { _all: true },
      orderBy: { skillCode: 'asc' },
    });

    return grouped.map((row) => ({
      skillCode: row.skillCode,
      skillLabel: row.skillLabel,
      employeeCount: row._count._all,
    }));
  }
}
