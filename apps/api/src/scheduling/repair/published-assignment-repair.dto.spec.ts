import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PublishedAssignmentRepairApplyDto } from './published-assignment-repair.dto';

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
