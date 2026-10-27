import Fastify from 'fastify';
import type { Pool } from 'pg';
import { registerErrorHandler } from './common/error-handler.js';
import { accountRoutes } from './modules/accounts/account.routes.js';
import { transactionRoutes } from './modules/transactions/transaction.routes.js';
import { transferRoutes } from './modules/transfers/transfer.routes.js';
import { checkDatabase } from './db/readiness.js';

export function buildApp(
  pool: Pool,
  options: { logger?: boolean; closePool?: boolean } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 16384,
    logController: new Fastify.LogController({ disableRequestLogging: true }),
  });
  registerErrorHandler(app);
  accountRoutes(app, pool);
  transactionRoutes(app, pool);
  transferRoutes(app, pool);
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    try {
      await checkDatabase(pool);
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: 'Database is unavailable',
          details: [],
        },
      });
    }
  });
  if (options.closePool ?? true) app.addHook('onClose', async () => pool.end());
  return app;
}
