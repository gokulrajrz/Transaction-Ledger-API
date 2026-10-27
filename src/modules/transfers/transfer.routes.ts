import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { validate } from '../../common/validation.js';
import { transferSchema } from './transfer.schema.js';
import { transferMoney } from './transfer.service.js';

export function transferRoutes(app: FastifyInstance, pool: Pool): void {
  app.post('/transfers', async (request, reply) => {
    const input = validate(transferSchema, request.body);
    return reply.code(201).send(await transferMoney(pool, input));
  });
}
