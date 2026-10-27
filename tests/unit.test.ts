import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { loadConfig } from '../src/config/env.js';
import { amount } from '../src/common/validation.js';
import { inTransaction } from '../src/db/transaction.js';
import { buildApp } from '../src/app.js';

describe('money contract', () => {
  it.each([
    ['10', '10.00'],
    ['10.5', '10.50'],
    ['10.50', '10.50'],
    ['0.01', '0.01'],
    ['9999999999999999.99', '9999999999999999.99'],
    [50, '50.00'],
    [10.5, '10.50'],
    [0.01, '0.01'],
    [90071992547409.9, '90071992547409.90'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991.00'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(amount.parse(input)).toBe(expected);
  });
  it.each([
    '0',
    '0.00',
    '-10',
    '10.999',
    '1e3',
    'abc',
    'NaN',
    'Infinity',
    '10000000000000000',
    ' 1',
    '1.',
    '.1',
    '01',
    '',
    0,
    -1,
    1.001,
    1.005,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    null,
  ])('rejects %s', (input) => {
    expect(amount.safeParse(input).success).toBe(false);
  });
});

describe('configuration', () => {
  const url = 'postgresql://user:secret@localhost:5432/postgres';
  it('validates defaults', () => {
    expect(loadConfig({ DATABASE_URL: url })).toMatchObject({
      PORT: 3000,
      DB_POOL_MAX: 10,
      DB_LOCK_TIMEOUT_MS: 5000,
    });
  });
  it.each([
    {},
    { DATABASE_URL: 'secret malformed url' },
    { DATABASE_URL: 'https://example.com' },
    { DATABASE_URL: `${url}?sslmode=no-verify` },
    { DATABASE_URL: `${url}?host=other` },
    { DATABASE_URL: url, DB_POOL_MAX: '0' },
    { DATABASE_URL: url, PORT: '70000' },
  ])('rejects invalid config without exposing inputs', (input) => {
    expect(() => loadConfig(input)).toThrow(
      'Invalid environment configuration',
    );
    try {
      loadConfig(input);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
});

describe('transaction client lifecycle', () => {
  function mockPool(query = vi.fn().mockResolvedValue({ rows: [] })) {
    const client = Object.assign(new EventEmitter(), {
      query,
      release: vi.fn(),
    });
    const pool = { connect: vi.fn().mockResolvedValue(client) };
    return { client, pool: pool as unknown as Pool };
  }
  it('commits and releases on success', async () => {
    const { pool, client } = mockPool();
    expect(await inTransaction(pool, async () => 'value')).toBe('value');
    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('rolls back and preserves the original error', async () => {
    const { pool, client } = mockPool();
    const failure = new Error('original');
    await expect(
      inTransaction(pool, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'ROLLBACK',
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('discards the client if rollback also fails', async () => {
    const { pool, client } = mockPool(
      vi
        .fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('rollback failed')),
    );
    const failure = new Error('original');
    await expect(
      inTransaction(pool, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('discards on ambiguous commit and never retries the operation', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('commit network failure'))
      .mockResolvedValueOnce({});
    const { pool, client } = mockPool(query);
    const work = vi
      .fn<(client: PoolClient) => Promise<void>>()
      .mockResolvedValue(undefined);
    await expect(inTransaction(pool, work)).rejects.toThrow(
      'commit network failure',
    );
    expect(work).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('discards when BEGIN fails', async () => {
    const { pool, client } = mockPool(
      vi.fn().mockRejectedValue(new Error('begin failed')),
    );
    await expect(inTransaction(pool, async () => {})).rejects.toThrow(
      'begin failed',
    );
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('does not try to release a client never acquired', async () => {
    const pool = {
      connect: vi.fn().mockRejectedValue(new Error('pool unavailable')),
    } as unknown as Pool;
    await expect(inTransaction(pool, async () => {})).rejects.toThrow(
      'pool unavailable',
    );
  });
});

describe('checked-out connection failures', () => {
  it('handles client errors without committing or leaking listeners', async () => {
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn().mockResolvedValue({ rows: [] }),
      release: vi.fn(),
    });
    const pool = { connect: async () => client } as unknown as Pool;
    const failure = new Error('transport disconnected');
    await expect(
      inTransaction(pool, async () => {
        client.emit('error', failure);
        return 'uncommitted';
      }),
    ).rejects.toBe(failure);
    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount('error')).toBe(0);
  });
});

describe('HTTP boundary without a database', () => {
  it('rejects bad input before acquiring resources and sanitizes malformed bodies', async () => {
    const pool = { query: vi.fn(), connect: vi.fn() } as unknown as Pool;
    const app = buildApp(pool, { closePool: false });
    for (const payload of [
      {},
      { name: ' ' },
      { name: 'A', balance: '10' },
      { name: 'A\u0000B' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/accounts',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_ERROR');
    }
    const malformed = await app.inject({
      method: 'POST',
      url: '/accounts',
      headers: { 'content-type': 'application/json' },
      payload: '{secret',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain('secret');
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    await app.close();
  });
  it('returns safe database errors and readiness without impacting health', async () => {
    const failure = Object.assign(
      new Error('password=secret SQL internal detail'),
      { code: '23505', constraint: 'unrelated_constraint' },
    );
    const pool = {
      query: vi.fn().mockRejectedValue(failure),
    } as unknown as Pool;
    const app = buildApp(pool, { closePool: false });
    const response = await app.inject({
      method: 'POST',
      url: '/accounts',
      payload: { name: 'A' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('DATABASE_ERROR');
    expect(response.body).not.toMatch(/secret|SQL|constraint/);
    expect((await app.inject('/ready')).statusCode).toBe(503);
    expect((await app.inject('/health')).statusCode).toBe(200);
    await app.close();
  });
});
