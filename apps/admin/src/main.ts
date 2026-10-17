import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { parseEnvironment } from '../../../packages/config/src/index.js';
import { openPersistenceDatabase } from '../../../packages/persistence/src/index.js';
import {
  REPO_ROOT,
  STARTER_KIT_DIR,
  createToolService,
  loadTrustedDirectory,
} from '../../api/src/index.js';
import { databasePathFor } from '../../mcp/src/provisioning.js';
import { MAX_BODY_BYTES, handleRequest } from './handler.js';

function die(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const environment = parseEnvironment(process.env['MERIDIAN_ENV'] ?? 'dev');
if (!environment.ok) {
  die('MERIDIAN_ENV must be one of dev, staging, prod');
}
// Caller selection is a simulation: with no authentication it must never serve production.
if (environment.value === 'prod') {
  die('the simulated-caller admin UI refuses to run in prod');
}

const directory = loadTrustedDirectory(STARTER_KIT_DIR);
if (!directory.ok) {
  die('trusted directory could not be loaded');
}
const database = openPersistenceDatabase(
  resolve(REPO_ROOT, process.env['MERIDIAN_DB_PATH'] ?? databasePathFor(environment.value)),
);
const app = {
  directory: directory.value,
  service: createToolService({
    environment: environment.value,
    directory: directory.value,
    database,
    now: () => new Date(),
  }),
};

const server = createServer((request, response) => {
  let body = '';
  let tooLarge = false;
  request.on('data', (chunk: Buffer) => {
    if (body.length <= MAX_BODY_BYTES) {
      body += chunk.toString('utf8');
    } else {
      tooLarge = true;
    }
  });
  request.on('end', () => {
    const result = handleRequest(app, {
      method: request.method ?? '',
      url: request.url ?? '/',
      body: tooLarge ? 'x'.repeat(MAX_BODY_BYTES + 1) : body,
    });
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  });
});
const port = Number(process.env['MERIDIAN_ADMIN_PORT'] ?? '3100');
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`admin UI on http://127.0.0.1:${String(port)} (${environment.value})\n`);
});
