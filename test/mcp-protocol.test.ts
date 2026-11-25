import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import {
  LEGACY_PROTOCOL_VERSIONS,
  MCP_PROTOCOL_VERSION,
  RpcError,
  makeError,
  makeResult,
  parseRpcLine,
  validateModernRequest,
  type RpcContext,
} from '../src/mcp/protocol.ts';

const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
const SUBSCRIPTION_ID_META_KEY = 'io.modelcontextprotocol/subscriptionId';
const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const MODERN_META = {
  [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
  [CLIENT_CAPABILITIES_META_KEY]: { tools: {} },
  'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
};

type RpcResponse = {
  jsonrpc: string;
  id: string | number | null;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: any };
};

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function startMcpServer(t: TestContext): {
  child: ChildProcessWithoutNullStreams;
  send(value: unknown): void;
  sendRaw(line: string): void;
  nextResponse(): Promise<RpcResponse>;
  stdout(): string;
  stderr(): string;
  close(): Promise<void>;
} {
  const protocolUrl = new URL('../src/mcp/protocol.ts', import.meta.url).href;
  const script = `
    const { runMcpStdio, RpcError } = await import(${JSON.stringify(protocolUrl)});
    await runMcpStdio({
      serverInfo: { name: 'test-server', version: '2.3.4' },
      capabilities: { tools: { listChanged: false } },
      instructions: 'Test instructions',
      log(line) { console.error('stderr-log:' + line); },
      async handle(method, params, ctx) {
        if (method === 'tools/list') {
          return {
            tools: [{ name: 'echo', inputSchema: { type: 'object' } }],
            modern: ctx.modern,
            protocolVersion: ctx.protocolVersion,
            clientInfo: ctx.clientInfo ?? null,
            clientCapabilities: ctx.clientCapabilities,
          };
        }
        if (method === 'tools/call' && params.name === 'boom') {
          throw new RpcError(-32001, 'Expected failure', { reason: 'test' });
        }
        if (method === 'tools/call' && params.name === 'crash') {
          throw new Error('secret stack');
        }
        return { method, params };
      },
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });

  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let terminalError: Error | undefined;
  const signal = (): void => {
    const resume = wake;
    wake = undefined;
    resume?.();
  };
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    lines.push(line);
    signal();
  });
  child.on('error', (error) => {
    terminalError = error;
    signal();
  });
  child.on('exit', (code, exitSignal) => {
    if (code !== 0) terminalError = new Error(`MCP child exited with ${code ?? exitSignal}`);
    signal();
  });

  function send(value: unknown): void {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  async function nextResponse(): Promise<RpcResponse> {
    while (lines.length === 0) {
      if (terminalError !== undefined) throw terminalError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error('MCP child exited before sending a response');
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          wake = undefined;
          reject(new Error('Timed out waiting for MCP stdout'));
        }, 3000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    const line = lines.shift();
    assert.ok(line !== undefined);
    return JSON.parse(line) as RpcResponse;
  }

  async function close(): Promise<void> {
    child.stdin.end();
    const [code, signal] = await withTimeout(once(child, 'exit'), 3000, 'MCP EOF');
    assert.equal(code, 0);
    assert.equal(signal, null);
  }

  return {
    child,
    send,
    sendRaw: (line: string) => { child.stdin.write(`${line}\n`); },
    nextResponse,
    stdout: () => stdout,
    stderr: () => stderr,
    close,
  };
}

function modernRequest(
  id: string | number,
  method: string,
  params: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params: { ...params, _meta: MODERN_META },
  };
}

function assertRpcError(response: RpcResponse, id: string | number | null, code: number): void {
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, id);
  assert.equal(response.result, undefined);
  assert.equal(response.error?.code, code);
}

test('parseRpcLine strictly accepts requests and notifications', () => {
  assert.deepEqual(parseRpcLine('{"jsonrpc":"2.0","method":"ping"}'), {
    jsonrpc: '2.0',
    method: 'ping',
  });
  assert.equal(parseRpcLine('{"jsonrpc":"2.0","id":7,"method":"ping"}').id, 7);
  assert.equal(parseRpcLine('{"jsonrpc":"2.0","id":"x","method":"ping"}').id, 'x');

  for (const line of [
    '[]',
    '{"jsonrpc":"1.0","method":"ping"}',
    '{"jsonrpc":"2.0","id":null,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1.5,"method":"ping"}',
    '{"jsonrpc":"2.0","id":true,"method":"ping"}',
    '{"jsonrpc":"2.0","id":1,"result":{}}',
    '{"jsonrpc":"2.0","id":1,"method":"ping","error":{}}',
  ]) {
    assert.throws(
      () => parseRpcLine(line),
      (error: unknown) => error instanceof RpcError && error.code === -32600,
    );
  }
  assert.throws(
    () => parseRpcLine('{bad json'),
    (error: unknown) => error instanceof RpcError && error.code === -32700,
  );
});

test('modern metadata validation and result/error envelopes follow the protocol', () => {
  const context = validateModernRequest(modernRequest(1, 'server/discover'));
  assert.deepEqual(context, {
    modern: true,
    protocolVersion: MCP_PROTOCOL_VERSION,
    clientInfo: { name: 'test-client', version: '1.0.0' },
    clientCapabilities: { tools: {} },
  });

  assert.throws(
    () => validateModernRequest({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    (error: unknown) => error instanceof RpcError && error.code === -32602,
  );
  assert.throws(
    () => validateModernRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { _meta: { ...MODERN_META, [PROTOCOL_VERSION_META_KEY]: '2099-01-01' } },
    }),
    (error: unknown) => {
      assert.ok(error instanceof RpcError);
      assert.equal(error.code, -32022);
      assert.deepEqual(error.data, {
        supported: [MCP_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS],
      });
      return true;
    },
  );

  const serverInfo = { name: 'unit', version: '1' };
  const modern = makeResult(1, { value: 3, _meta: { keep: true } }, context, serverInfo);
  assert.deepEqual(modern, {
    jsonrpc: '2.0',
    id: 1,
    result: {
      value: 3,
      resultType: 'complete',
      _meta: { keep: true, [SERVER_INFO_META_KEY]: serverInfo },
    },
  });
  const legacyContext: RpcContext = {
    modern: false,
    protocolVersion: LEGACY_PROTOCOL_VERSIONS[0],
    clientCapabilities: {},
  };
  const legacyResult = { value: 3 };
  assert.equal(makeResult(1, legacyResult, legacyContext, serverInfo).result, legacyResult);
  assert.deepEqual(makeError(null, new RpcError(-32600, 'bad', { field: 'id' })), {
    jsonrpc: '2.0',
    id: null,
    error: { code: -32600, message: 'bad', data: { field: 'id' } },
  });
});

test('modern server/discover returns completion metadata over real stdio', async (t) => {
  const server = startMcpServer(t);
  server.send(modernRequest(1, 'server/discover'));
  const response = await server.nextResponse();
  assert.equal(response.id, 1);
  assert.equal(response.error, undefined);
  assert.equal(response.result?.resultType, 'complete');
  assert.deepEqual(response.result?.supportedVersions, [
    MCP_PROTOCOL_VERSION,
    ...LEGACY_PROTOCOL_VERSIONS,
  ]);
  assert.deepEqual(response.result?.capabilities, { tools: { listChanged: false } });
  assert.equal(response.result?.instructions, 'Test instructions');
  assert.deepEqual(response.result?._meta, {
    [SERVER_INFO_META_KEY]: { name: 'test-server', version: '2.3.4' },
  });
  assert.equal(server.stdout().includes('stderr-log:'), false);
  for (const line of server.stdout().trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  await server.close();
});

test('modern subscriptions/listen acknowledges before gracefully closing a static catalog', async (t) => {
  const server = startMcpServer(t);
  server.send(modernRequest('listen:0', 'subscriptions/listen', {
    notifications: { toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true },
  }));
  const acknowledged = await server.nextResponse();
  assert.equal(acknowledged.id, undefined);
  assert.equal(acknowledged.error, undefined);
  assert.deepEqual(acknowledged.result, undefined);
  assert.deepEqual(acknowledged, {
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: {
      _meta: { [SUBSCRIPTION_ID_META_KEY]: 'listen:0' },
      notifications: {},
    },
  });
  // 订阅流保持打开时，普通目录请求必须仍能继续。
  server.send(modernRequest(2, 'tools/list'));
  const listed = await server.nextResponse();
  assert.equal(listed.id, 2);
  assert.equal(listed.result?.tools[0].name, 'echo');

  server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'listen:0' } });
  const closed = await server.nextResponse();
  assert.equal(closed.id, 'listen:0');
  assert.equal(closed.error, undefined);
  assert.equal(closed.result?.resultType, 'complete');
  assert.deepEqual(closed.result?._meta, {
    [SUBSCRIPTION_ID_META_KEY]: 'listen:0',
    [SERVER_INFO_META_KEY]: { name: 'test-server', version: '2.3.4' },
  });
  await server.close();
});

test('modern requests require _meta and unknown methods return -32601', async (t) => {
  const server = startMcpServer(t);
  server.send({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
  assertRpcError(await server.nextResponse(), 1, -32602);

  server.send(modernRequest(2, 'not/a/method'));
  assertRpcError(await server.nextResponse(), 2, -32601);

  server.send(modernRequest(3, 'ping'));
  const ping = await server.nextResponse();
  assert.equal(ping.id, 3);
  assert.deepEqual(ping.result, { resultType: 'complete', _meta: {
    [SERVER_INFO_META_KEY]: { name: 'test-server', version: '2.3.4' },
  } });
  await server.close();
});

test('RPC errors stay structured, internal errors hide stacks, and logs use stderr', async (t) => {
  const server = startMcpServer(t);
  server.send(modernRequest(1, 'tools/call', { name: 'boom' }));
  const expected = await server.nextResponse();
  assertRpcError(expected, 1, -32001);
  assert.deepEqual(expected.error?.data, { reason: 'test' });

  server.send(modernRequest(2, 'tools/call', { name: 'crash' }));
  const internal = await server.nextResponse();
  assertRpcError(internal, 2, -32603);
  assert.equal(internal.error?.message, 'Internal error');
  assert.equal(JSON.stringify(internal).includes('secret stack'), false);

  server.sendRaw('{bad json');
  assertRpcError(await server.nextResponse(), null, -32700);
  assert.match(server.stderr(), /stderr-log:MCP internal error/);
  assert.equal(server.stdout().includes('stderr-log:'), false);
  assert.equal(server.stdout().includes('secret stack'), false);
  await server.close();
});

test('legacy initialize negotiates, notifications stay silent, and tools/list reaches handle', async (t) => {
  const server = startMcpServer(t);
  server.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      clientInfo: { name: 'legacy-client', version: '1' },
    },
  });
  const initialized = await server.nextResponse();
  assert.equal(initialized.error, undefined);
  assert.equal(initialized.result?.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.result?.capabilities, { tools: { listChanged: false } });
  assert.deepEqual(initialized.result?.serverInfo, { name: 'test-server', version: '2.3.4' });
  assert.equal(initialized.result?.instructions, 'Test instructions');
  assert.equal(initialized.result?.resultType, undefined);

  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
  server.send({ jsonrpc: '2.0', method: 'notifications/unknown', params: {} });
  server.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: { cursor: 'next', _meta: { progressToken: 'progress-1' } },
  });
  const listed = await server.nextResponse();
  assert.equal(listed.id, 2);
  assert.equal(listed.result?.resultType, undefined);
  assert.equal(listed.result?.modern, false);
  assert.equal(listed.result?.protocolVersion, '2025-06-18');
  assert.deepEqual(listed.result?.clientInfo, { name: 'legacy-client', version: '1' });
  assert.deepEqual(listed.result?.clientCapabilities, { tools: {} });
  assert.deepEqual(listed.result?.tools, [{ name: 'echo', inputSchema: { type: 'object' } }]);

  server.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'initialize',
    params: { protocolVersion: '2099-01-01', capabilities: {} },
  });
  const fallback = await server.nextResponse();
  assert.equal(fallback.result?.protocolVersion, '2025-11-25');
  assert.equal(fallback.result?.resultType, undefined);
  await server.close();
});

test('stdin EOF resolves and exits the child with code zero', async (t) => {
  const server = startMcpServer(t);
  assert.equal(server.stdout(), '');
  await server.close();
});
