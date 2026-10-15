/**
 * 难度模型。
 *
 * 十个维度相互正交，前四档照顾 6-10 岁到成年人，最后一档（大师）叠加新机制：
 *   1. 形状      —— 圆形/六边形/三角/星形，换的是空间感而不是尺寸
 *   2. 尺寸      —— 最直观的难度信号
 *   3. 岔路      —— 越大岔路越多、决策点越多，**越大越难**（与 braid 相反）
 *   4. 环路 braid —— 0=全是死胡同（最难）… 1=几乎处处环路（最宽容）
 *   5. 足迹提示   —— 走过的路是否留下痕迹，直接决定「迷路感」
 *   6. 计时       —— 制造压力，低龄段应关闭
 *   星星收集     —— 正向激励，让中等难度不至于只是「变大」
 *
 * ── 以下四项是「尺寸/岔路/环路全部顶到上限」之后唯一还能加难度的方向 ──
 * （尺寸上限 24、岔路上限 1、环路下限 0，挑战档已经全部顶满，
 *   所以再加难度只能靠新机制，不能再靠调参。）
 *
 *   7. 视野 viewRadius —— 只看得见沿走廊 R 格以内，其余涂黑。
 *                        这是最大的难度跃升：全图可见时孩子直接「看着答案走」，
 *                        24×24 再大也只是体力活，不是智力题。
 *   8. 假出口 fakeExits —— 多放几个一模一样的绿门，走到跟前才发现是假的。
 *                        把「看见绿门就冲」变成「得先判断」。
 *   9. 巡逻怪 guards    —— 走廊里有怪来回巡逻，碰到就回起点，逼着看路而不是猛冲。
 *  10. 限时 timeLimitSec —— 超时直接失败（不是只记录用时）。让「走错路」真正变疼。
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
  /**
   * 视野半径，单位是「沿走廊的步数」。
   *
   * null = 全图可见（低龄档的默认行为）。
   * 给了值之后只有距离小球 R 步以内的格子能看见，其余涂黑；
   * 走过的格子会留下变暗的「记忆」，因此 R 越小越依赖记忆。
   *
   * 为什么用「沿走廊的步数」而不是欧氏半径：后者能隔着墙看见隔壁走廊，
   * 在岔路密集的迷宫里等于给了一半答案。BFS 计步则连拐角都看不见。
   */
  viewRadius: number | null;
  /** 假出口数量。真出口之外再放几个长得一模一样的门，走到跟前才发现是假的 */
  fakeExits: number;
  /** 巡逻怪数量。碰到就被送回起点 */
  guards: number;
  /**
   * 限时秒数。null = 不限时（timed 为 true 时只记录用时，不会失败）。
   * 超时会直接进入失败状态，这是让「走错路」真正有代价的那一项。
   */
  timeLimitSec: number | null;
}

/** 迷宫尺寸的硬边界，家长自定义也不超出。 */
export const LIMITS = {
  minCols: 6,
  maxCols: 24,
  minRows: 6,
  maxRows: 24,
  minStars: 0,
  maxStars: 8,
  /** 视野半径下限 2：再小连脚下都转不开身，不是难度是折磨 */
  minViewRadius: 2,
  maxViewRadius: 12,
  maxFakeExits: 4,
  maxGuards: 4,
  minTimeLimitSec: 60,
  maxTimeLimitSec: 1200,
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
    viewRadius: null,
    fakeExits: 0,
    guards: 0,
    timeLimitSec: null,
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
    viewRadius: null,
    fakeExits: 0,
    guards: 0,
    timeLimitSec: null,
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
    viewRadius: null,
    fakeExits: 0,
    guards: 0,
    timeLimitSec: null,
  },
  {
    id: 'hard',
    // 这一档按「成年人难度」配置，不再迁就儿童：
    // 尺寸顶到网格上限、岔路拉满、环路清零（每个死胡同都是真惩罚）、
    // 没有脚印也没有提示箭头。目标是「一眼看上去就不像能一次走通」。
    name: '挑战',
    ageHint: '成人难度：星形大迷宫，岔路最密、死路最多，没有脚印和提示箭头，且限时',
    shape: 'star',
    cols: 24,
    rows: 24,
    branchiness: 1,
    braid: 0,
    footprint: 'none',
    footprintFadeSec: 0,
    timed: true,
    stars: 5,
    hintDelayMs: null,
    viewRadius: null,
    fakeExits: 0,
    guards: 0,
    // 限时是「压力」，不是「刁难」：24×24 星形迷宫沿正路走完约需 2 分钟，
    // 加上走错与折返，5 分钟对成年人是明显但不残酷的门槛。
    timeLimitSec: 300,
  },
  {
    id: 'master',
    // 参数已经全部顶格，这一档只能靠「新机制」加难度，四件一起上：
    // 视野迷雾（只见身边几格）、假出口、巡逻怪、限时。
    // 保留 5 分钟以上的限时——迷雾下找路本身就慢，压得太紧会从「难」变成「不可能」。
    name: '大师',
    ageHint: '大师难度：只看得见身边几格，绿门有真有假，还有巡逻怪，而且限时',
    shape: 'star',
    cols: 24,
    rows: 24,
    branchiness: 1,
    braid: 0,
    footprint: 'none',
    footprintFadeSec: 0,
    timed: true,
    stars: 5,
    hintDelayMs: null,
    // 4 步：一次能看清自己所在的路口和每个方向的近处岔路，
    // 但看不到「这条路通向哪」——全局结构必须靠自己走出来。
    viewRadius: 4,
    fakeExits: 2,
    guards: 2,
    timeLimitSec: 480,
  },
] as const;

export function presetById(id: string): Difficulty {
  return PRESETS.find((p) => p.id === id) ?? (PRESETS[0] as Difficulty);
}

/**
 * 把家长指定的形状叠加到任意难度上。
 *
 * 形状是与难度档位**正交**的维度：家长在「难度设置」里选了形状之后，
 * 换到哪个档位都该保持这个形状（档位自带的形状只是默认值）。
 * shape 为 null 表示「跟随档位」，此时原样返回，不改对象引用。
 */
export function withShape(diff: Difficulty, shape: ShapeId | null): Difficulty {
  if (shape === null || shape === diff.shape) return diff;
  return { ...diff, shape };
}

/**
 * 把家长指定的星星数量叠加到任意难度上。
 *
 * 星星数与形状一样是跨难度的：它只决定「奖励放几个」，
 * 不参与迷宫结构，因此家长调一次就该对每一档都生效。
 * stars 为 null 表示「跟随档位」（入门/简单没有星星，中等 3 颗，挑战 5 颗）。
 */
export function withStars(diff: Difficulty, stars: number | null): Difficulty {
  if (stars === null || stars === diff.stars) return diff;
  return { ...diff, stars };
}

/**
 * 把 localStorage 里的星星覆盖值收敛到合法范围。
 *
 * 非法值（缺字段、被人手改成字符串、超出上限）一律返回 null 而不是 0：
 * null 是「跟随档位」，0 是家长明确要的「不要星星」，两者不能混。
 */
export function normalizeStarsOverride(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return clampInt(value, LIMITS.minStars, LIMITS.maxStars);
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
    // 只按「滑块的上限」收敛，不再按格子面积二次打折。
    // 旧实现会把它压到 floor(cols*rows/12)：家长在小迷宫上把星星拉到 8 颗，
    // 开局却只有 3 颗 —— 正是「设置后没生效」的来源之一。
    // 真正的容量约束在 placeCollectibles：必经之路放不下、死路也不够多时自然少放。
    stars,
    hintDelayMs: input.hintDelayMs === undefined ? base.hintDelayMs : input.hintDelayMs,
    // 视野与限时是「null 有意义」的两项，必须把「没设置」与「明确关闭」分开：
    // undefined → 沿用默认档位（旧存档就是这样），null → 明确关闭，数字 → 夹紧后使用。
    viewRadius: clampNullableInt(
      input.viewRadius,
      base.viewRadius,
      LIMITS.minViewRadius,
      LIMITS.maxViewRadius,
    ),
    timeLimitSec: clampNullableInt(
      input.timeLimitSec,
      base.timeLimitSec,
      LIMITS.minTimeLimitSec,
      LIMITS.maxTimeLimitSec,
    ),
    fakeExits: clampInt(input.fakeExits ?? base.fakeExits, 0, LIMITS.maxFakeExits),
    guards: clampInt(input.guards ?? base.guards, 0, LIMITS.maxGuards),
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

/**
 * 夹紧「可以为 null」的整数配置（视野半径、限时时长）。
 *
 * 三态必须分清，混掉任何一个都会让家长看到「改了没生效」：
 *   undefined → 沿用 default（旧存档缺字段时走这里）
 *   null      → 明确关闭（全图可见 / 不限时）
 *   数字      → 夹紧到 [min,max]
 */
function clampNullableInt(
  value: number | null | undefined,
  fallback: number | null,
  min: number,
  max: number,
): number | null {
  if (value === undefined) return fallback;
  if (value === null) return null;
  return clampInt(value, min, max);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** 形状是否合法。用于把 localStorage 里的脏数据挡在生成器之外。 */
function isShapeId(value: unknown): value is ShapeId {
  return typeof value === 'string' && value in SHAPE_LABELS;
}
