import { CAPABILITIES } from '../../../packages/domain/src/index.js';
import {
  WEEKS,
  type ChangeResult,
  type Dashboard,
  type Section,
  type TopUserRow,
  type UsageSummary,
} from './view-model.js';

export interface Choice {
  readonly id: string;
  readonly label: string;
}

export interface PageModel {
  readonly callers: readonly Choice[];
  readonly groups: readonly Choice[];
  readonly caller: string;
  readonly group: string;
  readonly week: string;
  readonly dashboard: Dashboard | undefined;
  readonly change:
    ChangeResult | { readonly kind: 'rejected'; readonly message: string } | undefined;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const e = escapeHtml;
const usd = (value: number): string => `$${value.toFixed(4)}`;
const count = (value: number): string => value.toLocaleString('en-US');

function options(choices: readonly Choice[], selected: string, extra?: Choice): string {
  const all =
    extra === undefined || choices.some((c) => c.id === extra.id) ? choices : [extra, ...choices];
  return all
    .map(
      (c) =>
        `<option value="${e(c.id)}"${c.id === selected ? ' selected' : ''}>${e(c.label)}</option>`,
    )
    .join('');
}

/** Renders every non-ok state the same way, so no section can show data after a refusal. */
function problem(section: Exclude<Section<unknown>, { readonly kind: 'ok' }>): string {
  switch (section.kind) {
    case 'denied':
      return `<p class="denied" role="alert">Denied (${e(section.code)}): ${e(section.reason)}${
        section.requiredScope === undefined ? '' : ` Required scope: ${e(section.requiredScope)}.`
      }</p>`;
    case 'error':
      return `<p class="error" role="alert">Error (${e(section.code)}): ${e(section.message)}</p>`;
    case 'invalid':
      return '<p class="error" role="alert">Error: the service returned an unrecognised response.</p>';
  }
}

function usageRows(week: string, usage: UsageSummary): string {
  return usage.platforms
    .map(
      (row) =>
        `<tr><td>${e(week)}</td><td>${e(row.platform)}</td><td>${row.requests === null ? 'n/a' : count(row.requests)}</td><td>${count(row.inputTokens)}</td><td>${count(row.outputTokens)}</td><td>${count(row.totalTokens)}</td><td>${usd(row.costUsd)}</td></tr>`,
    )
    .join('');
}

function usageSection(dashboard: Dashboard): string {
  const rows = dashboard.weeks
    .map(({ week, usage }) => {
      switch (usage.kind) {
        case 'ok':
          return usageRows(week, usage.value);
        case 'error':
          return usage.code === 'no_data'
            ? `<tr><td>${e(week)}</td><td colspan="6">no data</td></tr>`
            : `<tr><td>${e(week)}</td><td colspan="6">${e(usage.message)} (${e(usage.code)})</td></tr>`;
        case 'denied':
          return `<tr><td>${e(week)}</td><td colspan="6">denied (${e(usage.code)})</td></tr>`;
        case 'invalid':
          return `<tr><td>${e(week)}</td><td colspan="6">unrecognised response</td></tr>`;
      }
    })
    .join('');
  const first = dashboard.weeks[0]?.usage;
  const blocked = dashboard.weeks.every(({ usage }) => usage.kind === 'denied');
  if (blocked && first?.kind === 'denied') {
    return `<h2>Usage and cost by platform and week</h2>${problem(first)}`;
  }
  return `<h2>Usage and cost by platform and week</h2><table><thead><tr><th>Week</th><th>Platform</th><th>Requests</th><th>Input tokens</th><th>Output tokens</th><th>Total tokens</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function topUsersSection(week: string, section: Section<readonly TopUserRow[]>): string {
  const title = `<h2>Top users, ${e(week)}</h2>`;
  if (section.kind !== 'ok') {
    return title + problem(section);
  }
  const rows = section.value
    .map(
      (user) =>
        `<tr><td>${e(user.name)}</td><td>${e(user.userId)}</td><td>${count(user.totalTokens)}</td><td>${usd(user.costUsd)}</td></tr>`,
    )
    .join('');
  return `${title}<table><thead><tr><th>Name</th><th>User</th><th>Total tokens</th><th>Cost</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function capabilityForm(
  caller: string,
  week: string,
  target: { readonly group: string; readonly capability: string },
  enable: boolean,
): string {
  return `<form method="post" action="/capability"><input type="hidden" name="caller" value="${e(caller)}"><input type="hidden" name="group" value="${e(target.group)}"><input type="hidden" name="capability" value="${e(target.capability)}"><input type="hidden" name="enabled" value="${enable ? 'true' : 'false'}"><input type="hidden" name="week" value="${e(week)}"><button type="submit">${enable ? 'Enable' : 'Disable'}</button></form>`;
}

/**
 * capability_status is gated by usage-connector (contract: every tool is denied while it is
 * disabled), so state is unknown here. Writes stay open to the server's own decision, which lets
 * an authorised caller re-enable the connector. The UI offers both actions and decides nothing.
 */
function recoverySection(dashboard: Dashboard): string {
  if (dashboard.group === '') {
    return '<p>Capability state is hidden while usage-connector is disabled. Select your group explicitly to change capabilities.</p>';
  }
  const rows = CAPABILITIES.map(
    (capability) =>
      `<tr><td>${e(dashboard.group)}</td><td>${e(capability)}</td><td>unknown</td><td>${capabilityForm(dashboard.caller, dashboard.week, { group: dashboard.group, capability }, true)} ${capabilityForm(dashboard.caller, dashboard.week, { group: dashboard.group, capability }, false)}</td></tr>`,
  ).join('');
  return `<p>Capability state is hidden while usage-connector is disabled; the server decides whether a change is allowed.</p><table><thead><tr><th>Group</th><th>Capability</th><th>State</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function capabilitySection(dashboard: Dashboard): string {
  const title = '<h2>Capabilities</h2>';
  const section = dashboard.capabilities;
  if (section.kind === 'denied' && section.code === 'capability_disabled') {
    return title + problem(section) + recoverySection(dashboard);
  }
  if (section.kind !== 'ok') {
    return title + problem(section);
  }
  const rows = section.value
    .map(
      (row) =>
        `<tr><td>${e(row.group)}</td><td>${e(row.capability)}</td><td>${row.enabled ? 'enabled' : 'disabled'}</td><td>${e(row.updatedAt ?? 'default')}</td><td>${e(row.updatedBy ?? 'default')}</td><td>${capabilityForm(dashboard.caller, dashboard.week, row, !row.enabled)}</td></tr>`,
    )
    .join('');
  return `${title}<table><thead><tr><th>Group</th><th>Capability</th><th>State</th><th>Updated at</th><th>Updated by</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function changeBanner(change: NonNullable<PageModel['change']>): string {
  switch (change.kind) {
    case 'updated':
      return `<p class="ok" role="status">${e(change.row.capability)} for ${e(change.row.group)} is now ${change.row.enabled ? 'enabled' : 'disabled'}.</p>`;
    case 'rejected':
      return `<p class="error" role="alert">${e(change.message)}</p>`;
    case 'denied':
    case 'error':
    case 'invalid':
      return problem(change);
  }
}

export function renderPage(model: PageModel): string {
  const callerChoice: Choice = { id: model.caller, label: model.caller };
  const body =
    model.dashboard === undefined
      ? '<p>Select a simulated caller and press Load.</p>'
      : usageSection(model.dashboard) +
        topUsersSection(model.week, model.dashboard.topUsers) +
        capabilitySection(model.dashboard);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Meridian admin</title></head><body>
<h1>Meridian AI usage admin</h1>
<p>Simulated caller (development only). Access is decided by the server.</p>
<form method="get" action="/">
<label>Caller <select name="caller"><option value="">-- select --</option>${options(model.callers, model.caller, model.caller === '' ? undefined : callerChoice)}</select></label>
<label>Group <select name="group"><option value=""${model.group === '' ? ' selected' : ''}>(caller home group)</option>${options(model.groups, model.group, model.group === '' ? undefined : { id: model.group, label: model.group })}</select></label>
<label>Week <select name="week">${options(
    WEEKS.map((week) => ({ id: week, label: week })),
    model.week,
  )}</select></label>
<button type="submit">Load</button>
</form>
${model.change === undefined ? '' : changeBanner(model.change)}
${body}
</body></html>
`;
}
