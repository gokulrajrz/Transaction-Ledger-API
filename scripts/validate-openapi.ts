import { buildApp } from '../src/app.js';
import type { Pool } from 'pg';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import Draft04 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import type { OpenAPIV3 } from 'openapi-types';
import { amount } from '../src/common/validation.js';
import { createAccountSchema } from '../src/modules/accounts/account.schema.js';
import { createTransactionSchema } from '../src/modules/transactions/transaction.schema.js';
import { transferSchema } from '../src/modules/transfers/transfer.schema.js';
import { collectionPath, generatePostman, type Collection } from './postman.js';
import { loadContract } from './documentation.js';

const contract = await loadContract();
const reference = await readFile('docs/API_REFERENCE.md', 'utf8');
let referenceExampleCount = 0;
for (const match of reference.matchAll(/```json\n([\s\S]*?)```/g)) {
  const value = JSON.parse(match[1]!) as Record<string, unknown>;
  const schemaName =
    'error' in value
      ? 'Error'
      : 'transactions' in value
        ? 'TransferCreated'
        : 'pagination' in value
          ? 'TransactionHistory'
          : 'type' in value
            ? 'Transaction'
            : 'name' in value
              ? 'Account'
              : 'BalanceResponse';
  const schema = contract.document.components?.schemas?.[schemaName];
  if (!schema)
    throw new Error(`Missing schema for reference example: ${schemaName}`);
  contract.assertSchema(schema, value, `API reference ${schemaName}`);
  referenceExampleCount++;
}
for (const match of reference.matchAll(/\]\(([^)]+)\)/g)) {
  const target = match[1]!;
  if (/^(?:https?:|#)/.test(target)) continue;
  await access(resolve('docs', target.split('#')[0]!));
}
const raw = parse(await readFile('openapi.yaml', 'utf8')) as OpenAPIV3.Document;
const amountSchema = raw.components?.schemas?.Amount as OpenAPIV3.SchemaObject;
const moneyPattern = new RegExp(
  (amountSchema.oneOf![0] as OpenAPIV3.SchemaObject).pattern!,
);
for (const value of [
  50,
  10.5,
  0.29,
  90071992547409.9,
  Number.MAX_SAFE_INTEGER,
  0,
  -1,
  1.001,
  1.005,
  Number.MAX_SAFE_INTEGER + 1,
]) {
  let documented = true;
  try {
    contract.assertSchema(amountSchema, value, 'Numeric amount');
  } catch {
    documented = false;
  }
  if (documented !== amount.safeParse(value).success)
    throw new Error(
      `OpenAPI numeric monetary validation mismatch for ${value}`,
    );
}
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
await generatePostman(true);
const collection = JSON.parse(
  await readFile(collectionPath, 'utf8'),
) as Collection;
const schema = JSON.parse(
  await readFile('docs/schemas/postman-collection-v2.1.schema.json', 'utf8'),
);
const postmanAjv = new Draft04.default({ allErrors: true, strict: false });
addFormats.default(postmanAjv);
const validateCollection = postmanAjv.compile(schema);
if (!validateCollection(collection))
  throw new Error(
    `Invalid Postman collection: ${postmanAjv.errorsText(validateCollection.errors)}`,
  );

const app = buildApp({} as Pool, { closePool: false });
let exampleCount = 0;
const operations = new Set<string>();
try {
  await app.ready();
  for (const [path, item] of Object.entries(contract.document.paths)) {
    if (!item) continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const op = item[method];
      if (!op) continue;
      if (
        !app.hasRoute({
          method: method.toUpperCase(),
          url: path.replace(/\{([^}]+)\}/g, ':$1'),
        })
      )
        throw new Error(`Documented route does not exist: ${method} ${path}`);
      operations.add(`${method.toUpperCase()} ${path}`);
      const body = op.requestBody as OpenAPIV3.RequestBodyObject | undefined;
      const media = body?.content['application/json'];
      const validateExamples = (
        media: OpenAPIV3.MediaTypeObject | undefined,
        label: string,
      ) => {
        if (!media?.schema) return;
        for (const [name, sample] of Object.entries(media.examples ?? {})) {
          if (!('value' in sample))
            throw new Error(`Unresolved example: ${name}`);
          contract.assertSchema(media.schema, sample.value, `${label} ${name}`);
          exampleCount++;
          if (label.endsWith('request')) {
            const validator =
              path === '/accounts'
                ? createAccountSchema
                : path === '/transfers'
                  ? transferSchema
                  : createTransactionSchema;
            if (!validator.safeParse(sample.value).success)
              throw new Error(
                `Documented request rejected by application validation: ${name}`,
              );
          }
        }
      };
      validateExamples(media, `${method} ${path} request`);
      for (const [status, response] of Object.entries(op.responses)) {
        validateExamples(
          (response as OpenAPIV3.ResponseObject).content?.['application/json'],
          `${method} ${path} ${status}`,
        );
      }
    }
  }
  const covered = new Set<string>();
  for (const item of collection.item) {
    const url = item.request.url
      .replace('{{base_url}}', 'http://localhost')
      .replaceAll(/\{\{[^}]+\}\}/g, '11111111-1111-4111-8111-111111111111');
    const found = contract.operation(item.request.method, url);
    covered.add(`${item.request.method} ${found.path}`);
  }
  for (const operation of operations)
    if (!covered.has(operation))
      throw new Error(`Postman collection omits ${operation}`);
  process.stdout.write(
    `OpenAPI valid; ${operations.size} operations match routes; ${exampleCount} contract and ${referenceExampleCount} reference examples validated; local reference links valid; Postman v2.1 schema and ${collection.item.length}-request coverage verified\n`,
  );
} finally {
  await app.close();
}
