import { ArgumentMetadata, ValidationPipe } from '@nestjs/common';

import { VehicleQueryDto } from './dto/query.dto';

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
const asQuery: ArgumentMetadata = { type: 'query', metatype: VehicleQueryDto, data: '' };

describe('GET /vehicles query validation', () => {
  it('accepts a branch a vehicle must be able to serve', async () => {
    const query = (await pipe.transform({ servesBranch: 'COLOMBO' }, asQuery)) as VehicleQueryDto;

    expect(query.servesBranch).toBe('COLOMBO');
  });

  it('refuses a branch code it does not know', async () => {
    await expect(pipe.transform({ servesBranch: 'GALLE' }, asQuery)).rejects.toMatchObject({
      status: 400,
    });
  });
});
