/** MCP stdio 入口。stdout 只留给协议；启动配置只来自操作者环境，不来自模型工具参数。 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDedicatedOutputRoot } from './mcp/session.ts';
import { runHarnessMcpServer } from './mcp/server.ts';

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

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} 只能是 true / false`);
}

async function main(): Promise<void> {
  const outDir = assertDedicatedOutputRoot(
    process.env.AGENT_HARNESS_MCP_OUT ?? join(ROOT, 'sandbox', 'mcp'),
    ROOT,
  );
  await runHarnessMcpServer({
    outDir,
    maxActiveRuns: envInt('AGENT_HARNESS_MCP_MAX_ACTIVE', 8, 1, 64),
    maxSteps: envInt('AGENT_HARNESS_MCP_MAX_STEPS', 40, 1, 200),
    maxWallMs: envInt('AGENT_HARNESS_MCP_MAX_WALL_MS', 300_000, 1_000, 900_000),
    world: {
      seed: 6,
      ...(process.env.AGENT_HARNESS_MCP_MUTANT ? { mutant: process.env.AGENT_HARNESS_MCP_MUTANT } : {}),
      ...(process.env.AGENT_HARNESS_MCP_SOUND_MUTANT ? { soundMutant: process.env.AGENT_HARNESS_MCP_SOUND_MUTANT } : {}),
      doPredict: envBool('AGENT_HARNESS_MCP_PREDICT', true),
      doGoal: envBool('AGENT_HARNESS_MCP_GOAL', true),
      doEar: envBool('AGENT_HARNESS_MCP_EAR', true),
    },
    provenance: process.env.AGENT_HARNESS_MCP_PROVENANCE === 'fixture' ? 'fixture' : 'real',
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`[mcp] 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
