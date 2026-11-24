#!/usr/bin/env node
/** Skill fixture 冒烟：走真实 MCP stdio；只验接线，不是模型能力证据。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.AGENT_HARNESS_ROOT ?? join(here, '../../..'));
const entry = join(root, 'src/mcp.ts');
const out = mkdtempSync(join(tmpdir(), 'agent-harness-skill-'));
const child = spawn(process.execPath, [entry], {
  cwd: root,
  env: {
    ...process.env,
    AGENT_HARNESS_MCP_OUT: out,
    AGENT_HARNESS_MCP_PROVENANCE: 'fixture',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
const waiting = new Map();
let nextId = 1;
createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
  const response = JSON.parse(line);
  const pending = waiting.get(response.id);
  if (pending) {
    waiting.delete(response.id);
    pending(response);
  }
});

function request(method, params = {}) {
  const id = nextId++;
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`${method} 超时；stderr=${stderr.trim()}`));
    }, 10_000);
    waiting.set(id, (response) => {
      clearTimeout(timer);
      if (response.error) reject(new Error(`${method}: ${JSON.stringify(response.error)}`));
      else resolvePromise(response.result);
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id, method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': { tools: {}, resources: {}, prompts: {} },
          'io.modelcontextprotocol/clientInfo': { name: 'agent-harness-skill-smoke', version: '1' },
        },
      },
    })}\n`);
  });
}

async function call(name, args = {}) {
  const result = await request('tools/call', { name, arguments: args });
  assert.equal(result.isError, false, `${name} 返回工具错误`);
  return result.structuredContent;
}

async function main() {
  assert.ok(existsSync(entry), `找不到 server 入口；请设置 AGENT_HARNESS_ROOT：${root}`);
  const discovered = await request('server/discover');
  assert.equal(discovered.resultType, 'complete');
  assert.equal(discovered.capabilities.sampling, undefined);

  const started = await call('harness_start', { seed: 6, max_steps: 3 });
  assert.equal(started.kind, 'started');
  assert.equal(started.request.step, 1);
  assert.doesNotMatch(JSON.stringify(started), /mutant|internalState|coverage|detection/i);

  const looked = await call('harness_step', {
    run_id: started.run_id,
    expected_step: 1,
    decision: {
      thought: 'fixture：只观察首屏，不声称模型能力',
      call: { name: 'look', args: {} },
      predict: { hpDelta: 0 },
    },
  });
  assert.equal(looked.kind, 'stepped');
  assert.equal(looked.observation.ok, true);
  assert.equal(looked.request.step, 2);

  const finished = await call('harness_step', {
    run_id: started.run_id,
    expected_step: 2,
    decision: {
      thought: 'fixture：接线完成后收手',
      call: { name: 'finish', args: { summary: 'Skill fixture 冒烟收手' } },
    },
  });
  assert.equal(finished.kind, 'finished');
  assert.equal(finished.evidence_consistent, true);
  for (const file of Object.values(finished.files)) assert.ok(existsSync(file), `缺证据：${file}`);
  const header = JSON.parse(readFileSync(join(finished.run_dir, 'header.json'), 'utf8'));
  assert.equal(header.brainId, 'mcp-host');
  assert.equal(header.config.provenance, 'fixture');
  process.stdout.write(`MCP Skill fixture 冒烟通过：${finished.step_count} 步，证据目录 ${finished.run_dir}\n`);
}

main().catch((error) => {
  process.stderr.write(`MCP Skill fixture 冒烟失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}).finally(async () => {
  child.stdin.end();
  const exited = once(child, 'exit');
  const killer = setTimeout(() => child.kill(), 3_000);
  const [code] = await exited;
  clearTimeout(killer);
  if (code !== 0 && process.exitCode !== 1) {
    process.stderr.write(`MCP server 异常退出：${code}; stderr=${stderr.trim()}\n`);
    process.exitCode = 1;
  }
  rmSync(out, { recursive: true, force: true });
});
