import { once } from 'node:events';
import { createInterface } from 'node:readline';

export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const LEGACY_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2024-11-05',
] as const;

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  MCP_PROTOCOL_VERSION,
  ...LEGACY_PROTOCOL_VERSIONS,
];

type RpcId = string | number;
type ServerInfo = { name: string; version: string };

export type RpcContext = {
  modern: boolean;
  protocolVersion: string;
  clientInfo?: { name: string; version: string };
  clientCapabilities: Record<string, unknown>;
};

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): never {
  throw new RpcError(-32600, message);
}

/** Parse and validate one JSON-RPC request or notification line. */
export function parseRpcLine(line: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new RpcError(-32700, 'Parse error');
  }

  if (!isRecord(parsed)) invalidRequest('Invalid Request');
  if (parsed.jsonrpc !== '2.0') invalidRequest('Invalid Request');
  if (hasOwn(parsed, 'result') || hasOwn(parsed, 'error')) {
    invalidRequest('JSON-RPC responses are not requests');
  }
  if (typeof parsed.method !== 'string') invalidRequest('Invalid Request');

  if (hasOwn(parsed, 'id')) {
    const id = parsed.id;
    if (
      id === null ||
      (typeof id !== 'string' &&
        !(typeof id === 'number' && Number.isInteger(id)))
    ) {
      invalidRequest('Invalid Request');
    }
  }

  return parsed;
}

function readClientInfo(
  params: Record<string, unknown>,
  meta?: Record<string, unknown>,
): { name: string; version: string } | undefined {
  const candidates = meta === undefined
    ? [params.clientInfo]
    : [meta[CLIENT_INFO_META_KEY], meta.clientInfo, params.clientInfo];

  for (const candidate of candidates) {
    if (
      isRecord(candidate) &&
      typeof candidate.name === 'string' &&
      typeof candidate.version === 'string'
    ) {
      return { name: candidate.name, version: candidate.version };
    }
  }
  return undefined;
}

/** Validate the metadata required on every 2026-07-28 client request. */
export function validateModernRequest(msg: Record<string, unknown>): RpcContext {
  if (!isRecord(msg.params)) {
    throw new RpcError(-32602, 'Invalid params: params._meta is required');
  }
  const meta = msg.params._meta;
  if (!isRecord(meta)) {
    throw new RpcError(-32602, 'Invalid params: params._meta is required');
  }

  const protocolVersion = meta[PROTOCOL_VERSION_META_KEY];
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    throw new RpcError(
      -32602,
      `Invalid params: params._meta.${PROTOCOL_VERSION_META_KEY} is required`,
    );
  }
  if (protocolVersion !== MCP_PROTOCOL_VERSION) {
    throw new RpcError(-32022, 'Unsupported protocol version', {
      supported: [...SUPPORTED_PROTOCOL_VERSIONS],
    });
  }

  const clientCapabilities = meta[CLIENT_CAPABILITIES_META_KEY];
  if (!isRecord(clientCapabilities)) {
    throw new RpcError(
      -32602,
      `Invalid params: params._meta.${CLIENT_CAPABILITIES_META_KEY} is required`,
    );
  }

  return {
    modern: true,
    protocolVersion,
    clientInfo: readClientInfo(msg.params, meta),
    clientCapabilities,
  };
}

/** Add the completion envelope for modern results; leave legacy results untouched. */
export function makeResult(
  id: RpcId,
  result: Record<string, unknown>,
  context: RpcContext,
  serverInfo: ServerInfo,
): Record<string, unknown> {
  if (!context.modern) return { jsonrpc: '2.0', id, result };

  const existingMeta = isRecord(result._meta) ? result._meta : {};
  return {
    jsonrpc: '2.0',
    id,
    result: {
      ...result,
      resultType: 'complete',
      _meta: {
        ...existingMeta,
        [SERVER_INFO_META_KEY]: { ...serverInfo },
      },
    },
  };
}

export function makeError(id: RpcId | null, error: RpcError): Record<string, unknown> {
  const detail: Record<string, unknown> = {
    code: error.code,
    message: error.message,
  };
  if (error.data !== undefined) detail.data = error.data;
  return { jsonrpc: '2.0', id, error: detail };
}

function readParams(msg: Record<string, unknown>): Record<string, unknown> {
  if (!hasOwn(msg, 'params')) return {};
  if (!isRecord(msg.params)) {
    throw new RpcError(-32602, 'Invalid params: expected an object');
  }
  return msg.params;
}

function makeLegacyInitializeContext(msg: Record<string, unknown>): RpcContext {
  const params = readParams(msg);
  const requestedVersion = params.protocolVersion;
  const protocolVersion =
    typeof requestedVersion === 'string' &&
    (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requestedVersion)
      ? requestedVersion
      : LEGACY_PROTOCOL_VERSIONS[0];

  return {
    modern: false,
    protocolVersion,
    clientInfo: readClientInfo(params),
    clientCapabilities: isRecord(params.capabilities) ? params.capabilities : {},
  };
}

function asRpcError(error: unknown): RpcError {
  return error instanceof RpcError
    ? error
    : new RpcError(-32603, 'Internal error');
}

function supportsMethod(
  method: string,
  capabilities: Record<string, unknown>,
): boolean {
  if (method.startsWith('tools/')) return hasOwn(capabilities, 'tools');
  if (method.startsWith('prompts/')) return hasOwn(capabilities, 'prompts');
  if (method.startsWith('resources/')) return hasOwn(capabilities, 'resources');
  if (method === 'completion/complete') return hasOwn(capabilities, 'completions');
  if (method === 'logging/setLevel') return hasOwn(capabilities, 'logging');
  return false;
}

type PendingResponse = { id: RpcId | null; message: Record<string, unknown> };

export async function runMcpStdio(opts: {
  serverInfo: { name: string; version: string };
  capabilities: Record<string, unknown>;
  instructions?: string;
  handle(
    method: string,
    params: Record<string, unknown>,
    ctx: RpcContext,
  ): unknown | Promise<unknown>;
  log?: (line: string) => void;
}): Promise<void> {
  const log = opts.log ?? ((line: string): void => {
    process.stderr.write(`${line}\n`);
  });
  const serverInfo = { ...opts.serverInfo };
  let negotiatedLegacyContext: RpcContext | undefined;

  async function dispatchLine(line: string): Promise<PendingResponse | undefined> {
    let msg: Record<string, unknown>;
    try {
      msg = parseRpcLine(line);
    } catch (error) {
      return { id: null, message: makeError(null, asRpcError(error)) };
    }

    const method = msg.method as string;
    const notification = !hasOwn(msg, 'id');
    if (notification) {
      if (method === 'notifications/initialized') {
        // The legacy handshake is complete. Notifications never receive a response.
      } else if (method === 'notifications/cancelled') {
        // Cancellation is accepted; this minimal transport does not abort handlers.
      }
      return undefined;
    }

    const id = msg.id as RpcId;
    try {
      const params = readParams(msg);
      let context: RpcContext;
      if (method === 'initialize') {
        context = makeLegacyInitializeContext(msg);
        negotiatedLegacyContext = context;
      } else if (negotiatedLegacyContext !== undefined) {
        context = negotiatedLegacyContext;
      } else {
        context = validateModernRequest(msg);
      }

      let result: Record<string, unknown>;
      if (method === 'initialize') {
        result = {
          protocolVersion: context.protocolVersion,
          capabilities: opts.capabilities,
          serverInfo,
          ...(opts.instructions === undefined ? {} : { instructions: opts.instructions }),
        };
      } else if (method === 'server/discover') {
        if (!context.modern) {
          throw new RpcError(-32601, 'Method not found');
        }
        result = {
          supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
          capabilities: opts.capabilities,
          ...(opts.instructions === undefined ? {} : { instructions: opts.instructions }),
        };
      } else if (method === 'ping') {
        result = {};
      } else {
        if (!supportsMethod(method, opts.capabilities)) {
          throw new RpcError(-32601, 'Method not found');
        }
        const value = await opts.handle(method, params, context);
        if (!isRecord(value)) {
          throw new RpcError(-32603, 'Internal error');
        }
        result = value;
      }

      return { id, message: makeResult(id, result, context, serverInfo) };
    } catch (error) {
      if (!(error instanceof RpcError)) log('MCP internal error');
      return { id, message: makeError(id, asRpcError(error)) };
    }
  }

  const input = createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });

  for await (const line of input) {
    const pending = await dispatchLine(line);
    if (pending === undefined) continue;

    let encoded: string;
    try {
      encoded = JSON.stringify(pending.message);
    } catch {
      log('MCP internal error');
      encoded = JSON.stringify(makeError(pending.id, new RpcError(-32603, 'Internal error')));
    }

    if (!process.stdout.write(`${encoded}\n`)) {
      await once(process.stdout, 'drain');
    }
  }
}
