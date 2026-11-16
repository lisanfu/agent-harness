/**
 * 预测-对照引擎。M4 的核心分工：
 *
 *   模型预测  →  **代码算 diff**  →  模型判断是否意外
 *
 * 为什么中间那步必须是代码：让模型自己判断"我预测对了没"，它会替自己圆场。
 * M1 实测：agent 连续 4 次声称"我脚下有 +"，而客观账本 stoodOnPickup=false；
 * 另一局自报坐标越界 19 次。**自述不可信，必须由代码拿屏幕事实去对。**
 *
 * 为什么对照基准是屏幕而不是 WorldState：见 observe.ts 铁律 1。
 * 拿内部状态对答案，等于让 agent 读心，空间推理错误就永远暴露不出来。
 *
 * 诚实纪律：「无法核对」≠「预测被违反」。
 * 屏幕缺行、预测值不是合法数值、字段不认识 —— 一律记 unverifiable，不记 violated。
 * 把无法核对算成违反，会凭空制造"异常"，污染 M4 的三条独立异常源。
 */
import { observe, type Observation } from './observe.ts';
import { bool, num, pos, same } from './value.ts';
import type { PredictionDiff, PredictionRecord } from '../types.ts';

/** 允许预测的字段。全部是**画面上可见**的量，不含任何内部字段。 */
export const PREDICT_FIELDS = [
  'hpDelta', 'scoreDelta', 'playerAt', 'enemyCount', 'pickupCount', 'alive', 'attackReady',
] as const;

export type PredictField = (typeof PREDICT_FIELDS)[number];

/**
 * 预测字段的接口说明，原样进 system 契约。
 *
 * 界线（和 renderTools 一样）：只说**字段是什么、答案长什么形状**，
 * 绝不说"该去测什么""哪里容易出问题"。
 *
 * 一个刻意的取舍：playerAt 只说明「x 是列、y 是行」这一**答案格式**，
 * **不告诉它原点在左上角、也不告诉它轴的方向**。
 * 为什么：坐标约定属于世界知识，画面本身没印坐标轴，人也要自己数格子。
 * 说了就等于把 M1 §7 那 19 次越界自报的答案喂给它，空间推理能力再也测不出来。
 * 但字段顺序必须说清——[x,y] 还是 [y,x] 是接口歧义，
 * 不说会把"数对了但顺序反了"判成违反，那是凭空制造异常（ACI 那一课）。
 */
export const PREDICT_SPEC = [
  '  - hpDelta: 整数，本帧血量相对上一帧的变化量（掉血为负）',
  '  - scoreDelta: 整数，本帧分数相对上一帧的变化量',
  '  - playerAt: [x, y]，动作后你所在的格子；x 是列、y 是行',
  '  - enemyCount: 整数，动作后画面上活着的敌人个数',
  '  - pickupCount: 整数，动作后画面上未被拾取的物品个数',
  '  - alive: true / false，动作后你是否还活着',
  '  - attackReady: true / false，动作后攻击是否就绪',
  '  可以只写其中一部分字段。例：{"predict":{"hpDelta":0,"playerAt":[3,4]}}',
].join('\n');

// 容错归一化在 value.ts，与目标条件通道共用同一份：模型会写 "3" / [3,4] / "3,4" / {x:3,y:4}，都认。

/** 从「上一帧屏幕 + 本帧屏幕」算出各字段的实际值。算不出给 null。 */
function actuals(prev: Observation, next: Observation): Record<PredictField, unknown> {
  // 网格没解析出来时，坐标/计数一律 null——空数组会被误读成"没有敌人"
  const gridOk = next.size !== null;
  const delta = (a: number | null, b: number | null) => (a !== null && b !== null ? b - a : null);
  return {
    hpDelta: delta(prev.hp, next.hp),
    scoreDelta: delta(prev.score, next.score),
    playerAt: gridOk ? next.player : null,
    enemyCount: gridOk ? next.enemies.length : null,
    pickupCount: gridOk ? next.pickups.length : null,
    alive: next.alive,
    attackReady: next.attackReady,
  };
}

const normalize = (field: PredictField, v: unknown): unknown => {
  switch (field) {
    case 'hpDelta': case 'scoreDelta': case 'enemyCount': case 'pickupCount': return num(v);
    case 'playerAt': return pos(v);
    case 'alive': case 'attackReady': return bool(v);
  }
};

/**
 * 核对一次预测。prevScreen 是动作前的屏幕，nextScreen 是动作后的屏幕。
 * 两者都只经过 observe()，绝不接触内部状态。
 */
export function checkPrediction(
  predicted: Record<string, unknown> | undefined,
  prevScreen: string,
  nextScreen: string,
): PredictionRecord {
  const prev = observe(prevScreen);
  const next = observe(nextScreen);
  const act = actuals(prev, next);
  const pred = predicted ?? {};
  const given = Object.keys(pred).length > 0;
  // 帧号是**画面上印着的**可观测量，不是内部字段。
  // 解析不到就保守当成"没推进"：宁可把它归到偏容易的那一类，也不猜它推进了。
  const advanced = prev.tick !== null && next.tick !== null && next.tick > prev.tick;

  const diffs: PredictionDiff[] = [];
  for (const [field, raw] of Object.entries(pred)) {
    const known = (PREDICT_FIELDS as readonly string[]).includes(field);
    const want = known ? normalize(field as PredictField, raw) : null;
    const actual = known ? act[field as PredictField] : null;
    // 三种情况都算「无法核对」：字段不认识 / 预测值不合法 / 屏幕没给出该量
    const status: PredictionDiff['status'] =
      want === null || actual === null || actual === undefined ? 'unverifiable'
        : same(want, actual) ? 'ok' : 'violated';
    diffs.push({ field, predicted: raw, actual: actual ?? null, status });
  }

  return {
    given,
    advanced,
    predicted: pred,
    diffs,
    violated: diffs.filter((d) => d.status === 'violated').length,
    unverifiable: diffs.filter((d) => d.status === 'unverifiable').length,
  };
}

const STATUS_TEXT = { ok: '相符', violated: '**不符**', unverifiable: '无法核对' } as const;

/**
 * 把代码算出的差异渲染成给模型看的事实文本。
 * 只陈述事实，不下结论、不给策略——「是否意外」的判断权归模型。
 */
export function describeCheck(rec: PredictionRecord): string {
  if (!rec.given) return '预测对照：你这一步没有给 predict，无法核对。';
  const lines = rec.diffs.map((d) => {
    const p = JSON.stringify(d.predicted);
    const a = JSON.stringify(d.actual);
    return `  - ${d.field}：你预测 ${p}，画面实际 ${a} → ${STATUS_TEXT[d.status]}`;
  });
  return [
    `预测对照（由代码核对屏幕得出，不是你的自述）：${rec.violated} 项不符，${rec.unverifiable} 项无法核对。`,
    ...lines,
    '请在下一步的 surprise 字段里判断这些差异是否出乎你的意料，并说明理由。',
  ].join('\n');
}