import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AssignmentsController } from './assignments.controller';
import { UnassignedVisitQueryDto } from './dto';

describe('UnassignedVisitQueryDto HTTP boundary', () => {
  it('accepts the operation-state and conflict-group values sent by the manager page', async () => {
    const dto = plainToInstance(UnassignedVisitQueryDto, {
      operationState: 'EXCEPTION',
      conflictGroup: 'MISSING_SKILL',
    });

    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect(dto.operationState).toBe('EXCEPTION');
    expect(dto.conflictGroup).toBe('MISSING_SKILL');
  });

  it('rejects unsupported status and display group values at the HTTP boundary', async () => {
    const dto = plainToInstance(UnassignedVisitQueryDto, {
      status: 'EXCEPTION',
      conflictCode: 'MISSING_SKILL',
    });

    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).not.toEqual([]);
  });

  it('passes transformed query values to the queue handler like Nest HTTP validation does', async () => {
    const assignments = { unassignedQueue: jest.fn(async (query) => ({ query })) };
    const controller = new AssignmentsController(assignments as never);
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });

    const query = await pipe.transform(
      { operationState: 'UNASSIGNED', conflictGroup: 'VEHICLE_OVERLAP' },
      { type: 'query', metatype: UnassignedVisitQueryDto, data: '' },
    );

    await expect(controller.queue(query)).resolves.toEqual({ query });
    expect(assignments.unassignedQueue).toHaveBeenCalledWith(
      expect.objectContaining({ operationState: 'UNASSIGNED', conflictGroup: 'VEHICLE_OVERLAP' }),
    );
  });
});
