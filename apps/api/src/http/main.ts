import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnvironment } from '../../../../packages/config/src/index.js';
import { openPersistenceDatabase } from '../../../../packages/persistence/src/index.js';
import { databasePathFor } from '../../../mcp/src/provisioning.js';
import { REPO_ROOT, STARTER_KIT_DIR, loadTrustedDirectory } from '../bootstrap.js';
import { createToolService } from '../tool-service.js';
import { buildServer } from './server.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = '3200';

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const environment = parseEnvironment(process.env['MERIDIAN_ENV'] ?? '');
if (!environment.ok) {
  die('MERIDIAN_ENV must be one of dev, staging, prod');
}
// The assignment simulates identity with X-Meridian-User-Id, so every environment (including the
// fictional prod) is allowed; authorization still applies that environment's own grants.

const rawPort = process.env['MERIDIAN_API_PORT'] ?? DEFAULT_PORT;
const port = Number(rawPort);
if (!/^\d{1,5}$/.test(rawPort) || port < 1 || port > 65_535) {
  die('MERIDIAN_API_PORT must be a port number between 1 and 65535');
}

const directory = loadTrustedDirectory(STARTER_KIT_DIR);
if (!directory.ok) {
  die('trusted directory could not be loaded');
}
const databasePath = resolve(
  REPO_ROOT,
  process.env['MERIDIAN_DB_PATH'] ?? databasePathFor(environment.value),
);
// Opening a missing path would silently create an empty database.
if (!existsSync(databasePath)) {
  die('database not provisioned; run scripts/provision.ts for this environment');
}

const database = openPersistenceDatabase(databasePath);
const app = buildServer(
  createToolService({
    environment: environment.value,
    directory: directory.value,
    database,
    now: () => new Date(),
  }),
);

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  // Stop accepting and drain requests before the database goes away.
  try {
    await app.close();
  } finally {
    database.close();
  }
}
process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});

try {
  await app.listen({ host: HOST, port });
  process.stdout.write(`HTTP API on http://${HOST}:${String(port)} (${environment.value})\n`);
} catch {
  stopping = true;
  database.close();
  die('HTTP API could not start listening');
}
