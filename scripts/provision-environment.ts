import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { provisionDatabase, REPO_ROOT, STARTER_KIT_DIR } from '../apps/api/src/index.js';
import { databasePathFor, renderProvisioning } from '../apps/mcp/src/provisioning.js';

export interface ProvisionOptions {
  readonly environment: string;
  /** Defaults to the repository root; the output lands in `<root>/generated/<environment>`. */
  readonly rootDir?: string;
  readonly starterKitDir?: string;
  readonly recordedAt: string;
}

/**
 * Renders registration + manifests and provisions the database. Unknown environments fail before
 * anything is written. Re-running is repeatable: same bytes for generated files, no duplicate rows.
 */
export function provisionEnvironment(options: ProvisionOptions): string | undefined {
  const rendered = renderProvisioning(options.environment);
  if (!rendered.ok) {
    return rendered.error;
  }
  const rootDir = options.rootDir ?? REPO_ROOT;
  mkdirSync(join(rootDir, 'generated', rendered.value.environment), { recursive: true });
  const provisioned = provisionDatabase({
    environment: rendered.value.environment,
    databasePath: join(rootDir, databasePathFor(rendered.value.environment)),
    starterKitDir: options.starterKitDir ?? STARTER_KIT_DIR,
    recordedAt: options.recordedAt,
  });
  if (!provisioned.ok) {
    return provisioned.error;
  }
  provisioned.value.database.close();
  for (const file of rendered.value.files) {
    writeFileSync(join(rootDir, 'generated', rendered.value.environment, file.name), file.content);
  }
  return undefined;
}
