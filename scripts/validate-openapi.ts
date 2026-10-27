import SwaggerParser from '@apidevtools/swagger-parser';
import { buildApp } from '../src/app.js';
import type { Pool } from 'pg';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { amount } from '../src/common/validation.js';

const document = await SwaggerParser.validate('openapi.yaml');
const raw: { components: { schemas: { Amount: { pattern: string } } } } = parse(
  await readFile('openapi.yaml', 'utf8'),
);
const moneyPattern = new RegExp(raw.components.schemas.Amount.pattern);
for (const value of [
  '0',
  '0.0',
  '0.00',
  '0.01',
  '10',
  '10.5',
  '10.50',
  '-1',
  '1e3',
  '1.001',
  '01',
  '9999999999999999.99',
  '10000000000000000',
]) {
  if (moneyPattern.test(value) !== amount.safeParse(value).success)
    throw new Error(`OpenAPI monetary validation mismatch for ${value}`);
}
const app = buildApp({} as Pool, { closePool: false });
await app.ready();
const operations: string[] = [];
for (const [path, item] of Object.entries(document.paths ?? {})) {
  if (!item) continue;
  for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
    if (item[method]) {
      const url = path.replace(/\{([^}]+)\}/g, ':$1');
      if (!app.hasRoute({ method: method.toUpperCase(), url }))
        throw new Error(`Documented route does not exist: ${method} ${url}`);
      operations.push(`${method.toUpperCase()} ${path}`);
    }
  }
}
await app.close();
process.stdout.write(
  `OpenAPI valid; ${operations.length} operations match registered routes\n`,
);
