import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listCapabilityState } from '../../../packages/persistence/src/index.js';
import { expectedUsage } from '../../../packages/persistence/test/expected-usage.js';
import { emptyUsageHarness, provisionedHarness, userWith } from '../../api/test/helpers.js';
import { handleRequest, type AdminApp, type AdminResponse } from '../src/handler.js';
import { WEEKS } from '../src/view-model.js';

const SRC = join(import.meta.dirname, '../src');

function appFor(environment: 'dev' | 'staging' | 'prod') {
  const h = provisionedHarness(environment);
  const ids = {
    admin: userWith(h.directory, 'platform_admin', 'it-platform').userId,
    financeLead: userWith(h.directory, 'team_lead', 'finance').userId,
    financeMember: userWith(h.directory, 'member', 'finance').userId,
  };
  return { h, ids, app: { service: h.service, directory: h.directory } satisfies AdminApp };
}

const get = (app: AdminApp, query: Record<string, string>): AdminResponse =>
  handleRequest(app, {
    method: 'GET',
    url: `/?${new URLSearchParams(query).toString()}`,
    body: '',
  });

const post = (app: AdminApp, fields: Record<string, string>): AdminResponse =>
  handleRequest(app, {
    method: 'POST',
    url: '/capability',
    body: new URLSearchParams(fields).toString(),
  });

const count = (value: bigint): string => Number(value).toLocaleString('en-US');

function capabilityRows(h: ReturnType<typeof appFor>['h']) {
  const rows = listCapabilityState(h.database);
  if (!rows.ok) {
    throw new Error('state');
  }
  return rows.value;
}

describe('dashboard', () => {
  it('renders usage by platform, group and week from service data', () => {
    const { app, ids } = appFor('dev');
    const html = get(app, { caller: ids.admin, group: 'finance', week: '2026-W36' }).body;
    const expected = expectedUsage('finance', '2026-08-31', '2026-09-07');
    for (const week of WEEKS) {
      expect(html).toContain(`<td>${week}</td>`);
    }
    const w36 = html.split('<tr>').filter((row) => row.includes('<td>2026-W36</td>'));
    expect(w36).toHaveLength(2);
    expect(w36[0]).toContain('<td>claude</td>');
    expect(w36[0]).toContain(`<td>${count(expected.claudeInput)}</td>`);
    expect(w36[0]).toContain(`<td>${count(expected.claudeRequests)}</td>`);
    expect(w36[0]).toContain(`$${(Number(expected.claudeCostE8) / 1e8).toFixed(4)}`);
    expect(w36[1]).toContain('<td>gemini</td>');
    expect(w36[1]).toContain(`<td>${count(expected.geminiOutput)}</td>`);
    expect(html).toContain('<h2>Top users, 2026-W36</h2>');
  });

  it('shows a different group to an admin and the home group to a lead', () => {
    const { app, ids } = appFor('dev');
    const lead = get(app, { caller: ids.financeLead, group: '', week: '2026-W36' }).body;
    const admin = get(app, { caller: ids.admin, group: 'finance', week: '2026-W36' }).body;
    expect(lead).toContain('<td>finance</td>');
    expect(lead).toContain('Updated by');
    expect(admin).toContain('<td>finance</td>');
  });

  it('prompts without calling the service when no caller is selected', () => {
    const { app } = appFor('dev');
    const html = get(app, {}).body;
    expect(html).toContain('Select a simulated caller');
    expect(html).not.toContain('<table>');
  });

  it('falls back to the default week for unknown weeks', () => {
    const { app, ids } = appFor('dev');
    const html = get(app, { caller: ids.admin, group: 'finance', week: '2099-W01' }).body;
    expect(html).toContain('<h2>Top users, 2026-W39</h2>');
  });
});

describe('denial states', () => {
  it.each([
    ['member', 'financeMember', 'finance', 'scope_not_granted'],
    ['lead on a foreign group', 'financeLead', 'it-platform', 'group_not_permitted'],
    ['unknown group', 'admin', 'no-such-group', 'group_not_found'],
    ['unknown caller', undefined, '', 'identity_unresolved'],
  ])('%s is denied with no usage data', (_name, who, group, code) => {
    const { app, ids } = appFor('staging');
    const caller = who === undefined ? 'u-nope' : ids[who as keyof typeof ids];
    const html = get(app, { caller, group, week: '2026-W36' }).body;
    expect(html).toContain(`Denied (${code})`);
    expect(html).not.toMatch(/<td>(claude|gemini)<\/td>/);
    expect(html).not.toContain('Updated by');
  });

  it('denies a lead whose group connector is disabled (prod)', () => {
    const { app, h } = appFor('prod');
    const lead = userWith(h.directory, 'team_lead', 'finance').userId;
    const html = get(app, { caller: lead, group: '', week: '2026-W36' }).body;
    expect(html).toContain('Denied (capability_disabled)');
    expect(html).not.toMatch(/<td>(claude|gemini)<\/td>/);
  });

  it('escapes hostile input', () => {
    const { app } = appFor('dev');
    const html = get(app, { caller: '<script>alert(1)</script>', group: '"><img src=x>' }).body;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows errors, never zeros, without ingested data', () => {
    const h = emptyUsageHarness('dev');
    const admin = userWith(h.directory, 'platform_admin', 'it-platform').userId;
    const html = get(
      { service: h.service, directory: h.directory },
      {
        caller: admin,
        group: 'finance',
        week: '2026-W36',
      },
    ).body;
    expect(html).toContain('The requested data is unavailable.');
    expect(html).not.toMatch(/<td>(claude|gemini)<\/td>/);
    expect(html).not.toContain('$0.0000');
  });
});

describe('capability controls', () => {
  it('toggles a capability as the simulated caller and reflects it', () => {
    const { app, h, ids } = appFor('dev');
    const response = post(app, {
      caller: ids.admin,
      group: 'finance',
      capability: 'web-search',
      enabled: 'false',
      week: '2026-W36',
    });
    expect(response.status).toBe(200);
    expect(response.body).toContain('web-search for finance is now disabled.');
    const row = capabilityRows(h).find(
      (r) => r.groupId === 'finance' && r.capability === 'web-search',
    );
    expect(row?.enabled).toBe(false);
    expect(row?.updatedBy).toBe(ids.admin);
    const page = get(app, { caller: ids.admin, group: 'finance', week: '2026-W36' }).body;
    expect(page).toContain('<td>disabled</td>');
    expect(page).toContain('value="true"');
  });

  it('lets a lead change their own group but not another', () => {
    const { app, h, ids } = appFor('dev');
    const own = post(app, {
      caller: ids.financeLead,
      group: 'finance',
      capability: 'code-execution',
      enabled: 'false',
    });
    expect(own.body).toContain('code-execution for finance is now disabled.');
    const before = capabilityRows(h);
    const foreign = post(app, {
      caller: ids.financeLead,
      group: 'it-platform',
      capability: 'code-execution',
      enabled: 'false',
    });
    expect(foreign.body).toContain('Denied (group_not_permitted)');
    expect(capabilityRows(h)).toEqual(before);
  });

  it('denies a member and writes nothing', () => {
    const { app, h, ids } = appFor('staging');
    const before = capabilityRows(h);
    const response = post(app, {
      caller: ids.financeMember,
      group: 'finance',
      capability: 'web-search',
      enabled: 'false',
    });
    expect(response.body).toContain('Denied (scope_not_granted)');
    expect(capabilityRows(h)).toEqual(before);
  });

  it.each([
    { enabled: 'yes' },
    { enabled: '' },
    { enabled: 'true', capability: 'root-access' },
    { enabled: 'true', caller: '' },
  ])('rejects invalid input %j without a write', (override) => {
    const { app, h, ids } = appFor('dev');
    const before = capabilityRows(h);
    const response = post(app, {
      caller: ids.admin,
      group: 'finance',
      capability: 'web-search',
      ...override,
    });
    expect(response.body).toMatch(/invalid/i);
    expect(capabilityRows(h)).toEqual(before);
  });

  it('ignores forged role, scope and identity fields', () => {
    const { app, h, ids } = appFor('staging');
    const before = capabilityRows(h);
    const response = post(app, {
      caller: ids.financeMember,
      group: 'finance',
      capability: 'web-search',
      enabled: 'false',
      role: 'platform_admin',
      scope: 'capabilities:write',
      home_group: 'finance',
      user_id: ids.admin,
    });
    expect(response.body).toContain('Denied (scope_not_granted)');
    expect(capabilityRows(h)).toEqual(before);
    const query = get(app, {
      caller: ids.financeMember,
      group: 'it-platform',
      role: 'platform_admin',
      scope: 'usage:read',
    }).body;
    expect(query).toContain('Denied (scope_not_granted)');
  });
});

describe('transport', () => {
  it('rejects oversized bodies, unknown routes and wrong methods', () => {
    const { app } = appFor('dev');
    expect(
      handleRequest(app, { method: 'POST', url: '/capability', body: 'a'.repeat(5000) }).status,
    ).toBe(413);
    expect(handleRequest(app, { method: 'GET', url: '/nope', body: '' }).status).toBe(404);
    expect(handleRequest(app, { method: 'GET', url: '/capability', body: '' }).status).toBe(405);
    expect(handleRequest(app, { method: 'POST', url: '/', body: '' }).status).toBe(405);
  });

  it('sets hardening headers', () => {
    const { app } = appFor('dev');
    const { headers } = get(app, {});
    expect(headers['content-security-policy']).toContain("default-src 'none'");
    expect(headers['cache-control']).toBe('no-store');
  });
});

describe('UI contains no authorization policy', () => {
  it('does not import authorization or mention roles/scopes', () => {
    for (const file of readdirSync(SRC).filter((name) => name.endsWith('.ts'))) {
      const source = readFileSync(join(SRC, file), 'utf8');
      expect(source, file).not.toMatch(/packages\/authorization/);
      expect(source, file).not.toMatch(/platform_admin|team_lead|usage:read|capabilities:write/);
    }
  });
});

describe('regression: Aisha Rahman (member, clinical-operations) through the admin request path', () => {
  const AISHA = 'user_B1AA49EEED515A8B4C2254F5';
  const DATA = /<td>(claude|gemini)<\/td>|Updated by|<h2>Top users[^<]*<\/h2><table/;

  it('has the authoritative directory identity', () => {
    const { h } = appFor('dev');
    const aisha = [...h.directory.usersById.values()].find((user) => user.userId === AISHA);
    expect(aisha?.name).toBe('Aisha Rahman');
    expect(aisha?.role).toBe('member');
    expect(aisha?.groupIds).toEqual(['clinical-operations']);
  });

  // dev.yaml: group_visibility "all" (any caller may read any group), so this is intended policy.
  it('dev: reads any group exactly as starter-kit/environments/dev.yaml specifies', () => {
    const { app } = appFor('dev');
    for (const group of ['clinical-operations', 'finance', 'hr']) {
      const html = get(app, { caller: AISHA, group, week: '2026-W36' }).body;
      expect(html, group).not.toContain('Denied');
      expect(html, group).toMatch(DATA);
    }
  });

  it.each(['staging', 'prod'] as const)(
    '%s: members have no usage:read, so every group (own, finance, hr) is denied with no data',
    (environment) => {
      const { app } = appFor(environment);
      for (const group of ['clinical-operations', 'finance', 'hr', '']) {
        const html = get(app, { caller: AISHA, group, week: '2026-W36' }).body;
        expect(html, group).toContain('Denied (scope_not_granted)');
        expect(html, group).not.toMatch(DATA);
      }
    },
  );
});

describe('regression: control-plane recovery while usage-connector is disabled', () => {
  const DATA = /<td>(claude|gemini)<\/td>/;

  it('lets an authorised lead disable then re-enable usage-connector', () => {
    const { app, h, ids } = appFor('dev');
    const query = { caller: ids.financeLead, group: 'finance', week: '2026-W36' };
    expect(get(app, query).body).toMatch(DATA);

    const disabled = post(app, { ...query, capability: 'usage-connector', enabled: 'false' });
    expect(disabled.body).toContain('usage-connector for finance is now disabled.');

    const page = get(app, query).body;
    expect(page).toContain('Denied (capability_disabled)');
    expect(page).not.toMatch(DATA);
    expect(page).not.toContain('<h2>Top users, 2026-W36</h2><table');
    expect(page).toContain('<td>unknown</td>');
    expect(page).toContain('name="capability" value="usage-connector"');
    expect(page).toContain('name="enabled" value="true"');

    const enabled = post(app, { ...query, capability: 'usage-connector', enabled: 'true' });
    expect(enabled.body).toContain('usage-connector for finance is now enabled.');
    const restored = get(app, query).body;
    expect(restored).not.toContain('Denied');
    expect(restored).toMatch(DATA);
    expect(capabilityRows(h).find((r) => r.capability === 'usage-connector')?.enabled).toBe(true);
  });

  it('without an explicit group offers no controls', () => {
    const { app, ids } = appFor('dev');
    post(app, {
      caller: ids.financeLead,
      group: 'finance',
      capability: 'usage-connector',
      enabled: 'false',
    });
    const page = get(app, { caller: ids.financeLead, group: '', week: '2026-W36' }).body;
    expect(page).toContain('Select your group explicitly');
    expect(page).not.toContain('action="/capability"');
  });

  it('still denies a write by an unauthorised caller while the connector is disabled', () => {
    const { app, h, ids } = appFor('dev');
    post(app, {
      caller: ids.financeLead,
      group: 'finance',
      capability: 'usage-connector',
      enabled: 'false',
    });
    const before = capabilityRows(h);
    const denied = post(app, {
      caller: ids.financeMember,
      group: 'finance',
      capability: 'usage-connector',
      enabled: 'true',
    });
    expect(denied.body).toContain('Denied (scope_not_granted)');
    expect(capabilityRows(h)).toEqual(before);
  });

  it('offers no recovery controls for scope denials', () => {
    const { app, ids } = appFor('staging');
    const page = get(app, { caller: ids.financeMember, group: 'finance', week: '2026-W36' }).body;
    expect(page).toContain('Denied (scope_not_granted)');
    expect(page).not.toContain('action="/capability"');
  });
});
