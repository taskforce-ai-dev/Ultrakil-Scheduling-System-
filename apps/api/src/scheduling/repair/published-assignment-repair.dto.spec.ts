import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  PublishedAssignmentRepairApplyDto,
  PublishedAssignmentRepairPlanDto,
} from './published-assignment-repair.dto';

describe('PublishedAssignmentRepairApplyDto', () => {
  it('rejects an unconfirmed apply request at the HTTP boundary', async () => {
    const dto = plainToInstance(PublishedAssignmentRepairApplyDto, {
      operations: [],
      planHash: 'a'.repeat(64),
      sourceFingerprints: [],
      confirmation: false,
      reason: 'Correct legacy data',
      idempotencyKey: 'repair-1',
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['operations', 'sourceFingerprints', 'confirmation']),
    );
  });
});

describe('PublishedAssignmentRepairPlanDto', () => {
  it.each([
    { sourceAssignmentIds: [] },
    {
      sourceAssignmentIds: Array.from(
        { length: 101 },
        (_, index) =>
          `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      ),
    },
    {
      sourceAssignmentIds: [
        '11111111-1111-4111-8111-111111111111',
        '11111111-1111-4111-8111-111111111111',
      ],
    },
  ])('requires one to 100 unique source assignment IDs', async ({ sourceAssignmentIds }) => {
    const dto = plainToInstance(PublishedAssignmentRepairPlanDto, {
      sourceAssignmentIds,
    });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toContain('sourceAssignmentIds');
  });
});
