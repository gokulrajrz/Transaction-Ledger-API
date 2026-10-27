import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import type { OpenAPIV3 } from 'openapi-types';
import { parse } from 'yaml';
import { buildApp } from '../src/app.js';
import { loadContract } from '../scripts/documentation.js';
import {
  collectionPath,
  type Collection,
  type CollectionItem,
} from '../scripts/postman.js';
import { createTestDatabase } from './setup/database.js';

const query = vi.fn(() => {
  throw new Error('Documentation must not query the database');
});
const documentationApp = buildApp({ query } as unknown as Pool, {
  closePool: false,
});
beforeAll(async () => {
  await documentationApp.ready();
});
afterAll(async () => {
  await documentationApp.close();
});

describe('published API documentation', () => {
  it('serves Swagger UI and its self-hosted assets without database access', async () => {
    const html = await documentationApp.inject('/docs/');
    expect(html.statusCode).toBe(200);
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
    expect(html.body).toContain('swagger-ui');
    expect(html.body).toContain(
      '<title>Confluencr | API Documentation</title>',
    );
    for (const path of [
      '/docs/static/swagger-ui-bundle.js',
      '/docs/static/swagger-ui.css',
      '/docs/static/swagger-initializer.js',
    ]) {
      const response = await documentationApp.inject(path);
      expect(response.statusCode, path).toBe(200);
      expect(response.body.length).toBeGreaterThan(100);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('publishes identical JSON/YAML contracts from the checked-in specification', async () => {
    const json = await documentationApp.inject('/docs/json');
    const yaml = await documentationApp.inject('/docs/yaml');
    expect(json.statusCode).toBe(200);
    expect(yaml.statusCode).toBe(200);
    const expected = parse(await readFile('openapi.yaml', 'utf8'));
    expect(json.json()).toEqual(expected);
    expect(parse(yaml.body)).toEqual(expected);
    expect(
      Object.values(expected.paths)
        .flatMap((item) => Object.keys(item as object))
        .filter((method) => ['get', 'post'].includes(method)),
    ).toHaveLength(7);
  });

  it('does not expose repository files through documentation routes', async () => {
    for (const path of [
      '/docs/package.json',
      '/docs/src/app.ts',
      '/docs/.env',
    ]) {
      const response = await documentationApp.inject(path);
      expect(response.statusCode, path).toBe(404);
    }
  });
});

describe('Postman collection contract over real HTTP and PostgreSQL', () => {
  it('executes all 24 requests, assertions and response schemas in order', async () => {
    const contract = await loadContract();
    const collection = JSON.parse(
      await readFile(collectionPath, 'utf8'),
    ) as Collection;
    const fixture = await createTestDatabase();
    const app = buildApp(fixture.pool, { closePool: false });
    let assertionCount = 0;
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 });
      const variables = new Map(
        collection.variable.map((v) => [v.key, v.value]),
      );
      variables.set('base_url', origin);
      const replace = (text: string): string =>
        text.replace(/\{\{([^}]+)\}\}/g, (_match, key: string) => {
          if (key === '$guid') return randomUUID();
          const value = variables.get(key);
          if (!value) throw new Error(`Collection variable missing: ${key}`);
          return value;
        });
      const collectionVariables = {
        get: (key: string) => variables.get(key),
        set: (key: string, value: string) => variables.set(key, value),
        unset: (key: string) => variables.delete(key),
      };
      const runScripts = (
        item: CollectionItem,
        kind: 'prerequest' | 'test',
        response?: { status: number; body: unknown },
      ) => {
        for (const event of item.event.filter(
          (event) => event.listen === kind,
        )) {
          runInNewContext(
            event.script.exec.join('\n'),
            {
              pm: {
                collectionVariables,
                variables: { replaceIn: replace },
                response: {
                  json: () => response?.body,
                  to: {
                    have: {
                      status: (expected: number) =>
                        expect(response?.status, item.name).toBe(expected),
                    },
                  },
                },
                expect,
                test: (name: string, fn: () => void) => {
                  try {
                    fn();
                    assertionCount++;
                  } catch (error) {
                    throw new Error(name, { cause: error });
                  }
                },
              },
            },
            { timeout: 1000 },
          );
        }
      };
      const covered = new Set<string>();
      for (const item of collection.item) {
        runScripts(item, 'prerequest');
        const url = replace(item.request.url);
        const found = contract.operation(item.request.method, url);
        covered.add(`${item.request.method} ${found.path}`);
        const body = item.request.body
          ? replace(item.request.body.raw)
          : undefined;
        const response = await fetch(url, {
          method: item.request.method,
          headers: Object.fromEntries(
            item.request.header.map((h) => [h.key, h.value]),
          ),
          ...(body ? { body } : {}),
          signal: AbortSignal.timeout(10000),
        });
        const result: unknown = await response.json();
        const documented = found.operation.responses[
          String(response.status)
        ] as OpenAPIV3.ResponseObject | undefined;
        const responseSchema =
          documented?.content?.['application/json']?.schema;
        expect(
          responseSchema,
          `${item.name}: undocumented status ${response.status}`,
        ).toBeDefined();
        contract.assertSchema(responseSchema!, result, `${item.name} response`);
        if (response.status === 201) {
          const requestSchema = (
            found.operation.requestBody as OpenAPIV3.RequestBodyObject
          ).content['application/json']?.schema;
          contract.assertSchema(
            requestSchema!,
            JSON.parse(body!),
            `${item.name} request`,
          );
        }
        runScripts(item, 'test', { status: response.status, body: result });
      }
      expect(collection.item).toHaveLength(24);
      expect(covered.size).toBe(7);
      expect(assertionCount).toBe(48);
      // Reconcile stored projections with the immutable ledger after rejected retries.
      const totals = await fixture.pool.query<{
        name: string;
        balance: string;
        computed: string;
      }>(`
        SELECT a.name, a.balance::text, COALESCE(SUM(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0)::numeric(18,2)::text AS computed
        FROM ledger.accounts a LEFT JOIN ledger.transactions t ON t.account_id = a.id GROUP BY a.id ORDER BY a.name
      `);
      expect(totals.rows).toEqual([
        { name: 'Alice', balance: '50.00', computed: '50.00' },
        { name: 'Bob', balance: '80.00', computed: '80.00' },
      ]);
    } finally {
      await app.close();
      await fixture.stop();
    }
  }, 60000);
});
