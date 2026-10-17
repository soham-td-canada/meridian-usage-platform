import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../apps/api/src/index.js';
import { provisionEnvironment } from './provision-environment.js';

/**
 * Browser E2E fixture: provisions a private staging database in a temp directory, runs the real
 * Admin process against it, and removes everything when stopped. Never touches generated/.
 */
const port = process.env['MERIDIAN_E2E_PORT'] ?? '3199';
const root = mkdtempSync(join(tmpdir(), 'meridian-admin-e2e-'));

function cleanup(): void {
  rmSync(root, { recursive: true, force: true });
}

const failure = provisionEnvironment({
  environment: 'staging',
  rootDir: root,
  recordedAt: '2026-10-01T00:00:00.000Z',
});
if (failure !== undefined) {
  cleanup();
  process.stderr.write(`e2e provisioning failed: ${failure}\n`);
  process.exit(1);
}

const child = spawn(
  process.execPath,
  [
    '--disable-warning=ExperimentalWarning',
    '--experimental-transform-types',
    '--import',
    './scripts/register-ts.mjs',
    'apps/admin/src/main.ts',
  ],
  {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: {
      PATH: process.env['PATH'] ?? '',
      MERIDIAN_ENV: 'staging',
      MERIDIAN_DB_PATH: join(root, 'generated/staging/meridian.sqlite'),
      MERIDIAN_ADMIN_PORT: port,
    },
  },
);

child.on('exit', (code) => {
  cleanup();
  process.exit(code ?? 1);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    child.kill(signal);
  });
}
