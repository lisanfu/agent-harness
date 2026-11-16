/**
 * 注入式随机源 + 状态哈希。M2「确定性重放」的地基现在就打好。
 *
 * 纪律：任何需要随机的地方都必须用这里注入的 rng，禁止直接 Math.random。
 * 理由和 Redux 一样：action + 初始 state 决定一切，才能逐位重放。
 */
import { createHash } from 'node:crypto';

/** mulberry32：32 位种子，快、分布够用、可复现 */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串种子 → 32 位整数（FNV-1a），方便用 "run-42" 这种可读种子 */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 规范化 JSON：键排序，保证 {a,b} 与 {b,a} 哈希一致。
 * 不做这一步，重放比对会因为键序不同而误报分歧。
 */
export function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function hashState(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 16);
}