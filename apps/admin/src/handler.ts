import type { Directory } from '../../../packages/domain/src/index.js';
import type { ToolService } from '../../api/src/index.js';
import { renderPage, type Choice, type PageModel } from './render.js';
import { DEFAULT_WEEK, WEEKS, changeCapability, loadDashboard } from './view-model.js';

export interface AdminApp {
  readonly service: ToolService;
  readonly directory: Directory;
}

export interface AdminRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

export interface AdminResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export const MAX_BODY_BYTES = 4096;
const MAX_PARAM_LENGTH = 128;

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; form-action 'self'",
} as const;

const respond = (status: number, body: string): AdminResponse => ({
  status,
  headers: HEADERS,
  body,
});

const text = (status: number, message: string): AdminResponse =>
  respond(status, `<p>${message}</p>`);

function param(params: URLSearchParams, key: string): string {
  const value = params.get(key) ?? '';
  return value.length > MAX_PARAM_LENGTH ? value.slice(0, MAX_PARAM_LENGTH) : value;
}

function weekOf(params: URLSearchParams): string {
  const week = param(params, 'week');
  return WEEKS.find((candidate) => candidate === week) ?? DEFAULT_WEEK;
}

function choices(app: AdminApp): { callers: Choice[]; groups: Choice[] } {
  return {
    callers: [...app.directory.usersById.values()].map((user) => ({
      id: user.userId,
      label: `${user.name} (${user.userId})`,
    })),
    groups: [...app.directory.groupsById.values()].map((group) => ({
      id: group.groupId,
      label: group.name,
    })),
  };
}

function page(app: AdminApp, params: URLSearchParams, change?: PageModel['change']): AdminResponse {
  const caller = param(params, 'caller');
  const group = param(params, 'group');
  const week = weekOf(params);
  const dashboard = caller === '' ? undefined : loadDashboard(app.service, { caller, group, week });
  return respond(200, renderPage({ ...choices(app), caller, group, week, dashboard, change }));
}

function parseEnabled(raw: string): boolean | undefined {
  return raw === 'true' ? true : raw === 'false' ? false : undefined;
}

export function handleRequest(app: AdminApp, request: AdminRequest): AdminResponse {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/') {
    return request.method === 'GET'
      ? page(app, url.searchParams)
      : text(405, 'Method not allowed.');
  }
  if (url.pathname !== '/capability') {
    return text(404, 'Not found.');
  }
  if (request.method !== 'POST') {
    return text(405, 'Method not allowed.');
  }
  if (Buffer.byteLength(request.body) > MAX_BODY_BYTES) {
    return text(413, 'Request too large.');
  }
  const form = new URLSearchParams(request.body);
  const caller = param(form, 'caller');
  const enabled = parseEnabled(param(form, 'enabled'));
  if (caller === '' || enabled === undefined) {
    return page(app, form, { kind: 'rejected', message: 'The change request was invalid.' });
  }
  // Only group/capability/enabled are forwarded; the server decides whether the caller may write.
  const change = changeCapability(app.service, {
    caller,
    group: param(form, 'group'),
    capability: param(form, 'capability'),
    enabled,
  });
  return page(app, form, change);
}
