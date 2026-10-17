import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../api/src/index.js';
import { provisionEnvironment } from '../../../scripts/provision-environment.js';

const root = mkdtempSync(join(tmpdir(), 'meridian-admin-process-'));
const children: ChildProcess[] = [];
for (const environment of ['dev', 'staging']) {
  provisionEnvironment({ environment, rootDir: root, recordedAt: '2026-10-01T00:00:00.000Z' });
}
const databasePath = join(root, 'generated/dev/meridian.sqlite');

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
      'apps/admin/src/main.ts',
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

describe('admin server process boundary', () => {
  it('starts for dev and staging, then stops listening and exits 0 on SIGTERM and SIGINT', async () => {
    for (const [environment, signal] of [
      ['dev', 'SIGTERM'],
      ['dev', 'SIGINT'],
      ['staging', 'SIGTERM'],
    ] as const) {
      const port = await freePort();
      const run = start({
        MERIDIAN_ENV: environment,
        MERIDIAN_DB_PATH: join(root, `generated/${environment}/meridian.sqlite`),
        MERIDIAN_ADMIN_PORT: String(port),
      });
      await new Promise<void>((resolve) => {
        run.child.stdout.once('data', () => {
          resolve();
        });
      });
      const page = await fetch(`http://127.0.0.1:${String(port)}/`);
      expect(page.status).toBe(200);
      run.child.kill(signal);
      expect(await run.exit).toBe(0);
      await expect(fetch(`http://127.0.0.1:${String(port)}/`)).rejects.toThrow();
    }
  }, 60_000);

  it('fails closed on stderr: unset env, invalid env, prod, and a missing database is never created', async () => {
    const missing = join(root, 'never-created.sqlite');
    for (const env of [
      { MERIDIAN_DB_PATH: databasePath },
      { MERIDIAN_ENV: 'qa', MERIDIAN_DB_PATH: databasePath },
      { MERIDIAN_ENV: 'prod', MERIDIAN_DB_PATH: databasePath },
      { MERIDIAN_ENV: 'dev', MERIDIAN_DB_PATH: missing },
    ]) {
      const run = start(env);
      expect(await run.exit).toBe(1);
      expect(run.stdout()).toBe('');
      expect(run.stderr()).not.toBe('');
      expect(run.stderr()).not.toMatch(/\n\s+at /);
    }
    expect(existsSync(missing)).toBe(false);
  }, 60_000);
});
