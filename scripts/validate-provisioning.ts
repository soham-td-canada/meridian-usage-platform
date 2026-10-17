import { validateProvisioning } from './provisioning-validation.js';

const problems = validateProvisioning();
if (problems.length > 0) {
  process.stderr.write(
    `provisioning validation failed:\n${problems.map((p) => `- ${p}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write('provisioning validation passed: dev, staging, prod\n');
