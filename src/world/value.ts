/**
 * 值的归一化与相等判定。**预测通道与目标条件通道共用这一份。**
 *
 * 为什么必须共用（故障 #1 的教训：同一份契约不许有两条装配路径）：
 * 模型写 `"3"` / `[3,4]` / `"3,4"` / `{x:3,y:4}` 都要认。
 * 如果预测那边认 `{x,y}` 而目标条件那边不认，同一个模型输出会被两条通道判成不同结果——
 * 于是"目标达成了"与"预测相符"互相打架，而错的是 harness 不是 agent。
 *
 * 纪律：纯函数，不读时钟、不用随机、不抛错。归一化不了就给 null，
 * 由调用方决定那是"无法核对"还是别的什么。**绝不猜一个值出来。**
 */

/** 数字：认 number 与"看起来是数字的字符串"。空串、NaN、Infinity 一律 null。 */
export function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** 布尔：认 boolean 与 "true"/"false"（大小写不敏感）。其余 null，绝不把 "yes" 猜成 true。 */
export function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return null;
}

/** 坐标：认 [x,y] / "x,y" / {x,y}。x 是列、y 是行——**字段顺序是接口歧义，必须说清**；轴方向不说（那是世界知识）。 */
export function pos(v: unknown): [number, number] | null {
  if (Array.isArray(v) && v.length === 2) {
    const x = num(v[0]), y = num(v[1]);
    return x !== null && y !== null ? [x, y] : null;
  }
  if (typeof v === 'string') {
    const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(v);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const x = num(o['x']), y = num(o['y']);
    return x !== null && y !== null ? [x, y] : null;
  }
  return null;
}

/** 相等：数组逐位比（坐标），其余严格相等。不做类型 coercion——"3" 与 3 的归一化在 num 里已经做完。 */
export function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return a === b;
}