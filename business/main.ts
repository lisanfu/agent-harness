/** 业务 Agent MCP 入口。stdout 只走 MCP JSON-RPC，启动日志只走 stderr。 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDedicatedOutputRoot } from '../src/mcp/session.ts';
import { JsonlRunJournal } from './audit.ts';
import { BusinessRuntime } from './runtime.ts';
import { runBusinessMcpServer } from './server.ts';
import { createDemoStores } from './store.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} 必须是整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须在 ${min}..${max}`);
  }
  return value;
}

async function main(): Promise<void> {
  const outDir = assertDedicatedOutputRoot(
    process.env['BUSINESS_AGENT_OUT'] ?? join(ROOT, 'sandbox', 'business'),
    ROOT,
  );
  const stores = createDemoStores();
  const options = {
    ...stores,
    journalFactory: (runId: string) => new JsonlRunJournal(outDir, runId),
    maxActiveRuns: envInt('BUSINESS_AGENT_MAX_ACTIVE', 8, 1, 64),
    defaultMaxSteps: envInt('BUSINESS_AGENT_MAX_STEPS', 12, 1, 50),
    defaultMaxWallMs: envInt('BUSINESS_AGENT_MAX_WALL_MS', 300_000, 1000, 900_000),
    toolTimeoutMs: envInt('BUSINESS_AGENT_TOOL_TIMEOUT_MS', 10_000, 50, 120_000),
  };
  await runBusinessMcpServer({ ...options, runtime: new BusinessRuntime(options) });
}

main().catch((error: unknown) => {
  process.stderr.write(`[business-agent] 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
