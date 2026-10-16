import type { Environment } from '@meridian/config';
import type { Capability, GroupId } from '@meridian/domain';

export type RunStatus = 'blocked' | 'partial' | 'complete_with_exclusions' | 'complete' | 'failed';
export type PersistableRunStatus = Extract<RunStatus, 'complete' | 'complete_with_exclusions'>;

export type PersistenceError =
  | { readonly kind: 'status_refused'; readonly status: Exclude<RunStatus, PersistableRunStatus> }
  | { readonly kind: 'money_out_of_range'; readonly amount: bigint }
  | { readonly kind: 'unknown_environment'; readonly environment: string }
  | {
      readonly kind: 'config_group_missing';
      readonly environment: Environment;
      readonly groupId: string;
    }
  | { readonly kind: 'unknown_group'; readonly groupId: string }
  | { readonly kind: 'unknown_capability'; readonly capability: string }
  | { readonly kind: 'state_missing'; readonly groupId: GroupId; readonly capability: Capability }
  | { readonly kind: 'integrity_error'; readonly message: string }
  | { readonly kind: 'write_verification_failed'; readonly message: string }
  | { readonly kind: 'sqlite_error'; readonly operation: string; readonly message: string };
