import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found', details: [] },
    }),
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }
    const info = error as { code?: string; statusCode?: number };
    if (info.statusCode && info.statusCode >= 400 && info.statusCode < 500) {
      return reply.code(info.statusCode).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body or content type',
          details: [],
        },
      });
    }
    const databaseFailure =
      typeof info.code === 'string' && !info.code.startsWith('FST_');
    // Never log raw pg errors: detail, query, stack or message can contain user data/secrets.
    request.log.error(
      {
        event: 'request_failed',
        requestId: request.id,
        ...(info.code && /^[0-9A-Z]{5}$/.test(info.code)
          ? { sqlstate: info.code }
          : {}),
      },
      'Request failed',
    );
    return reply.code(500).send({
      error: {
        code: databaseFailure ? 'DATABASE_ERROR' : 'INTERNAL_SERVER_ERROR',
        message: 'The operation could not be completed',
        details: [],
      },
    });
  });
}
