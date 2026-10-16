import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createToolService } from '../../api/src/index.js';
import { provisionedHarness, userWith } from '../../api/test/helpers.js';
import { handleLine, handleMessage, type McpServerContext } from '../src/server.js';
import { GROUP_IDS, TOOL_DEFINITIONS } from '../src/tools.js';

function contextFor(
  environment: 'dev' | 'staging' | 'prod',
  actor: (h: ReturnType<typeof provisionedHarness>) => string | undefined,
): McpServerContext {
  const h = provisionedHarness(environment);
  return {
    serverName: 'meridian-usage-test',
    serverVersion: '0.0.0',
    actorUserId: actor(h),
    service: createToolService({
      environment,
      directory: h.directory,
      database: h.database,
      now: () => new Date('2026-10-01T12:00:00.000Z'),
    }),
  };
}

const admin = (h: ReturnType<typeof provisionedHarness>): string =>
  userWith(h.directory, 'platform_admin', 'it-platform').userId;

function call(context: McpServerContext, name: unknown, args?: unknown, id = 1): unknown {
  const params = args === undefined ? { name } : { name, arguments: args };
  return handleMessage(context, { jsonrpc: '2.0', id, method: 'tools/call', params });
}

function resultOf(response: unknown): Record<string, unknown> {
  const record = response as { result?: Record<string, unknown> };
  if (record.result === undefined) {
    throw new Error(`no result: ${JSON.stringify(response)}`);
  }
  return record.result;
}

function textOf(result: Record<string, unknown>): unknown {
  const content = result['content'] as readonly { type: string; text: string }[];
  expect(content).toHaveLength(1);
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0]?.text ?? 'null');
}

function errorCodeOf(response: unknown): number {
  const record = response as { error?: { code: number } };
  if (record.error === undefined) {
    throw new Error(`no error: ${JSON.stringify(response)}`);
  }
  return record.error.code;
}

describe('MCP protocol', () => {
  const context = contextFor('dev', admin);

  it('initializes with tools capability and negotiates the protocol version', () => {
    for (const version of ['2025-06-18', '2025-03-26', '2024-11-05']) {
      const response = handleMessage(context, {
        jsonrpc: '2.0',
        id: 'a',
        method: 'initialize',
        params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'x' } },
      });
      expect(response).toEqual({
        jsonrpc: '2.0',
        id: 'a',
        result: {
          protocolVersion: version,
          capabilities: { tools: {} },
          serverInfo: { name: 'meridian-usage-test', version: '0.0.0' },
        },
      });
    }
    const fallback = resultOf(
      handleMessage(context, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '1999-01-01' },
      }),
    );
    expect(fallback['protocolVersion']).toBe('2025-06-18');
  });

  it('never answers notifications', () => {
    expect(
      handleMessage(context, { jsonrpc: '2.0', method: 'notifications/initialized' }),
    ).toBeUndefined();
    expect(handleMessage(context, { jsonrpc: '2.0', method: 'whatever/else' })).toBeUndefined();
    expect(handleLine(context, '')).toBeUndefined();
    expect(handleLine(context, '   ')).toBeUndefined();
  });

  it('answers ping', () => {
    expect(handleMessage(context, { jsonrpc: '2.0', id: 3, method: 'ping' })).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: {},
    });
  });

  it('returns JSON-RPC errors for malformed traffic and unknown methods/tools', () => {
    expect(JSON.parse(handleLine(context, '{not json') ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    for (const bad of [
      [],
      'x',
      5,
      null,
      { id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: null, method: 'ping' },
      { jsonrpc: '2.0', id: {}, method: 'ping' },
    ]) {
      expect(errorCodeOf(handleMessage(context, bad))).toBe(-32600);
    }
    expect(
      errorCodeOf(handleMessage(context, { jsonrpc: '2.0', id: 1, method: 'resources/list' })),
    ).toBe(-32601);
    expect(errorCodeOf(call(context, 'nope', {}))).toBe(-32602);
    expect(errorCodeOf(call(context, 7, {}))).toBe(-32602);
    expect(
      errorCodeOf(handleMessage(context, { jsonrpc: '2.0', id: 1, method: 'tools/call' })),
    ).toBe(-32602);
    expect(
      errorCodeOf(
        handleMessage(context, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: [] }),
      ),
    ).toBe(-32602);
  });
});

describe('tools/list', () => {
  const context = contextFor('dev', admin);
  const contract = JSON.parse(
    readFileSync(join(process.cwd(), 'starter-kit/contracts/tools.schema.json'), 'utf8'),
  ) as {
    $defs: {
      Period: { pattern: string };
      GroupId: { enum: string[] };
      Capability: { enum: string[] };
    };
    tools: Record<
      string,
      { input: { required?: string[]; properties: Record<string, Record<string, unknown>> } }
    >;
  };

  it('exposes exactly the four contract tools', () => {
    const listed = resultOf(
      handleMessage(context, { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    );
    const names = (listed['tools'] as { name: string }[]).map((tool) => tool.name);
    expect(names).toEqual(['usage_summary', 'top_users', 'capability_status', 'set_capability']);
    expect(Object.keys(contract.tools)).toEqual(names);
  });

  it('publishes input schemas that mirror tools.schema.json', () => {
    expect([...GROUP_IDS]).toEqual(contract.$defs.GroupId.enum);
    for (const tool of TOOL_DEFINITIONS) {
      const expected = contract.tools[tool.name];
      const schema = tool.inputSchema as {
        required?: string[];
        properties: Record<string, Record<string, unknown>>;
        additionalProperties: boolean;
      };
      expect(expected).toBeDefined();
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required ?? []).toEqual(expected?.input.required ?? []);
      expect(Object.keys(schema.properties)).toEqual(Object.keys(expected?.input.properties ?? {}));
      for (const [key, property] of Object.entries(schema.properties)) {
        const contractProperty = expected?.input.properties[key] ?? {};
        if ('$ref' in contractProperty) {
          const ref = String(contractProperty['$ref']).split('/').pop();
          if (ref === 'GroupId') {
            expect(property['enum']).toEqual(contract.$defs.GroupId.enum);
          } else if (ref === 'Period') {
            expect(property['pattern']).toBe(contract.$defs.Period.pattern);
          } else if (ref === 'Capability') {
            expect(property['enum']).toEqual(contract.$defs.Capability.enum);
          }
        } else {
          for (const field of ['type', 'minimum', 'maximum', 'default']) {
            expect(property[field]).toEqual(contractProperty[field]);
          }
        }
      }
    }
  });
});

describe('tools/call', () => {
  it('returns success as text content plus structured content', () => {
    const context = contextFor('dev', admin);
    const result = resultOf(call(context, 'usage_summary', { period: '2026-W36' }));
    expect(result['isError']).toBe(false);
    const body = textOf(result) as { group: string };
    expect(body.group).toBe('it-platform');
    expect(result['structuredContent']).toEqual(body);
    const list = resultOf(call(context, 'top_users', { period: '2026-W36', limit: 2 }));
    expect(list['isError']).toBe(false);
    expect(Array.isArray(textOf(list))).toBe(true);
    expect(list['structuredContent']).toBeUndefined();
    expect(resultOf(call(context, 'capability_status'))['isError']).toBe(false);
  });

  it('keeps denials structured, with the Denial shape, not generic errors', () => {
    const context = contextFor(
      'prod',
      (h) => userWith(h.directory, 'team_lead', 'it-platform').userId,
    );
    const result = resultOf(
      call(context, 'set_capability', {
        group: 'it-platform',
        capability: 'web-search',
        enabled: false,
      }),
    );
    expect(result['isError']).toBe(true);
    const denial = {
      error: 'permission_denied',
      code: 'scope_not_granted',
      reason: 'The caller lacks the required scope.',
      required_scope: 'capabilities:write',
    };
    expect(textOf(result)).toEqual(denial);
    expect(result['structuredContent']).toEqual(denial);
    const foreign = resultOf(
      call(context, 'usage_summary', { group: 'finance', period: '2026-W36' }),
    );
    expect(textOf(foreign)).toMatchObject({
      error: 'permission_denied',
      code: 'group_not_permitted',
    });
  });

  it('keeps validation and data errors structured', () => {
    const context = contextFor('dev', admin);
    expect(textOf(resultOf(call(context, 'top_users', { period: '2026-W36', limit: 99 })))).toEqual(
      {
        error: 'invalid_input',
        message: 'The tool arguments are invalid.',
      },
    );
    expect(textOf(resultOf(call(context, 'usage_summary', { period: '2025-01' })))).toMatchObject({
      error: 'no_data',
    });
  });

  it('rejects null or non-object arguments instead of defaulting them', () => {
    const context = contextFor('dev', admin);
    for (const args of [null, 5, 'x', []]) {
      const result = resultOf(
        handleMessage(context, {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'capability_status', arguments: args },
        }),
      );
      expect(result['isError']).toBe(true);
      expect(textOf(result)).toMatchObject({ error: 'invalid_input' });
    }
  });

  it('takes identity only from server context, never from arguments', () => {
    const lead = contextFor(
      'prod',
      (h) => userWith(h.directory, 'team_lead', 'it-platform').userId,
    );
    const adminId = userWith(
      provisionedHarness('prod').directory,
      'platform_admin',
      'it-platform',
    ).userId;
    for (const extra of [
      { user_id: adminId },
      { role: 'platform_admin' },
      { scope: 'capabilities:write' },
      { actor: adminId },
    ]) {
      const result = resultOf(
        call(lead, 'set_capability', {
          group: 'finance',
          capability: 'web-search',
          enabled: false,
          ...extra,
        }),
      );
      expect(result['isError']).toBe(true);
      expect(textOf(result)).toMatchObject({ error: 'invalid_input' });
    }
    const asAdmin = contextFor('prod', admin);
    expect(
      resultOf(
        call(asAdmin, 'set_capability', {
          group: 'finance',
          capability: 'web-search',
          enabled: false,
        }),
      )['isError'],
    ).toBe(false);
  });

  it('denies every tool when the server has no trusted identity', () => {
    const context = contextFor('dev', () => undefined);
    for (const [name, args] of [
      ['usage_summary', { period: '2026-W36' }],
      ['top_users', { period: '2026-W36' }],
      ['capability_status', {}],
      ['set_capability', { group: 'finance', capability: 'web-search', enabled: true }],
    ] as const) {
      const result = resultOf(call(context, name, args));
      expect(result['isError']).toBe(true);
      expect(textOf(result)).toMatchObject({
        error: 'permission_denied',
        code: 'identity_unresolved',
      });
    }
  });
});
