import { provisionEnvironment } from './provision-environment.js';

const error = provisionEnvironment({
  environment: process.argv[2] ?? '',
  recordedAt: new Date().toISOString(),
});
if (error !== undefined) {
  process.stderr.write(`provision failed: ${error}\nusage: provision <dev|staging|prod>\n`);
  process.exit(1);
}
process.stdout.write(`provisioned ${process.argv[2] ?? ''}\n`);
