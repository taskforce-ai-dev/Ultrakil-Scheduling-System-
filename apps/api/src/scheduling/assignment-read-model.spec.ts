import 'reflect-metadata';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { RolesGuard } from '../auth/guards/roles.guard';
import { CalendarQueryDto } from './calendar/dto';
import { AssignmentsController } from './eligibility/assignments.controller';
import { EmployeeAssignmentQueryDto } from './eligibility/dto';

describe.each<new () => object>([CalendarQueryDto, EmployeeAssignmentQueryDto])('%p date-only query', (Dto) => {
  it.each(['2024-02-29', '2026-09-07'])('accepts the real date %s', (date) => {
    expect(validateSync(plainToInstance(Dto, { from: date, to: date }))).toEqual([]);
  });

  describe.each(['from', 'to'])('%s', (field) => {
    it.each(['2026-02-29', '2026-02-30', '2026-02-31', '2026-13-01', '2026-09-00', '2026-09-07T00:00:00Z'])(
      'rejects %s',
      (date) => {
        const errors = validateSync(plainToInstance(Dto, {
          from: '2026-09-07', to: '2026-09-07', [field]: date,
        }));
        expect(errors.some((error) => error.property === field)).toBe(true);
      },
    );
  });
});

describe('employee assignments authorization', () => {
  const guard = new RolesGuard(new Reflector());
  const context = (role: string) => ({
    getHandler: () => AssignmentsController.prototype.employeeAssignments,
    getClass: () => AssignmentsController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  }) as unknown as ExecutionContext;

  it.each([UserRole.ADMIN, UserRole.MANAGER])('allows %s', (role) => {
    expect(guard.canActivate(context(role))).toBe(true);
  });

  it('does not grant an unrecognized future worker role arbitrary employee access', () => {
    expect(() => guard.canActivate(context('WORKER'))).toThrow();
  });
});
