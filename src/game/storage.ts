/**
 * 本地进度与偏好存储。
 *
 * 全部放在 localStorage，不做账号、不上传任何数据。
 * 对儿童应用这是有意的选择：无网络请求就无隐私面，家长也无需担心。
 * 隐私模式 / 存储被禁用时所有函数静默降级，游戏照常可玩。
 */

import { normalizeStarsOverride } from '../core/difficulty';
import { isShapeId, type ShapeId } from '../core/shape';

export interface Progress {
  /** 各难度已通关次数 */
  cleared: Record<string, number>;
  /** 各难度的最佳成绩 */
  best: Record<string, { seconds: number; stars: number }>;
  /** 累计收集星星 */
  totalStars: number;
  /** 是否已完成「添加到主屏幕」引导 */
  installHintSeen: boolean;
}

export interface Prefs {
  sound: boolean;
  /** 辅助模式：高亮走廊 */
  highlightCorridors: boolean;
  /** 是否已看过操作引导 */
  tutorialSeen: boolean;
  /**
   * 家长在「难度设置」里选的迷宫形状，对所有难度档位生效。
   * null = 跟随档位自带的默认形状（入门圆形、中等三角形…）。
   */
  shapeOverride: ShapeId | null;
  /**
   * 家长在「难度设置」里选的星星数量，同样对所有难度档位生效。
   * null = 跟随档位自带的数量（入门/简单 0 颗、中等 3 颗、挑战 5 颗）。
   * 0 是有效值（明确不要星星），不能与 null 混为一谈。
   */
  starsOverride: number | null;
}

const PROGRESS_KEY = 'maze.progress.v1';
const PREFS_KEY = 'maze.prefs.v1';

const DEFAULT_PROGRESS: Progress = {
  cleared: {},
  best: {},
  totalStars: 0,
  installHintSeen: false,
};

const DEFAULT_PREFS: Prefs = {
  sound: true,
  highlightCorridors: false,
  tutorialSeen: false,
  shapeOverride: null,
  starsOverride: null,
};

export function loadProgress(): Progress {
  return { ...DEFAULT_PROGRESS, ...readJson<Partial<Progress>>(PROGRESS_KEY, {}) };
}

export function saveProgress(p: Progress): void {
  writeJson(PROGRESS_KEY, p);
}

export function loadPrefs(): Prefs {
  const raw = readJson<Partial<Prefs>>(PREFS_KEY, {});
  return {
    ...DEFAULT_PREFS,
    ...raw,
    // 老存档没有这个字段，或被手改成非法值：一律落回「跟随档位」
    shapeOverride: isShapeId(raw.shapeOverride) ? raw.shapeOverride : null,
    starsOverride: normalizeStarsOverride(raw.starsOverride),
  };
}

export function savePrefs(p: Prefs): void {
  writeJson(PREFS_KEY, p);
}

/**
 * 记录一次通关。
 * 只在成绩更好时更新最佳记录，这样孩子偶尔失误不会「弄丢」自己的好成绩。
 */
export function recordWin(
  progress: Progress,
  difficultyId: string,
  seconds: number,
  stars: number,
): Progress {
  const next: Progress = {
    ...progress,
    cleared: { ...progress.cleared },
    best: { ...progress.best },
    totalStars: progress.totalStars + stars,
  };
  next.cleared[difficultyId] = (next.cleared[difficultyId] ?? 0) + 1;

  const prev = next.best[difficultyId];
  if (!prev || seconds < prev.seconds) {
    next.best[difficultyId] = { seconds, stars };
  }
  return next;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式或配额用尽：丢弃这次写入，不影响本次游玩
  }
}
