# Demo Script (about 7 minutes)

Setup before recording (staging; Priya is a team lead, Chloe a platform admin):

```bash
pnpm install && pnpm check && pnpm provision staging
MERIDIAN_ENV=staging pnpm start:admin     # terminal 1: http://127.0.0.1:3100
MERIDIAN_ENV=staging pnpm start:api       # terminal 2: http://127.0.0.1:3200
```

| Person       | Group               | Role           | User id                         |
| ------------ | ------------------- | -------------- | ------------------------------- |
| Priya Nair   | clinical-operations | team lead      | `user_E7691888F28227066DD2FB86` |
| Chloe Dubois | it-platform         | platform admin | `user_533B58E6F66C98ACB833527A` |

Keep `README.md` (Architecture) and a terminal ready. Do not read code aloud.

## 5. Admin UI (2:40, 100 s)

- **Action:** Open `http://127.0.0.1:3100`. Caller: Priya Nair, Group: Clinical Operations, Week: 2026-W36, Load.
- **Should appear:** Claude and Gemini usage rows, top users, capability table.
- **Say:** "A team lead sees her own group, with each platform kept separate."

- **Action:** Change Group to Finance, Load.
- **Should appear:** Alert `group_not_permitted`; no usage table, no Finance data.
- **Say:** "The server denies the foreign group and returns nothing partial."

- **Action:** Group back to Clinical Operations. Click Disable on `usage-connector`, then Load.
- **Should appear:** Status "usage-connector for clinical-operations is now disabled"; alert `capability_disabled`; capability row shows `unknown` with Enable and Disable buttons.
- **Say:** "Capability state is persisted and gates reads. The Enable button is the recovery path."

- **Action:** Click Enable, then Load.
- **Should appear:** Status "... is now enabled"; usage visible again.
- **Say:** "Recovery works because set_capability is exempt from the connector gate, not from authorization."

- **Action:** Caller: Chloe Dubois, Group: Finance, Load. Then Regulatory Affairs.
- **Should appear:** Usage for each group, no alerts.
- **Say:** "Platform admins may read every group."

## 6. HTTP API (4:20, 45 s)

- **Action:** In a terminal:

```bash
curl -s -H "X-Meridian-User-Id: user_E7691888F28227066DD2FB86" \
  "http://127.0.0.1:3200/api/usage-summary?period=2026-W36"
curl -s -i -H "X-Meridian-User-Id: user_E7691888F28227066DD2FB86" \
  "http://127.0.0.1:3200/api/usage-summary?group=finance&period=2026-W36"
```

- **Should appear:** First call: JSON for `clinical-operations` with `claude` and `gemini` platforms. Second call: `403`, `code: group_not_permitted`.
- **Say:** "The header only names the simulated caller. Role and group come from the directory, and the API is a thin transport over the same service."

## 7. MCP (5:05, 100 s)

- **Action:** Terminal 3: `MERIDIAN_ENV=staging MERIDIAN_ACTOR_USER_ID=user_E7691888F28227066DD2FB86 pnpm -s start:mcp`. Paste each line below, one at a time:

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"usage_summary","arguments":{"period":"2026-W36"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"usage_summary","arguments":{"group":"finance","period":"2026-W36"}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"set_capability","arguments":{"group":"finance","capability":"web-search","enabled":false}}}
```

- **Should appear:** `initialize` returns `meridian-usage-staging`. `tools/list` shows exactly four tools; `period` is required on two. Line 3: `isError: false`, group `clinical-operations`. Lines 4 and 5: `isError: true`, `error: permission_denied`, `code: group_not_permitted`, no Finance data and no state change. Press Ctrl-D to exit.
- **Say:** "Identity is the configured actor, never an argument. The cross-group read and the cross-group write are both denied with a structured result and no protected data." Optionally mention that `docs/part-b-transcript.md` holds the same session.

## 8. Tests, provisioning and packaging (6:05, 45 s)

- **Action:** Show the `pnpm check` summary (536 tests), `pnpm validate:provisioning` output, `ls generated/staging/claude-plugin generated/staging/gemini-extension` and `.github/workflows/ci.yml`.
- **Should appear:** All tests passing; `provisioning validation passed: dev, staging, prod`; the two package folders; CI jobs.
- **Say:** "Tests cover mapping, authorization attacks, real server processes and a browser run. CI repeats them in two timezones and validates provisioning. Provisioning also generates a Claude plugin and a Gemini extension that launch this same MCP server; they are validated by tests, not yet installed in a live host."

## 10. Production evolution (7:30, 20 s)

- **Action:** Show "In the real enterprise version".
- **Should appear:** Six bullets.
- **Say:** "None of this is built: real identity, managed database, real vendor APIs, audit and observability. The boundaries are where those slot in."

## Cleanup

Step 5 re-enabled `usage-connector`; step 7 changed nothing. Verify in the Admin capability table (Priya, Clinical Operations) that `usage-connector` is enabled. If a take was interrupted, click Enable, or re-run `pnpm provision staging` after deleting `generated/staging/`.
