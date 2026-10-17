import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCapabilityState } from '../../../packages/persistence/src/index.js';
import { buildServer } from '../src/http/server.js';
import { provisionedHarness, userWith, type Harness } from './helpers.js';

const IDENTITY = 'x-meridian-user-id';
const PERIOD = '2026-W39';

let h: Harness;
let app: FastifyInstance;
let priya: string;
let member: string;
let meiRegulatory: string;

beforeEach(() => {
  h = provisionedHarness('staging');
  app = buildServer(h.service);
  const named = (name: string): string => {
    const user = [...h.directory.usersById.values()].find((candidate) => candidate.name === name);
    if (user === undefined) {
      throw new Error(`missing ${name}`);
    }
    return user.userId;
  };
  priya = named('Priya Nair');
  member = userWith(h.directory, 'member', 'clinical-operations').userId;
  meiRegulatory = named('Mei Chen');
});

afterEach(async () => {
  await app.close();
  h.database.close();
});

function snapshot(): string {
  const rows = listCapabilityState(h.database);
  if (!rows.ok) {
    throw new Error('state unavailable');
  }
  return JSON.stringify(rows.value);
}

function get(url: string, user?: string) {
  return app.inject({
    method: 'GET',
    url,
    ...(user === undefined ? {} : { headers: { [IDENTITY]: user } }),
  });
}

function post(url: string, payload: object, user?: string) {
  return app.inject({
    method: 'POST',
    url,
    payload,
    ...(user === undefined ? {} : { headers: { [IDENTITY]: user } }),
  });
}

const setUsageConnector = (user: string, group: string, enabled: boolean) =>
  post(`/api/capabilities/${group}/usage-connector`, { enabled }, user);

describe('HTTP API reads', () => {
  it('returns own-group usage for an authorized caller', async () => {
    const res = await get(`/api/usage-summary?group=clinical-operations&period=${PERIOD}`, priya);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ group: string; totals: { total_tokens: number } }>();
    expect(body.group).toBe('clinical-operations');
    expect(body.totals.total_tokens).toBeGreaterThan(0);
    expect(res.body).not.toContain('permission_denied');
  });

  it('defaults to the caller home group', async () => {
    const res = await get(`/api/usage-summary?period=${PERIOD}`, priya);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ group: string }>().group).toBe('clinical-operations');
  });

  it('serves top-users and capabilities through the same service', async () => {
    const top = await get(`/api/top-users?period=${PERIOD}&limit=2`, priya);
    expect(top.statusCode).toBe(200);
    expect(top.json<unknown[]>()).toHaveLength(2);
    const caps = await get('/api/capabilities', priya);
    expect(caps.statusCode).toBe(200);
    expect(caps.json<unknown[]>()).toHaveLength(3);
  });

  it('denies cross-group reads with the domain code and no data', async () => {
    const res = await get(`/api/usage-summary?group=finance&period=${PERIOD}`, priya);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'permission_denied', code: 'group_not_permitted' });
    expect(res.body).not.toMatch(/total_tokens|cost_usd|platforms/);
    const top = await get(`/api/top-users?group=finance&period=${PERIOD}`, priya);
    expect(top.statusCode).toBe(403);
    expect(top.body).not.toMatch(/user_id|total_tokens/);
  });

  it('denies a caller lacking the read scope (staging member)', async () => {
    const res = await get(`/api/usage-summary?period=${PERIOD}`, member);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'scope_not_granted' });
  });

  it('defers unknown groups to authorization instead of disclosing existence', async () => {
    const res = await get(`/api/usage-summary?group=nope&period=${PERIOD}`, priya);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'group_not_permitted' });
  });
});

describe('HTTP API writes', () => {
  it('lets an authorized team lead change own-group state, attributed to the caller', async () => {
    const before = snapshot();
    try {
      const res = await setUsageConnector(priya, 'clinical-operations', false);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        group: 'clinical-operations',
        capability: 'usage-connector',
        enabled: false,
        updated_by: priya,
      });
      expect(snapshot()).not.toBe(before);
    } finally {
      await setUsageConnector(priya, 'clinical-operations', true);
    }
    const restored = await get('/api/capabilities?group=clinical-operations', priya);
    expect(restored.json<{ capability: string; enabled: boolean }[]>()).toContainEqual(
      expect.objectContaining({ capability: 'usage-connector', enabled: true }),
    );
  });

  it('denies writes to a foreign group and for members, leaving state unchanged', async () => {
    const before = snapshot();
    const foreign = await setUsageConnector(meiRegulatory, 'finance', false);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ code: 'group_not_permitted' });
    const asMember = await setUsageConnector(member, 'clinical-operations', false);
    expect(asMember.statusCode).toBe(403);
    expect(asMember.json()).toMatchObject({ code: 'scope_not_granted' });
    expect(snapshot()).toBe(before);
  });

  it('enforces the capability gate and recovers through an authorized write', async () => {
    const own = `/api/usage-summary?period=${PERIOD}`;
    try {
      expect((await setUsageConnector(priya, 'clinical-operations', false)).statusCode).toBe(200);
      const gated = await get(own, priya);
      expect(gated.statusCode).toBe(403);
      expect(gated.json()).toMatchObject({ code: 'capability_disabled' });
      expect(gated.body).not.toMatch(/total_tokens/);
      expect((await setUsageConnector(priya, 'clinical-operations', true)).statusCode).toBe(200);
      expect((await get(own, priya)).statusCode).toBe(200);
    } finally {
      await setUsageConnector(priya, 'clinical-operations', true);
    }
  });
});

describe('HTTP API identity', () => {
  it('fails closed without an identity header, even for mutations and invalid input', async () => {
    const before = snapshot();
    for (const res of [
      await get(`/api/usage-summary?period=${PERIOD}`),
      await get('/api/usage-summary'),
      await post('/api/capabilities/clinical-operations/usage-connector', { enabled: false }),
    ]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'permission_denied', code: 'identity_unresolved' });
    }
    expect(snapshot()).toBe(before);
  });

  it('rejects an unknown or malformed identity without echoing it', async () => {
    for (const raw of ['user_DOESNOTEXIST', 'has space', 'x'.repeat(200)]) {
      const res = await get(`/api/usage-summary?period=${PERIOD}`, raw);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: 'identity_unresolved' });
      expect(res.body).not.toContain(raw);
    }
  });

  it('ignores caller-supplied role, group or scope inputs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/usage-summary?period=${PERIOD}&role=platform_admin`,
      headers: { [IDENTITY]: priya, 'x-meridian-role': 'platform_admin' },
    });
    expect(res.statusCode).toBe(400);
    const spoofed = await app.inject({
      method: 'GET',
      url: `/api/usage-summary?group=finance&period=${PERIOD}`,
      headers: { [IDENTITY]: priya, 'x-meridian-role': 'platform_admin', 'x-meridian-scopes': '*' },
    });
    expect(spoofed.statusCode).toBe(403);
  });
});

describe('HTTP API input validation', () => {
  it('returns 400 for invalid reads', async () => {
    for (const url of [
      '/api/usage-summary',
      '/api/usage-summary?period=yesterday',
      '/api/usage-summary?period=2026-W99',
      `/api/usage-summary?period=${PERIOD}&period=2026-W38`,
      `/api/top-users?period=${PERIOD}&limit=0`,
      `/api/top-users?period=${PERIOD}&limit=26`,
      `/api/top-users?period=${PERIOD}&limit=abc`,
      `/api/top-users?period=${PERIOD}&limit=1.5`,
      '/api/capabilities?extra=1',
    ]) {
      const res = await get(url, priya);
      expect(res.statusCode, url).toBe(400);
      expect(res.json(), url).toMatchObject({ error: 'invalid_input' });
    }
  });

  it('returns 400 for invalid writes without mutating state', async () => {
    const before = snapshot();
    const base = '/api/capabilities/clinical-operations';
    for (const [url, payload] of [
      [`${base}/not-a-capability`, { enabled: true }],
      [`${base}/usage-connector`, { enabled: 'true' }],
      [`${base}/usage-connector`, { enabled: 1 }],
      [`${base}/usage-connector`, {}],
      [`${base}/usage-connector`, { enabled: false, role: 'platform_admin' }],
      [`${base}/usage-connector`, { enabled: false, group: 'finance' }],
    ] as const) {
      const res = await post(url, payload, priya);
      expect(res.statusCode, `${url} ${JSON.stringify(payload)}`).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_input' });
    }
    const malformed = await app.inject({
      method: 'POST',
      url: `${base}/usage-connector`,
      headers: { [IDENTITY]: priya, 'content-type': 'application/json' },
      payload: '{"enabled":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(snapshot()).toBe(before);
  });

  it('returns a sanitized 404 for unknown routes and an exact method set', async () => {
    const res = await get('/api/anything', priya);
    expect(res.statusCode).toBe(404);
    expect((await get('/api/tools/set_capability', priya)).statusCode).toBe(404);
  });
});

describe('HTTP API privacy and errors', () => {
  it('does not expose directory emails, principals, source keys, paths or stack traces', async () => {
    const responses = [
      await get(`/api/usage-summary?period=${PERIOD}`, priya),
      await get(`/api/usage-summary?group=finance&period=${PERIOD}`, priya),
      await get('/api/capabilities', priya),
      await get('/api/usage-summary?period=bad', priya),
      await get(`/api/usage-summary?period=${PERIOD}`, 'user_unknown'),
      await get('/api/usage-summary'),
      await post('/api/capabilities/finance/usage-connector', { enabled: false }, priya),
    ];
    for (const res of responses) {
      expect(res.body).not.toMatch(
        /@meridianls|gcp_principal|user:|projects\/|\.sqlite|\/Users\/|node_modules|\n\s+at |SQLITE/i,
      );
    }
  });

  it('maps an unexpected failure to a sanitized 500', async () => {
    const broken = buildServer({
      invoke() {
        throw new Error('SQLITE_CORRUPT at /secret/path.sqlite');
      },
    });
    const res = await broken.inject({
      method: 'GET',
      url: `/api/usage-summary?period=${PERIOD}`,
      headers: { [IDENTITY]: priya },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'internal_error', message: 'An internal error occurred.' });
    await broken.close();
  });

  it('maps no_data and data_unavailable consistently', async () => {
    const none = await get('/api/usage-summary?period=2020-01', priya);
    expect(none.statusCode).toBe(404);
    expect(none.json()).toMatchObject({ error: 'no_data' });
    h.database.sqlite.exec('DELETE FROM capability_state');
    const unavailable = await get(`/api/usage-summary?period=${PERIOD}`, priya);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ code: 'capability_state_unavailable' });
  });
});
