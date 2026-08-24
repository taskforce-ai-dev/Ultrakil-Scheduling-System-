/**
 * Writes the OpenAPI contract to packages/api-contracts/openapi/openapi.json.
 *
 * Runs the Nest application factory in preview mode, so the contract can be
 * regenerated in CI without PostgreSQL, Redis or the scheduler running.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument } from '../src/openapi';

const OUTPUT_PATH = resolve(
  __dirname,
  '../../../packages/api-contracts/openapi/openapi.json',
);

async function main(): Promise<void> {
  // preview:true instantiates the dependency graph without running lifecycle
  // hooks, so no database or Redis connection is opened.
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
    preview: true,
  });

  // Must match main.ts, or the committed contract would describe paths the
  // running API does not serve.
  app.setGlobalPrefix(process.env.API_GLOBAL_PREFIX ?? 'api');

  const document = buildOpenApiDocument(app);
  await app.close();

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  const paths = Object.keys(document.paths ?? {}).length;
  const schemas = Object.keys(document.components?.schemas ?? {}).length;
  process.stdout.write(
    `OpenAPI contract written to ${OUTPUT_PATH} (${paths} paths, ${schemas} schemas)\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Failed to generate the OpenAPI contract: ${
      error instanceof Error ? error.stack : String(error)
    }\n`,
  );
  process.exit(1);
});
