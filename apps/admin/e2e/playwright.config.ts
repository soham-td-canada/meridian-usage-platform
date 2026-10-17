import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const port = process.env['MERIDIAN_E2E_PORT'] ?? '3199';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  // Scenarios share one staging database, so they run serially.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env['CI'] !== undefined,
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      'node --disable-warning=ExperimentalWarning --experimental-transform-types --import ./scripts/register-ts.mjs scripts/e2e-admin-server.ts',
    cwd: resolve(import.meta.dirname, '../../..'),
    url: baseURL,
    // Never attach to a developer's running Admin or database.
    reuseExistingServer: false,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    env: { MERIDIAN_E2E_PORT: port, PATH: process.env['PATH'] ?? '' },
  },
});
