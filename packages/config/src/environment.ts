import { fail, ok, type Result } from '@meridian/domain';

export const ENVIRONMENTS = ['dev', 'staging', 'prod'] as const;

export type Environment = (typeof ENVIRONMENTS)[number];

export function parseEnvironment(raw: string): Result<Environment, string> {
  const environment = ENVIRONMENTS.find((candidate) => candidate === raw);
  if (environment === undefined) {
    return fail(`unknown environment ${raw}`);
  }
  return ok(environment);
}
