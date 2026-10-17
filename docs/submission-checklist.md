# Submission checklist

Assignment ID: `Fullstack-ClaudeGemini-UsageConnector-v1`

## Automated complete

Verified on the final working tree:

- [x] `pnpm check`: format, lint, typecheck, 536 tests passing
- [x] `pnpm test:e2e`: 3/3 Playwright scenarios (Admin, staging)
- [x] `pnpm validate:provisioning`: dev, staging, prod
- [x] `pnpm test` under `TZ=America/Toronto` and `TZ=Asia/Kolkata`
- [x] `git diff --check` clean
- [x] README: overview, setup, architecture, mapping, attribution, permission model, HTTP API, Admin UI, MCP tools, registration and packaging, provisioning, testing/CI, decisions, standards, omissions, AI usage and overrides, "In the real enterprise version"
- [x] Claude registration and plugin package (`generated/<env>/claude.mcp.json`, `claude-plugin/<server_name>/`)
- [x] Gemini registration and extension package (`generated/<env>/gemini.settings.json`, `gemini-extension/<server_name>/`)
- [x] Part B evidence: `docs/part-b-transcript.md` (allowed read section 3, denied cross-group read section 4, denied write section 5)
- [x] Demo script (`docs/demo-script.md`) and team-lead note (`docs/team-leads-note.md`)

Claude and Gemini packages are generated and validated by repository tests. They have not been installed in a live host.

## Manual remaining

- [x] Review the final diff
- [x] Untrack `.idea/` (`git rm -r --cached .idea`); it is git-ignored but was committed and contains local paths
- [x] Commit
- [x] Push
- [x] Verify the GitHub Actions run is green
- [x] Record the Loom using `docs/demo-script.md`
- [x] Add or share the Loom URL where required
- [x] Confirm reviewer repository access
- [x] Optional: validate the plugin and extension in live Claude Code and Gemini CLI sessions
