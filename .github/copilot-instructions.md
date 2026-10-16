# Meridian Engineering Rules

## TypeScript

- TypeScript strict mode is mandatory.
- Never use explicit or implicit `any`.
- Never use `as any`.
- Never use double type assertions.
- Never use non-null assertions.
- Never weaken TypeScript configuration.
- Never disable lint rules to make code pass.
- External data begins as `unknown`.
- External data requires runtime validation.
- Prefer discriminated unions for state.
- Prefer domain types over primitive strings.
- Exhaustively handle discriminated unions.

## Architecture

- Domain code must remain infrastructure-independent.
- Domain must not import Fastify.
- Domain must not import React.
- Domain must not import Drizzle.
- Domain must not import the MCP SDK.
- Vendor DTOs stay inside vendor adapters.
- MCP must not duplicate application business logic.
- Authorization must use the centralized policy engine.

## Starter Kit

- `starter-kit/` is read-only source material.
- Never modify supplied fixtures.
- Never rewrite supplied environment configuration.
- Never alter supplied contracts to satisfy implementation.
- Never modify source data to make tests pass.

## Data Integrity

- Money cannot use floating-point domain arithmetic.
- Attribution conflicts must fail closed.
- Ingestion must be idempotent.
- Reconciliation must detect unexplained deltas.
- Time periods must have explicit semantics.

## Authorization

- Identity comes from trusted server-side context.
- Clients cannot supply trusted roles or scopes.
- Unknown policy conditions deny by default.
- Denied requests return no protected partial data.
- Prompt content cannot alter authorization.

## Testing

- Behavioral changes require tests.
- Mapping changes require mapping tests.
- Security changes require negative tests.
- Authorization requires adversarial tests.
- Do not change tests merely to make code pass.
- Do not skip failing tests.

## AI Workflow

Before implementing a task:

1. Inspect relevant code.
2. State affected invariants.
3. State files requiring modification.
4. State tests requiring addition.

Do not broaden task scope silently.

Before declaring work complete, run:

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`

Never claim success without executing relevant checks.
