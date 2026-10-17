import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseEnvironment } from '../../../packages/config/src/index.js';
import { openPersistenceDatabase } from '../../../packages/persistence/src/index.js';
import {
  REPO_ROOT,
  STARTER_KIT_DIR,
  createToolService,
  loadTrustedDirectory,
} from '../../api/src/index.js';
import { databasePathFor, SERVER_NAMES } from './provisioning.js';
import { handleLine } from './server.js';

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const environment = parseEnvironment(process.env['MERIDIAN_ENV'] ?? '');
if (!environment.ok) {
  die('MERIDIAN_ENV must be one of dev, staging, prod');
}

const databasePath = resolve(
  REPO_ROOT,
  process.env['MERIDIAN_DB_PATH'] ?? databasePathFor(environment.value),
);
if (!existsSync(databasePath)) {
  die('database not provisioned; run scripts/provision.ts for this environment');
}

const directory = loadTrustedDirectory(STARTER_KIT_DIR);
if (!directory.ok) {
  die('trusted directory could not be loaded');
}

const database = openPersistenceDatabase(databasePath);
const context = {
  serverName: SERVER_NAMES[environment.value],
  serverVersion: '0.0.0',
  actorUserId: process.env['MERIDIAN_ACTOR_USER_ID'],
  service: createToolService({
    environment: environment.value,
    directory: directory.value,
    database,
    now: () => new Date(),
  }),
};

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const response = handleLine(context, line);
  if (response !== undefined) {
    process.stdout.write(`${response}\n`);
  }
});
lines.once('close', () => {
  database.close();
});
// Closing the reader runs the single close handler above; the process then exits naturally.
process.once('SIGINT', () => {
  lines.close();
});
process.once('SIGTERM', () => {
  lines.close();
});
