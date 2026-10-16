import { fail, ok, type Result } from './result.js';

export const CAPABILITIES = ['usage-connector', 'web-search', 'code-execution'] as const;

export type Capability = (typeof CAPABILITIES)[number];

export function parseCapability(raw: string): Result<Capability, string> {
  const capability = CAPABILITIES.find((candidate) => candidate === raw);
  if (capability === undefined) {
    return fail(`unknown capability ${raw}`);
  }
  return ok(capability);
}
