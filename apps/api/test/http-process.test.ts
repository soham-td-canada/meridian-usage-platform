import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { provisionEnvironment } from '../../../scripts/provision-environment.js';
import { REPO_ROOT, loadTrustedDirectory, STARTER_KIT_DIR } from '../src/index.js';

const root = mkdtempSync(join(tmpdir(), 'meridian-api-process-'));
const children: ChildProcess[] = [];
provisionEnvironment({
  environment: 'staging',
  rootDir: root,
  recordedAt: '2026-10-01T00:00:00.000Z',
});
const databasePath = join(root, 'generated/staging/meridian.sqlite');
provisionEnvironment({
  environment: 'prod',
  rootDir: root,
  recordedAt: '2026-10-01T00:00:00.000Z',
});
const prodDatabasePath = join(root, 'generated/prod/meridian.sqlite');

afterAll(() => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  rmSync(root, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => {
        resolve(port);
      });
    });
  });
}

function start(env: Record<string, string>) {
  const child = spawn(
    'node',
    [
      '--disable-warning=ExperimentalWarning',
      '--experimental-transform-types',
      '--import',
      './scripts/register-ts.mjs',
      'apps/api/src/http/main.ts',
    ],
    { cwd: REPO_ROOT, env: { PATH: process.env['PATH'] ?? '', ...env } },
  );
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk;
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on('close', resolve);
  });
  return { child, exit, stdout: () => out, stderr: () => err };
}

function idOf(name: string): string {
  const directory = loadTrustedDirectory(STARTER_KIT_DIR);
  if (!directory.ok) {
    throw new Error(directory.error);
  }
  const user = [...directory.value.usersById.values()].find((u) => u.name === name);
  if (user === undefined) {
    throw new Error(`${name} missing`);
  }
  return user.userId;
}

const priyaId = (): string => idOf('Priya Nair');

async function ready(run: ReturnType<typeof start>): Promise<void> {
  await new Promise<void>((resolve) => {
    run.child.stdout.once('data', () => {
      resolve();
    });
  });
}

describe('HTTP API process boundary', () => {
  it('serves real HTTP on an isolated staging database and exits 0 on SIGTERM', async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${String(port)}`;
    const run = start({
      MERIDIAN_ENV: 'staging',
      MERIDIAN_DB_PATH: databasePath,
      MERIDIAN_API_PORT: String(port),
    });
    await ready(run);
    const headers = { 'x-meridian-user-id': priyaId() };

    const allowed = await fetch(`${base}/api/usage-summary?period=2026-W39`, { headers });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-type')).toMatch(/application\/json/);
    expect(await allowed.json()).toMatchObject({ group: 'clinical-operations' });

    const denied = await fetch(`${base}/api/usage-summary?group=finance&period=2026-W39`, {
      headers,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'group_not_permitted' });

    const anonymous = await fetch(`${base}/api/usage-summary?period=2026-W39`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: 'identity_unresolved' });

    run.child.kill('SIGTERM');
    expect(await run.exit).toBe(0);
    expect(run.stderr()).toBe('');
    await expect(fetch(`${base}/api/capabilities`, { headers })).rejects.toThrow();
  }, 60_000);

  it('starts in prod and applies prod authorization, not dev/staging grants', async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${String(port)}`;
    const run = start({
      MERIDIAN_ENV: 'prod',
      MERIDIAN_DB_PATH: prodDatabasePath,
      MERIDIAN_API_PORT: String(port),
    });
    await ready(run);
    expect(run.stdout()).toContain('(prod)');
    const as = (name: string) => ({ 'x-meridian-user-id': idOf(name) });
    const connector = (group: string) => `${base}/api/capabilities/${group}/usage-connector`;
    const write = (group: string, name: string, enabled: boolean) =>
      fetch(connector(group), {
        method: 'POST',
        headers: { ...as(name), 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });

    expect(
      (await fetch(`${base}/api/usage-summary?period=2026-W39`, { headers: as('Priya Nair') }))
        .status,
    ).toBe(200);
    const gated = await fetch(`${base}/api/usage-summary?period=2026-W39`, {
      headers: as('Sofia Rossi'),
    });
    expect(gated.status).toBe(403);
    expect(await gated.json()).toMatchObject({ code: 'capability_disabled' });

    // A team lead may write their own group in staging, but prod restricts writes to platform admins.
    const leadWrite = await write('clinical-operations', 'Priya Nair', false);
    expect(leadWrite.status).toBe(403);
    expect(await leadWrite.json()).toMatchObject({ code: 'scope_not_granted' });
    const unchanged = await fetch(`${base}/api/capabilities?group=clinical-operations`, {
      headers: as('Priya Nair'),
    });
    expect(await unchanged.json()).toContainEqual(
      expect.objectContaining({ capability: 'usage-connector', enabled: true }),
    );

    // A platform admin's write is authorized and recovers the gated group.
    const adminWrite = await write('finance', 'Chloe Dubois', true);
    expect(adminWrite.status).toBe(200);
    expect(await adminWrite.json()).toMatchObject({ group: 'finance', enabled: true });
    expect(
      (await fetch(`${base}/api/usage-summary?period=2026-W39`, { headers: as('Sofia Rossi') }))
        .status,
    ).toBe(200);

    run.child.kill('SIGTERM');
    expect(await run.exit).toBe(0);
    expect(run.stderr()).toBe('');
  }, 60_000);

  it('refuses to start for unset/invalid env, bad port or missing database, creating nothing', async () => {
    const missing = join(root, 'never-created.sqlite');
    const before = readdirSync(root).sort();
    for (const env of [
      { MERIDIAN_DB_PATH: databasePath },
      { MERIDIAN_ENV: 'qa', MERIDIAN_DB_PATH: databasePath },
      { MERIDIAN_ENV: 'staging', MERIDIAN_DB_PATH: databasePath, MERIDIAN_API_PORT: '99999' },
      { MERIDIAN_ENV: 'staging', MERIDIAN_DB_PATH: missing },
    ]) {
      const run = start(env);
      expect(await run.exit).toBe(1);
      expect(run.stdout()).toBe('');
      expect(run.stderr()).not.toBe('');
      expect(run.stderr()).not.toMatch(/\n\s+at |node_modules|Error:/);
    }
    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(before);
  }, 60_000);
});
