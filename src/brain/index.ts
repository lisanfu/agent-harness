/**
 * 大脑工厂 + 零依赖 .env 读取。
 * 三种模式：openai（远端）/ stdio（宿主）/ mock（仅测试）。不使用任何本地模型。
 */
import { existsSync, readFileSync } from 'node:fs';
import { ErrCode, HarnessError } from '../errors.ts';
import type { Brain } from '../types.ts';
import { MockBrain } from './mock.ts';
import { OpenAIBrain } from './openai.ts';
import { StdioBrain } from './stdio.ts';

export type BrainKind = 'openai' | 'stdio' | 'mock';

/** 极简 .env 解析：支持引号、行内注释、等号两侧空格。不覆盖已存在的环境变量。 */
export function loadEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.startsWith('"') || val.startsWith("'")) {
      const q = val[0]!;
      const end = val.indexOf(q, 1);
      val = end > 0 ? val.slice(1, end) : val.slice(1);
    } else {
      const hash = val.indexOf(' #');
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}

export function createBrain(kind: BrainKind, mockScript?: ConstructorParameters<typeof MockBrain>[0]): Brain {
  if (kind === 'stdio') {
    return new StdioBrain(Number(process.env['BRAIN_TIMEOUT_MS'] ?? 600_000));
  }
  if (kind === 'mock') {
    return new MockBrain(mockScript ?? []);
  }
  if (kind === 'openai') {
    return new OpenAIBrain({
      baseUrl: process.env['BRAIN_BASE_URL'] ?? '',
      apiKey: process.env['BRAIN_API_KEY'] ?? '',
      model: process.env['BRAIN_MODEL'] ?? '',
      timeoutMs: Number(process.env['BRAIN_TIMEOUT_MS'] ?? 60_000),
      temperature: process.env['BRAIN_TEMPERATURE'] ? Number(process.env['BRAIN_TEMPERATURE']) : undefined,
      // 重试旋钮全部可配，且都有默认值：免费额度撞 429 是常态，
      // 但"重试几次、等多久"必须能按账号额度调，不能写死在代码里。
      maxRetries: process.env['BRAIN_MAX_RETRIES'] ? Number(process.env['BRAIN_MAX_RETRIES']) : undefined,
      backoffMs: process.env['BRAIN_BACKOFF_MS'] ? Number(process.env['BRAIN_BACKOFF_MS']) : undefined,
      maxBackoffMs: process.env['BRAIN_MAX_BACKOFF_MS'] ? Number(process.env['BRAIN_MAX_BACKOFF_MS']) : undefined,
    });
  }
  throw new HarnessError(ErrCode.CONFIG, `未知大脑类型：${String(kind)}（可选 openai / stdio / mock）`);
}