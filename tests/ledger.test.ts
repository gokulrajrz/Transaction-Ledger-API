import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { checkDatabase } from '../src/db/readiness.js';
import { createTestDatabase } from './setup/database.js';

let fixture: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: Pool;
let app: FastifyInstance;

beforeAll(async () => {
  fixture = await createTestDatabase();
  pool = fixture.pool;
  app = buildApp(pool, { closePool: false });
});
afterAll(async () => {
  if (app) await app.close();
  if (fixture) await fixture.stop();
});

async function account(name = 'Test account'): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/accounts',
    payload: { name },
  });
  expect(response.statusCode).toBe(201);
  return response.json().id;
}
async function post(
  id: string,
  amount = '10.00',
  type = 'credit',
  reference_id: string = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: `/accounts/${id}/transactions`,
    payload: { type, amount, reference_id, description: 'Test posting' },
  });
}
async function balance(id: string): Promise<string> {
  const response = await app.inject(`/accounts/${id}/balance`);
  expect(response.statusCode).toBe(200);
  return response.json().balance;
}
async function reconcile(id: string, expected?: string) {
  const result = await pool.query(
    `SELECT a.balance::text AS stored, coalesce(sum(CASE WHEN t.type = 'credit' THEN t.amount ELSE -t.amount END), 0)::numeric(18,2)::text AS calculated
    FROM ledger.accounts a LEFT JOIN ledger.transactions t ON t.account_id = a.id WHERE a.id = $1 GROUP BY a.id`,
    [id],
  );
  expect(result.rows[0].stored).toBe(result.rows[0].calculated);
  if (expected !== undefined) expect(result.rows[0].stored).toBe(expected);
}

describe('accounts', () => {
  it.each(['name', 'reference_id', 'description', 'transfer_reference'])(
    'rejects NUL in %s as invalid input without financial changes',
    async (field) => {
      const id = await account();
      const text = 'invalid\u0000text';
      const response =
        field === 'name'
          ? await app.inject({
              method: 'POST',
              url: '/accounts',
              payload: { name: text },
            })
          : field === 'transfer_reference'
            ? await app.inject({
                method: 'POST',
                url: '/transfers',
                payload: {
                  from_account_id: id,
                  to_account_id: await account(),
                  amount: '1',
                  reference_id: text,
                },
              })
            : await app.inject({
                method: 'POST',
                url: `/accounts/${id}/transactions`,
                payload: {
                  type: 'credit',
                  amount: '1',
                  reference_id: 'invalid-text',
                  [field]: text,
                },
              });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
      await reconcile(id, '0.00');
      expect(
        (await app.inject(`/accounts/${id}/transactions`)).json().data,
      ).toEqual([]);
    },
  );
  it('creates a generated UUID and timestamp with a zero string balance and trimmed name', async () => {
    const before = Date.now();
    const response = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: '  Alice  ' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      name: 'Alice',
      balance: '0.00',
      id: expect.any(String),
      created_at: expect.any(String),
    });
    expect(response.json().id).toMatch(/^[a-f0-9-]{36}$/);
    expect(Date.parse(response.json().created_at)).toBeGreaterThanOrEqual(
      before - 1000,
    );
    await reconcile(response.json().id, '0.00');
  });
  it.each([
    {},
    { name: '' },
    { name: ' \n\t' },
    { name: 'x'.repeat(201) },
    { name: 'A', balance: '0' },
    { name: 'A', id: randomUUID() },
    { name: 'A', created_at: '2020-01-01' },
    { name: 'A', extra: true },
  ])(
    'rejects invalid or system-controlled account properties',
    async (payload) => {
      const response = await app.inject({
        method: 'POST',
        url: '/accounts',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    },
  );
  it('returns invalid UUID and missing account errors on all account routes', async () => {
    for (const id of ['bad', randomUUID()]) {
      for (const [method, suffix, payload] of [
        ['GET', 'balance', undefined],
        ['GET', 'transactions', undefined],
        [
          'POST',
          'transactions',
          { type: 'credit', amount: '1', reference_id: 'ref' },
        ],
      ] as const) {
        const response = await app.inject({
          method,
          url: `/accounts/${id}/${suffix}`,
          ...(payload ? { payload } : {}),
        });
        expect(response.statusCode).toBe(id === 'bad' ? 400 : 404);
        expect(response.json().error.code).toBe(
          id === 'bad' ? 'INVALID_ACCOUNT_ID' : 'ACCOUNT_NOT_FOUND',
        );
      }
    }
  });
});

describe('postings and exact balances', () => {
  it('returns every assessed transaction field with unique generated IDs and system timestamps', async () => {
    const id = await account();
    const before = Date.now();
    const description = "Invoice payment: O'Reilly; -- retained as text";
    const response = await app.inject({
      method: 'POST',
      url: `/accounts/${id}/transactions`,
      payload: {
        type: 'credit',
        amount: '10.50',
        reference_id: 'complete-record',
        description,
      },
    });
    expect(response.statusCode).toBe(201);
    const entry = response.json();
    expect(entry).toEqual({
      id: expect.stringMatching(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      ),
      account_id: id,
      type: 'credit',
      amount: '10.50',
      description,
      reference_id: 'complete-record',
      created_at: expect.any(String),
      transfer_id: null,
    });
    expect(Date.parse(entry.created_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(entry.created_at)).toBeLessThanOrEqual(Date.now() + 1000);
    const second = await post(id, '0.50');
    expect(second.statusCode).toBe(201);
    expect(second.json().id).not.toBe(entry.id);
    for (const [field, value] of [
      ['id', randomUUID()],
      ['account_id', randomUUID()],
      ['created_at', '2000-01-01T00:00:00Z'],
      ['transfer_id', randomUUID()],
    ]) {
      const rejected = await app.inject({
        method: 'POST',
        url: `/accounts/${id}/transactions`,
        payload: {
          type: 'credit',
          amount: '1',
          reference_id: `forbidden-${field}`,
          [field!]: value,
        },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error.code).toBe('VALIDATION_ERROR');
    }
    const history = (await app.inject(`/accounts/${id}/transactions`)).json();
    expect(history.pagination.total_records).toBe(2);
    expect(history.data).toContainEqual(entry);
    await reconcile(id, '11.00');
  });
  it('uses the same sanitized error envelope for all assessed HTTP failure categories', async () => {
    const id = await account();
    await post(id, '10', 'credit', 'error-envelope-reference');
    const responses = [
      [
        await app.inject(`/accounts/${randomUUID()}/balance`),
        404,
        'ACCOUNT_NOT_FOUND',
      ],
      [
        await app.inject('/accounts/invalid/balance'),
        400,
        'INVALID_ACCOUNT_ID',
      ],
      [await post(id, '1', 'invalid'), 400, 'VALIDATION_ERROR'],
      [await post(id, '0'), 400, 'VALIDATION_ERROR'],
      [
        await app.inject({
          method: 'POST',
          url: `/accounts/${id}/transactions`,
          payload: { type: 'credit', amount: '1' },
        }),
        400,
        'VALIDATION_ERROR',
      ],
      [
        await app.inject(`/accounts/${id}/transactions?page=0`),
        400,
        'INVALID_PAGINATION',
      ],
      [await post(id, '11', 'debit'), 422, 'INSUFFICIENT_BALANCE'],
      [
        await post(id, '1', 'credit', 'error-envelope-reference'),
        409,
        'DUPLICATE_TRANSACTION',
      ],
      [
        await app.inject({
          method: 'POST',
          url: '/accounts',
          headers: { 'content-type': 'application/json' },
          payload: '{broken-json',
        }),
        400,
        'VALIDATION_ERROR',
      ],
      [
        await app.inject({ method: 'POST', url: '/accounts', payload: [] }),
        400,
        'VALIDATION_ERROR',
      ],
    ] as const;
    for (const [response, status, code] of responses) {
      expect(response.statusCode).toBe(status);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.json()).toEqual({
        error: {
          code,
          message: expect.any(String),
          details: expect.any(Array),
        },
      });
      expect(response.json().error.message.length).toBeGreaterThan(0);
      expect(response.body).not.toMatch(
        /password|stack|node_modules|postgresql:\/\//i,
      );
    }
    await reconcile(id, '10.00');
  });
  it('executes the mandatory 100 + 50 - 30 - 20 sequence and reconciles', async () => {
    const id = await account();
    for (const [amount, type] of [
      ['100', 'credit'],
      ['50', 'credit'],
      ['30', 'debit'],
      ['20', 'debit'],
    ]) {
      expect((await post(id, amount, type)).statusCode).toBe(201);
      await reconcile(id);
    }
    expect(await balance(id)).toBe('100.00');
    await reconcile(id, '100.00');
  });
  it('handles fractional cents and values beyond JS safe integer precision exactly', async () => {
    const id = await account();
    expect((await post(id, '9007199254740993.10')).statusCode).toBe(201);
    expect((await post(id, '0.20')).statusCode).toBe(201);
    expect((await post(id, '0.01', 'debit')).statusCode).toBe(201);
    await reconcile(id, '9007199254740993.29');
  });
  it('rejects overdrafts without changing balance or ledger', async () => {
    const id = await account();
    await post(id, '100');
    const response = await post(id, '100.01', 'debit');
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toEqual({
      code: 'INSUFFICIENT_BALANCE',
      message: 'Insufficient balance for this debit',
      details: [],
    });
    expect(
      (await app.inject(`/accounts/${id}/transactions`)).json().pagination
        .total_records,
    ).toBe(1);
    await reconcile(id, '100.00');
  });
  it.each([
    '0',
    '-1',
    '1.001',
    '1e3',
    'NaN',
    'Infinity',
    'abc',
    '10000000000000000',
  ])('rejects invalid money %s without writing', async (amount) => {
    const id = await account();
    expect((await post(id, amount)).statusCode).toBe(400);
    await reconcile(id, '0.00');
  });
  it.each([
    { type: 'other', amount: '1', reference_id: 'a' },
    { type: 'credit', amount: 1, reference_id: 'a' },
    { type: 'credit', amount: '1' },
    { type: 'credit', amount: '1', reference_id: ' ' },
    {
      type: 'credit',
      amount: '1',
      reference_id: 'null-description',
      description: null,
    },
    {
      type: 'credit',
      amount: '1',
      reference_id: 'a',
      account_id: randomUUID(),
    },
  ])('rejects invalid transaction bodies', async (payload) => {
    const id = await account();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/accounts/${id}/transactions`,
          payload,
        })
      ).statusCode,
    ).toBe(400);
    await reconcile(id, '0.00');
  });
  it('returns the original transaction on a duplicate, even when new debit would overdraw', async () => {
    const id = await account();
    const first = await post(id, '10', 'credit', 'duplicate');
    expect(first.statusCode).toBe(201);
    const duplicate = await post(id, '1000', 'debit', 'duplicate');
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('DUPLICATE_TRANSACTION');
    expect(duplicate.json().error.details).toEqual([first.json()]);
    await reconcile(id, '10.00');
    const other = await account();
    expect((await post(other, '10', 'credit', 'duplicate')).statusCode).toBe(
      201,
    );
    await reconcile(other, '10.00');
  });
  it('preserves case and whitespace of reference IDs consistently', async () => {
    const id = await account();
    for (const ref of ['Ref', 'ref', ' ref '])
      expect((await post(id, '1', 'credit', ref)).statusCode).toBe(201);
    expect((await post(id, '1', 'credit', ' ref ')).statusCode).toBe(409);
    await reconcile(id, '3.00');
  });
  it('generates an omitted description and rejects mutation routes', async () => {
    const id = await account();
    const response = await app.inject({
      method: 'POST',
      url: `/accounts/${id}/transactions`,
      payload: { type: 'credit', amount: '1', reference_id: 'no-description' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().description).toBe('Credit transaction');
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const)
      expect(
        (
          await app.inject({
            method,
            url: `/accounts/${id}/transactions/${response.json().id}`,
          })
        ).statusCode,
      ).toBe(404);
  });
  it.each([
    ['credit', undefined, 'Credit transaction'],
    ['credit', '', 'Credit transaction'],
    ['credit', ' \n\t', 'Credit transaction'],
    ['debit', undefined, 'Debit transaction'],
    ['debit', '', 'Debit transaction'],
    ['debit', ' \n\t', 'Debit transaction'],
  ] as const)(
    'generates a description for %s with missing or blank input %s',
    async (type, description, expected) => {
      const id = await account();
      if (type === 'debit') await post(id, '10');
      const response = await app.inject({
        method: 'POST',
        url: `/accounts/${id}/transactions`,
        payload: {
          type,
          amount: '1',
          reference_id: 'generated-description',
          ...(description === undefined ? {} : { description }),
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().description).toBe(expected);
      const history = (await app.inject(`/accounts/${id}/transactions`)).json();
      expect(
        history.data.find(
          (row: { id: string }) => row.id === response.json().id,
        ).description,
      ).toBe(expected);
      await reconcile(id, type === 'credit' ? '1.00' : '9.00');
    },
  );
});

describe('history', () => {
  it('handles empty histories and default pagination', async () => {
    const id = await account();
    expect((await app.inject(`/accounts/${id}/transactions`)).json()).toEqual({
      data: [],
      pagination: { page: 1, limit: 20, total_records: 0, total_pages: 0 },
    });
  });
  it('filters, pages and sorts by timestamp with deterministic UUID ties', async () => {
    const id = await account();
    const ids = [
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000003',
    ];
    // Direct fixture inserts set equal timestamps to exercise the secondary key without mutating immutable rows.
    for (let i = 0; i < ids.length; i++)
      await pool.query(
        `INSERT INTO ledger.transactions (id,account_id,type,amount,reference_id,description,created_at) VALUES ($1,$2,$3,1,$4,'Ordering fixture','2025-01-01T00:00:00Z')`,
        [ids[i], id, i === 1 ? 'debit' : 'credit', `tie-${i}`],
      );
    await pool.query('UPDATE ledger.accounts SET balance = 1 WHERE id = $1', [
      id,
    ]);
    const page = (
      await app.inject(`/accounts/${id}/transactions?page=1&limit=2`)
    ).json();
    expect(page.data.map((entry: { id: string }) => entry.id)).toEqual([
      ids[2],
      ids[1],
    ]);
    expect(page.pagination).toEqual({
      page: 1,
      limit: 2,
      total_records: 3,
      total_pages: 2,
    });
    expect(
      (await app.inject(`/accounts/${id}/transactions?page=2&limit=2`)).json()
        .data[0].id,
    ).toBe(ids[0]);
    const credits = (
      await app.inject(`/accounts/${id}/transactions?type=credit&limit=1`)
    ).json();
    expect(credits.data[0].id).toBe(ids[2]);
    expect(credits.pagination.total_records).toBe(2);
    expect(credits.pagination.total_pages).toBe(2);
    const debits = (
      await app.inject(`/accounts/${id}/transactions?type=debit`)
    ).json();
    expect(debits.data).toHaveLength(1);
    expect(debits.data[0].type).toBe('debit');
    expect(
      (await app.inject(`/accounts/${id}/transactions?page=9`)).json().data,
    ).toEqual([]);
    const newest = await post(id, '1');
    expect(
      (await app.inject(`/accounts/${id}/transactions`)).json().data[0].id,
    ).toBe(newest.json().id);
    await reconcile(id, '2.00');
  });
  it.each([
    'page=0',
    'page=-1',
    'page=1.5',
    'page=1e2',
    'page=2147483648',
    'limit=0',
    'limit=101',
    'limit=x',
    'type=bad',
    'page=',
    'limit=1&limit=2',
    'extra=1',
  ])('rejects invalid pagination %s', async (query) => {
    const id = await account();
    const response = await app.inject(`/accounts/${id}/transactions?${query}`);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_PAGINATION');
  });
});

describe('real PostgreSQL concurrency', () => {
  it('commits exactly five of ten simultaneous debits of 20 from 100', async () => {
    const id = await account();
    await post(id, '100');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => post(id, '20', 'debit')),
    );
    expect(results.filter((result) => result.statusCode === 201)).toHaveLength(
      5,
    );
    expect(results.filter((result) => result.statusCode === 422)).toHaveLength(
      5,
    );
    const history = (
      await app.inject(`/accounts/${id}/transactions?type=debit`)
    ).json();
    expect(history.pagination.total_records).toBe(5);
    expect(
      new Set(
        history.data.map((row: { reference_id: string }) => row.reference_id),
      ).size,
    ).toBe(5);
    await reconcile(id, '0.00');
  });
  it('commits exactly one of ten concurrent identical credit references', async () => {
    const id = await account();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(id, '20', 'credit', 'parallel-duplicate'),
      ),
    );
    expect(results.filter((result) => result.statusCode === 201)).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.statusCode === 409)).toHaveLength(
      9,
    );
    expect(
      (await app.inject(`/accounts/${id}/transactions`)).json().pagination
        .total_records,
    ).toBe(1);
    await reconcile(id, '20.00');
  });
  it('allows an unrelated account to post while another account is locked', async () => {
    const blocked = await account();
    const independent = await account();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT id FROM ledger.accounts WHERE id=$1 FOR UPDATE',
        [blocked],
      );
      expect((await post(independent, '1')).statusCode).toBe(201);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    await reconcile(independent, '1.00');
  });
});

describe('atomic transfers', () => {
  async function transfer(
    from: string,
    to: string,
    amount = '30',
    reference_id: string = randomUUID(),
  ) {
    return app.inject({
      method: 'POST',
      url: '/transfers',
      payload: {
        from_account_id: from,
        to_account_id: to,
        amount,
        reference_id,
      },
    });
  }
  it('posts two linked rows and conserves money', async () => {
    const from = await account('Alice');
    const to = await account('Bob');
    await post(from, '100');
    await post(to, '50');
    const response = await transfer(from, to);
    expect(response.statusCode).toBe(201);
    const result = response.json();
    expect(result).toMatchObject({
      from_account_id: from,
      to_account_id: to,
      amount: '30.00',
    });
    expect(result.transactions).toHaveLength(2);
    expect(
      result.transactions.map((row: { type: string }) => row.type),
    ).toEqual(['debit', 'credit']);
    for (const row of result.transactions)
      expect(row.transfer_id).toBe(result.id);
    expect(result.transactions[0].description).toBe('Transfer to Bob');
    expect(result.transactions[1].description).toBe('Transfer from Alice');
    expect(
      (await app.inject(`/accounts/${from}/transactions`)).json().data[0]
        .description,
    ).toBe('Transfer to Bob');
    expect(
      (await app.inject(`/accounts/${to}/transactions`)).json().data[0]
        .description,
    ).toBe('Transfer from Alice');
    await reconcile(from, '70.00');
    await reconcile(to, '80.00');
    const total = await pool.query(
      'SELECT sum(balance)::text AS total FROM ledger.accounts WHERE id=ANY($1::uuid[])',
      [[from, to]],
    );
    expect(total.rows[0].total).toBe('150.00');
    await expect(
      pool.query('DELETE FROM ledger.transfers WHERE id=$1', [result.id]),
    ).rejects.toMatchObject({ code: '55000' });
  });
  it('rejects same-account transfer including differently cased UUIDs', async () => {
    const id = await account();
    const response = await transfer(id, id.toUpperCase());
    expect(response.statusCode).toBe(400);
    await reconcile(id, '0.00');
  });
  it('rejects missing source, missing destination and insufficient funds without partial writes', async () => {
    const from = await account();
    const to = await account();
    for (const [a, b, status] of [
      [randomUUID(), to, 404],
      [from, randomUUID(), 404],
      [from, to, 422],
    ] as const) {
      const response = await transfer(a, b);
      expect(response.statusCode).toBe(status);
    }
    await reconcile(from, '0.00');
    await reconcile(to, '0.00');
    expect(
      (await app.inject(`/accounts/${from}/transactions`)).json().data,
    ).toHaveLength(0);
    expect(
      (await app.inject(`/accounts/${to}/transactions`)).json().data,
    ).toHaveLength(0);
  });
  it('rejects duplicate transfers and allows the same reference on another source', async () => {
    const from = await account();
    const to = await account();
    await post(from, '100');
    const first = await transfer(from, to, '30', 'stable-transfer');
    expect(first.statusCode).toBe(201);
    const second = await transfer(from, to, '70', 'stable-transfer');
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('DUPLICATE_TRANSFER');
    expect(second.json().error.details[0].id).toBe(first.json().id);
    await reconcile(from, '70.00');
    await reconcile(to, '30.00');
    expect((await transfer(to, from, '10', 'stable-transfer')).statusCode).toBe(
      201,
    );
    await reconcile(from, '80.00');
    await reconcile(to, '20.00');
  });
  it('serializes concurrent duplicate transfers to one committed pair', async () => {
    const from = await account();
    const to = await account();
    await post(from, '100');
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        transfer(from, to, '20', 'parallel-transfer'),
      ),
    );
    expect(
      results.filter((response) => response.statusCode === 201),
    ).toHaveLength(1);
    expect(
      results.filter((response) => response.statusCode === 409),
    ).toHaveLength(9);
    await reconcile(from, '80.00');
    await reconcile(to, '20.00');
    expect(
      (await app.inject(`/accounts/${to}/transactions`)).json().pagination
        .total_records,
    ).toBe(1);
  });
  it('handles concurrent opposing transfers without deadlock or money loss', async () => {
    const a = await account();
    const b = await account();
    await post(a, '100');
    await post(b, '100');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0 ? transfer(a, b, '10') : transfer(b, a, '10'),
      ),
    );
    expect(results.map((response) => response.statusCode)).toEqual(
      Array(10).fill(201),
    );
    await reconcile(a, '100.00');
    await reconcile(b, '100.00');
  });
  it('prevents concurrent transfers from overdrawing the source', async () => {
    const from = await account();
    const to = await account();
    await post(from, '100');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => transfer(from, to, '20')),
    );
    expect(
      results.filter((response) => response.statusCode === 201),
    ).toHaveLength(5);
    expect(
      results.filter((response) => response.statusCode === 422),
    ).toHaveLength(5);
    await reconcile(from, '0.00');
    await reconcile(to, '100.00');
  });
  it('rolls back source debit, both entries and metadata if destination overflows', async () => {
    const from = await account();
    const to = await account();
    await post(from, '100');
    await post(to, '9999999999999999.99');
    expect(
      (await transfer(from, to, '1', 'overflow-transfer')).statusCode,
    ).toBe(500);
    await reconcile(from, '100.00');
    await reconcile(to, '9999999999999999.99');
    expect(
      (
        await pool.query(
          'SELECT * FROM ledger.transfers WHERE from_account_id=$1',
          [from],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (await app.inject(`/accounts/${from}/transactions`)).json().pagination
        .total_records,
    ).toBe(1);
    expect(
      (await app.inject(`/accounts/${to}/transactions`)).json().pagination
        .total_records,
    ).toBe(1);
  });
  it('keeps the generated posting reference namespace reserved', async () => {
    const id = await account();
    expect(
      (await post(id, '1', 'credit', 'transfer/spoof/debit')).statusCode,
    ).toBe(400);
    await reconcile(id, '0.00');
  });
  it('validates transfer UUIDs, money, reference and unknown properties', async () => {
    const from = await account();
    const to = await account();
    const valid = {
      from_account_id: from,
      to_account_id: to,
      amount: '1',
      reference_id: 'ref',
    };
    for (const override of [
      { from_account_id: 'bad' },
      { amount: 1 },
      { amount: '0' },
      { amount: '1.001' },
      { reference_id: '' },
      { extra: true },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/transfers',
        payload: { ...valid, ...override },
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('database integrity and rollback', () => {
  it.each([null, '', ' \n\t'])(
    'requires a nonblank description on future SQL inserts: %s',
    async (description) => {
      const id = await account();
      await expect(
        pool.query(
          "INSERT INTO ledger.transactions (account_id,type,amount,reference_id,description) VALUES ($1,'credit',1,'missing-description',$2)",
          [id, description],
        ),
      ).rejects.toMatchObject({
        code: '23514',
        constraint: 'transactions_description_required',
      });
      await reconcile(id, '0.00');
    },
  );
  it('adds the description requirement without rewriting legacy immutable transactions', async () => {
    const legacy = await createTestDatabase({ migrate: false });
    let legacyApp: FastifyInstance | undefined;
    try {
      const migration = '20261028000300_require_transaction_descriptions.sql';
      const prior = (await readdir('supabase/migrations'))
        .filter((file) => file.endsWith('.sql') && file < migration)
        .sort();
      for (const file of prior)
        await legacy.pool.query(
          await readFile(`supabase/migrations/${file}`, 'utf8'),
        );
      const client = await legacy.pool.connect();
      let original;
      let id: string;
      try {
        await client.query('BEGIN');
        const created = await client.query(
          "INSERT INTO ledger.accounts (name) VALUES ('Legacy account') RETURNING id",
        );
        id = created.rows[0].id;
        original = (
          await client.query(
            "INSERT INTO ledger.transactions (account_id,type,amount,reference_id) VALUES ($1,'credit',1,'legacy-null-description') RETURNING *",
            [id],
          )
        ).rows[0];
        await client.query('UPDATE ledger.accounts SET balance=1 WHERE id=$1', [
          id,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      expect(original.description).toBeNull();
      await legacy.pool.query(
        await readFile(`supabase/migrations/${migration}`, 'utf8'),
      );
      expect(
        (
          await legacy.pool.query(
            'SELECT * FROM ledger.transactions WHERE id=$1',
            [original.id],
          )
        ).rows[0],
      ).toEqual(original);
      await expect(
        legacy.pool.query(
          "UPDATE ledger.transactions SET description='Backfilled' WHERE id=$1",
          [original.id],
        ),
      ).rejects.toMatchObject({ code: '55000' });
      legacyApp = buildApp(legacy.pool, { closePool: false });
      const response = await legacyApp.inject({
        method: 'POST',
        url: `/accounts/${id}/transactions`,
        payload: {
          type: 'credit',
          amount: '1',
          reference_id: 'new-generated-description',
        },
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().description).toBe('Credit transaction');
      expect(
        (await legacyApp.inject(`/accounts/${id}/balance`)).json().balance,
      ).toBe('2.00');
      const history = (
        await legacyApp.inject(`/accounts/${id}/transactions`)
      ).json().data;
      expect(
        history.find((row: { id: string }) => row.id === original.id)
          .description,
      ).toBeNull();
    } finally {
      if (legacyApp) await legacyApp.close();
      await legacy.stop();
    }
  });
  it('fails readiness when a required migration column is missing', async () => {
    await pool.query(
      'ALTER TABLE ledger.transactions RENAME COLUMN transfer_id TO unavailable_transfer_id',
    );
    try {
      await expect(checkDatabase(pool)).rejects.toMatchObject({
        code: '42703',
      });
      const response = await app.inject('/ready');
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('DATABASE_UNAVAILABLE');
      expect((await app.inject('/health')).statusCode).toBe(200);
    } finally {
      await pool.query(
        'ALTER TABLE ledger.transactions RENAME COLUMN unavailable_transfer_id TO transfer_id',
      );
    }
    expect((await app.inject('/ready')).statusCode).toBe(200);
  });
  it('grants runtime operations while denying system fields, ledger mutation and DDL', async () => {
    const role = `ledger_runtime_test_${randomUUID().replaceAll('-', '')}`;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE ROLE "${role}" NOLOGIN`);
      // PostgreSQL 16+ CREATEROLE logins do not automatically receive SET access
      // to roles they create. Give the test administrator only that access.
      await client.query(`GRANT "${role}" TO CURRENT_USER WITH SET TRUE`);
      const grants = (
        await readFile('docs/runtime-grants.sql', 'utf8')
      ).replaceAll('ledger_runtime', `"${role}"`);
      await client.query(grants);
      await client.query(`SET LOCAL ROLE "${role}"`);
      const created = await client.query(
        "INSERT INTO ledger.accounts (name) VALUES ('Least privilege') RETURNING *",
      );
      const id: string = created.rows[0].id;
      await client.query(
        'SELECT id FROM ledger.accounts WHERE id=$1 FOR UPDATE',
        [id],
      );
      await client.query(
        "INSERT INTO ledger.transactions (account_id,type,amount,reference_id,description) VALUES ($1,'credit',10,'runtime','Runtime permission fixture')",
        [id],
      );
      await client.query(
        'UPDATE ledger.accounts SET balance=balance+10 WHERE id=$1',
        [id],
      );
      const result = await client.query(
        'SELECT balance FROM ledger.accounts WHERE id=$1',
        [id],
      );
      expect(result.rows[0].balance).toBe('10.00');
      for (const sql of [
        "INSERT INTO ledger.accounts (name,balance) VALUES ('forbidden',100)",
        'UPDATE ledger.transactions SET amount=100',
        'DELETE FROM ledger.transactions',
        'TRUNCATE ledger.transactions',
        'CREATE TABLE ledger.forbidden (id int)',
      ]) {
        await client.query('SAVEPOINT denied_operation');
        await expect(client.query(sql)).rejects.toMatchObject({
          code: '42501',
        });
        await client.query('ROLLBACK TO SAVEPOINT denied_operation');
      }
    } finally {
      // Role creation and all fixture data are rolled back together.
      await client.query('ROLLBACK');
      client.release();
    }
  });
  it('verifies numeric types, schema constraints and the history index', async () => {
    const columns = await pool.query(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale FROM information_schema.columns WHERE table_schema='ledger'`,
    );
    for (const [table, column] of [
      ['accounts', 'balance'],
      ['transactions', 'amount'],
    ])
      expect(columns.rows).toContainEqual(
        expect.objectContaining({
          table_name: table,
          column_name: column,
          data_type: 'numeric',
          numeric_precision: 18,
          numeric_scale: 2,
        }),
      );
    const constraints = await pool.query(
      `SELECT conname, contype FROM pg_constraint WHERE connamespace = 'ledger'::regnamespace`,
    );
    for (const type of ['p', 'f', 'u', 'c'])
      expect(constraints.rows.some((row) => row.contype === type)).toBe(true);
    const indexes = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='ledger' AND indexname='idx_transactions_account_history'`,
    );
    expect(indexes.rows[0].indexdef).toContain(
      '(account_id, created_at DESC, id DESC)',
    );
  });
  it('enforces checks, foreign keys, unique references and delete restriction', async () => {
    const id = await account();
    await post(id, '10', 'credit', 'unique');
    await expect(
      pool.query('UPDATE ledger.accounts SET balance=-1 WHERE id=$1', [id]),
    ).rejects.toMatchObject({
      code: '23514',
      constraint: 'accounts_balance_check',
    });
    await expect(
      pool.query("UPDATE ledger.accounts SET balance='NaN' WHERE id=$1", [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query("INSERT INTO ledger.accounts (name) VALUES (' ')"),
    ).rejects.toMatchObject({ code: '23514' });
    for (const [accountId, type, amount, ref, code] of [
      [randomUUID(), 'credit', '1', 'fk', '23503'],
      [id, 'bad', '1', 'type', '23514'],
      [id, 'credit', '0', 'zero', '23514'],
      [id, 'credit', '-1', 'negative', '23514'],
      [id, 'credit', 'NaN', 'nan', '23514'],
      [id, 'credit', '1', '', '23514'],
      [id, 'credit', '1', 'unique', '23505'],
    ]) {
      await expect(
        pool.query(
          "INSERT INTO ledger.transactions (account_id,type,amount,reference_id,description) VALUES ($1,$2,$3,$4,'Constraint fixture')",
          [accountId, type, amount, ref],
        ),
      ).rejects.toMatchObject({ code });
    }
    await expect(
      pool.query('DELETE FROM ledger.accounts WHERE id=$1', [id]),
    ).rejects.toMatchObject({ code: '23503' });
    await reconcile(id, '10.00');
  });
  it('rejects UPDATE and DELETE even through direct SQL', async () => {
    const id = await account();
    const entry = (await post(id)).json();
    const other = await account();
    for (const [assignment, value] of [
      ['type=$2', 'debit'],
      ['amount=$2', '999.99'],
      ['description=$2', 'changed'],
      ['reference_id=$2', 'changed-reference'],
      ['account_id=$2', other],
      ['created_at=$2', '2000-01-01T00:00:00Z'],
    ]) {
      await expect(
        pool.query(`UPDATE ledger.transactions SET ${assignment} WHERE id=$1`, [
          entry.id,
          value,
        ]),
      ).rejects.toMatchObject({ code: '55000' });
    }
    await expect(
      pool.query('DELETE FROM ledger.transactions WHERE id=$1', [entry.id]),
    ).rejects.toMatchObject({ code: '55000' });
    expect(
      (await app.inject(`/accounts/${id}/transactions`)).json().data,
    ).toEqual([entry]);
    await reconcile(id, '10.00');
  });
  it('preserves balance and ledger when the ledger insertion itself fails', async () => {
    const id = await account();
    await post(id, '10');
    await pool.query(`CREATE FUNCTION ledger.test_reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.reference_id = 'forced-entry-insert' THEN RAISE EXCEPTION 'injected insertion failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_reject_insert BEFORE INSERT ON ledger.transactions FOR EACH ROW EXECUTE FUNCTION ledger.test_reject_insert()`);
    try {
      const response = await post(id, '5', 'credit', 'forced-entry-insert');
      expect(response.statusCode).toBe(500);
      expect(response.json().error.code).toBe('DATABASE_ERROR');
      expect(response.body).not.toContain('injected insertion failure');
      await reconcile(id, '10.00');
      expect(
        (await app.inject(`/accounts/${id}/transactions`)).json().pagination
          .total_records,
      ).toBe(1);
    } finally {
      await pool.query(
        'DROP TRIGGER test_reject_insert ON ledger.transactions; DROP FUNCTION ledger.test_reject_insert()',
      );
    }
    expect(
      (await post(id, '5', 'credit', 'forced-entry-insert')).statusCode,
    ).toBe(201);
    await reconcile(id, '15.00');
    expect(pool.waitingCount).toBe(0);
  });
  it('rolls back the inserted ledger row when balance numeric overflows', async () => {
    const id = await account();
    expect((await post(id, '9999999999999999.99')).statusCode).toBe(201);
    const overflow = await post(id, '0.01');
    expect(overflow.statusCode).toBe(500);
    expect(overflow.json().error.code).toBe('DATABASE_ERROR');
    expect(
      (await app.inject(`/accounts/${id}/transactions`)).json().pagination
        .total_records,
    ).toBe(1);
    await reconcile(id, '9999999999999999.99');
  });
  it('rolls back after a controlled balance update failure and returns the connection', async () => {
    const id = await account();
    await pool.query(
      "UPDATE ledger.accounts SET name='fail-balance-update' WHERE id=$1",
      [id],
    );
    await pool.query(`CREATE FUNCTION ledger.test_reject_balance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.name = 'fail-balance-update' THEN RAISE EXCEPTION 'injected update failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_reject_balance BEFORE UPDATE ON ledger.accounts FOR EACH ROW EXECUTE FUNCTION ledger.test_reject_balance()`);
    try {
      const response = await post(id, '10', 'credit', 'rollback-ref');
      expect(response.statusCode).toBe(500);
      await reconcile(id, '0.00');
      expect(
        (await app.inject(`/accounts/${id}/transactions`)).json().data,
      ).toEqual([]);
    } finally {
      await pool.query(
        'DROP TRIGGER test_reject_balance ON ledger.accounts; DROP FUNCTION ledger.test_reject_balance()',
      );
    }
    expect((await post(id, '10', 'credit', 'rollback-ref')).statusCode).toBe(
      201,
    );
    await reconcile(id, '10.00');
    expect(pool.waitingCount).toBe(0);
    expect(pool.idleCount).toBe(pool.totalCount);
  });
  it('serves all assessment endpoints and transfer flows over real network HTTP', async () => {
    expect((await app.inject('/health')).json()).toEqual({ status: 'ok' });
    expect((await app.inject('/ready')).json()).toEqual({ status: 'ready' });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Real HTTP' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      balance: '0.00',
      name: 'Real HTTP',
    });
    const send = async (method: string, path: string, payload?: unknown) => {
      const result = await fetch(`${address}${path}`, {
        method,
        ...(payload === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }),
      });
      return { status: result.status, data: await result.json() };
    };
    const source = await send('POST', '/accounts', { name: 'HTTP source' });
    const destination = await send('POST', '/accounts', {
      name: 'HTTP destination',
    });
    expect(source.status).toBe(201);
    expect(destination.status).toBe(201);
    expect(source.data.id).not.toBe(destination.data.id);
    const a = source.data.id as string;
    const b = destination.data.id as string;
    const deposit = await send('POST', `/accounts/${a}/transactions`, {
      type: 'credit',
      amount: '100',
      reference_id: 'http-deposit',
    });
    expect(deposit.status).toBe(201);
    expect(deposit.data.description).toBe('Credit transaction');
    expect(
      (
        await send('POST', `/accounts/${b}/transactions`, {
          type: 'credit',
          amount: '50',
          reference_id: 'http-deposit',
        })
      ).status,
    ).toBe(201);
    const duplicate = await send('POST', `/accounts/${a}/transactions`, {
      type: 'credit',
      amount: '100',
      reference_id: 'http-deposit',
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.data.error.details).toEqual([deposit.data]);
    const transfer = await send('POST', '/transfers', {
      from_account_id: a,
      to_account_id: b,
      amount: '30',
      reference_id: 'http-transfer',
    });
    expect(transfer.status).toBe(201);
    expect(transfer.data.transactions).toHaveLength(2);
    expect(
      transfer.data.transactions.map(
        (entry: { description: string }) => entry.description,
      ),
    ).toEqual(['Transfer to HTTP destination', 'Transfer from HTTP source']);
    expect((await send('GET', `/accounts/${a}/balance`)).data).toEqual({
      account_id: a,
      balance: '70.00',
    });
    expect((await send('GET', `/accounts/${b}/balance`)).data).toEqual({
      account_id: b,
      balance: '80.00',
    });
    expect(
      (
        await send('POST', `/accounts/${a}/transactions`, {
          type: 'debit',
          amount: '20',
          reference_id: 'http-withdrawal',
        })
      ).status,
    ).toBe(201);
    const insufficient = await send('POST', `/accounts/${a}/transactions`, {
      type: 'debit',
      amount: '51',
      reference_id: 'http-overdraft',
    });
    expect(insufficient.status).toBe(422);
    expect(insufficient.data.error.code).toBe('INSUFFICIENT_BALANCE');
    const history = await send(
      'GET',
      `/accounts/${a}/transactions?page=1&limit=1`,
    );
    expect(history.status).toBe(200);
    expect(history.data.pagination).toEqual({
      page: 1,
      limit: 1,
      total_records: 3,
      total_pages: 3,
    });
    expect(history.data.data[0].reference_id).toBe('http-withdrawal');
    expect(
      (await send('GET', `/accounts/${a}/transactions?type=credit`)).data
        .pagination.total_records,
    ).toBe(1);
    expect(
      (await send('GET', `/accounts/${a}/transactions?type=debit`)).data
        .pagination.total_records,
    ).toBe(2);
    expect(
      (await send('GET', `/accounts/${a}/transactions?page=0`)).status,
    ).toBe(400);
    expect(
      (await send('GET', `/accounts/${randomUUID()}/balance`)).status,
    ).toBe(404);
    expect((await send('GET', '/accounts/invalid/balance')).status).toBe(400);
    expect(
      (
        await send('POST', '/accounts', {
          name: 'Forbidden initial balance',
          balance: '1',
        })
      ).status,
    ).toBe(400);
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(
        (await send(method, `/accounts/${a}/transactions/${deposit.data.id}`))
          .status,
      ).toBe(404);
    }
    expect(
      (await send('GET', `/accounts/${a}/transactions?type=credit`)).data.data,
    ).toEqual([deposit.data]);
    await reconcile(a, '50.00');
    await reconcile(b, '80.00');
  });
  it('reconciles every account and transfer after the complete assessment scenarios', async () => {
    const accounts = await pool.query(`SELECT a.id FROM ledger.accounts a
      LEFT JOIN ledger.transactions t ON t.account_id=a.id GROUP BY a.id
      HAVING a.balance < 0 OR a.balance <> coalesce(sum(CASE WHEN t.type='credit' THEN t.amount ELSE -t.amount END),0)`);
    expect(accounts.rows).toEqual([]);
    const transfers = await pool.query(`SELECT f.id FROM ledger.transfers f
      LEFT JOIN ledger.transactions t ON t.transfer_id=f.id GROUP BY f.id
      HAVING count(t.id) <> 2
        OR count(*) FILTER (WHERE t.type='debit' AND t.account_id=f.from_account_id AND t.amount=f.amount) <> 1
        OR count(*) FILTER (WHERE t.type='credit' AND t.account_id=f.to_account_id AND t.amount=f.amount) <> 1
        OR coalesce(sum(CASE WHEN t.type='credit' THEN t.amount ELSE -t.amount END),0) <> 0`);
    expect(transfers.rows).toEqual([]);
  });
});
