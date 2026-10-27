import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { accountParams, validate } from '../../common/validation.js';
import { createAccountSchema } from './account.schema.js';
import { createAccount, getBalance } from './account.service.js';

export function accountRoutes(app: FastifyInstance, pool: Pool): void {
  app.post('/accounts', async (request, reply) => {
    const body = validate(createAccountSchema, request.body);
    return reply.code(201).send(await createAccount(pool, body.name));
  });
  app.get('/accounts/:id/balance', async (request) => {
    const { id } = validate(
      accountParams,
      request.params,
      'INVALID_ACCOUNT_ID',
    );
    return getBalance(pool, id);
  });
}
