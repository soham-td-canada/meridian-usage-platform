import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../api/src/index.js';
import { loadDirectoryOrThrow, userWith } from '../../api/test/helpers.js';
import { provisionEnvironment } from '../../../scripts/provision-environment.js';
import { SERVER_ARGS, SERVER_COMMAND } from '../src/provisioning.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
const root = mkdtempSync(join(tmpdir(), 'meridian-process-'));
roots.push(root);
provisionEnvironment({ environment: 'dev', rootDir: root, recordedAt: '2026-10-01T00:00:00.000Z' });
const databasePath = join(root, 'generated/dev/meridian.sqlite');
const directory = loadDirectoryOrThrow();
const adminId = userWith(directory, 'platform_admin', 'it-platform').userId;
const memberId = userWith(directory, 'member', 'it-platform').userId;

afterAll(() => {
  for (const child of children) {
    child.kill('SIGKILL');
  }
  for (const dir of roots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Run {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exit: Promise<number | null>;
}

function start(env: Record<string, string>): Run {
  const child = spawn(SERVER_COMMAND, [...SERVER_ARGS], {
    cwd: REPO_ROOT,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk;
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on('close', resolve);
  });
  return { child, stdout: () => out, stderr: () => err, exit };
}

const provisioned = (actor: string): Record<string, string> => ({
  MERIDIAN_ENV: 'dev',
  MERIDIAN_DB_PATH: databasePath,
  MERIDIAN_ACTOR_USER_ID: actor,
});

function parseLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function request(id: number, method: string, params?: object): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

function toolCall(id: number, name: string, args: object): string {
  return request(id, 'tools/call', { name, arguments: args });
}

function denial(response: Record<string, unknown> | undefined): unknown {
  const result = response?.['result'] as { isError: boolean; content: { text: string }[] };
  expect(result.isError).toBe(true);
  return JSON.parse(result.content[0]?.text ?? '{}');
}

describe('MCP server process boundary', () => {
  it('speaks JSON-RPC only on stdout, serves tools, denies, and exits cleanly on EOF', async () => {
    const run = start(provisioned(memberId));
    run.child.stdin?.end(
      request(1, 'initialize', { protocolVersion: '2025-06-18' }) +
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n` +
        request(2, 'tools/list') +
        toolCall(3, 'usage_summary', { period: '2026-W36' }) +
        toolCall(4, 'set_capability', {
          group: 'it-platform',
          capability: 'web-search',
          enabled: false,
        }),
    );
    expect(await run.exit).toBe(0);
    expect(run.stderr()).toBe('');
    const lines = parseLines(run.stdout());
    expect(lines.map((line) => line['id'])).toEqual([1, 2, 3, 4]);
    expect(lines.every((line) => line['jsonrpc'] === '2.0')).toBe(true);
    const tools = (lines[1]?.['result'] as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'capability_status',
      'set_capability',
      'top_users',
      'usage_summary',
    ]);
    expect((lines[2]?.['result'] as { isError: boolean }).isError).toBe(false);
    expect(denial(lines[3])).toMatchObject({
      error: 'permission_denied',
      code: 'scope_not_granted',
    });
  }, 60_000);

  it('denies an unknown actor over stdio without leaking the identity', async () => {
    const run = start(provisioned('nobody@example.invalid'));
    run.child.stdin?.end(toolCall(1, 'capability_status', {}));
    expect(await run.exit).toBe(0);
    expect(denial(parseLines(run.stdout())[0])).toMatchObject({ code: 'identity_unresolved' });
    expect(run.stdout()).not.toContain('nobody@example.invalid');
    expect(run.stderr()).toBe('');
  }, 60_000);

  it('exits cleanly on SIGTERM while stdin is still open', async () => {
    const run = start(provisioned(adminId));
    run.child.stdin?.write(request(1, 'ping'));
    await new Promise<void>((resolve) => {
      run.child.stdout?.once('data', () => {
        resolve();
      });
    });
    run.child.kill('SIGTERM');
    expect(await run.exit).toBe(0);
    expect(parseLines(run.stdout())).toHaveLength(1);
  }, 60_000);

  it('fails closed on stderr with no stdout, no fallback and no database creation', async () => {
    const missing = join(root, 'never-created.sqlite');
    for (const env of [
      { MERIDIAN_ENV: 'qa', MERIDIAN_DB_PATH: databasePath },
      { MERIDIAN_DB_PATH: databasePath },
      { MERIDIAN_ENV: 'dev', MERIDIAN_DB_PATH: missing },
    ]) {
      const run = start(env);
      run.child.stdin?.end();
      expect(await run.exit).toBe(1);
      expect(run.stdout()).toBe('');
      expect(run.stderr()).not.toBe('');
      expect(run.stderr()).not.toMatch(/\n\s+at /);
    }
    expect(existsSync(missing)).toBe(false);
  }, 60_000);
});
