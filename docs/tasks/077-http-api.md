# Step 7.7 — HTTP API

Closes the assignment requirement to expose an API (plus the existing minimal Admin page). Before
this step no externally callable HTTP API existed: Admin serves HTML only and MCP is stdio.

## Surface

Fastify transport adapter in `apps/api/src/http/` (`server.ts`, `routes.ts`, `error-mapping.ts`,
`main.ts`). Start with `MERIDIAN_ENV=<dev|staging|prod> pnpm start:api`
(`MERIDIAN_API_PORT`, default 3200; binds 127.0.0.1; `MERIDIAN_DB_PATH` optional, as in Admin/MCP).

| Route                                       | ToolService tool    |
| ------------------------------------------- | ------------------- |
| `GET /api/usage-summary?group?&period`      | `usage_summary`     |
| `GET /api/top-users?group?&period&limit?`   | `top_users`         |
| `GET /api/capabilities?group?`              | `capability_status` |
| `POST /api/capabilities/:group/:capability` | `set_capability`    |

POST body: `{ "enabled": true | false }`; unknown properties are rejected. No generic
"invoke any tool" endpoint exists. Success bodies are exactly the `ToolService` JSON values.

## Identity

One header, `X-Meridian-User-Id`, carrying only the simulated directory user ID. Role, group and
scopes are resolved by `ToolService`/the trusted directory; no role/group/scope input is accepted.
A missing, repeated-array, empty, over-long or non-printable header → 401 `identity_unresolved`
before any validation or service call. An unknown ID → the service's `identity_unresolved` denial;
the supplied value is never echoed. The executable runs in `dev`, `staging` and `prod` (the header
is the assignment's simulated identity); a missing or invalid `MERIDIAN_ENV` exits 1. Authorization
applies the selected environment's own grants, so prod keeps its platform-admin-only writes and
persisted capability state. Unlike Admin, it does not refuse prod; MCP's and Admin's behavior is unchanged.

## Boundary

request → identity header → Fastify schema (shape only) → `ToolService.invoke` → authorization →
persistence. The transport contains no authorization rules and no SQL. Fastify's Ajv is configured
with `removeAdditional: false`, `coerceTypes: false` so extra properties/`"true"` are rejected
rather than silently fixed. `capability` is validated against `CAPABILITIES`; `limit` must be
digits at the transport and is range-checked (1–25) by `ToolService`. `group` is deliberately
_not_ enum-validated at the transport: unknown groups flow to authorization, which returns the
same denial as a foreign group for callers who cannot see every group (no existence oracle).

## Status mapping (`error-mapping.ts`, domain code always preserved in the body)

| Outcome                                                                                      | HTTP                                           |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| ok                                                                                           | 200                                            |
| `invalid_input` / schema failure / malformed JSON                                            | 400                                            |
| denial `identity_unresolved`                                                                 | 401                                            |
| denials `scope_not_granted`, `group_not_permitted`, `group_not_found`, `capability_disabled` | 403                                            |
| denials `policy_unavailable`, `capability_state_unavailable`; `data_unavailable`             | 503                                            |
| `no_data` (valid, authorized, but nothing for that group/period)                             | 404                                            |
| `unknown_tool` (cannot occur; routes are fixed), unexpected exception                        | 500 (exceptions sanitized to `internal_error`) |
| unknown route / oversized or wrong-type body                                                 | 404 / 413 / 415                                |

`no_data` is 404: the requested group/period report does not exist. The body keeps the domain
`error: "no_data"`, which distinguishes it from the unknown-route 404 (`not_found`).
`group_not_found` is 403 (admin-only code) to keep denials uniform.

## Tests

- `apps/api/test/http.test.ts` (Fastify `inject`, in-memory staging DB): own-group read, group
  default, top-users/capabilities, cross-group denial without data, member scope denial, unknown
  group, authorized write (attributed to the caller, state restored in `finally`), unauthorized
  writes leave state unchanged, capability gate + recovery, missing/unknown/malformed identity,
  spoofed role headers/params, validation cases (no mutation), privacy scan, sanitized 500,
  no_data/unavailable mapping.
- `apps/api/test/http-process.test.ts`: real process on a temp provisioned staging DB and free
  port; allowed/denied/anonymous over real HTTP, SIGTERM exit 0 with no stderr and port closed;
  prod start with prod authorization semantics (team lead write denied, usage-connector gate, platform-admin write and recovery); refusal for unset/invalid env, bad port, missing DB (exit 1, sanitized stderr, nothing created).

## Manual examples

```sh
U=<user_id from starter-kit/data/directory/users.json, e.g. Priya Nair>
MERIDIAN_ENV=staging pnpm start:api &
curl -H "X-Meridian-User-Id: $U" 'http://127.0.0.1:3200/api/usage-summary?period=2026-W39'
curl -H "X-Meridian-User-Id: $U" 'http://127.0.0.1:3200/api/usage-summary?group=finance&period=2026-W39'   # 403
curl -H "X-Meridian-User-Id: $U" 'http://127.0.0.1:3200/api/capabilities'
curl -X POST -H "X-Meridian-User-Id: $U" -H 'content-type: application/json' \
  -d '{"enabled":false}' 'http://127.0.0.1:3200/api/capabilities/clinical-operations/web-search'
```

## Deliberate non-decisions / P3

- No authentication: the header is a simulation, even in the fictional prod. Real deployments need
  authenticated identity (OIDC/mTLS) in front of the same `ToolService` call.
- No rate limiting, CORS, TLS, request logging or OpenAPI document.
- `worker-threads-shim.d.ts` is a type-only shim: Fastify's pino typings pull in `thread-stream`,
  which references `TransferListItem`, removed from `@types/node` 26. Delete it when upstream fixes.
- `top_users` includes `email` for in-group rows because the starter-kit contract specifies it.
