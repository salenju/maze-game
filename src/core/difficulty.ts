/**
 * 难度模型。
 *
 * 五个维度相互正交，覆盖 6-10 岁的完整跨度：
 *   1. 尺寸      —— 最直观的难度信号
 *   2. 环路 braid —— 0=全是死胡同（最难）… 1=几乎处处环路（最宽容）
 *   3. 足迹提示   —— 走过的路是否留下痕迹，直接决定「迷路感」
 *   4. 计时       —— 制造压力，低龄段应关闭
 *   5. 星星收集   —— 正向激励，让中等难度不至于只是「变大」
 */

export type FootprintMode = 'always' | 'fade' | 'none';

export interface Difficulty {
  id: string;
  name: string;
  /** 给家长看的一句话说明 */
  ageHint: string;
  cols: number;
  rows: number;
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
    ageHint: '5-6 岁：小迷宫、脚印全留、不计时，迷路也不会受挫',
    cols: 7,
    rows: 7,
    braid: 0.6,
    footprint: 'always',
    footprintFadeSec: 0,
    timed: false,
    stars: 0,
    hintDelayMs: 10_000,
  },
  {
    id: 'easy',
    name: '简单',
    ageHint: '6-7 岁：稍大一点，脚印仍全显，自己决定要不要计时',
    cols: 10,
    rows: 10,
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
    ageHint: '8-9 岁：脚印会慢慢淡出，加入计时和 3 颗星星',
    cols: 14,
    rows: 14,
    braid: 0.25,
    footprint: 'fade',
    footprintFadeSec: 6,
    timed: true,
    stars: 3,
    hintDelayMs: 25_000,
  },
  {
    id: 'hard',
    name: '挑战',
    ageHint: '9-10 岁：大迷宫、无脚印、死路多，靠记忆和规划',
    cols: 18,
    rows: 18,
    braid: 0.08,
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
    cols,
    rows,
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
