import {
  parseToolName,
  type JsonValue,
  type ToolOutcome,
  type ToolService,
} from '../../api/src/index.js';
import { TOOL_DEFINITIONS } from './tools.js';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const DEFAULT_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type RequestId = string | number | null;

export type JsonRpcResponse =
  | { readonly jsonrpc: '2.0'; readonly id: RequestId; readonly result: JsonValue }
  | {
      readonly jsonrpc: '2.0';
      readonly id: RequestId;
      readonly error: { readonly code: number; readonly message: string };
    };

export interface McpServerContext {
  readonly serverName: string;
  readonly serverVersion: string;
  /** Server-side trusted identity (launch environment); never read from a message. */
  readonly actorUserId: string | undefined;
  readonly service: ToolService;
}

type Message = Readonly<Record<string, unknown>>;

const failure = (id: RequestId, code: number, message: string): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: { code, message },
});

const success = (id: RequestId, result: JsonValue): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  result,
});

function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function toolResult(outcome: ToolOutcome): JsonValue {
  switch (outcome.kind) {
    case 'ok':
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.value) }],
        ...(isJsonObject(outcome.value) ? { structuredContent: outcome.value } : {}),
        isError: false,
      };
    case 'denied':
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.denial) }],
        structuredContent: { ...outcome.denial },
        isError: true,
      };
    case 'error':
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.error) }],
        structuredContent: { ...outcome.error },
        isError: true,
      };
  }
}

function callTool(context: McpServerContext, id: RequestId, params: unknown): JsonRpcResponse {
  if (!isMessage(params)) {
    return failure(id, INVALID_PARAMS, 'Invalid params');
  }
  const tool = parseToolName(params['name']);
  if (tool === undefined) {
    return failure(id, INVALID_PARAMS, 'Unknown tool');
  }
  const outcome = context.service.invoke(
    context.actorUserId ?? '',
    tool,
    params['arguments'] === undefined ? {} : params['arguments'],
  );
  return success(id, toolResult(outcome));
}

function initialize(context: McpServerContext, id: RequestId, params: unknown): JsonRpcResponse {
  const requested = isMessage(params) ? params['protocolVersion'] : undefined;
  const protocolVersion =
    SUPPORTED_PROTOCOL_VERSIONS.find((candidate) => candidate === requested) ??
    DEFAULT_PROTOCOL_VERSION;
  return success(id, {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: { name: context.serverName, version: context.serverVersion },
  });
}

/** Handles one decoded JSON-RPC message. Notifications produce no response. */
export function handleMessage(
  context: McpServerContext,
  message: unknown,
): JsonRpcResponse | undefined {
  if (
    !isMessage(message) ||
    message['jsonrpc'] !== '2.0' ||
    typeof message['method'] !== 'string'
  ) {
    return failure(null, INVALID_REQUEST, 'Invalid request');
  }
  if (!('id' in message)) {
    return undefined;
  }
  const id = message['id'];
  if (!isRequestId(id)) {
    return failure(null, INVALID_REQUEST, 'Invalid request');
  }
  switch (message['method']) {
    case 'initialize':
      return initialize(context, id, message['params']);
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, {
        tools: TOOL_DEFINITIONS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
    case 'tools/call':
      return callTool(context, id, message['params']);
    default:
      return failure(id, METHOD_NOT_FOUND, 'Method not found');
  }
}

/** Handles one newline-delimited JSON-RPC line; returns the serialized response, if any. */
export function handleLine(context: McpServerContext, line: string): string | undefined {
  if (line.trim() === '') {
    return undefined;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    return JSON.stringify(failure(null, PARSE_ERROR, 'Parse error'));
  }
  const response = handleMessage(context, decoded);
  return response === undefined ? undefined : JSON.stringify(response);
}
