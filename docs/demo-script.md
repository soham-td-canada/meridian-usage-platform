# Demo Script (about 6 minutes)

Setup (before recording), staging environment:

```bash
pnpm install && pnpm check
TS="node --disable-warning=ExperimentalWarning --experimental-transform-types --import ./scripts/register-ts.mjs"
$TS scripts/provision.ts staging
MERIDIAN_ENV=staging $TS apps/admin/src/main.ts    # http://127.0.0.1:3100
```

Directory ids used (from `starter-kit/data/directory/users.json`):

| Role           | Group               | User id                         |
| -------------- | ------------------- | ------------------------------- |
| team lead      | clinical-operations | `user_E7691888F28227066DD2FB86` |
| platform admin | it-platform         | `user_533B58E6F66C98ACB833527A` |
| member         | clinical-operations | `user_699C48763F6FA2958D2CDB5D` |

| #   | Action                                                                                      | Expected visible result                                                                     | Narration                                                                                                    |
| --- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | Show `README.md` Architecture diagram and `apps/`, `packages/` folders.                     | Diagram: exports, ingestion, persistence, ToolService, authorization, UI/MCP.               | Authorization sits below both Admin and MCP, so neither client can bypass it.                                |
| 2   | Admin: caller = clinical-operations team lead, group = own group, week = 2026-W36.          | Claude and Gemini rows with tokens and cost; top users; capability table.                   | A team lead sees their own group's usage, with each platform kept separate.                                  |
| 3   | Same caller, change group to `finance`.                                                     | Denied: `group_not_permitted`; no usage numbers.                                            | Cross-group reads fail closed and reveal no partial data.                                                    |
| 4   | Same caller, own group: disable `usage-connector`.                                          | Page re-renders with the connector disabled; usage sections now show `capability_disabled`. | Capability controls are persisted and writable by a lead for their own group.                                |
| 5   | Reload the page for the same caller and group.                                              | Usage sections show `capability_disabled`; capability status shows "unknown".               | Disabling the connector gates every read tool, including `capability_status`.                                |
| 6   | Click Enable for `usage-connector`.                                                         | Usage is visible again.                                                                     | `set_capability` is the exempt control-plane path, and still requires role, scope and group.                 |
| 7   | Switch caller to the platform admin, group = `finance`.                                     | Finance usage is visible.                                                                   | Admins may read every group.                                                                                 |
| 8   | Run the MCP server (below) and send `initialize` then `tools/list`.                         | Server info `meridian-usage-staging`; exactly four tools.                                   | MCP is a small stdio JSON-RPC server over the same ToolService.                                              |
| 9   | MCP as team lead: `usage_summary` with `{"period":"2026-W36"}`.                             | Result for `clinical-operations` with `isError` absent or false.                            | The group defaults to the caller's home group; the period is required.                                       |
| 10  | MCP as team lead: `usage_summary` with `{"group":"finance","period":"2026-W36"}`.           | `isError: true`, `code: group_not_permitted`.                                               | Identity comes from `MERIDIAN_ACTOR_USER_ID`, never from arguments.                                          |
| 11  | MCP as the member: `set_capability` for `clinical-operations`, `web-search`, `false`.       | `isError: true`, `code: scope_not_granted`, `required_scope: capabilities:write`.           | Writes need the `capabilities:write` scope.                                                                  |
| 12  | Show `pnpm check` output, then `pnpm validate:provisioning` and `.github/workflows/ci.yml`. | 507 tests across 30 files; provisioning passes for dev, staging, prod.                      | CI also runs tests in two timezones and validates provisioning for all three environments.                   |
| 13  | Show the AI-Assisted Development section of the README.                                     | List of issues caught in review.                                                            | Agents drafted and reviewed code, and review caught real defects such as `period` being treated as optional. |

MCP session for steps 8 to 11 (one JSON object per line on stdin; replace the user id per step):

```bash
MERIDIAN_ENV=staging MERIDIAN_ACTOR_USER_ID=user_E7691888F28227066DD2FB86 $TS apps/mcp/src/main.ts
```

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"usage_summary","arguments":{"period":"2026-W36"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"usage_summary","arguments":{"group":"finance","period":"2026-W36"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"set_capability","arguments":{"group":"clinical-operations","capability":"web-search","enabled":false}}}
```

Line 5 is denied for the member (`scope_not_granted`). For the team lead it would succeed, so run it only as the member.

Cleanup: ensure step 6 re-enabled `usage-connector`. Capability changes persist across reprovisioning, so `web-search` and `usage-connector` should remain enabled for staging.
