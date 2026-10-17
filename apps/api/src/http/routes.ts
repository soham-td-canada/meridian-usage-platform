import type { FastifyInstance } from 'fastify';
import { denial } from '../../../../packages/authorization/src/index.js';
import { CAPABILITIES } from '../../../../packages/domain/src/index.js';
import type { ToolService } from '../tool-service.js';
import { denialReply, mapOutcome } from './error-mapping.js';

export const IDENTITY_HEADER = 'x-meridian-user-id';
const MAX_IDENTITY_LENGTH = 128;
const MAX_GROUP_LENGTH = 64;

const group = { type: 'string', minLength: 1, maxLength: MAX_GROUP_LENGTH } as const;
const period = { type: 'string', minLength: 1, maxLength: 16 } as const;

const usageQuery = {
  type: 'object',
  properties: { group, period },
  required: ['period'],
  additionalProperties: false,
} as const;

const topUsersQuery = {
  type: 'object',
  properties: { group, period, limit: { type: 'string', pattern: '^[0-9]{1,3}$' } },
  required: ['period'],
  additionalProperties: false,
} as const;

const capabilitiesQuery = {
  type: 'object',
  properties: { group },
  additionalProperties: false,
} as const;

const setCapabilitySchema = {
  params: {
    type: 'object',
    properties: {
      group,
      capability: { type: 'string', enum: [...CAPABILITIES] },
    },
    required: ['group', 'capability'],
    additionalProperties: false,
  },
  body: {
    type: 'object',
    properties: { enabled: { type: 'boolean' } },
    required: ['enabled'],
    additionalProperties: false,
  },
} as const;

interface UsageQuery {
  group?: string;
  period: string;
}
interface TopUsersQuery extends UsageQuery {
  limit?: string;
}

/** The identity header is the only identity input; anything but one short printable value is rejected. */
export function callerIdFrom(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTITY_LENGTH &&
    /^[\x21-\x7e]+$/.test(value)
    ? value
    : undefined;
}

const withGroup = (groupId: string | undefined): { group?: string } =>
  groupId === undefined ? {} : { group: groupId };

export function registerRoutes(app: FastifyInstance, service: ToolService): void {
  // Runs before schema validation so an anonymous caller never learns about request validation.
  app.addHook('onRequest', async (request, reply) => {
    if (callerIdFrom(request.headers[IDENTITY_HEADER]) === undefined) {
      const { status, body } = denialReply(denial('identity_unresolved'));
      return reply.code(status).send(body);
    }
    return undefined;
  });

  function invoke(
    headers: Readonly<Record<string, string | string[] | undefined>>,
    tool: string,
    args: unknown,
  ) {
    return mapOutcome(service.invoke(callerIdFrom(headers[IDENTITY_HEADER]) ?? '', tool, args));
  }

  app.get<{ Querystring: UsageQuery }>(
    '/api/usage-summary',
    { schema: { querystring: usageQuery } },
    async (request, reply) => {
      const { status, body } = invoke(request.headers, 'usage_summary', {
        ...withGroup(request.query.group),
        period: request.query.period,
      });
      return reply.code(status).send(body);
    },
  );

  app.get<{ Querystring: TopUsersQuery }>(
    '/api/top-users',
    { schema: { querystring: topUsersQuery } },
    async (request, reply) => {
      const { limit } = request.query;
      const { status, body } = invoke(request.headers, 'top_users', {
        ...withGroup(request.query.group),
        period: request.query.period,
        ...(limit === undefined ? {} : { limit: Number(limit) }),
      });
      return reply.code(status).send(body);
    },
  );

  app.get<{ Querystring: { group?: string } }>(
    '/api/capabilities',
    { schema: { querystring: capabilitiesQuery } },
    async (request, reply) => {
      const { status, body } = invoke(
        request.headers,
        'capability_status',
        withGroup(request.query.group),
      );
      return reply.code(status).send(body);
    },
  );

  app.post<{
    Params: { group: string; capability: string };
    Body: { enabled: boolean };
  }>(
    '/api/capabilities/:group/:capability',
    { schema: setCapabilitySchema },
    async (request, reply) => {
      const { status, body } = invoke(request.headers, 'set_capability', {
        group: request.params.group,
        capability: request.params.capability,
        enabled: request.body.enabled,
      });
      return reply.code(status).send(body);
    },
  );
}
