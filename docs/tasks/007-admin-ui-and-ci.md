# 007 — Admin UI and CI

## Goal

A plain server-rendered admin page over the Task 006 `ToolService`, plus a deterministic CI workflow that runs format/lint/typecheck/tests and validates provisioning for dev, staging and prod.

Sources: `starter-kit/README.md`, Tasks 004–006 (read-only).

## Affected invariants

- The UI never decides access. Every read and write goes through `ToolService.invoke` (Task 006), which applies `resolveActor` + `authorizeRead` / `authorizeCapabilityWrite`. The UI renders every control for every caller and shows the server's denial.
- Identity is server-side. The only client input is a simulated caller `user_id`, honoured by the admin server process solely outside `prod`; role, scope and home group are never accepted or forwarded. `prod` refuses to start the admin server (no authentication exists; Out of scope).
- Denials/errors render fixed `code`/`reason`/`message` strings only, HTML-escaped; a denied section shows no data. Unknown shapes from the service render as an error, never as zero.
- Money is displayed as received (exact decimal → number from Task 006); the UI never sums or converts money.
- Periods are the Task 006 ISO-week strings; the data window is 2026-W32..W39 (README).
- Steps 2–6 behaviour, the contract and the MCP surface are unchanged.

## Design (no new dependencies; `node:http`, no React/Fastify)

| Path                                 | Role                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `apps/admin/src/view-model.ts`       | `loadDashboard` / `changeCapability`: call the service, validate JSON shapes (`unknown` → typed), no policy    |
| `apps/admin/src/render.ts`           | Pure HTML rendering with escaping                                                                              |
| `apps/admin/src/handler.ts`          | `handleRequest(app, {method,url,body})` → `{status,headers,body}`; `GET /`, `POST /capability`; body size cap  |
| `apps/admin/src/main.ts`             | Reads `MERIDIAN_ENV`/`MERIDIAN_DB_PATH`, refuses `prod`, binds `127.0.0.1`                                     |
| `scripts/provisioning-validation.ts` | Provisions dev/staging/prod into a temp root twice; checks files, server names, defaults, byte-identical rerun |
| `scripts/validate-provisioning.ts`   | CLI wrapper (`pnpm validate:provisioning`)                                                                     |
| `.github/workflows/ci.yml`           | CI                                                                                                             |

Page (`GET /?caller=<userId>&group=<groupId>&week=<ISO week>`):

- Caller `<select>` (simulated identity; lists directory names/ids only), group `<select>` (all groups), week `<select>` (W32–W39).
- Usage by platform for the selected group, one row set per week W32–W39 (`usage_summary` per week); weeks without data show "no data".
- Top users for the selected week (`top_users`).
- Capability table for the group (`capability_status`) with an enable/disable form per capability (`POST /capability` → `set_capability`), result banner, page re-rendered.
- Recovery: `capability_status` stays gated by `usage-connector` (contract: every tool is denied). On `capability_disabled` with an explicit group, the UI shows state "unknown" with Enable/Disable forms per capability; writes still go to `set_capability`, which Task 005 exempts from the gate and authorizes server-side. No policy is added to the UI.
- States: each section independently renders `ok`, `denied` (code + reason + required scope), `error` (code + message), or `invalid response`. Invalid query params fall back to defaults; unknown caller is sent as-is and the server denies `identity_unresolved`.

## CI

`.github/workflows/ci.yml` (Node 22, `pnpm install --frozen-lockfile`): `pnpm check`, `TZ=America/Toronto pnpm test`, `TZ=Asia/Kolkata pnpm test`, `pnpm validate:provisioning`. No network beyond install, no secrets, no time-dependent steps.

## MUST-HAVE tests

1. Dashboard: platform/week/group dimensions correct against the service output; admin can view another group, lead own group.
2. Denials: member (no scope), lead foreign group, connector disabled, unknown caller → structured denial rendered, no usage numbers present, HTML-escaped.
3. Capability update: toggle persists, `updated_by` is the simulated caller, page reflects it; denied write changes nothing; invalid form values rejected without a write.
4. Adversarial: `role`/`scope`/`home_group`/extra form fields ignored; script/HTML in params escaped; oversized body rejected; unknown route/method 404/405.
5. Missing data/errors: empty database ⇒ error states, never zeros.
6. UI source contains no authorization policy (no imports from `packages/authorization`, no role/scope literals).
7. Provisioning validation passes for all three environments and fails closed on a corrupted result.

## Out of scope

Authentication/sessions, production hosting, CSRF tokens, styling/design system, client-side JS, charts, new dependencies, MCP/API/auth changes, audit logging, Step 8.
