/**
 * 难度模型。
 *
 * 六个维度相互正交，覆盖 6-10 岁的完整跨度：
 *   1. 形状      —— 圆形/六边形/三角/星形，换的是空间感而不是尺寸
 *   2. 尺寸      —— 最直观的难度信号
 *   3. 岔路      —— 越大岔路越多、决策点越多，**越大越难**（与 braid 相反）
 *   4. 环路 braid —— 0=全是死胡同（最难）… 1=几乎处处环路（最宽容）
 *   5. 足迹提示   —— 走过的路是否留下痕迹，直接决定「迷路感」
 *   6. 计时       —— 制造压力，低龄段应关闭
 *   星星收集     —— 正向激励，让中等难度不至于只是「变大」
 */

import { SHAPE_LABELS, type ShapeId } from './shape';

export type FootprintMode = 'always' | 'fade' | 'none';

export interface Difficulty {
  id: string;
  name: string;
  /** 给家长看的一句话说明 */
  ageHint: string;
  /** 迷宫形状 */
  shape: ShapeId;
  cols: number;
  rows: number;
  /**
   * 岔路密度 0..1。
   * 注意：**值越大迷宫越难**（岔路与死路都变多、决策点变多），
   * 方向与 braid 相反。这是最容易写反的一对参数，两边都写了死注释。
   */
  branchiness: number;
  /** 0..1，越大越简单（死胡同越少） */
  braid: number;
  footprint: FootprintMode;
  /** 足迹淡出所需的秒数，仅 footprint==='fade' 时有意义 */
  footprintFadeSec: number;
  timed: boolean;
  /** 每关的星星数量 */
  stars: number;
  /** 多久没进展后显示指向出口的箭头；null 表示从不提示 */
  hintDelayMs: number | null;
}

/** 迷宫尺寸的硬边界，家长自定义也不超出。 */
export const LIMITS = {
  minCols: 6,
  maxCols: 24,
  minRows: 6,
  maxRows: 24,
  minStars: 0,
  maxStars: 8,
} as const;

export const PRESETS: readonly Difficulty[] = [
  {
    id: 'starter',
    name: '入门',
    ageHint: '5-6 岁：小圆迷宫、脚印全留、不计时，迷路也不会受挫',
    shape: 'circle',
    cols: 7,
    rows: 7,
    // 入门档也加了岔路（原来几乎没有），但 braid 仍高，走错绕得回来
    branchiness: 0.25,
    braid: 0.55,
    footprint: 'always',
    footprintFadeSec: 0,
    timed: false,
    stars: 0,
    hintDelayMs: 10_000,
  },
  {
    id: 'easy',
    name: '简单',
    ageHint: '6-7 岁：六边形迷宫，稍大一点，脚印仍全显',
    shape: 'hexagon',
    cols: 10,
    rows: 10,
    branchiness: 0.45,
    braid: 0.45,
    footprint: 'always',
    footprintFadeSec: 0,
    timed: false,
    stars: 0,
    hintDelayMs: 15_000,
  },
  {
    id: 'medium',
    name: '中等',
    ageHint: '8-9 岁：三角形迷宫，岔路明显变多，脚印会淡出并计时',
    shape: 'triangle',
    cols: 14,
    rows: 14,
    branchiness: 0.65,
    braid: 0.3,
    footprint: 'fade',
    footprintFadeSec: 6,
    timed: true,
    stars: 3,
    hintDelayMs: 25_000,
  },
  {
    id: 'hard',
    name: '挑战',
    ageHint: '9-10 岁：星形迷宫，岔路最密、无脚印，靠记忆和规划',
    shape: 'star',
    cols: 18,
    rows: 18,
    branchiness: 0.85,
    braid: 0.15,
    footprint: 'none',
    footprintFadeSec: 0,
    timed: true,
    stars: 5,
    hintDelayMs: null,
  },
] as const;

export function presetById(id: string): Difficulty {
  return PRESETS.find((p) => p.id === id) ?? (PRESETS[0] as Difficulty);
}

/** 家长自定义配置的存储键。 */
const CUSTOM_KEY = 'maze.custom.v1';

export function clampCustom(input: Partial<Difficulty>): Difficulty {
  const base = presetById('medium');
  const cols = clampInt(input.cols ?? base.cols, LIMITS.minCols, LIMITS.maxCols);
  const rows = clampInt(input.rows ?? base.rows, LIMITS.minRows, LIMITS.maxRows);
  const stars = clampInt(input.stars ?? base.stars, LIMITS.minStars, LIMITS.maxStars);
  return {
    id: 'custom',
    name: '自定义',
    ageHint: '家长自定规则',
    // 形状来自 localStorage，可能是任意字符串（旧版本没有这个字段，或被人手改过）：
    // 非法值一律落回方形，绝不把坏数据传进生成器
    shape: isShapeId(input.shape) ? input.shape : 'square',
    cols,
    rows,
    branchiness: clamp01(input.branchiness ?? base.branchiness),
    braid: clamp01(input.braid ?? base.braid),
    footprint: input.footprint ?? base.footprint,
    footprintFadeSec: clampInt(input.footprintFadeSec ?? base.footprintFadeSec, 1, 20),
    timed: input.timed ?? base.timed,
    stars: Math.min(stars, Math.max(0, Math.floor((cols * rows) / 12))),
    hintDelayMs: input.hintDelayMs === undefined ? base.hintDelayMs : input.hintDelayMs,
  };
}

export function loadCustom(): Difficulty {
  try {
    const raw = globalThis.localStorage?.getItem(CUSTOM_KEY);
    if (!raw) return clampCustom({});
    return clampCustom(JSON.parse(raw) as Partial<Difficulty>);
  } catch {
    return clampCustom({});
  }
}

export function saveCustom(diff: Difficulty): void {
  try {
    globalThis.localStorage?.setItem(CUSTOM_KEY, JSON.stringify(diff));
  } catch {
    // 隐私模式下 localStorage 可能抛异常；存不了就用默认值，不影响游玩
  }
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 形状是否合法。用于把 localStorage 里的脏数据挡在生成器之外。 */
function isShapeId(value: unknown): value is ShapeId {
  return typeof value === 'string' && value in SHAPE_LABELS;
}
