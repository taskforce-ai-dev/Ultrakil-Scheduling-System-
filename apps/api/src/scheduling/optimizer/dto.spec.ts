import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { PublishScheduleDto } from './dto';

describe('PublishScheduleDto', () => {
  it('retains and validates the explicit partial-publish acknowledgement under whitelist validation', async () => {
    const dto = plainToInstance(PublishScheduleDto, {
      reason: 'Manager reviewed the remaining unassigned visits.',
      acknowledgePartial: true,
    });

    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect(dto.acknowledgePartial).toBe(true);
  });

  it('rejects a non-boolean partial-publish acknowledgement', async () => {
    const dto = plainToInstance(PublishScheduleDto, { acknowledgePartial: 'yes' });

    expect(await validate(dto, { whitelist: true })).not.toEqual([]);
  });

  it('carries both acknowledgements independently under whitelist validation', async () => {
    const dto = plainToInstance(PublishScheduleDto, {
      reason: 'Unassigned visits reviewed and the fallback hours accepted.',
      acknowledgePartial: true,
      acknowledgeProvenance: true,
    });

    expect(await validate(dto, { whitelist: true })).toEqual([]);
    expect(dto.acknowledgePartial).toBe(true);
    expect(dto.acknowledgeProvenance).toBe(true);
  });

  it('rejects a non-boolean source-data acknowledgement', async () => {
    const dto = plainToInstance(PublishScheduleDto, { acknowledgeProvenance: 'yes' });

    expect(await validate(dto, { whitelist: true })).not.toEqual([]);
  });
});
