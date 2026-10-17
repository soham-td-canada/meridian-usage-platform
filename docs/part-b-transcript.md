# Part B transcript: MCP over stdio

Backup evidence for the Part B recording. All output below was captured from the real server, not edited, except where marked _abbreviated_.

- Environment: `staging`, freshly provisioned (`scripts/provision.ts staging`).
- Caller: Priya Nair, `team_lead` of `clinical-operations`, supplied only through `MERIDIAN_ACTOR_USER_ID`.
- Server: `apps/mcp/src/main.ts`, newline-delimited JSON-RPC 2.0 on stdin/stdout. Server stderr was empty during the session.

```bash
TS="node --disable-warning=ExperimentalWarning --experimental-transform-types --import ./scripts/register-ts.mjs"
MERIDIAN_ENV=staging MERIDIAN_ACTOR_USER_ID=user_E7691888F28227066DD2FB86 $TS apps/mcp/src/main.ts
```

## 1. initialize

```json
-> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"transcript","version":"0"}}}
<- {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"meridian-usage-staging","version":"0.0.0"}}}
```

## 2. tools/list: exactly four tools

```json
-> {"jsonrpc":"2.0","id":2,"method":"tools/list"}
<- (abbreviated: descriptions and property schemas omitted)
[{"name":"usage_summary","required":["period"]},{"name":"top_users","required":["period"]},{"name":"capability_status","required":[]},{"name":"set_capability","required":["group","capability","enabled"]}]
```

`period` is required for `usage_summary` and `top_users`. `group` is optional. `set_capability` requires `group`, `capability` and `enabled`.

## 3. ALLOWED READ: own group

```json
-> {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"usage_summary","arguments":{"period":"2026-W36"}}}
<- {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"group\":\"clinical-operations\",\"period\":{\"start\":\"2026-08-31\",\"end_exclusive\":\"2026-09-07\"},\"platforms\":[{\"platform\":\"claude\",\"requests\":379,\"input_tokens\":2395860,\"output_tokens\":258965,\"total_tokens\":2654825,\"cost_usd\":34.84464716},{\"platform\":\"gemini\",\"requests\":null,\"input_tokens\":1615887,\"output_tokens\":527967,\"total_tokens\":2143854,\"cost_usd\":2.369597}],\"totals\":{\"total_tokens\":4798679,\"cost_usd\":37.21424416}}"}],"structuredContent":{"group":"clinical-operations","period":{"start":"2026-08-31","end_exclusive":"2026-09-07"},"platforms":[{"platform":"claude","requests":379,"input_tokens":2395860,"output_tokens":258965,"total_tokens":2654825,"cost_usd":34.84464716},{"platform":"gemini","requests":null,"input_tokens":1615887,"output_tokens":527967,"total_tokens":2143854,"cost_usd":2.369597}],"totals":{"total_tokens":4798679,"cost_usd":37.21424416}},"isError":false}}
```

The result is for `clinical-operations` (the caller's home group, selected by the server). The Claude and Gemini rows stay separate; `requests` is `null` for Gemini because billing exports carry no request count.

## 4. DENIED CROSS-GROUP READ

```json
-> {"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"usage_summary","arguments":{"group":"finance","period":"2026-W36"}}}
<- {"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"{\"error\":\"permission_denied\",\"code\":\"group_not_permitted\",\"reason\":\"The caller may not access the requested group.\"}"}],"structuredContent":{"error":"permission_denied","code":"group_not_permitted","reason":"The caller may not access the requested group."},"isError":true}}
```

`isError` is `true`. The denial names no usage data and does not reveal whether `finance` has any.

## 5. DENIED WRITE

```json
-> {"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"set_capability","arguments":{"group":"finance","capability":"web-search","enabled":false}}}
<- {"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"{\"error\":\"permission_denied\",\"code\":\"group_not_permitted\",\"reason\":\"The caller may not access the requested group.\"}"}],"structuredContent":{"error":"permission_denied","code":"group_not_permitted","reason":"The caller may not access the requested group."},"isError":true}}
```

Priya holds `capabilities:write` in staging, but only for her own group, so the foreign-group write is denied and nothing is persisted. Other denial codes seen elsewhere in the test suite: `scope_not_granted` (role lacks the scope, e.g. a member, or any team lead in prod) and `capability_disabled` (`usage-connector` off for the caller's group).
