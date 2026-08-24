import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/**
 * Single definition of the OpenAPI document, shared by the running app (which
 * serves Swagger UI at /api/docs) and by scripts/generate-openapi.ts (which
 * writes the committed contract). Having one definition is what guarantees the
 * committed contract and the live API cannot drift.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('UltraKIL Scheduling API')
    .setDescription(
      [
        'Phase 1 pilot API for UltraKIL scheduling and dispatching.',
        '',
        'Hard rules enforced by this API:',
        '- Colombo staff serve Colombo work only; Kandy staff serve Kandy work only.',
        '- Permanently stationed staff are never moved away from their site.',
        '- Every job carries at least one PMS-grade supervisor.',
        '- A vehicle may only be driven by an employee authorised for it.',
        '- Allowed service days are hard constraints; preferred days are preferences.',
        '',
        'Work that cannot satisfy every hard rule stays in the Unassigned queue',
        'with an explanation. Hard rules are never relaxed to fill a schedule.',
        '',
        'Errors always carry a stable `code`. Clients must branch on `code`,',
        'never on `message`.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .addTag('health', 'Liveness and readiness probes')
    .addTag('meta', 'Shared vocabulary: enums, grades and error codes')
    .addServer('http://localhost:3001', 'Local development')
    .build();

  return SwaggerModule.createDocument(app, config);
}
