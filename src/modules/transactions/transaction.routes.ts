import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { accountParams, validate } from '../../common/validation.js';
import {
  createTransactionSchema,
  historySchema,
} from './transaction.schema.js';
import { addTransaction, getHistory } from './transaction.service.js';

export function transactionRoutes(app: FastifyInstance, pool: Pool): void {
  app.post('/accounts/:id/transactions', async (request, reply) => {
    const { id } = validate(
      accountParams,
      request.params,
      'INVALID_ACCOUNT_ID',
    );
    const body = validate(createTransactionSchema, request.body);
    return reply.code(201).send(await addTransaction(pool, id, body));
  });
  app.get('/accounts/:id/transactions', async (request) => {
    const { id } = validate(
      accountParams,
      request.params,
      'INVALID_ACCOUNT_ID',
    );
    const query = validate(historySchema, request.query, 'INVALID_PAGINATION');
    return getHistory(pool, id, query);
  });
}
