import Fastify, { type FastifyInstance } from 'fastify';
import type { ToolService } from '../tool-service.js';
import { INTERNAL_ERROR_BODY, INVALID_REQUEST_BODY, NOT_FOUND_BODY } from './error-mapping.js';
import { registerRoutes } from './routes.js';

const MAX_BODY_BYTES = 4096;

/**
 * Transport adapter over ToolService. Authorization, validation of domain values and persistence
 * all stay below `service`.
 */
export function buildServer(service: ToolService): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_BODY_BYTES,
    // Defaults would silently strip extra properties and coerce types; reject instead.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });

  app.setNotFoundHandler((_request, reply) => reply.code(404).send(NOT_FOUND_BODY));

  app.setErrorHandler((error: unknown, _request, reply) => {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.code(status === 413 || status === 415 ? status : 400).send(INVALID_REQUEST_BODY);
    }
    return reply.code(500).send(INTERNAL_ERROR_BODY);
  });

  registerRoutes(app, service);
  return app;
}
